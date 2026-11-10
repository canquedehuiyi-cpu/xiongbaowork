import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agents,
  type LocalLearningSkipReason,
  localLearningRuns,
  localLearningState,
  localSkillCandidates,
  skills,
} from "../db/schema";
import { QuotaExceeded } from "../quota/limits";
import { asPlatform, isPersonTenant, runAsTenant } from "../tenant/context";
import {
  collectEvidence,
  type EvidenceThread,
  MAX_RUNS_PER_PASS,
} from "./evidence";
import {
  MIN_THREADS_PER_AGENT,
  type ProposalCall,
  proposeSkills,
} from "./propose";

/** 两次学习之间至少隔多久。一天一次：对话要攒一攒才看得出反复出现的做法。 */
export const LEARN_EVERY_MS = 24 * 3_600_000;
/** 一次扫描最多认领几个人：剩下的下一轮再认领，一轮不会拖太久。 */
const CLAIM_BATCH = 20;
/** 一次学习最多看几位员工（对话最多的几位）。 */
const MAX_AGENTS_PER_RUN = 3;
/** 一次「正在学」超过这么久还没结束，算进程死在半路，记为失败，让这个人下次还能学。 */
const STALE_RUN_MS = 3_600_000;
/** 多少天内有过对话的人才认领。 */
const ACTIVE_DAYS = 14;

export type LocalLearningResult =
  | { outcome: "busy" }
  | { outcome: "skipped"; reason: LocalLearningSkipReason }
  | { outcome: "proposed" | "nothing"; candidates: number }
  | { outcome: "failed" };

export type LocalLearningEngineDeps = {
  database: Database;
  /**
   * 这位员工用的模型，已经按这个人计量（`models/runtime-resolver.ts`）。在本人帧里调用。
   * null 表示没有模型可用。
   */
  modelFor: (agentId: string) => Promise<LanguageModel | null>;
  /** 这位员工已经有的技能名称，给模型看，免得重复提。在本人帧里调用。 */
  skillsFor: (agentId: string) => Promise<string[]>;
  /** 本月任务额度用完就不学，和主动巡检一样（`proactive/engine.ts` 的 `quota`）。 */
  quota?: {
    assertCapacity: (
      tenantId: string,
      metric: "tasksPerMonth",
    ) => Promise<void>;
  };
  now?: () => Date;
  /** 一次扫描最多认领几个人，默认 20。 */
  claimBatch?: number;
  /** 测试替身：模型调用。 */
  call?: ProposalCall;
};

/**
 * 本地学习：每人每天一次，读 TA 自己最近的对话，请 TA 的员工所用的模型提出技能草案，存起来等 TA 审。
 *
 * 和上游的区别：上游把对话线程存进 Intelligence，由它分析；这里对话不出库，分析在本地做，用的是
 * 这个人自己的员工的模型、计入这个人的用量。草案在本人批准之前不会给任何员工用。
 *
 * 多副本：`sweep` 用一条带条件的 upsert 认领到期的人，同一个人只有一个副本认领到；同一个人同一
 * 时刻只有一行「正在学」（部分唯一索引），「现在学一次」和定时扫描撞上时后到的那个直接返回 busy。
 */
export function createLocalLearningEngine(deps: LocalLearningEngineDeps) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());

  /** 认领到期的人：最近有对话、开着、到时间了的。没有设置行的人第一次被扫到时建行。 */
  async function claimDue(): Promise<string[]> {
    const at = now();
    const next = new Date(at.getTime() + LEARN_EVERY_MS);
    const since = new Date(at.getTime() - ACTIVE_DAYS * 86_400_000);
    const rows = await database.execute<{ tenant_id: string }>(sql`
      WITH active AS (
        SELECT r.tenant_id
        FROM (SELECT DISTINCT tenant_id FROM thread_runs WHERE created_at > ${since}) r
        LEFT JOIN local_learning_state s ON s.tenant_id = r.tenant_id
        WHERE r.tenant_id NOT IN ('system', 'team', 'platform')
          AND (s.tenant_id IS NULL OR (s.enabled AND (s.next_run_at IS NULL OR s.next_run_at <= ${at})))
        LIMIT ${deps.claimBatch ?? CLAIM_BATCH}
      )
      INSERT INTO local_learning_state (tenant_id, next_run_at, updated_at)
      SELECT tenant_id, ${next}, ${at} FROM active
      ON CONFLICT (tenant_id) DO UPDATE
        SET next_run_at = EXCLUDED.next_run_at, updated_at = EXCLUDED.updated_at
        WHERE local_learning_state.enabled
          AND (local_learning_state.next_run_at IS NULL OR local_learning_state.next_run_at <= ${at})
      RETURNING tenant_id
    `);
    return rowsOf<{ tenant_id: string }>(rows)
      .map((row) => row.tenant_id)
      .filter(isPersonTenant);
  }

  /** 进程死在半路留下的「正在学」，记为失败。 */
  async function closeStale(): Promise<void> {
    await database
      .update(localLearningRuns)
      .set({ outcome: "failed", finishedAt: now() })
      .where(
        and(
          eq(localLearningRuns.outcome, "running"),
          lt(
            localLearningRuns.startedAt,
            new Date(now().getTime() - STALE_RUN_MS),
          ),
        ),
      );
  }

  /** 在这个人的帧里学一次。调用方负责进帧。 */
  async function learn(tenantId: string): Promise<LocalLearningResult> {
    const runId = randomUUID();
    try {
      await database
        .insert(localLearningRuns)
        .values({ id: runId, startedAt: now() });
    } catch (error) {
      if (uniqueViolation(error)) return { outcome: "busy" };
      throw error;
    }
    const finish = (values: Partial<typeof localLearningRuns.$inferInsert>) =>
      database
        .update(localLearningRuns)
        .set({ finishedAt: now(), ...values })
        .where(eq(localLearningRuns.id, runId));
    const skip = async (reason: LocalLearningSkipReason, runsRead = 0) => {
      await finish({ outcome: "skipped", skipReason: reason, runsRead });
      return { outcome: "skipped" as const, reason };
    };

    try {
      const [state] = await database
        .select()
        .from(localLearningState)
        .where(eq(localLearningState.tenantId, tenantId))
        .limit(1);
      if (state && !state.enabled) return await skip("off");

      if (deps.quota) {
        try {
          await deps.quota.assertCapacity(tenantId, "tasksPerMonth");
        } catch (error) {
          if (error instanceof QuotaExceeded) return await skip("quota");
          throw error;
        }
      }

      const evidence = await collectEvidence(database, {
        since: state?.evidenceCursor ?? null,
        now: now(),
      });
      const advance = () =>
        evidence.cursor
          ? database
              .insert(localLearningState)
              .values({ evidenceCursor: evidence.cursor, updatedAt: now() })
              .onConflictDoUpdate({
                target: localLearningState.tenantId,
                set: { evidenceCursor: evidence.cursor, updatedAt: now() },
              })
          : Promise.resolve();

      const byAgent = groupByAgent(evidence.threads)
        .filter((group) => group.threads.length >= MIN_THREADS_PER_AGENT)
        .slice(0, MAX_AGENTS_PER_RUN);
      if (byAgent.length === 0) {
        // 不够一位员工两段对话：游标不推进，攒到下次一起看。读满了一窗却还是不够（比如都在
        // 同一段对话里）时推进，不然下次读到的还是这一窗，永远学不到后面的。
        if (evidence.runsRead >= MAX_RUNS_PER_PASS) await advance();
        return await skip("no_evidence", evidence.runsRead);
      }

      const taken = new Set(
        [
          ...(await database.select({ slug: skills.slug }).from(skills)),
          ...(await database
            .select({ slug: localSkillCandidates.slug })
            .from(localSkillCandidates)
            .where(eq(localSkillCandidates.status, "pending_review"))),
        ].map((row) => row.slug),
      );
      const names = new Map(
        (
          await database
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              inArray(
                agents.id,
                byAgent.map((group) => group.agentId),
              ),
            )
        ).map((row) => [row.id, row.name]),
      );

      let candidates = 0;
      let modelled = 0;
      for (const group of byAgent) {
        const agentName = names.get(group.agentId);
        // 已经不在这个人可见范围里的员工，不为它学。
        if (!agentName) continue;
        const model = await deps.modelFor(group.agentId);
        if (!model) continue;
        modelled += 1;
        const proposals = await proposeSkills({
          model,
          agentName,
          existingSkills: await deps.skillsFor(group.agentId),
          taken,
          threads: group.threads,
          ...(deps.call ? { call: deps.call } : {}),
        });
        for (const proposal of proposals) {
          taken.add(proposal.slug);
          await database.insert(localSkillCandidates).values({
            id: randomUUID(),
            runId,
            agentId: group.agentId,
            slug: proposal.slug,
            title: proposal.title,
            summary: proposal.summary,
            instructions: proposal.instructions,
            reason: proposal.reason,
            evidence: proposal.evidence.map((thread) => ({
              threadId: thread.threadId,
              runId: thread.runId,
              at: thread.at.toISOString(),
            })),
            createdAt: now(),
          });
          candidates += 1;
        }
      }
      if (modelled === 0) return await skip("no_model", evidence.runsRead);

      await advance();
      const outcome = candidates > 0 ? "proposed" : "nothing";
      await finish({ outcome, runsRead: evidence.runsRead, candidates });
      return { outcome, candidates };
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "local-learning-failed",
          // 只记类型，不记内容：模型或数据库的错误里可能带着对话片段或连接信息。
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
      await finish({ outcome: "failed" }).catch(() => {});
      return { outcome: "failed" };
    }
  }

  return {
    /** 定时扫描：收拾死掉的、认领到期的、一个个学。 */
    async sweep(): Promise<void> {
      await asPlatform(closeStale);
      const due = await asPlatform(claimDue);
      for (const tenantId of due)
        await runAsTenant(tenantId, () => learn(tenantId));
    },

    /**
     * 「现在学一次」：本人在设置里点的。关着时不学；顺延下一次定时学习，免得刚学完又学。
     * 在本人帧里调用。
     */
    async learnNow(tenantId: string): Promise<LocalLearningResult> {
      const [state] = await database
        .select({ enabled: localLearningState.enabled })
        .from(localLearningState)
        .where(eq(localLearningState.tenantId, tenantId))
        .limit(1);
      if (state && !state.enabled) return { outcome: "skipped", reason: "off" };
      const next = new Date(now().getTime() + LEARN_EVERY_MS);
      await database
        .insert(localLearningState)
        .values({ nextRunAt: next, updatedAt: now() })
        .onConflictDoUpdate({
          target: localLearningState.tenantId,
          set: { nextRunAt: next, updatedAt: now() },
        });
      return learn(tenantId);
    },

    /** 有没有正在学的。在本人帧里调用。 */
    async running(): Promise<boolean> {
      const [row] = await database
        .select({ id: localLearningRuns.id })
        .from(localLearningRuns)
        .where(eq(localLearningRuns.outcome, "running"))
        .limit(1);
      return row !== undefined;
    },
  };
}

export type LocalLearningEngine = ReturnType<typeof createLocalLearningEngine>;

function groupByAgent(
  threads: EvidenceThread[],
): { agentId: string; threads: EvidenceThread[] }[] {
  const groups = new Map<string, EvidenceThread[]>();
  for (const thread of threads) {
    const list = groups.get(thread.agentId) ?? [];
    list.push(thread);
    groups.set(thread.agentId, list);
  }
  return [...groups.entries()]
    .map(([agentId, list]) => ({ agentId, threads: list }))
    .sort((a, b) => b.threads.length - a.threads.length);
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** 同一个人已经有一行「正在学」。Bun 的驱动把 SQLSTATE 放在 `errno`，drizzle 把它包成 `cause`。 */
function uniqueViolation(error: unknown): boolean {
  type Driver = { errno?: unknown; constraint?: unknown };
  return [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ].some(
    (candidate) =>
      candidate?.errno === "23505" &&
      candidate.constraint === "local_learning_runs_one_running_idx",
  );
}

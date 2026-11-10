import type {
  LocalLearningOverview,
  LocalSkillCandidateDetail,
  LocalSkillCandidateSummary,
} from "@openbot/shared/local-learning";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agents,
  localLearningRuns,
  localLearningState,
  localSkillCandidates,
  skills,
  threads,
} from "../db/schema";
import type { LocalLearningEngine } from "./engine";

/**
 * 本人的本地学习：开关、「现在学一次」、草案列表和审核（`/api/local-learning`）。
 *
 * 每个请求都在本人的租户帧里（`requireUser`），行级安全只给看本人的行。
 *
 * 批准不在这里写技能库。浏览器先经 `POST /api/plugins/skills` 存技能、经 `POST /api/plugins/grants`
 * 交给员工，和「员工起草技能 → 本人确认保存」走同一条路、同一套检查（谁的员工、能不能授予）；
 * 这里只在确认这个人的技能库里真有这条技能之后，把草案记为已批准。拒绝只改状态。
 */
export function createLocalLearningRoutes(deps: {
  database: Database;
  engine: LocalLearningEngine | undefined;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore?: AuditStore;
}) {
  const { database, engine } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser, bodyLimit({ maxSize: 8_192 }));
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "local-learning-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "本地学习暂时不可用，请稍后再试。" }, 503);
  });

  const overview = async (): Promise<LocalLearningOverview> => {
    const [state] = await database.select().from(localLearningState).limit(1);
    const [lastRun] = await database
      .select()
      .from(localLearningRuns)
      .orderBy(desc(localLearningRuns.startedAt))
      .limit(1);
    const pending = await database
      .select()
      .from(localSkillCandidates)
      .where(eq(localSkillCandidates.status, "pending_review"))
      .orderBy(desc(localSkillCandidates.createdAt))
      .limit(50);
    const reviewed = await database
      .select()
      .from(localSkillCandidates)
      .where(ne(localSkillCandidates.status, "pending_review"))
      .orderBy(desc(localSkillCandidates.reviewedAt))
      .limit(20);
    const names = await agentNames([...pending, ...reviewed]);
    return {
      available: engine !== undefined,
      enabled: state?.enabled ?? true,
      running: lastRun?.outcome === "running",
      nextRunAt: state?.nextRunAt?.toISOString() ?? null,
      lastRun: lastRun
        ? {
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            outcome: lastRun.outcome,
            skipReason: lastRun.skipReason ?? null,
            runsRead: lastRun.runsRead,
            candidates: lastRun.candidates,
          }
        : null,
      pending: pending.map((row) => summaryOf(row, names)),
      reviewed: reviewed.map((row) => summaryOf(row, names)),
    };
  };

  async function agentNames(
    rows: { agentId: string }[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.agentId))];
    if (ids.length === 0) return new Map();
    return new Map(
      (
        await database
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, ids))
      ).map((row) => [row.id, row.name]),
    );
  }

  const candidate = async (id: string) => {
    const [row] = await database
      .select()
      .from(localSkillCandidates)
      .where(eq(localSkillCandidates.id, id))
      .limit(1);
    return row;
  };

  routes.get("/", async (context) => context.json(await overview()));

  routes.put("/", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (typeof body?.enabled !== "boolean")
      return context.json({ error: "需要说明开还是关。" }, 400);
    await database
      .insert(localLearningState)
      .values({ enabled: body.enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: localLearningState.tenantId,
        set: { enabled: body.enabled, updatedAt: new Date() },
      });
    return context.json(await overview());
  });

  routes.post("/learn", async (context) => {
    if (!engine)
      return context.json({ error: "管理员关闭了从对话中学习。" }, 409);
    if (await engine.running())
      return context.json({ error: "正在学习，请稍后再看。" }, 409);
    const [state] = await database
      .select({ enabled: localLearningState.enabled })
      .from(localLearningState)
      .limit(1);
    if (state && !state.enabled)
      return context.json({ error: "先打开「从对话中学习」。" }, 409);
    // 不等它学完：一次学习要调用模型，可能要一两分钟。仍在本人帧里跑（异步上下文随调用延续）。
    void engine.learnNow(context.var.actor.id).catch(() => {});
    return context.json({ started: true }, 202);
  });

  routes.get("/candidates/:id", async (context) => {
    const row = await candidate(context.req.param("id"));
    if (!row) return context.json({ error: "找不到这条草案。" }, 404);
    const names = await agentNames([row]);
    const threadIds = row.evidence.map((item) => item.threadId);
    const found = new Map(
      threadIds.length === 0
        ? []
        : (
            await database
              .select({ id: threads.id, name: threads.name })
              .from(threads)
              .where(inArray(threads.id, threadIds))
          ).map((thread) => [thread.id, thread.name]),
    );
    const detail: LocalSkillCandidateDetail = {
      ...summaryOf(row, names),
      instructions: row.instructions,
      reason: row.reason,
      evidence: row.evidence.map((item) => ({
        ...item,
        name: found.get(item.threadId) ?? null,
        exists: found.has(item.threadId),
      })),
    };
    return context.json({ candidate: detail });
  });

  routes.post("/candidates/:id/approve", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      slug?: unknown;
    } | null;
    const row = await candidate(context.req.param("id"));
    if (!row) return context.json({ error: "找不到这条草案。" }, 404);
    if (row.status !== "pending_review")
      return context.json({ error: "这条草案已经处理过了。" }, 409);
    const slug =
      typeof body?.slug === "string" && body.slug.trim()
        ? body.slug.trim()
        : row.slug;
    // 只认这个人自己的技能：存进技能库那一步必须已经成功。
    const [saved] = await database
      .select({ slug: skills.slug })
      .from(skills)
      .where(
        and(
          eq(skills.slug, slug),
          eq(skills.ownerUserId, context.var.actor.id),
        ),
      )
      .limit(1);
    if (!saved)
      return context.json({ error: "技能库里还没有这项技能，先保存它。" }, 409);
    const reviewedAt = new Date();
    await database
      .update(localSkillCandidates)
      .set({
        status: "approved",
        skillSlug: slug,
        reviewedAt,
        reviewedBy: context.var.actor.id,
      })
      .where(
        and(
          eq(localSkillCandidates.id, row.id),
          eq(localSkillCandidates.status, "pending_review"),
        ),
      );
    await audit(context.var.actor.id, row, "approved", slug);
    const names = await agentNames([row]);
    return context.json({
      candidate: summaryOf(
        { ...row, status: "approved", skillSlug: slug, reviewedAt },
        names,
      ),
    });
  });

  routes.post("/candidates/:id/reject", async (context) => {
    const row = await candidate(context.req.param("id"));
    if (!row) return context.json({ error: "找不到这条草案。" }, 404);
    if (row.status !== "pending_review")
      return context.json({ error: "这条草案已经处理过了。" }, 409);
    const reviewedAt = new Date();
    await database
      .update(localSkillCandidates)
      .set({
        status: "rejected",
        reviewedAt,
        reviewedBy: context.var.actor.id,
      })
      .where(
        and(
          eq(localSkillCandidates.id, row.id),
          eq(localSkillCandidates.status, "pending_review"),
        ),
      );
    await audit(context.var.actor.id, row, "rejected", null);
    const names = await agentNames([row]);
    return context.json({
      candidate: summaryOf({ ...row, status: "rejected", reviewedAt }, names),
    });
  });

  /** 本人对一条草案的决定写进审计：哪位员工、哪项技能、批准还是拒绝。不写技能正文。 */
  async function audit(
    actorId: string,
    row: { id: string; agentId: string; slug: string },
    decision: "approved" | "rejected",
    skillSlug: string | null,
  ): Promise<void> {
    if (!deps.auditStore) return;
    await recordAuditEvent(deps.auditStore, {
      eventType: "learning.local_candidate_reviewed",
      targetType: "local_skill_candidate",
      targetId: row.id,
      actorUserId: actorId,
      payload: {
        agentId: row.agentId,
        proposedSlug: row.slug,
        decision,
        ...(skillSlug ? { skillSlug } : {}),
      },
    }).catch(() => {});
  }

  return routes;
}

function summaryOf(
  row: typeof localSkillCandidates.$inferSelect,
  names: Map<string, string>,
): LocalSkillCandidateSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: names.get(row.agentId) ?? null,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    status: row.status,
    skillSlug: row.skillSlug ?? null,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

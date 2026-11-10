// 本地学习（L1）在真实数据库上：证据只取本人的对话、草案只写进本人的租户、审核要求技能已经存好。
import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  localLearningRuns,
  localLearningState,
  localSkillCandidates,
  skills,
  threadRunEvents,
  threadRuns,
  threads,
  users,
} from "../src/db/schema";
import { createLocalLearningEngine } from "../src/local-learning/engine";
import type { ProposalCall } from "../src/local-learning/propose";
import { createLocalLearningRoutes } from "../src/local-learning/routes";
import { QuotaExceeded } from "../src/quota/limits";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { afterAll, beforeAll, test } from "./support/platform-frame";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const A = `local-learning-a-${suite}`;
const B = `local-learning-b-${suite}`;
const AGENT_A = `ll-agent-a-${suite}`;
const AGENT_B = `ll-agent-b-${suite}`;
const tenants = [A, B];

/** 模型的提示词，按人记下；回答由测试决定。 */
const prompts: { tenant: string; prompt: string }[] = [];
let answer: (prompt: string) => string = () => '{"skills":[]}';
const call: ProposalCall = async ({ prompt }) => {
  prompts.push({ tenant: currentTenantOf(prompt), prompt });
  return { text: answer(prompt) };
};
function currentTenantOf(prompt: string): string {
  return prompt.includes("Bot: 写周报的员工") ? A : B;
}

const model = {} as LanguageModel;
let quotaFull = false;
const engine = createLocalLearningEngine({
  database,
  modelFor: async () => model,
  skillsFor: async () => ["已有的技能"],
  quota: {
    assertCapacity: async () => {
      if (quotaFull) throw new QuotaExceeded("tasksPerMonth", 10, 10, "Free");
    },
  },
  call,
  // 测试库里还有别的测试留下的人；认领不设上限，才能确定扫到本测试的人。
  claimBatch: 10_000,
});

let at = Date.now() - 3_600_000;
async function conversation(input: {
  tenant: string;
  agentId: string;
  name: string;
  person: string;
  failed?: boolean;
}): Promise<{ threadId: string; runId: string }> {
  const threadId = `ll-thread-${randomUUID()}`;
  const runId = `ll-run-${randomUUID()}`;
  at += 60_000;
  await runAsTenant(input.tenant, async () => {
    await database.insert(threads).values({
      id: threadId,
      agentId: input.agentId,
      name: input.name,
      messagesSnapshot: [
        { id: "m1", role: "user", content: input.person },
        {
          id: "m2",
          role: "assistant",
          content: "好的，我来整理。",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read_sheet", arguments: '{"secret":"x"}' },
            },
          ],
        },
        {
          id: "m3",
          role: "tool",
          toolCallId: "c1",
          content: "工具原文不该出现",
        },
      ],
    });
    await database.insert(threadRuns).values({
      id: runId,
      threadId,
      agentId: input.agentId,
      eventCount: 2,
      createdAt: new Date(at),
    });
    if (input.failed)
      await database.insert(threadRunEvents).values({
        threadId,
        runId,
        seq: 0,
        event: { type: "RUN_ERROR", message: "stalled" },
      });
  });
  return { threadId, runId };
}

let first: { threadId: string; runId: string };
let second: { threadId: string; runId: string };
let failedRun: { threadId: string; runId: string };

beforeAll(async () => {
  await database.insert(users).values([
    { id: A, email: `${A}@example.test` },
    { id: B, email: `${B}@example.test` },
  ]);
  await runAsTenant(A, () =>
    database.insert(agents).values({
      id: AGENT_A,
      name: "写周报的员工",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    }),
  );
  await runAsTenant(B, () =>
    database.insert(agents).values({
      id: AGENT_B,
      name: "B 的员工",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    }),
  );
  first = await conversation({
    tenant: A,
    agentId: AGENT_A,
    name: "周一的周报",
    person: "把本周进展整理成周报，发给 boss@example.com，电话 13800138000",
  });
  failedRun = await conversation({
    tenant: A,
    agentId: AGENT_A,
    name: "失败的那次",
    person: "这一段运行失败了，不该被读到",
    failed: true,
  });
  second = await conversation({
    tenant: A,
    agentId: AGENT_A,
    name: "又一次周报",
    person: "还是周报，这次先列风险再列进展",
  });
});

afterAll(async () => {
  for (const tenant of tenants)
    await runAsTenant(tenant, async () => {
      await database.delete(localSkillCandidates);
      await database.delete(localLearningRuns);
      await database.delete(localLearningState);
      await database.delete(skills).where(eq(skills.ownerUserId, tenant));
      const own = await database.select({ id: threads.id }).from(threads);
      if (own.length > 0) {
        const ids = own.map((row) => row.id);
        await database
          .delete(threadRunEvents)
          .where(inArray(threadRunEvents.threadId, ids));
        await database
          .delete(threadRuns)
          .where(inArray(threadRuns.threadId, ids));
        await database.delete(threads).where(inArray(threads.id, ids));
      }
      await database
        .delete(agents)
        .where(inArray(agents.id, [AGENT_A, AGENT_B]));
    });
  await database.delete(users).where(inArray(users.id, tenants));
  await database.$client.end({ timeout: 5 });
});

describe("learning once, in the person's own frame", () => {
  test("proposes a skill from the person's own successful conversations, masked, and records the run", async () => {
    answer = () =>
      JSON.stringify({
        skills: [
          {
            slug: "weekly-report",
            title: "整理周报",
            summary: "按固定格式整理本周进展",
            instructions:
              "先列出本周的风险，再按项目列出进展，最后写下周计划。每一项都要写清负责人和截止时间，因为周报是给上级看进度的。",
            reason: "对话 1 和 2 都在要周报，第 2 次纠正了顺序",
            evidence: [1, 2, 9],
          },
          {
            slug: "Not A Slug",
            title: "坏的",
            instructions: "x".repeat(50),
            evidence: [1],
          },
        ],
      });

    const result = await runAsTenant(A, () => engine.learnNow(A));

    expect(result).toEqual({ outcome: "proposed", candidates: 1 });
    const prompt = prompts.at(-1)?.prompt ?? "";
    expect(prompt).toContain("Bot: 写周报的员工");
    expect(prompt).toContain("- 已有的技能");
    expect(prompt).toContain("Person: 还是周报，这次先列风险再列进展");
    expect(prompt).toContain("(Bot used tools: read_sheet)");
    // 失败的运行、工具的参数和返回、邮箱和电话都不进模型。
    expect(prompt).not.toContain("这一段运行失败了");
    expect(prompt).not.toContain("工具原文不该出现");
    expect(prompt).not.toContain("secret");
    expect(prompt).not.toContain("boss@example.com");
    expect(prompt).not.toContain("13800138000");

    const rows = await runAsTenant(A, () =>
      database.select().from(localSkillCandidates),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: A,
      agentId: AGENT_A,
      slug: "weekly-report",
      title: "整理周报",
      status: "pending_review",
    });
    // 只记本地 id；编号 9 不是真的对话，被丢掉。
    expect(rows[0]?.evidence.map((item) => item.threadId)).toEqual([
      first.threadId,
      second.threadId,
    ]);
    expect(rows[0]?.evidence.map((item) => item.threadId)).not.toContain(
      failedRun.threadId,
    );

    const [run] = await runAsTenant(A, () =>
      database.select().from(localLearningRuns),
    );
    expect(run).toMatchObject({
      outcome: "proposed",
      candidates: 1,
      runsRead: 3,
    });
    const [state] = await runAsTenant(A, () =>
      database.select().from(localLearningState),
    );
    expect(state?.evidenceCursor).toBeInstanceOf(Date);
    expect(state?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  test("another person sees none of it", async () => {
    const seen = await runAsTenant(B, async () => ({
      candidates: await database.select().from(localSkillCandidates),
      runs: await database.select().from(localLearningRuns),
    }));

    expect(seen.candidates).toEqual([]);
    expect(seen.runs).toEqual([]);
  });

  test("nothing new since the last time is not enough to learn from", async () => {
    const before = prompts.length;

    const result = await runAsTenant(A, () => engine.learnNow(A));

    expect(result).toEqual({ outcome: "skipped", reason: "no_evidence" });
    expect(prompts.length).toBe(before);
  });

  test("a run already going is not started twice", async () => {
    const running = randomUUID();
    await runAsTenant(A, () =>
      database.insert(localLearningRuns).values({ id: running }),
    );
    try {
      expect(await runAsTenant(A, () => engine.learnNow(A))).toEqual({
        outcome: "busy",
      });
    } finally {
      await runAsTenant(A, () =>
        database
          .delete(localLearningRuns)
          .where(eq(localLearningRuns.id, running)),
      );
    }
  });

  test("a month with no task allowance left is skipped, and says why", async () => {
    quotaFull = true;
    try {
      expect(await runAsTenant(A, () => engine.learnNow(A))).toEqual({
        outcome: "skipped",
        reason: "quota",
      });
    } finally {
      quotaFull = false;
    }
  });
});

describe("the sweep", () => {
  test("claims a person with conversations and learns in that person's frame only", async () => {
    await conversation({
      tenant: B,
      agentId: AGENT_B,
      name: "B1",
      person: "帮我订会议室",
    });
    await conversation({
      tenant: B,
      agentId: AGENT_B,
      name: "B2",
      person: "再帮我订会议室",
    });
    answer = (prompt) =>
      prompt.includes("Bot: B 的员工")
        ? JSON.stringify({
            skills: [
              {
                slug: "book-a-room",
                title: "订会议室",
                summary: "按习惯订会议室",
                instructions:
                  "先问清时间和人数，再查空闲的会议室，订好之后把房间号和时间发回来，因为对方要转发给参会的人。",
                reason: "两次都在订会议室",
                evidence: [1, 2],
              },
            ],
          })
        : '{"skills":[]}';

    await engine.sweep();

    const ofB = await runAsTenant(B, () =>
      database.select().from(localSkillCandidates),
    );
    expect(ofB.map((row) => [row.tenantId, row.slug])).toEqual([
      [B, "book-a-room"],
    ]);
    const ofA = await runAsTenant(A, () =>
      database
        .select({ slug: localSkillCandidates.slug })
        .from(localSkillCandidates),
    );
    expect(ofA.map((row) => row.slug)).toEqual(["weekly-report"]);
  });

  test("a person who turned it off is not claimed", async () => {
    await runAsTenant(B, () =>
      database
        .update(localLearningState)
        .set({ enabled: false, nextRunAt: new Date(0) }),
    );
    const before = await runAsTenant(B, () =>
      database.select().from(localLearningRuns),
    );

    await engine.sweep();

    const after = await runAsTenant(B, () =>
      database.select().from(localLearningRuns),
    );
    expect(after.length).toBe(before.length);
    expect(await runAsTenant(B, () => engine.learnNow(B))).toEqual({
      outcome: "skipped",
      reason: "off",
    });
  });
});

describe("the person's routes", () => {
  const audit: AuditEventInput[] = [];
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: A, email: `${A}@example.test`, role: "member" });
    await runAsTenant(A, () => next());
  };
  const app = new Hono().route(
    "/api/local-learning",
    createLocalLearningRoutes({
      database,
      engine,
      requireUser,
      auditStore: { insert: async (event) => void audit.push(event) },
    }),
  );
  const ask = (path: string, init?: RequestInit) =>
    app.request(`/api/local-learning${path}`, init);
  const post = (path: string, body: unknown = {}) =>
    ask(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function pendingId(): Promise<string> {
    const [row] = await runAsTenant(A, () =>
      database
        .select({ id: localSkillCandidates.id })
        .from(localSkillCandidates)
        .where(eq(localSkillCandidates.status, "pending_review")),
    );
    if (!row) throw new Error("no pending candidate");
    return row.id;
  }

  test("the overview lists the person's drafts with their Bot's name", async () => {
    const response = await ask("");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      available: boolean;
      enabled: boolean;
      pending: { slug: string; agentName: string | null }[];
      lastRun: { outcome: string } | null;
    };
    expect(body.available).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.pending).toEqual([
      expect.objectContaining({
        slug: "weekly-report",
        agentName: "写周报的员工",
      }),
    ]);
  });

  test("a draft's detail names the conversations it came from", async () => {
    const response = await ask(`/candidates/${await pendingId()}`);

    expect(response.status).toBe(200);
    const { candidate } = (await response.json()) as {
      candidate: {
        instructions: string;
        evidence: { name: string | null; exists: boolean }[];
      };
    };
    expect(candidate.instructions).toContain("先列出本周的风险");
    expect(candidate.evidence).toEqual([
      expect.objectContaining({ name: "周一的周报", exists: true }),
      expect.objectContaining({ name: "又一次周报", exists: true }),
    ]);
  });

  test("approving before the skill is saved is refused, and the draft stays pending", async () => {
    const id = await pendingId();

    const response = await post(`/candidates/${id}/approve`, {
      slug: "weekly-report",
    });

    expect(response.status).toBe(409);
    const [row] = await runAsTenant(A, () =>
      database
        .select({ status: localSkillCandidates.status })
        .from(localSkillCandidates)
        .where(eq(localSkillCandidates.id, id)),
    );
    expect(row?.status).toBe("pending_review");
  });

  test("approving once the person's own skill is saved records it and audits the decision", async () => {
    const id = await pendingId();
    await runAsTenant(A, () =>
      database.insert(skills).values({
        id: randomUUID(),
        ownerUserId: A,
        slug: "weekly-report-2",
        title: "整理周报",
        summary: "按固定格式整理本周进展",
        instructions: "先列风险。",
        origin: "learned",
      }),
    );

    const response = await post(`/candidates/${id}/approve`, {
      slug: "weekly-report-2",
    });

    expect(response.status).toBe(200);
    const [row] = await runAsTenant(A, () =>
      database
        .select()
        .from(localSkillCandidates)
        .where(eq(localSkillCandidates.id, id)),
    );
    expect(row).toMatchObject({
      status: "approved",
      skillSlug: "weekly-report-2",
      reviewedBy: A,
    });
    expect(audit.at(-1)).toMatchObject({
      eventType: "learning.local_candidate_reviewed",
      targetId: id,
      actorUserId: A,
      payload: {
        agentId: AGENT_A,
        proposedSlug: "weekly-report",
        decision: "approved",
        skillSlug: "weekly-report-2",
      },
    });
    expect(JSON.stringify(audit.at(-1))).not.toContain("先列风险");

    expect((await post(`/candidates/${id}/approve`)).status).toBe(409);
  });

  test("a draft that is someone else's is not found", async () => {
    const [ofB] = await runAsTenant(B, () =>
      database
        .select({ id: localSkillCandidates.id })
        .from(localSkillCandidates),
    );

    expect((await ask(`/candidates/${ofB?.id}`)).status).toBe(404);
    expect((await post(`/candidates/${ofB?.id}/reject`)).status).toBe(404);
    const [still] = await runAsTenant(B, () =>
      database
        .select({ status: localSkillCandidates.status })
        .from(localSkillCandidates)
        .where(and(eq(localSkillCandidates.id, ofB?.id ?? ""))),
    );
    expect(still?.status).toBe("pending_review");
  });

  test("turning it off is the person's own setting", async () => {
    const response = await ask("", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { enabled: boolean }).enabled).toBe(
      false,
    );
    expect((await post("/learn")).status).toBe(409);
    const [ofB] = await runAsTenant(B, () =>
      database
        .select({ enabled: localLearningState.enabled })
        .from(localLearningState),
    );
    // B 的开关是 B 上一条用例里自己关的，A 的请求碰不到 B 的行。
    expect(ofB?.enabled).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HeadlessToolSuspension } from "../../toolkit/src/headless-tools";
import {
  createPlanApproval,
  PLAN_NOT_APPROVED,
  REVIEW_READ_ONLY,
} from "../src/agents/plan-approval";
import { createSubagents } from "../src/agents/subagent";
import { updatePlanTools } from "../src/agents/update-plan";
import { createPlanHold } from "../src/approvals/plan-hold";
import { createApprovalQuestions } from "../src/approvals/questions";
import { restrictToReads } from "../src/approvals/read-only-threads";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  ApprovalRefusedError,
  withApprovalContext,
} from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 计划须批准（试点 4），经真实的闸门、问题收件箱路由和库：
 * 长计划进收件箱；批准前有副作用的调用被挡、只读的不挡；批准后放行；
 * 带意见驳回后仍挡，意见作为回到会话的答复；别人不能批准；3 步计划不触发；开关关时闸门不变。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `plan-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const bot = `${prefix}-bot`;
const keys: string[] = [];

const hold = createPlanHold(database);
/** Built as the deployment builds it with the pilot on, and off. */
const storeOn = {
  ...createApprovalStore(database),
  planApprovalPending: hold.pending,
};
const storeOff = createApprovalStore(database);
const serviceOn = createApprovalService(
  storeOn,
  createApprovalQuestions(database, async () => undefined),
);
const serviceOff = createApprovalService(storeOff);

const as = <T>(person: string, body: () => Promise<T>) =>
  runAsTenant(person, body);

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/approvals",
  createApprovalRoutes(serviceOn, async (context, next) => {
    const id = context.req.header("x-person") ?? alice;
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  }),
);
const respond = (person: string, key: string, body: unknown) =>
  runAsTenant(person, () =>
    Promise.resolve(
      app.request(`/api/approvals/questions/${key}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-person": person },
        body: JSON.stringify(body),
      }),
    ),
  );

const steps = (count: number, tail = "") =>
  Array.from({ length: count }, (_, index) => ({
    text: `第 ${index + 1} 步${tail}`,
    status: "pending" as const,
  }));

/** The conversation a call runs in: what the gate and `update_plan` read. */
const inThread = <T>(threadId: string, body: () => Promise<T>) =>
  withApprovalContext(
    {
      runId: `run-${threadId}`,
      threadId,
      toolCallId: randomUUID(),
      toolName: "update_plan",
      args: {},
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
    body,
  );

/**
 * What the deployment's `ask` does for a plan: the row `ask_person` saves, with the plan's marker.
 * Written out here because the real route needs a channel and a roster this test has no use for.
 */
const asker: Parameters<typeof createPlanApproval>[0]["ask"] = async (
  input,
) => {
  const key = randomUUID();
  keys.push(key);
  await database.insert(workItems).values({
    kind: "person.question",
    key,
    payload: {
      actorId: input.actorId,
      botId: input.botId,
      threadId: input.threadId,
      runId: input.runId,
      question: input.question,
      why: input.why,
      sourceBotId: input.botId,
      channelId: `${prefix}-channel`,
      mode: "completed_question",
      planApproval: input.planApproval,
    },
  });
  return { reached: "the person" };
};

/** The plan tool an employee holds under the pilot, for `person` and a declared (or not) employee. */
const planTool = (person: string, declared = true) => {
  const [tool] = updatePlanTools({
    approval: createPlanApproval({
      actorId: person,
      botId: bot,
      initiator: undefined,
      declared: async () => declared,
      latest: (owner, threadId) => hold.latest(owner, threadId),
      ask: asker,
    }),
  });
  if (!tool) throw new Error("Expected the plan tool.");
  return tool;
};

const plan = (
  person: string,
  threadId: string,
  items: unknown[],
  declared = true,
) =>
  as(person, () =>
    inThread(threadId, () => planTool(person, declared).execute({ items })),
  );

/**
 * A tool call with a side effect, or only a read, put to the gate in `threadId`: "ran" when the gate
 * lets it through, "asked" when it goes on to ask the person as it always does, or the refusal.
 */
async function call(
  service: typeof serviceOn,
  person: string,
  threadId: string,
  effect: "write" | "read" = "write",
) {
  const action: ApprovalCandidate = {
    actorId: person,
    botId: bot,
    toolRef: effect === "read" ? "computer_read_file" : "computer_run_command",
    effect,
    scope: "workspace",
    args: { target: effect },
  };
  return as(person, () =>
    inThread(threadId, () => service.gate(action)).then(
      () => "ran",
      (error: unknown) => {
        if (error instanceof ApprovalRefusedError) return error.message;
        // The gate's ordinary answer to a change: the person is asked, as with no pilot at all.
        if (error instanceof HeadlessToolSuspension) return "asked";
        throw error;
      },
    ),
  );
}

const rowsOf = (person: string, threadId: string) =>
  as(person, () =>
    database
      .select()
      .from(workItems)
      .where(eq(workItems.kind, "person.question")),
  ).then((rows) =>
    rows.filter(
      (row) =>
        (row.payload as { threadId?: string; planApproval?: unknown })
          .threadId === threadId &&
        (row.payload as { planApproval?: unknown }).planApproval !== undefined,
    ),
  );

beforeAll(async () => {
  for (const id of [alice, bob])
    await runAsTenant(id, () =>
      database.insert(users).values({ id, email: `${id}@example.test` }),
    );
});

afterAll(async () => {
  for (const id of [alice, bob])
    await runAsTenant(id, async () => {
      await database
        .delete(workItems)
        .where(
          and(
            inArray(workItems.kind, ["person.question", "person.response"]),
            inArray(workItems.key, keys),
          ),
        );
      await database.delete(users).where(eq(users.id, id));
    });
  await database.$client.close();
});

describe("a long plan is put to its owner", () => {
  test("four steps go into the owner's inbox as a question that lists them", async () => {
    const thread = `${prefix}-t-inbox`;
    expect(await plan(alice, thread, steps(4))).toContain("请主人批准");
    const [row] = await rowsOf(alice, thread);
    expect(row?.payload).toMatchObject({
      actorId: alice,
      planApproval: { steps: 4 },
    });
    const inbox = await as(alice, () => serviceOn.inbox(alice));
    const listed = inbox.questions.find((question) => question.id === row?.key);
    expect(listed?.question).toContain("1. 第 1 步");
    expect(listed?.question).toContain("4. 第 4 步");
    expect(listed?.why).toContain("批准");
    // Nobody else's inbox has it.
    expect(
      (await as(bob, () => serviceOn.inbox(bob))).questions.some(
        (question) => question.id === row?.key,
      ),
    ).toBe(false);
  });

  test("three steps are not: nothing is put, nothing is held", async () => {
    const thread = `${prefix}-t-three`;
    expect(await plan(alice, thread, steps(3))).toBe(
      "已更新计划：3 项，完成 0 项",
    );
    expect(await rowsOf(alice, thread)).toHaveLength(0);
    expect(await call(serviceOn, alice, thread)).toBe("asked");
  });

  test("an employee that did not declare the pilot is not held on four", async () => {
    const thread = `${prefix}-t-undeclared`;
    expect(await plan(alice, thread, steps(4), false)).toBe(
      "已更新计划：4 项，完成 0 项",
    );
    expect(await rowsOf(alice, thread)).toHaveLength(0);
    expect(await call(serviceOn, alice, thread)).toBe("asked");
  });
});

describe("before the owner answers", () => {
  test("a change is refused and a read runs", async () => {
    const thread = `${prefix}-t-hold`;
    await plan(alice, thread, steps(4));
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
    // A read is not the hold's business: it goes on to the gate's ordinary answer.
    expect(await call(serviceOn, alice, thread, "read")).not.toBe(
      PLAN_NOT_APPROVED,
    );
    // Another conversation of the same person is not held by this one's plan.
    expect(await call(serviceOn, alice, `${prefix}-t-other`)).toBe("asked");
  });

  test("the same plan again is not put a second time", async () => {
    const thread = `${prefix}-t-twice`;
    await plan(alice, thread, steps(4));
    expect(await plan(alice, thread, steps(4))).toContain("还在等主人批准");
    expect(await rowsOf(alice, thread)).toHaveLength(1);
  });

  test("a subagent is not started: its own thread is not the one held", async () => {
    const thread = `${prefix}-t-sub`;
    await plan(alice, thread, steps(4));
    const subagents = createSubagents({
      turn: {} as never,
      buildAgentFor: async () => {
        throw new Error("no subagent should be built");
      },
      withdrawApprovals: async () => undefined,
      planPending: hold.pending,
    });
    const tool = subagents.toolForRun({
      actorId: alice,
      botId: bot,
      threadId: thread,
      runId: `run-${thread}`,
      initiator: { kind: "person" },
    });
    const answer = await as(alice, () =>
      tool.execute({ task: "查一下", answer: "一句话" }),
    );
    expect(answer).toContain("plan is not approved");
  });
});

describe("when the owner answers", () => {
  test("a yes lifts the hold and the work goes on", async () => {
    const thread = `${prefix}-t-yes`;
    await plan(alice, thread, steps(5));
    const [row] = await rowsOf(alice, thread);
    const answered = await respond(alice, row?.key ?? "", {
      response: "批准",
      inConversation: true,
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ id: row?.key, continueHere: true });
    expect(await call(serviceOn, alice, thread)).toBe("asked");
    // Ticking items afterwards is a plain update.
    expect(
      await plan(
        alice,
        thread,
        steps(5).map((item) => ({ ...item, status: "done" })),
      ),
    ).toBe("已更新计划：5 项，完成 5 项");
    expect(await rowsOf(alice, thread)).toHaveLength(1);
  });

  test("an opinion keeps the hold, comes back to the conversation as the answer, and a changed plan is put again", async () => {
    const thread = `${prefix}-t-opinion`;
    await plan(alice, thread, steps(4));
    const [first] = await rowsOf(alice, thread);
    // Answered away from the conversation, it is queued as the Bot's next turn with the words as written.
    const answered = await respond(alice, first?.key ?? "", {
      response: "第 3 步不要删文件",
    });
    expect(await answered.json()).toEqual({ id: first?.key, queued: true });
    const [queued] = await as(alice, () =>
      database
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.response"),
            eq(workItems.key, first?.key ?? ""),
          ),
        ),
    );
    expect(queued?.payload).toMatchObject({
      ownerUserId: alice,
      response: "第 3 步不要删文件",
    });
    // Still held: an opinion is not a yes.
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
    // The plan as it was is not put again; a changed one is, and a yes to it lifts the hold.
    expect(await plan(alice, thread, steps(4))).toContain("没获批准");
    expect(await rowsOf(alice, thread)).toHaveLength(1);
    expect(await plan(alice, thread, steps(4, "（不删文件）"))).toContain(
      "请主人批准",
    );
    const rows = await rowsOf(alice, thread);
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => row.key !== first?.key);
    await respond(alice, second?.key ?? "", {
      response: "批准。",
      inConversation: true,
    });
    expect(await call(serviceOn, alice, thread)).toBe("asked");
  });

  test("a plan put down without an answer stays unapproved", async () => {
    const thread = `${prefix}-t-dismiss`;
    await plan(alice, thread, steps(4));
    const [row] = await rowsOf(alice, thread);
    await as(alice, () => serviceOn.dismissQuestion(alice, row?.key ?? ""));
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
  });

  test("nobody else can approve it: not another person, and not in their frame", async () => {
    const thread = `${prefix}-t-owner`;
    await plan(alice, thread, steps(4));
    const [row] = await rowsOf(alice, thread);
    const refused = await respond(bob, row?.key ?? "", {
      response: "批准",
      inConversation: true,
    });
    expect(refused.status).toBe(404);
    // Still waiting, still held, and nothing was stamped on the row.
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
    const [after] = await rowsOf(alice, thread);
    expect(after?.finishedAt).toBeNull();
    expect(after?.payload).not.toHaveProperty("planDecision");
    // Bob's own conversation under the same thread id is not held by Alice's plan either way.
    expect(await call(serviceOn, bob, thread)).toBe("asked");
  });

  test("an answer to an ordinary question leaves its row as it was", async () => {
    const key = randomUUID();
    keys.push(key);
    await as(alice, () =>
      database.insert(workItems).values({
        kind: "person.question",
        key,
        payload: {
          actorId: alice,
          botId: bot,
          threadId: `${prefix}-t-plain`,
          runId: randomUUID(),
          question: "哪个城市？",
          mode: "completed_question",
        },
      }),
    );
    await respond(alice, key, { response: "批准", inConversation: true });
    const [row] = await as(alice, () =>
      database.select().from(workItems).where(eq(workItems.key, key)),
    );
    expect(row?.payload).not.toHaveProperty("planDecision");
  });
});

describe("with the switch off", () => {
  test("the gate holds nothing, whatever plan rows exist", async () => {
    const thread = `${prefix}-t-off`;
    await plan(alice, thread, steps(4));
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
    // The same rows, read by the gate as it is built without the pilot.
    expect(storeOff).not.toHaveProperty("planApprovalPending");
    expect(await call(serviceOff, alice, thread)).toBe("asked");
  });
});

describe("a thread held to reads", () => {
  test("refuses changes, lets reads run, and lets go when released", async () => {
    const thread = `${prefix}-t-review`;
    const release = restrictToReads(thread);
    expect(await call(serviceOff, alice, thread)).toBe(REVIEW_READ_ONLY);
    expect(await call(serviceOff, alice, thread, "read")).not.toBe(
      REVIEW_READ_ONLY,
    );
    release();
    expect(await call(serviceOff, alice, thread)).toBe("asked");
  });
});

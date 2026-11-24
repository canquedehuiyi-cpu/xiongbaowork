import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HeadlessToolSuspension } from "../../toolkit/src/headless-tools";
import { wireCoordination } from "../src/agents/coordination-wiring";
import {
  createPlanApproval,
  onlyDeclared,
  PLAN_NOT_APPROVED,
  PLAN_NOT_PUT,
  PLAN_SENT_BACK,
  planDigest,
  planQuestion as planQuestionOf,
  REVIEW_READ_ONLY,
} from "../src/agents/plan-approval";
import { createSubagents } from "../src/agents/subagent";
import { updatePlanTools } from "../src/agents/update-plan";
import { createPlanHold, PLAN_HOLD_KIND } from "../src/approvals/plan-hold";
import { createApprovalQuestions } from "../src/approvals/questions";
import {
  isReadOnlyThread,
  restrictToReads,
} from "../src/approvals/read-only-threads";
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

const hold = createPlanHold(database);
/** Built as the deployment builds it with the pilot on, and off. */
const storeOn = {
  ...createApprovalStore(database),
  planApprovalRefusal: (owner: string, threadId: string) =>
    hold.refusal(owner, threadId),
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
 * What the deployment's `ask` does for a plan: the real `routeQuestion` of `wireCoordination`, the
 * function `ask_person` is routed through, over the real database. What it never touches (the
 * roster, the channel store, delivery) is stood in for.
 */
const { routeQuestion } = wireCoordination({
  handoffDesk: {} as never,
  config: { handoff: {} } as never,
  approvalService: { gate: async () => undefined, store: {} } as never,
  agentProfileStore: { get: async () => null, list: async () => [] } as never,
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  channelSourceForRun: async () => null,
  database,
  pluginStore: {} as never,
  bootAuditStore: {} as never,
  peopleStore: {} as never,
  sourceForCoordinationRun: async () => ({
    channelId: `${prefix}-channel`,
    botId: bot,
  }),
  channelStore: { recordActivity: async () => undefined } as never,
  notify: async () => undefined,
});
const asker: Parameters<typeof createPlanApproval>[0]["ask"] = (input) =>
  routeQuestion(
    {
      actorId: input.actorId,
      botId: input.botId,
      threadId: input.threadId,
      runId: input.runId,
      question: input.question,
      why: input.why,
    },
    { planApproval: input.planApproval },
    input.key,
  );

/** The plan tool an employee holds under the pilot, for `person` and a declared (or not) employee. */
const planTool = (person: string, declared = true) => {
  const [tool] = updatePlanTools({
    approval: createPlanApproval({
      actorId: person,
      botId: bot,
      initiator: undefined,
      declared: async () => declared,
      latest: (owner, threadId) => hold.latest(owner, threadId),
      hold: hold.fail,
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
      .where(inArray(workItems.kind, ["person.question", PLAN_HOLD_KIND])),
  ).then((rows) =>
    rows
      .filter(
        (row) =>
          (row.payload as { threadId?: string; planApproval?: unknown })
            .threadId === threadId &&
          (row.payload as { planApproval?: unknown }).planApproval !==
            undefined,
      )
      // Oldest first, so the newest is `.at(-1)`.
      .sort(
        (one, other) => one.createdAt.getTime() - other.createdAt.getTime(),
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
          inArray(workItems.kind, [
            "person.question",
            "person.response",
            PLAN_HOLD_KIND,
          ]),
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
      planRefusal: (owner: string, threadId: string) =>
        hold.refusal(owner, threadId),
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
    expect(answer).toContain(PLAN_NOT_APPROVED);
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
    // Still held: an opinion is not a yes, and the model is told to rewrite, not to wait.
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_SENT_BACK);
    // The plan as it was is not put again; a changed one is, and a yes to it lifts the hold.
    expect(await plan(alice, thread, steps(4))).toContain(PLAN_SENT_BACK);
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
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_SENT_BACK);
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

describe("a plan that is not really put holds changes all the same", () => {
  test("a question of the same words asked first with ask_person does not stand for the plan", async () => {
    const thread = `${prefix}-t-collide`;
    const items = steps(4);
    // The row ask_person would save for the very words the plan is put in, under its own key.
    const { question } = planQuestionOf(items);
    const runId = `run-${thread}`;
    const key = createHash("sha256")
      .update(JSON.stringify([alice, bot, runId, question]))
      .digest("hex");
    await as(alice, () =>
      database.insert(workItems).values({
        kind: "person.question",
        key,
        payload: {
          actorId: alice,
          botId: bot,
          threadId: thread,
          runId,
          question,
          mode: "completed_question",
        },
      }),
    );
    expect(await plan(alice, thread, items)).toContain("请主人批准");
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
    // And a yes to the plain question stamps nothing that lifts the hold.
    await respond(alice, key, { response: "批准", inConversation: true });
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
  });

  test("a row on the plan's own key that is not that conversation's plan is a failure, held and said", async () => {
    const thread = `${prefix}-t-foreign`;
    const items = steps(4);
    const digest = planDigest(items);
    const key = `plan-approval:${createHash("sha256")
      .update(JSON.stringify([alice, thread, digest, ""]))
      .digest("hex")}`;
    await as(alice, () =>
      database.insert(workItems).values({
        kind: "person.question",
        key,
        payload: { actorId: alice, botId: bot, threadId: "somewhere-else" },
      }),
    );
    const logged = console.warn;
    console.warn = () => undefined;
    try {
      expect(await plan(alice, thread, items)).toContain(PLAN_NOT_PUT);
    } finally {
      console.warn = logged;
    }
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_PUT);
    // Nothing is waiting on an answer, so a plan put again is tried afresh (here, on a changed plan).
    expect(await plan(alice, thread, steps(4, "（改）"))).toContain(
      "请主人批准",
    );
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
  });

  test("a plan nobody can be asked about (no source conversation) is held, not let through", async () => {
    const thread = `${prefix}-t-nosource`;
    const refused = createPlanApproval({
      actorId: alice,
      botId: bot,
      initiator: undefined,
      declared: async () => true,
      latest: (owner, threadId) => hold.latest(owner, threadId),
      hold: hold.fail,
      ask: async () => ({
        refusal: "That question could not reach its source conversation.",
      }),
    });
    const [tool] = updatePlanTools({ approval: refused });
    const logged = console.warn;
    console.warn = () => undefined;
    try {
      expect(
        await as(alice, () =>
          inThread(
            thread,
            () => tool?.execute({ items: steps(5) }) as Promise<string>,
          ),
        ),
      ).toContain(PLAN_NOT_PUT);
    } finally {
      console.warn = logged;
    }
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_PUT);
  });
});

describe("the hold belongs to the person the plan was put to", () => {
  test("a plan row of somebody else on the same thread holds nothing, with row-level security out of the way", async () => {
    const thread = `${prefix}-t-actor`;
    // The platform frame reads every tenant's rows, so only the actor condition can tell them apart.
    const rowKey = `plan-approval:${randomUUID()}`;
    await runAsTenant("platform", async () => {
      await database.insert(workItems).values({
        kind: "person.question",
        key: rowKey,
        payload: {
          actorId: bob,
          botId: bot,
          threadId: thread,
          runId: "r",
          question: "q",
          mode: "completed_question",
          planApproval: { digest: "d", steps: 4 },
        },
      });
      expect(await hold.pending(alice, thread)).toBe(false);
      expect(await hold.pending(bob, thread)).toBe(true);
      await database.delete(workItems).where(eq(workItems.key, rowKey));
    });
  });
});

describe("an employee that did not declare the pilot, with the switch on", () => {
  test("is held by nothing and its gate reads nothing about plans", async () => {
    const thread = `${prefix}-t-nodecl`;
    // A plan row exists for the thread (the person's other, declared employee put it), yet this one is free.
    await plan(alice, thread, steps(4));
    let reads = 0;
    const refusalFor = onlyDeclared<[string], string | undefined>(
      async () => false,
      undefined,
      async (owner, threadId) => {
        reads += 1;
        return hold.refusal(owner, threadId);
      },
    );
    // As the deployment adapts it: the store's (owner, thread, bot) onto the check's (owner, bot, thread).
    const gated = createApprovalService({
      ...createApprovalStore(database),
      planApprovalRefusal: (owner: string, threadId: string, botId: string) =>
        refusalFor(owner, botId, threadId),
    });
    const candidate: ApprovalCandidate = {
      actorId: alice,
      botId: bot,
      toolRef: "computer_run_command",
      effect: "write",
      scope: "workspace",
      args: { target: "write" },
    };
    const outcome = await as(alice, () =>
      inThread(thread, () => gated.gate(candidate)).then(
        () => "ran",
        (error: unknown) =>
          error instanceof ApprovalRefusedError ? error.message : "asked",
      ),
    );
    expect(outcome).not.toBe(PLAN_NOT_APPROVED);
    expect(reads).toBe(0);
  });
});

describe("the reviewer's thread", () => {
  /** A subagent run that stops at once, noting whether its thread was held to reads while it ran. */
  async function readOnlyDuring(readOnly: boolean) {
    const seen: boolean[] = [];
    const subagents = createSubagents({
      turn: {} as never,
      buildAgentFor: async () => {
        throw new Error("stop");
      },
      withdrawApprovals: async () => undefined,
      models: {
        allowed: async () => ["m"],
        hardModelOf: async () => undefined,
        // Called with the run's thread before the run, and its undo after: both see the registration.
        pin: (threadId: string) => {
          seen.push(isReadOnlyThread(threadId));
          return () => {
            seen.push(isReadOnlyThread(threadId));
          };
        },
      },
    });
    const tool = subagents.toolForRun(
      {
        actorId: alice,
        botId: bot,
        threadId: `${prefix}-t-parent`,
        runId: "run-parent",
        initiator: { kind: "person" },
      },
      { readOnly },
    );
    await as(alice, () =>
      tool.execute(
        { task: "评审", answer: "意见", model: "m" },
        { toolCallId: `c-${randomUUID()}` },
      ),
    );
    return seen;
  }

  test("is held to reads for as long as the run lasts, and let go after", async () => {
    const seen = await readOnlyDuring(true);
    // The undo ran inside `finally`, before the release: the thread was still held then.
    expect(seen).toEqual([false, true]);
  });

  test("an ordinary subagent's thread is not", async () => {
    expect(await readOnlyDuring(false)).toEqual([false, false]);
  });
});

describe("a subagent is refused in the gate's own words", () => {
  test("waiting, sent back and not put each read the same as a change in the thread does", async () => {
    const subagents = createSubagents({
      turn: {} as never,
      buildAgentFor: async () => {
        throw new Error("no subagent should be built");
      },
      withdrawApprovals: async () => undefined,
      planRefusal: (owner: string, threadId: string) =>
        hold.refusal(owner, threadId),
    });
    const refusedIn = async (thread: string) =>
      as(alice, () =>
        subagents
          .toolForRun({
            actorId: alice,
            botId: bot,
            threadId: thread,
            runId: `run-${thread}`,
            initiator: { kind: "person" },
          })
          .execute({ task: "查", answer: "一句" }),
      );
    const thread = `${prefix}-t-words`;
    await plan(alice, thread, steps(4));
    expect(await refusedIn(thread)).toContain(
      await call(serviceOn, alice, thread),
    );
    const [row] = await rowsOf(alice, thread);
    await respond(alice, row?.key ?? "", {
      response: "改一下",
      inConversation: true,
    });
    expect(await refusedIn(thread)).toContain(PLAN_SENT_BACK);
    await as(alice, () =>
      hold.fail({ actorId: alice, threadId: thread, digest: "d" }),
    );
    expect(await refusedIn(thread)).toContain(PLAN_NOT_PUT);
  });
});

describe("going back to a plan that was sent back", () => {
  test("a plan put again after others were answered is a new row, waiting, and the model is told so", async () => {
    const thread = `${prefix}-t-back`;
    const answerLast = async (response: string) => {
      const rows = (await rowsOf(alice, thread)).filter(
        (row) => row.kind === "person.question",
      );
      const last = rows.at(-1);
      await respond(alice, last?.key ?? "", { response, inConversation: true });
    };
    const a = steps(4, "（甲）");
    const b = steps(4, "（乙）");
    expect(await plan(alice, thread, a)).toContain("请主人批准");
    await answerLast("改一下");
    expect(await plan(alice, thread, b)).toContain("请主人批准");
    await answerLast("还是用第一版");
    // The first plan again: its old row is long answered, so what is put is a row of its own.
    expect(await plan(alice, thread, a)).toContain("请主人批准");
    const rows = (await rowsOf(alice, thread)).filter(
      (row) => row.kind === "person.question",
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.at(-1)?.finishedAt).toBeNull();
    const inbox = await as(alice, () => serviceOn.inbox(alice));
    expect(
      inbox.questions.filter((question) =>
        rows.some((row) => row.key === question.id),
      ),
    ).toHaveLength(1);
    // The gate and the model say the same thing: waiting.
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
    // And a yes to that row lifts the hold.
    await answerLast("批准");
    expect(await call(serviceOn, alice, thread)).toBe("asked");
  });

  test("an answered row on the plan's own key is not taken for a plan put", async () => {
    // What the key could still meet: a row of this conversation's plan that is already answered.
    const thread = `${prefix}-t-answered`;
    const items = steps(4);
    expect(await plan(alice, thread, items)).toContain("请主人批准");
    const [row] = await rowsOf(alice, thread);
    await respond(alice, row?.key ?? "", {
      response: "批准",
      inConversation: true,
    });
    const again = await as(alice, () =>
      routeQuestion(
        {
          actorId: alice,
          botId: bot,
          threadId: thread,
          runId: "r",
          question: "同一份",
        },
        { planApproval: { digest: "d", steps: 4 } },
        row?.key,
      ),
    );
    expect(again).toEqual({
      refusal: "The plan could not be saved for its person.",
    });
  });
});

describe("words the database refuses, written into a plan", () => {
  test("a NUL in a step is dropped, the plan is put, and the gate holds as for any plan", async () => {
    const thread = `${prefix}-t-nul`;
    expect(await plan(alice, thread, steps(4, "\u0000"))).toContain(
      "请主人批准",
    );
    const [row] = await rowsOf(alice, thread);
    expect(JSON.stringify(row?.payload)).not.toContain("\\u0000");
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_APPROVED);
  });

  test("a plan whose row the database refuses anyway is held as not put, never let through", async () => {
    const thread = `${prefix}-t-refused`;
    const broken = updatePlanTools({
      approval: createPlanApproval({
        actorId: alice,
        botId: bot,
        initiator: undefined,
        declared: async () => true,
        latest: (owner, threadId) => hold.latest(owner, threadId),
        hold: hold.fail,
        ask: async () => {
          throw new Error("unsupported Unicode escape sequence");
        },
      }),
    })[0];
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(
        await as(alice, () =>
          inThread(
            thread,
            () => broken?.execute({ items: steps(4) }) as Promise<string>,
          ),
        ),
      ).toContain(PLAN_NOT_PUT);
    } finally {
      console.warn = warn;
    }
    expect(await call(serviceOn, alice, thread)).toBe(PLAN_NOT_PUT);
  });

  test("when not even the hold row can be written, the conversation is held from memory until a plan row is newer", async () => {
    const thread = `${prefix}-t-memory`;
    let failInsert = true;
    const flaky = new Proxy(database, {
      get(target, property) {
        if (property === "insert" && failInsert)
          return () => {
            throw new Error("down");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const memoryHold = createPlanHold(flaky);
    const logged = console.error;
    console.error = () => undefined;
    try {
      await as(alice, () =>
        memoryHold.fail({ actorId: alice, threadId: thread, digest: "d" }),
      );
    } finally {
      console.error = logged;
    }
    expect(await as(alice, () => memoryHold.refusal(alice, thread))).toBe(
      PLAN_NOT_PUT,
    );
    // A plan put afterwards is a row newer than the mark, and takes over.
    failInsert = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await plan(alice, thread, steps(4))).toContain("请主人批准");
    expect(await as(alice, () => memoryHold.refusal(alice, thread))).toBe(
      PLAN_NOT_APPROVED,
    );
  });
});

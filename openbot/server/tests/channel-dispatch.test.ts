import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  CHANNEL_DISPATCH_KIND,
  type ChannelDispatchDeps,
  createChannelDispatch,
  createChannelDispatchRoutes,
  type DispatchChannel,
  dispatchRunId,
} from "../src/channels/dispatch";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { QuotaExceeded } from "../src/quota/limits";
import type { TurnRunner } from "../src/routines/runner";
import { DISPATCH_LEDGER_KIND } from "../src/tasks/reclaim";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import type { WorkItem } from "../src/work/queue";

/**
 * Spec B2/B3 with every collaborator faked: no database, no model.
 *
 * What a person sees is decided here — which card is opened, for whom, with which executor; which
 * coworker the turn runs as and on which thread; where the answer is said; and how the card moves when
 * the turn answers, stops to ask, or fails. The PostgreSQL half (RLS, real tenants, the restart sweep)
 * is `channel-dispatch.integration.test.ts`.
 */

const OWNER: AgentActor = { id: "owner-1", role: "user" };
const CHANNEL: DispatchChannel = {
  id: "channel-1",
  threadId: "thread-1",
  agentIds: ["pinned"],
};

type Card = {
  tenantId: string;
  title: string;
  executorAgentId?: string | null;
  source: string;
  channelRef?: string;
  runRef?: string;
  status: string;
  approvalId?: string;
};

function harness(
  options: {
    channel?: DispatchChannel | null;
    bots?: Record<string, string>;
    runTurn?: TurnRunner;
    quotaFull?: boolean;
  } = {},
) {
  const items = new Map<string, WorkItem & { finished: boolean }>();
  const cards = new Map<string, Card>();
  const said: { channelId: string; pinnedAgentId: string; text: string }[] = [];
  const busy: [string, boolean][] = [];
  const turns: (Parameters<TurnRunner>[0] & { tenant: string })[] = [];
  const bots = options.bots ?? { pinned: "小熊", reviewer: "阿审" };

  const deps: ChannelDispatchDeps = {
    owner: "replica-1",
    queue: {
      async offer({ kind, key, payload = {} }) {
        if (items.has(key)) return "already";
        // The request's frame is the tenant the row is stamped with, as the column default does.
        items.set(key, {
          kind,
          key,
          tenantId: currentTenant(),
          payload,
          attempts: 0,
          finished: false,
        });
        return "queued";
      },
      async claim({ kind, maxAttempts = 5 }) {
        for (const item of items.values()) {
          if (item.kind !== kind || item.finished) continue;
          if (item.attempts >= maxAttempts) continue;
          item.attempts += 1;
          return [{ ...item }];
        }
        return [];
      },
      async finish({ key }) {
        const item = items.get(key);
        if (!item) return false;
        item.finished = true;
        return true;
      },
    },
    board: {
      async opened(input) {
        const existing = [...cards.entries()].find(
          ([, card]) => card.runRef === input.runRef,
        );
        if (existing) return existing[0];
        if (options.quotaFull)
          throw new QuotaExceeded("tasksPerMonth", 50, 50, "free");
        const id = `task-${cards.size + 1}`;
        cards.set(id, { ...input, status: "running" });
        return id;
      },
      async finished(input) {
        for (const card of cards.values()) {
          if (card.runRef !== input.runRef || card.tenantId !== input.tenantId)
            continue;
          if (
            input.onlyUnsettled &&
            !["running", "needs_action"].includes(card.status)
          )
            continue;
          card.status = input.failed ? "failed" : "awaiting_review";
        }
      },
      async needsAction(input) {
        for (const card of cards.values()) {
          if (card.runRef !== input.runRef) continue;
          card.status = "needs_action";
          card.approvalId = input.approvalId;
        }
      },
    },
    channel: async (actor, channelId) =>
      actor.id === OWNER.id && channelId === CHANNEL.id
        ? options.channel === undefined
          ? CHANNEL
          : options.channel
        : null,
    bot: async (actor, agentId) => {
      const name = bots[agentId];
      return actor.id === OWNER.id && name ? { id: agentId, name } : null;
    },
    actorFor: async (id) => ({ id, role: "user" }),
    runTurn:
      options.runTurn ?? (async () => ({ replyText: "合同第三条有风险。" })),
    activity: async ({ channelId, pinnedAgentId, text }) => {
      said.push({ channelId, pinnedAgentId, text });
    },
    busy: async (threadId, value) => {
      busy.push([threadId, value]);
    },
  };
  const inner = deps.runTurn;
  deps.runTurn = async (input) => {
    turns.push({ ...input, tenant: currentTenant() });
    return inner(input);
  };
  return {
    service: createChannelDispatch(deps),
    items,
    cards,
    said,
    busy,
    turns,
  };
}

const submit = (
  service: ReturnType<typeof harness>["service"],
  body: unknown,
  actor: AgentActor = OWNER,
  channelId = CHANNEL.id,
) => runAsTenant(actor.id, () => service.submit(actor, channelId, body));

test("the dispatch ledger kind is the one the restart sweep reads", () => {
  expect(CHANNEL_DISPATCH_KIND).toBe("channel.dispatch");
  expect(CHANNEL_DISPATCH_KIND).toBe(DISPATCH_LEDGER_KIND);
});

test("a dispatch queues the work and opens a chat card whose executor is the coworker named", async () => {
  const { service, items, cards } = harness();

  const accepted = await submit(service, {
    id: "m1",
    agentId: "reviewer",
    text: "@阿审 帮我审一下这份合同",
  });

  const runId = dispatchRunId(OWNER.id, CHANNEL.id, "m1");
  expect(accepted).toEqual({ taskId: "task-1", runId, queued: true });
  expect(cards.get("task-1")).toMatchObject({
    tenantId: OWNER.id,
    source: "chat",
    executorAgentId: "reviewer",
    channelRef: CHANNEL.id,
    runRef: runId,
    status: "running",
    title: "@阿审 帮我审一下这份合同",
  });
  const item = items.get(runId);
  expect(item?.kind).toBe("channel.dispatch");
  expect(item?.tenantId).toBe(OWNER.id);
  expect(item?.payload).toEqual({
    ownerUserId: OWNER.id,
    channelId: CHANNEL.id,
    agentId: "reviewer",
    text: "@阿审 帮我审一下这份合同",
    messageId: "m1",
  });
});

test("the same message sent twice is one piece of work and one card", async () => {
  const { service, items, cards } = harness();
  const body = { id: "m1", agentId: "reviewer", text: "@阿审 看一下" };

  const first = await submit(service, body);
  const second = await submit(service, body);

  expect(second.taskId).toBe(first.taskId);
  expect(second.runId).toBe(first.runId);
  expect(second.queued).toBe(false);
  expect(items.size).toBe(1);
  expect(cards.size).toBe(1);
});

test("a run id is the caller's, the channel's and the message's together", () => {
  const base = dispatchRunId("a", "c", "m");
  expect(base).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(dispatchRunId("a", "c", "m")).toBe(base);
  expect(dispatchRunId("b", "c", "m")).not.toBe(base);
  expect(dispatchRunId("a", "d", "m")).not.toBe(base);
  expect(dispatchRunId("a", "c", "n")).not.toBe(base);
});

test("a non-member, an unusable coworker and a group conversation are refused with nothing written", async () => {
  const stranger: AgentActor = { id: "stranger", role: "user" };
  const { service, items, cards } = harness();
  await expect(
    submit(service, { id: "m1", agentId: "reviewer", text: "x" }, stranger),
  ).rejects.toThrow("找不到");
  await expect(
    submit(service, { id: "m2", agentId: "someone-elses", text: "x" }),
  ).rejects.toThrow("找不到");

  const group = harness({
    channel: { ...CHANNEL, agentIds: ["pinned", "reviewer"] },
  });
  await expect(
    submit(group.service, { id: "m3", agentId: "reviewer", text: "x" }),
  ).rejects.toThrow("群组");

  expect(items.size).toBe(0);
  expect(cards.size).toBe(0);
  expect(group.items.size).toBe(0);
});

test("the worker runs the coworker named, on the channel's thread, in the claimed item's tenant", async () => {
  const { service, items, cards, said, busy, turns } = harness();
  const { runId, taskId } = await submit(service, {
    id: "m1",
    agentId: "reviewer",
    text: "@阿审 帮我审一下这份合同",
  });

  // A timer's frame, as `repeatAfterEach` gives every loop.
  expect(await runAsTenant("platform", () => service.sweep())).toBe(true);

  expect(turns).toHaveLength(1);
  const [turn] = turns;
  expect(turn?.tenant).toBe(OWNER.id);
  expect(turn?.ownerUserId).toBe(OWNER.id);
  expect(turn?.agentId).toBe("reviewer");
  expect(turn?.threadId).toBe(CHANNEL.threadId);
  expect(turn?.runId).toBe(runId);
  expect(turn?.cardOwnedByCaller).toBe(true);
  expect(turn?.initiator).toEqual({ kind: "person" });
  // The persisted user line is the person's own words, @Name included, so the transcript reads true.
  expect(turn?.userMessage).toMatchObject({
    role: "user",
    content: "@阿审 帮我审一下这份合同",
  });

  expect(cards.get(taskId)?.status).toBe("awaiting_review");
  expect(cards.size).toBe(1);
  expect(said).toEqual([
    {
      channelId: CHANNEL.id,
      pinnedAgentId: "pinned",
      text: "阿审：合同第三条有风险。",
    },
  ]);
  expect(busy).toEqual([
    [CHANNEL.threadId, true],
    [CHANNEL.threadId, false],
  ]);
  expect(items.get(runId)?.finished).toBe(true);
  // Handed out once and finished: nothing is left to claim, and nothing is replayed.
  expect(await service.sweep()).toBe(false);
});

test("a turn that stops for an approval parks the card in 需要操作", async () => {
  const { service, cards, said } = harness({
    runTurn: async () => {
      // The runtime's own sentence, as `approvals/service.ts` throws it: English, for the transcript.
      throw new HeadlessToolSuspension(
        "This action is waiting for your approval.",
        {
          kind: "approval",
          approvalId: "approval-1",
        },
      );
    },
  });
  const { taskId } = await submit(service, {
    id: "m1",
    agentId: "reviewer",
    text: "@阿审 付款",
  });
  await service.sweep();
  expect(cards.get(taskId)).toMatchObject({
    status: "needs_action",
    approvalId: "approval-1",
  });
  // The roster line is the product's own Chinese, never the runtime's English.
  expect(said.map((line) => line.text)).toEqual([
    '阿审 在等你批准，请到"需要操作"里处理。',
  ]);
});

test("a durable wait with no approval goes to the review lane, not to failure", async () => {
  const { service, cards, said } = harness({
    runTurn: async () => {
      throw new HeadlessToolSuspension("等电脑上线。", {
        kind: "computer",
        requestId: "r1",
      });
    },
  });
  const { taskId } = await submit(service, {
    id: "m1",
    agentId: "reviewer",
    text: "@阿审 截图",
  });
  await service.sweep();
  expect(cards.get(taskId)?.status).toBe("awaiting_review");
  expect(said.map((line) => line.text)).toEqual([
    "阿审 在等你处理一件事，请到任务看板查看。",
  ]);
});

test("a failed turn closes the card as failed and says so in the channel", async () => {
  const { service, cards, said, items } = harness({
    runTurn: async () => {
      throw new Error("模型不可用");
    },
  });
  const { taskId, runId } = await submit(service, {
    id: "m1",
    agentId: "reviewer",
    text: "@阿审 看看",
  });
  await service.sweep();
  expect(cards.get(taskId)?.status).toBe("failed");
  expect(said.map((line) => line.text)).toEqual([
    "阿审 没有完成这次任务：模型不可用",
  ]);
  expect(items.get(runId)?.finished).toBe(true);
});

test("an item whose payload names somebody other than its own tenant is not run", async () => {
  const { service, items, turns } = harness();
  await submit(service, { id: "m1", agentId: "reviewer", text: "x" });
  const [item] = [...items.values()];
  if (!item) throw new Error("expected an item");
  // Stamped with another tenant than the one the payload claims: the stamp wins, and nothing runs.
  item.tenantId = "someone-else";
  await service.sweep();
  expect(turns).toHaveLength(0);
  expect(item.finished).toBe(true);
});

test("a person who left the conversation before the turn ran gets no turn and a failed card", async () => {
  const live = harness();
  const { taskId } = await submit(live.service, {
    id: "m1",
    agentId: "reviewer",
    text: "x",
  });
  // The same rows, read again by a worker whose channel lookup now says "not a member".
  const gone = harness({ channel: null });
  for (const [key, value] of live.items) gone.items.set(key, value);
  for (const [key, value] of live.cards) gone.cards.set(key, value);
  await gone.service.sweep();
  expect(gone.turns).toHaveLength(0);
  expect(gone.cards.get(taskId)?.status).toBe("failed");
});

test("over the month's ceiling: 402 at the door, and the queued item never runs", async () => {
  const { service, turns, items } = harness({ quotaFull: true });
  const routes = new Hono<{ Variables: AppVariables }>().route(
    "/api/channels",
    createChannelDispatchRoutes(service, async (context, next) => {
      context.set("actor", { ...OWNER, email: "owner@example.test" });
      await runAsTenant(OWNER.id, () => next());
    }),
  );
  const response = await routes.request(
    `/api/channels/${CHANNEL.id}/dispatch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m1", agentId: "reviewer", text: "x" }),
    },
  );
  expect(response.status).toBe(402);
  expect(((await response.json()) as { code: string }).code).toBe(
    "quota_exceeded",
  );
  await service.sweep();
  expect(turns).toHaveLength(0);
  expect([...items.values()].every((item) => item.finished)).toBe(true);
});

test("the route answers 202, 404, 400 as the story needs", async () => {
  const { service } = harness();
  const as = (actor: AgentActor) =>
    new Hono<{ Variables: AppVariables }>().route(
      "/api/channels",
      createChannelDispatchRoutes(service, async (context, next) => {
        context.set("actor", { ...actor, email: `${actor.id}@example.test` });
        await runAsTenant(actor.id, () => next());
      }),
    );
  const post = (actor: AgentActor, channelId: string, body: unknown) =>
    as(actor).request(`/api/channels/${channelId}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const accepted = await post(OWNER, CHANNEL.id, {
    id: "m1",
    agentId: "reviewer",
    text: "@阿审 看看",
  });
  expect(accepted.status).toBe(202);
  expect(
    ((await accepted.json()) as { taskId: string; queued: boolean }).queued,
  ).toBe(true);

  expect(
    (
      await post({ id: "stranger", role: "user" }, CHANNEL.id, {
        id: "m2",
        agentId: "reviewer",
        text: "x",
      })
    ).status,
  ).toBe(404);
  expect(
    (await post(OWNER, CHANNEL.id, { id: "m3", agentId: "nobody", text: "x" }))
      .status,
  ).toBe(404);
  expect(
    (await post(OWNER, CHANNEL.id, { id: "m4", agentId: "reviewer" })).status,
  ).toBe(400);
  expect(
    (
      await post(OWNER, CHANNEL.id, {
        id: "m5",
        agentId: "reviewer",
        text: "x",
        extra: true,
      })
    ).status,
  ).toBe(400);
});

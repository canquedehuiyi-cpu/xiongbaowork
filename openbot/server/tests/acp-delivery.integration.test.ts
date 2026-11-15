import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  ACP_DELIVERY_LATE_NOTE,
  createAcpGroupTurn,
  createAcpTurnStarter,
  DeviceAcpAgent,
  type DeviceAcpEmployee,
} from "../src/agents/acp/agent";
import {
  type AcpDelivery,
  cancelExternalTurns,
  createAcpDelivery,
  extensionSaidIn,
  externalProtocol,
  externalTurnWaiting,
} from "../src/agents/acp/delivery";
import {
  CHANNEL_DISPATCH_KIND,
  channelDispatched,
  createChannelDispatch,
} from "../src/channels/dispatch";
import { isExternalEmployee } from "../src/agents/acp/external";
import { createAcpRelay } from "../src/agents/acp/relay";
import { type AcpTurnRow, createAcpTurnStore } from "../src/agents/acp/turns";
import { configureBotLifecycle } from "../src/agents/lifecycle";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import {
  acpTurns,
  agentProfiles,
  agents,
  tasks,
  threadRunEvents,
  threadRuns,
  threads,
  usageCounters,
  users,
  workItems,
} from "../src/db/schema";
import { createQuotaService } from "../src/quota/limits";
import { createTurnRunner } from "../src/routines/run-turn";
import { createCardTurns } from "../src/tasks/card-turns";
import { createDelivery, stageOf } from "../src/tasks/delivery";
import {
  type DeliveryNotice,
  runDeliveryCheck,
  threadRunning,
} from "../src/tasks/delivery-checker";
import {
  deliveryProtocol,
  EXTERNAL_DELIVERY_GUIDE,
} from "../src/tasks/delivery-tools";
import { dueSaidIn } from "../src/tasks/due-time";
import { listTaskEvents } from "../src/tasks/events";
import { createEvidenceGate } from "../src/tasks/evidence-gate";
import { createNudgeRuns, handoverText } from "../src/tasks/nudge-run";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工按交付规约走三步（spec 2026-11-15-delivery-loop §1、§9）：外部员工调不了熊宝的工具，由服务器替它走。
 * 只有派给它的活进三步（在群里派任务、在一对一对话里用 @ 派活、你点「当作一件活来跟」），在它自己的单聊里
 * 一问一答照普通对话走。派给它的活排队即「派出 · 待接下」，轮次开始即接下，第一轮的提示前加四条规约（每张卡一次），回复里第一次出现的
 * 「预计 HH:MM / N 分钟」记作预计时间，结束时有改动汇总就当交付物过证据门，没有就留在「已接下」并说一句
 * 「它没交东西」；取消卡片连排队的轮次一起取消。
 *
 * 服务器这一侧都是真的：PostgresAgentRunner、看板投影、交付闭环、证据门、relay、数据库里的轮次存储、
 * DeviceAcpAgent；电脑那一侧是测试自己按剧本回帧。
 */

type Frame = Record<string, unknown>;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const quota = createQuotaService(database);
const projector = createTaskProjector(database, undefined, quota);
const delivery = createDelivery(database);
const gate = createEvidenceGate(database);
const turns = createAcpTurnStore(database);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const suite = randomUUID().slice(0, 8);
const tenants: string[] = [];
const hired: string[] = [];
configureBotLifecycle({ database });
/** The tools an external employee does not hold, which nothing it is told may name. */
const TOOL_NAMES = /accept_task|deliver_task|request_extension/;
/** 2026-11-16 10:00 in Shanghai: the clock the server reads 「预计」 on. */
const NOW = new Date("2026-11-16T02:00:00.000Z");

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await settle(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterAll(async () => {
  for (const id of tenants) {
    await runAsTenant(id, async () => {
      await database.delete(acpTurns).where(eq(acpTurns.tenantId, id));
      await database
        .delete(threadRunEvents)
        .where(eq(threadRunEvents.tenantId, id));
      await database.delete(threadRuns).where(eq(threadRuns.tenantId, id));
      await database.delete(threads).where(eq(threads.tenantId, id));
      await database.delete(tasks).where(eq(tasks.tenantId, id));
      await database
        .delete(usageCounters)
        .where(eq(usageCounters.tenantId, id));
    });
  }
  await runAsTenant("platform", async () => {
    await database
      .delete(workItems)
      .where(inArray(workItems.tenantId, tenants));
    if (hired.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, hired));
      await database.delete(agents).where(inArray(agents.id, hired));
    }
  });
  // `task_events` is append-only for the application role; its rows stay, under tenants nobody has.
  await runAsTenant("platform", () =>
    database.delete(users).where(inArray(users.id, tenants)),
  );
  await database.$client.close();
});

/** A hirer with an external employee on a computer, and the server that runs it. */
async function harness(
  options: {
    /** Stands in for the delivery loop's end hook (a slow one, say). */
    ended?: AcpDelivery["ended"];
    deliverySettleMs?: number;
  } = {},
) {
  const tenantId = `acpdl-${suite}-${randomUUID().slice(0, 8)}`;
  await runAsTenant(tenantId, () =>
    database
      .insert(users)
      .values({ id: tenantId, email: `${tenantId}@example.test` }),
  );
  tenants.push(tenantId);
  // Hired from a computer, as the hiring flow leaves it: a `device_acp` Bot of this person's.
  const profile = await runAsTenant(tenantId, () =>
    profiles.create(
      { id: tenantId, role: "user" },
      {
        name: "小码",
        title: "Coder",
        roleDescription: "Fix things.",
        visibility: "private",
      },
    ),
  );
  hired.push(profile.id);
  await runAsTenant("platform", () =>
    database
      .update(agents)
      .set({
        type: "device_acp",
        configuration: {
          deviceId: "laptop",
          harness: "codex",
          workdirRef: "fld_work",
        },
      })
      .where(eq(agents.id, profile.id)),
  );
  const agentId = profile.id;
  const employee: DeviceAcpEmployee = {
    id: agentId,
    name: "小码",
    ownerUserId: tenantId,
    deviceId: "laptop",
    harness: "codex",
    workdirRef: "fld_work",
    persona: "",
  };
  const down: Frame[] = [];
  const state = { reachable: true };
  const target = { tenantId, deviceId: "laptop" };
  let starter: ReturnType<typeof createAcpTurnStarter> | undefined;
  const relay = createAcpRelay({
    channel: {
      notify: (_target, frame) => {
        if (!state.reachable) return false;
        down.push(frame);
        return true;
      },
      isReachable: () => state.reachable,
      connectionOf: () => "conn-1",
    },
    turns,
    startQueuedTurn: async (row) => {
      if (!starter) throw new Error("not yet");
      await starter(row);
    },
    log: () => undefined,
  });
  const realDelivery = createAcpDelivery({
    delivery,
    gate,
    dispatched: channelDispatched(database),
    timeZone: async () => "Asia/Shanghai",
    now: () => NOW,
    log: () => undefined,
  });
  const acpDelivery: AcpDelivery = options.ended
    ? { ...realDelivery, ended: options.ended }
    : realDelivery;
  const runner = new PostgresAgentRunner(database, projector, quota);
  const agentOf = (claimed?: AcpTurnRow) =>
    new DeviceAcpAgent({
      agentId,
      ownerUserId: tenantId,
      tenantId,
      deviceId: "laptop",
      harness: "codex",
      workdirRef: "fld_work",
      name: "小码",
      relay,
      turns,
      reachable: () => state.reachable,
      context: async () => [],
      every: () => () => undefined,
      delivery: acpDelivery,
      ...(options.deliverySettleMs
        ? { deliverySettleMs: options.deliverySettleMs }
        : {}),
      ...(claimed ? { claimed } : {}),
      log: () => undefined,
    });
  starter = createAcpTurnStarter({
    database,
    turns,
    runner,
    employeeFor: async () => employee,
    agentFor: (_employee, row) => agentOf(row),
    log: () => undefined,
  });
  const from = { ...target, connectionId: "conn-1" };
  const device = async (frame: Frame) => {
    relay.fromRunner(from, { agentId, ...frame });
    await relay.drain(from);
  };

  /**
   * The person says `text` in `threadId`; resolves with the run's id and, once it ends, its events.
   * `dispatched`: the run is a 派活's (`POST /api/channels/:id/dispatch`), which files its run in the
   * dispatch ledger before anything runs -- written here as the dispatch worker leaves it once it took
   * the item (finished), so no sweep in this file can take it again. The test of the dispatch itself,
   * below, goes through the real route's service end to end.
   */
  const say = (
    threadId: string,
    text: string,
    options: { dispatched?: boolean } = {},
  ) => {
    const runId = `acpdl-run-${randomUUID().slice(0, 8)}`;
    const events: BaseEvent[] = [];
    const filed = options.dispatched
      ? runAsTenant(tenantId, () =>
          database.insert(workItems).values({
            kind: CHANNEL_DISPATCH_KIND,
            key: runId,
            attempts: 1,
            finishedAt: new Date(),
            payload: { ownerUserId: tenantId, agentId, text },
          }),
        )
      : Promise.resolve();
    // As the runtime hands it over: the agent's own thread is the conversation's.
    const agent = agentOf();
    const message = {
      id: `msg-${randomUUID()}`,
      role: "user" as const,
      content: text,
    };
    agent.threadId = threadId;
    agent.setMessages([message]);
    const done = new Promise<void>((resolve) => {
      void filed.then(() =>
        runAsTenant(tenantId, () =>
          runner
            .run({
              threadId,
              agent,
              input: {
                runId,
                threadId,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [message],
              } as unknown as RunAgentInput,
            })
            .subscribe({
              next: (event) => events.push(event),
              complete: () => resolve(),
              error: () => resolve(),
            }),
        ),
      );
    }).then(async () => {
      // The runner writes the run through one macrotask after it ends.
      await settle(30);
      await until(
        async () =>
          !(await runAsTenant(tenantId, () => runner.isRunning({ threadId }))),
        "the thread to be idle",
      );
    });
    return { runId, events, done };
  };

  /** The computer's side of one turn, once its prompt is down: what it said, then the end. */
  const frameAfter = async (type: string, threadId: string, from = 0) => {
    let found: Frame | undefined;
    await until(() => {
      found = down
        .slice(from)
        .find((frame) => frame.type === type && frame.threadId === threadId);
      return found !== undefined;
    }, type);
    return found as Frame;
  };
  const open = async (threadId: string, from: number, loaded = false) => {
    await frameAfter("acp.open", threadId, from);
    await device({
      type: "acp.session",
      threadId,
      sessionId: `s-${threadId}`,
      loaded,
    });
    const prompt = await frameAfter("acp.prompt", threadId, from);
    const turnId = prompt.turnId as string;
    await device({ type: "acp.turn.ack", threadId, turnId });
    return {
      turnId,
      content: prompt.content as { type: string; text?: string }[],
    };
  };
  let seq = 0;
  const update = (threadId: string, turnId: string, value: unknown) =>
    device({ type: "acp.update", threadId, turnId, seq: ++seq, update: value });
  const said = (threadId: string, turnId: string, text: string) =>
    update(threadId, turnId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  const end = (threadId: string, turnId: string) =>
    device({
      type: "acp.turn.end",
      threadId,
      turnId,
      stopReason: "end_turn",
      interrupted: false,
    });

  const cards = () =>
    runAsTenant(tenantId, () =>
      database
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.tenantId, tenantId), eq(tasks.executorAgentId, agentId)),
        )
        .orderBy(asc(tasks.createdAt)),
    );
  const cardOf = async (threadId: string) =>
    (await cards()).find((card) => card.threadRef === threadId);
  const history = (taskId: string) =>
    runAsTenant(tenantId, () => listTaskEvents(database, { tenantId, taskId }));

  /*
   * The delivery checker as index.ts wires it, on a clock of the test's own: the nudge is the real
   * nudge round (an unattended turn on the real runner, with this employee's transport, so it reaches
   * the computer), the person's notices are recorded.
   */
  const notices: DeliveryNotice[] = [];
  const nudges: string[] = [];
  const runTurn = createTurnRunner({
    intelligence: {
      getOrCreateThread: async (params: { threadId: string }) => ({
        thread: { id: params.threadId },
        created: false,
      }),
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async (params: {
        threadId: string;
        runId: string;
      }) => ({
        threadId: params.threadId,
        runId: params.runId,
        joinToken: "test",
      }),
      ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
      ɵcleanupThreadLock: async () => undefined,
    } as never,
    runner: runner as never,
    buildAgentFor: async () => agentOf(),
  });
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn,
    runner,
    isExternal: (tenant, agent) => isExternalEmployee(database, tenant, agent),
  });
  const check = (now: Date) =>
    runDeliveryCheck(
      {
        database,
        workHours: async () => ({
          start: "00:00",
          end: "24:00",
          weekends: true,
          timeZone: "Asia/Shanghai",
        }),
        notify: async (_tenant, notice) => {
          notices.push(notice);
          return "sent";
        },
        nudge: async (tenant, taskId, text) => {
          nudges.push(text);
          return nudgeRuns.startNudgeRun(tenant, taskId, text);
        },
        turnRunning: threadRunning(runner),
        turnQueued: externalTurnWaiting({
          turns,
          reachable: async () => state.reachable,
        }),
        isExternal: (tenant, agent) =>
          isExternalEmployee(database, tenant, agent),
        agentName: async () => "小码",
        onlyTenants: [tenantId],
      },
      now,
    );

  return {
    tenantId,
    agentId,
    employee,
    acpDelivery,
    runTurn,
    state,
    target,
    relay,
    runner,
    down,
    notices,
    nudges,
    check,
    frameAfter,
    say,
    open,
    said,
    update,
    end,
    cards,
    cardOf,
    history,
  };
}

const textOf = (events: readonly BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as BaseEvent & { delta: string }).delta)
    .join("");

describe("external employees in the delivery loop", () => {
  test("work handed to it by 派活 is pending_accept once queued; turn start sets accepted_at", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    h.state.reachable = false;
    const queued = h.say(threadId, "帮我把登录页的报错修一下", {
      dispatched: true,
    });
    await queued.done;
    expect(textOf(queued.events)).toContain("这件活已排队");

    const [card] = await h.cards();
    if (!card) throw new Error("the queued work opened no card");
    expect(card.tracked).toBe(true);
    expect(card.threadRef).toBe(threadId);
    expect(card.acceptedAt).toBeNull();
    expect(stageOf(card)).toBe("pending_accept");
    expect((await h.history(card.id)).map((row) => row.kind)).toEqual([
      "dispatched",
    ]);

    // The computer comes back: the queued turn starts, and starting it is taking the work on.
    h.state.reachable = true;
    const from = h.down.length;
    // Resolves once the prompt is on the computer, which needs the computer's answers below.
    const resumed = h.relay.resumeQueued(h.target);
    const { turnId } = await h.open(threadId, from);
    await resumed;
    await until(
      async () => (await h.cardOf(threadId))?.acceptedAt != null,
      "accepted_at",
    );
    const accepted = await h.cardOf(threadId);
    if (!accepted) throw new Error("the card is gone");
    expect(accepted.id).toBe(card.id);
    expect(stageOf(accepted)).toBe("accepted");
    expect(accepted.dueReported).toBe(false);
    expect((await h.history(card.id)).map((row) => row.kind)).toEqual([
      "dispatched",
      "accepted",
    ]);
    await h.said(threadId, turnId, "好的，我来看。");
    await h.end(threadId, turnId);
    await until(
      async () =>
        (await h.history(card.id)).some((row) => row.kind === "run_ended"),
      "the round's end",
    );
    // One card for the piece of work, whatever queued and ran it.
    expect(await h.cards()).toHaveLength(1);
  });

  test("protocol prefix is added once per card, not on resumed turns", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const first = h.say(threadId, "把首页的按钮改成蓝色", {
      dispatched: true,
    });
    const one = await h.open(threadId, 0);
    expect(one.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining(deliveryProtocol()),
    });
    expect(one.content.at(-1)).toEqual({
      type: "text",
      text: "把首页的按钮改成蓝色",
    });
    await h.said(threadId, one.turnId, "收到，在改。");
    await h.end(threadId, one.turnId);
    await first.done;

    /*
     * The person's follow-up in the conversation is the same card's next turn (一件活一张卡), even in a
     * new session on the computer: no rules again.
     */
    const from = h.down.length;
    const second = h.say(threadId, "顺便把字号也调大一点");
    const two = await h.open(threadId, from, false);
    expect(two.content).toEqual([
      { type: "text", text: "顺便把字号也调大一点" },
    ]);
    await h.said(threadId, two.turnId, "好。");
    await h.end(threadId, two.turnId);
    await second.done;
    expect(await h.cards()).toHaveLength(1);
    const texts = h.down
      .filter((frame) => frame.type === "acp.prompt")
      .flatMap((frame) => frame.content as { text?: string }[])
      .map((block) => block.text ?? "");
    expect(
      texts.filter((text) => text.includes(deliveryProtocol())),
    ).toHaveLength(1);
  });

  test("预计 16:00 / 预计 40 分钟 in the reply sets due_at and due_reported", async () => {
    const h = await harness();
    const clockThread = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const clock = h.say(clockThread, "把发票导出做完", {
      dispatched: true,
    });
    const a = await h.open(clockThread, 0);
    await h.said(clockThread, a.turnId, "已接下，预计 16:00 交。");
    // Only the first 「预计」 counts.
    await h.update(clockThread, a.turnId, {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      kind: "read",
      title: "读 invoices.ts",
      status: "completed",
    });
    await h.said(clockThread, a.turnId, "看了下可能要预计 17:30。");
    await h.end(clockThread, a.turnId);
    await clock.done;
    const byClock = await h.cardOf(clockThread);
    if (!byClock) throw new Error("no card");
    expect(byClock.dueReported).toBe(true);
    expect(byClock.dueAt?.toISOString()).toBe("2026-11-16T08:00:00.000Z");
    expect(byClock.originalDueAt?.toISOString()).toBe(
      "2026-11-16T08:00:00.000Z",
    );

    const spanThread = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const from = h.down.length;
    const span = h.say(spanThread, "整理一下周报", {
      dispatched: true,
    });
    const b = await h.open(spanThread, from);
    await h.said(spanThread, b.turnId, "收到，预计 40 分钟。");
    await h.end(spanThread, b.turnId);
    await span.done;
    const bySpan = await h.cardOf(spanThread);
    if (!bySpan) throw new Error("no card");
    expect(bySpan.dueReported).toBe(true);
    expect(bySpan.dueAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 40 * 60_000).toISOString(),
    );
  });

  test("edit diffs become a deliverable and pass the gate", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "修一下登录页的校验", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.update(threadId, turnId, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      kind: "edit",
      title: "改 login.ts",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "src/login.ts",
          oldText: "a\n",
          newText: "a\nb\nc\n",
        },
      ],
    });
    await h.said(
      threadId,
      turnId,
      "改好了。\n自查：跑了登录页的单测，全部通过。",
    );
    await h.end(threadId, turnId);
    await work.done;

    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.status).toBe("awaiting_review");
    expect(stageOf(card)).toBe("delivered");
    expect(card.deliverableRef).toEqual({
      kind: "deliverable",
      diffs: [{ files: 1, added: 2, removed: 0, ref: work.runId }],
      checks: ["自查：跑了登录页的单测，全部通过。"],
    });
    const lines = await h.history(card.id);
    expect(lines.map((row) => row.kind)).toContain("delivered");
    // The 交付卡 is in the conversation, with the change in one line.
    const shown = work.events.find(
      (event) =>
        event.type === EventType.CUSTOM &&
        (event as { name?: string }).name === "delivery.delivered",
    ) as { value?: { taskId?: string } } | undefined;
    expect(shown?.value?.taskId).toBe(card.id);
    expect(textOf(work.events)).not.toContain("它没交东西");
  });

  test("a turn with no diff or attachment stays accepted and posts 它没交东西", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "查一下为什么构建变慢了", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.said(threadId, turnId, "我看了一下，还在查。");
    await h.end(threadId, turnId);
    await work.done;

    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.status).toBe("running");
    expect(stageOf(card)).toBe("accepted");
    expect(card.deliverableRef).toBeNull();
    const kinds = (await h.history(card.id)).map((row) => row.kind);
    expect(kinds).not.toContain("delivered");
    expect(kinds).not.toContain("bounced");
    expect(textOf(work.events)).toContain("它没交东西");
  });

  test("cancelling the card cancels the queued ACP turn", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    h.state.reachable = false;
    const queued = h.say(threadId, "把旧接口下线", {
      dispatched: true,
    });
    await queued.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    const lane = await turns.openInThread(h.tenantId, threadId, h.agentId);
    expect(lane.map((row) => row.status)).toEqual(["queued"]);

    // What `POST /api/tasks/:id/cancel` does: the card, then the round on it, through the card turns.
    const cardTurns = createCardTurns({
      database,
      runTurn: (async () => {
        throw new Error("no turn is started by a cancel");
      }) as never,
      runner: h.runner,
      cancelExternalTurn: cancelExternalTurns({ turns, relay: h.relay }),
    });
    const cancelled = await delivery.cancelTask(
      h.tenantId,
      card.id,
      `user:${h.tenantId}`,
    );
    if (!cancelled?.threadRef) throw new Error("the card was not cancelled");
    await cardTurns.stopRound(h.tenantId, {
      threadId: cancelled.threadRef,
      agentId: cancelled.agentId,
      runId: cancelled.runId,
    });
    expect(
      (await turns.openInThread(h.tenantId, threadId, h.agentId)).map(
        (row) => row.turnId,
      ),
    ).toEqual([]);
    expect(
      lane[0] && (await turns.get(h.tenantId, lane[0].turnId))?.status,
    ).toBe("cancelled");

    // The computer comes back: nothing of the cancelled work goes to it.
    h.state.reachable = true;
    await h.relay.resumeQueued(h.target);
    await settle(50);
    expect(h.down.filter((frame) => frame.threadId === threadId)).toEqual([]);
    expect((await h.cardOf(threadId))?.status).toBe("cancelled");
  });
  test("an employee repeating the rules back sets no due time", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把首页的按钮改成蓝色", {
      dispatched: true,
    });
    const { turnId, content } = await h.open(threadId, 0);
    expect(content[0]).toEqual({ type: "text", text: externalProtocol() });
    // It says the rules back, examples and all, before it gives a time of its own.
    await h.said(threadId, turnId, `收到规约：\n${externalProtocol()}`);
    await h.end(threadId, turnId);
    await work.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.dueReported).toBe(false);
    expect(card.dueAt).toBeNull();
    expect(card.originalDueAt).toBeNull();
    // Nor a time it only quotes, as a nudge or a hand-over puts the card's time to it.
    expect(dueSaidIn("原定预计 16:00 交，我接着做。")).toBeUndefined();
    expect(dueSaidIn("原定预计 16:00，现在预计 17:30 交。")).toBe("17:30");
  });

  test("a words-only answer with 自查 is handed in, and is not nudged again", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "查一下为什么构建变慢了", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.said(
      threadId,
      turnId,
      "结论：构建变慢是因为 CI 的缓存键每次都变。\n自查：对比了最近 20 次构建的日志。",
    );
    await h.end(threadId, turnId);
    await work.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.status).toBe("awaiting_review");
    expect(card.deliverableRef).toEqual({
      kind: "deliverable",
      notes: ["构建变慢是因为 CI 的缓存键每次都变。"],
      checks: ["自查：对比了最近 20 次构建的日志。"],
    });
    expect(textOf(work.events)).not.toContain("它没交东西");
    // Hours past anything due: a card handed in waits for the person, nobody nudges it.
    await h.check(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(h.nudges).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test("「延到 18:00」 in the reply is its 延期申请", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把支付回调接上", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.said(
      threadId,
      turnId,
      "交不了：缺测试环境的商户号，要延到 18:00。",
    );
    await h.end(threadId, turnId);
    await work.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    const asked = (await h.history(card.id)).filter(
      (row) => row.kind === "extension_requested",
    );
    expect(asked.map((row) => row.detail)).toEqual([
      {
        runId: work.runId,
        dueAt: "2026-11-16T10:00:00.000Z",
        reason: "交不了：缺测试环境的商户号，要延到 18:00",
      },
    ]);
    // Asked for, not granted: the due time is the person's to move.
    expect(card.dueAt).toBeNull();
    expect(textOf(work.events)).not.toContain("它没交东西");
    // Only its own request: not a spread, a postponement nobody asked for, or a change it describes.
    expect(extensionSaidIn("问题蔓延到 18:00 的那批订单。")).toBeUndefined();
    expect(extensionSaidIn("会议顺延到 18:00。")).toBeUndefined();
    expect(extensionSaidIn("我把超时延到 30 分钟了。")).toBeUndefined();
    expect(extensionSaidIn("需要延到明早 10 点。")?.due).toBe("明早 10 点");
  });

  test("「交不了，延到 18:00。自查：…」 is only a 延期申请, never a hand-in", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把支付回调接上", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.said(
      threadId,
      turnId,
      "交不了，缺商户号，延到 18:00。\n自查：确认了测试环境里没有商户号配置。",
    );
    await h.end(threadId, turnId);
    await work.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.status).toBe("running");
    expect(card.deliverableRef).toBeNull();
    const kinds = (await h.history(card.id)).map((row) => row.kind);
    expect(kinds).toContain("extension_requested");
    expect(kinds).not.toContain("delivered");
    // Still with the employee: the checker goes on watching it.
    await h.check(new Date(NOW.getTime() + 3 * 60 * 60_000));
    expect(h.nudges).toHaveLength(1);
  });

  test("progress with a 自查 line is not a hand-in", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把导出改成异步", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.said(threadId, turnId, "还在改。\n自查：已经跑了一半测试。");
    await h.end(threadId, turnId);
    await work.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.status).toBe("running");
    expect(card.deliverableRef).toBeNull();
    expect((await h.history(card.id)).map((row) => row.kind)).not.toContain(
      "delivered",
    );
    expect(textOf(work.events)).toContain("它没交东西");
  });

  test("a hand-in too slow to wait for ends the round all the same, and says so", async () => {
    const h = await harness({
      ended: () => new Promise<string | undefined>(() => undefined),
      deliverySettleMs: 50,
    });
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把导出改成异步", {
      dispatched: true,
    });
    const { turnId } = await h.open(threadId, 0);
    await h.said(threadId, turnId, "改好了。");
    await h.end(threadId, turnId);
    await work.done;
    expect(textOf(work.events)).toContain(ACP_DELIVERY_LATE_NOTE);
    expect(
      work.events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
  });

  test("an overdue external card is nudged in its own words, naming no tool it does not have", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把发票导出做完", {
      dispatched: true,
    });
    const first = await h.open(threadId, 0);
    await h.said(threadId, first.turnId, "已接下，预计 16:00 交。");
    await h.end(threadId, first.turnId);
    await work.done;
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");

    // 16:40 in Shanghai: five minutes past due, the nudge; thirty-five, overdue and the hirer told.
    const from = h.down.length;
    await h.check(new Date("2026-11-16T08:40:00.000Z"));
    expect(h.nudges).toHaveLength(1);
    // The nudge round reaches the computer, and what it carries names no tool and says what to write.
    const nudge = await h.open(threadId, from, true);
    const told = nudge.content.map((block) => block.text ?? "").join("\n");
    expect(told).not.toMatch(TOOL_NAMES);
    expect(told).toContain(
      "【系统催办】『把发票导出做完』原定 16:00 交，已经过了 40 分钟。",
    );
    expect(told).toContain(EXTERNAL_DELIVERY_GUIDE);
    expect(told).toContain("「自查：」");
    expect(told).toContain("「延到 HH:MM」");
    await h.said(threadId, nudge.turnId, "在改，还差导出格式。");
    await h.end(threadId, nudge.turnId);
    await until(
      async () =>
        (await h.history(card.id)).filter((row) => row.kind === "run_ended")
          .length === 2,
      "the nudge round's end",
    );
    expect(h.notices.map((notice) => notice.kind)).toEqual(["overdue"]);
    const overdue = await h.cardOf(threadId);
    if (!overdue) throw new Error("no card");
    expect(overdue.overdueAt?.toISOString()).toBe("2026-11-16T08:40:00.000Z");

    // A hand-over to an external employee is told the same way.
    const handover = handoverText(
      {
        title: "把发票导出做完",
        criteria: null,
        deliverable: {
          kind: "deliverable",
          diffs: [{ files: 2, added: 10, removed: 3, ref: "run-1" }],
        },
        progress: "在改",
      },
      { external: true },
    );
    expect(handover).not.toMatch(TOOL_NAMES);
    expect(handover).toContain(EXTERNAL_DELIVERY_GUIDE);
    expect(handover).toContain("改动 2 个文件 · +10 −3");
  });

  test("a plain question in its own conversation is not followed: no rules, no 它没交东西, never nudged or told", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const asked = h.say(threadId, "这个报错是什么意思？");
    const { turnId, content } = await h.open(threadId, 0);
    // The question as asked, nothing in front of it.
    expect(content).toEqual([{ type: "text", text: "这个报错是什么意思？" }]);
    await h.said(threadId, turnId, "这是类型不匹配：把 a 改成数字就好。");
    await h.end(threadId, turnId);
    await asked.done;
    expect(textOf(asked.events)).toContain("这是类型不匹配");
    expect(textOf(asked.events)).not.toContain("它没交东西");

    const [card] = await h.cards();
    if (!card) throw new Error("the turn opened no card");
    expect(card.tracked).toBe(false);
    expect(stageOf(card)).toBeNull();
    expect(card.acceptedAt).toBeNull();
    expect(await h.history(card.id)).toEqual([]);

    // Asked while the computer is away: queued, and still only a question.
    h.state.reachable = false;
    const later = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const queued = h.say(later, "顺便问下这个配置项干嘛的？");
    await queued.done;
    expect(textOf(queued.events)).toContain("已排队");
    const waiting = await h.cards();
    expect(waiting.map((row) => row.tracked)).toEqual([false, false]);

    // Hours on: nobody is nudged, the person is told nothing.
    for (const hours of [3, 6, 24])
      await h.check(new Date(NOW.getTime() + hours * 60 * 60_000));
    expect(h.nudges).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(
      h.down.filter(
        (frame) =>
          frame.type === "acp.prompt" &&
          JSON.stringify(frame.content).includes(deliveryProtocol()),
      ),
    ).toEqual([]);
  });

  test("a conversation the person follows (当作一件活来跟) walks the three steps from its next turn", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const asked = h.say(threadId, "看看登录页为什么慢");
    const one = await h.open(threadId, 0);
    expect(one.content).toEqual([{ type: "text", text: "看看登录页为什么慢" }]);
    await h.said(threadId, one.turnId, "主要是首屏请求太多。");
    await h.end(threadId, one.turnId);
    await asked.done;
    const [card] = await h.cards();
    if (!card) throw new Error("no card");
    expect(card.tracked).toBe(false);

    // What `POST /api/tasks/:id/track` does.
    const followed = await delivery.track(
      h.tenantId,
      card.id,
      `user:${h.tenantId}`,
    );
    expect(followed).toEqual({ ok: true, threadRef: threadId });
    expect(stageOf((await h.cardOf(threadId)) ?? card)).toBe("pending_accept");

    const from = h.down.length;
    const next = h.say(threadId, "那就把请求合并一下");
    const two = await h.open(threadId, from);
    expect(two.content[0]).toEqual({ type: "text", text: externalProtocol() });
    await until(
      async () => (await h.cardOf(threadId))?.acceptedAt != null,
      "accepted_at",
    );
    await h.said(threadId, two.turnId, "在改，还没好。");
    await h.end(threadId, two.turnId);
    await next.done;
    expect(textOf(next.events)).toContain("它没交东西");
    const taken = await h.cardOf(threadId);
    expect(taken?.id).toBe(card.id);
    expect(stageOf(taken ?? card)).toBe("accepted");
    expect(await h.cards()).toHaveLength(1);
    expect((await h.history(card.id)).map((row) => row.kind)).toEqual([
      "dispatched",
      "accepted",
      "progress",
      "run_ended",
    ]);
  });

  test("work handed to it with @ in another conversation (派活) walks the three steps", async () => {
    const h = await harness();
    const channelId = `acpdl-ch-${randomUUID().slice(0, 8)}`;
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    // The real dispatch service, its real work queue and board; the conversation is another coworker's.
    const dispatch = createChannelDispatch({
      queue: createWorkQueue(database),
      owner: `acpdl-dispatch-${suite}`,
      board: projector,
      channel: async () => ({
        id: channelId,
        threadId,
        agentIds: ["acpdl-pinned"],
      }),
      bot: async (_actor, agentId) =>
        agentId === h.agentId ? { id: h.agentId, name: "小码" } : null,
      actorFor: async (id) => ({ id, role: "user" }),
      runTurn: h.runTurn,
    });
    const submitted = await runAsTenant(h.tenantId, () =>
      dispatch.submit({ id: h.tenantId, role: "user" }, channelId, {
        id: `msg-${randomUUID()}`,
        agentId: h.agentId,
        text: "把发票导出做完",
      }),
    );
    const ran = dispatch.sweep();
    const turn = await h.open(threadId, 0);
    expect(turn.content[0]).toEqual({ type: "text", text: externalProtocol() });
    await h.said(threadId, turn.turnId, "已接下，预计 16:00 交。");
    await h.end(threadId, turn.turnId);
    expect(await ran).toBe(true);
    const card = (await h.cards()).find((row) => row.id === submitted.taskId);
    if (!card) throw new Error("the dispatch opened no card");
    expect(card.tracked).toBe(true);
    expect(card.threadRef).toBe(threadId);
    expect(stageOf(card)).toBe("accepted");
    expect(card.dueAt?.toISOString()).toBe("2026-11-16T08:00:00.000Z");
    expect((await h.history(card.id)).map((row) => row.kind)).toEqual(
      expect.arrayContaining(["dispatched", "accepted"]),
    );
  });

  test("work asked of it in a group is followed; a peer's 转交 is not", async () => {
    const h = await harness();
    const groupTurn = createAcpGroupTurn({
      turns,
      relay: h.relay,
      channel: { isReachable: () => false },
      employeeFor: async () => h.employee,
      delivery: h.acpDelivery,
      log: () => undefined,
    });
    const groupThread = `acpdl-group-${randomUUID().slice(0, 8)}`;
    const opened = async (runId: string) =>
      runAsTenant(h.tenantId, () =>
        projector.opened({
          tenantId: h.tenantId,
          title: "把发票导出做完",
          executorAgentId: h.agentId,
          source: "chat",
          channelRef: `acpdl-group-channel-${suite}`,
          runRef: runId,
        }),
      );
    const asked = `acpdl-run-${randomUUID().slice(0, 8)}`;
    const askedCard = await opened(asked);
    await groupTurn({
      agentId: h.agentId,
      threadId: groupThread,
      instruction: "@小码 把发票导出做完",
      runId: asked,
    });
    const handed = `acpdl-run-${randomUUID().slice(0, 8)}`;
    const handedCard = await opened(handed);
    await groupTurn({
      agentId: h.agentId,
      threadId: `${groupThread}-hop`,
      instruction: "@小码 你帮看下",
      runId: handed,
      initiator: { kind: "handoff" },
    });
    const byId = new Map((await h.cards()).map((row) => [row.id, row]));
    expect(byId.get(askedCard)?.tracked).toBe(true);
    expect(byId.get(askedCard)?.threadRef).toBe(groupThread);
    expect(byId.get(handedCard)?.tracked).toBe(false);
  });

  test("an offline, queued external card is still recorded overdue and its hirer told, but not nudged", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把发票导出做完", {
      dispatched: true,
    });
    const first = await h.open(threadId, 0);
    await h.said(threadId, first.turnId, "已接下，预计 16:00 交。");
    await h.end(threadId, first.turnId);
    await work.done;
    // The computer goes away; the person's follow-up waits in its queue.
    h.state.reachable = false;
    const followUp = h.say(threadId, "进展怎么样？");
    await followUp.done;
    expect(
      (await turns.openInThread(h.tenantId, threadId)).map((row) => row.status),
    ).toEqual(["queued"]);

    await h.check(new Date("2026-11-16T08:40:00.000Z"));
    const card = await h.cardOf(threadId);
    if (!card) throw new Error("no card");
    expect(card.overdueAt?.toISOString()).toBe("2026-11-16T08:40:00.000Z");
    expect(h.notices).toEqual([
      {
        kind: "overdue",
        taskId: card.id,
        text: "『把发票导出做完』已逾期 40 分钟（小码，催过 0 次，电脑离线，活还在排队）",
      },
    ]);
    expect(h.nudges).toEqual([]);
    expect((await h.history(card.id)).map((row) => row.kind)).not.toContain(
      "nudged",
    );
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  createAcpTurnStarter,
  DeviceAcpAgent,
  type DeviceAcpEmployee,
} from "../src/agents/acp/agent";
import {
  cancelExternalTurns,
  createAcpDelivery,
  externalProtocol,
  externalTurnWaiting,
} from "../src/agents/acp/delivery";
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
import { listTaskEvents } from "../src/tasks/events";
import { createEvidenceGate } from "../src/tasks/evidence-gate";
import { createNudgeRuns, handoverText } from "../src/tasks/nudge-run";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工按交付规约走三步（spec 2026-11-15-delivery-loop §9）：外部员工调不了熊宝的工具，由服务器替它走。
 * 排队即「派出 · 待接下」，轮次开始即接下，第一轮的提示前加四条规约（每张卡一次），回复里第一次出现的
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
async function harness() {
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
  const acpDelivery = createAcpDelivery({
    delivery,
    gate,
    timeZone: async () => "Asia/Shanghai",
    now: () => NOW,
    log: () => undefined,
  });
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

  /** The person says `text` in `threadId`; resolves with the run's id and, once it ends, its events. */
  const say = (threadId: string, text: string) => {
    const runId = `acpdl-run-${randomUUID().slice(0, 8)}`;
    const events: BaseEvent[] = [];
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
  const nudgeRuns = createNudgeRuns({
    database,
    runTurn: createTurnRunner({
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
    }),
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
  test("queued external work is pending_accept; turn start sets accepted_at", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    h.state.reachable = false;
    const queued = h.say(threadId, "帮我把登录页的报错修一下");
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
    const first = h.say(threadId, "把首页的按钮改成蓝色");
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

    // The same card's next turn, even in a new session on the computer: no rules again.
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
    const clock = h.say(clockThread, "把发票导出做完");
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
    const span = h.say(spanThread, "整理一下周报");
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
    const work = h.say(threadId, "修一下登录页的校验");
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
    const work = h.say(threadId, "查一下为什么构建变慢了");
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
    const queued = h.say(threadId, "把旧接口下线");
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
    const work = h.say(threadId, "把首页的按钮改成蓝色");
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
  });

  test("a words-only answer with 自查 is handed in, and is not nudged again", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "查一下为什么构建变慢了");
    const { turnId } = await h.open(threadId, 0);
    await h.said(
      threadId,
      turnId,
      "构建变慢是因为 CI 的缓存键每次都变。\n自查：对比了最近 20 次构建的日志。",
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
    const work = h.say(threadId, "把支付回调接上");
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
  });

  test("an overdue external card is nudged in its own words, naming no tool it does not have", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把发票导出做完");
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
      "【系统催办】『把发票导出做完』预计 16:00 交，已经过了 40 分钟。",
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
    expect((await h.cardOf(threadId))?.overdueAt).not.toBeNull();

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

  test("an offline, queued external card is still recorded overdue and its hirer told, but not nudged", async () => {
    const h = await harness();
    const threadId = `acpdl-thread-${randomUUID().slice(0, 8)}`;
    const work = h.say(threadId, "把发票导出做完");
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

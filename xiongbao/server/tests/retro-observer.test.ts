import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
  RUN_ENDED_EARLY,
  SEGMENT_LIMIT_MESSAGE,
} from "@xiongbao/toolkit/headless-tools";
import {
  CARD_DELIVERED_MIN_STEPS_DEFAULT,
  createRetroObserver,
  createRetrospector,
  type ObservedTurn,
  RETRO_TOTAL_TIMEOUT_MS_DEFAULT,
  type RetroOutcome,
  type RetroTurn,
  retroCardMinSteps,
  retroPrompt,
  retroTotalTimeoutMs,
  runErrorKindOf,
  shouldRetrospect,
  traceStepsOf,
} from "../src/learning/retrospect";

function call(id: string, name: string, args: unknown, answer: string) {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: id,
      messageId: `m-${id}`,
      content: answer,
    },
  ] as unknown as BaseEvent[];
}

const work = (count: number, prefix = "c") =>
  Array.from({ length: count }, (_, index) =>
    call(
      `${prefix}${index}`,
      "computer_run_command",
      { command: `s${index}` },
      "{}",
    ),
  ).flat();

function turnOf(
  events: BaseEvent[],
  overrides: Partial<ObservedTurn> = {},
): ObservedTurn {
  return {
    tenant: "u1",
    agentId: "bot",
    threadId: "t1",
    runId: "r1",
    messages: [{ role: "user", content: "把动作清单做成汇总表" }],
    events,
    failed: false,
    kind: "task",
    ...overrides,
  };
}

function harness(
  overrides: Partial<Parameters<typeof createRetroObserver>[0]> = {},
) {
  const seen: RetroTurn[] = [];
  const logs: string[] = [];
  const observe = createRetroObserver({
    retrospect: async (turn): Promise<RetroOutcome> => {
      seen.push(turn);
      return { outcome: "saved", id: "auto-1", status: "active" };
    },
    deliveredCard: async () => null,
    cardTurn: async () => null,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { observe, seen, logs };
}

describe("a card handed in is a piece of work done", () => {
  test("the bar for a delivered card is lower than the long-turn one, and can be set", () => {
    expect(retroCardMinSteps({})).toBe(CARD_DELIVERED_MIN_STEPS_DEFAULT);
    expect(retroCardMinSteps({ XIONGBAO_RETRO_CARD_MIN_STEPS: "4" })).toBe(4);
    expect(retroCardMinSteps({ XIONGBAO_RETRO_CARD_MIN_STEPS: "0" })).toBe(
      CARD_DELIVERED_MIN_STEPS_DEFAULT,
    );
    const turn = (steps: number): RetroTurn => ({
      ownerUserId: "u1",
      agentId: "bot",
      threadId: "t",
      runId: "r",
      request: "x",
      reply: "y",
      steps: traceStepsOf(work(steps)),
      failed: false,
      trigger: "card_delivered",
    });
    expect(shouldRetrospect(turn(CARD_DELIVERED_MIN_STEPS_DEFAULT), {})).toBe(
      true,
    );
    expect(
      shouldRetrospect(turn(CARD_DELIVERED_MIN_STEPS_DEFAULT - 1), {}),
    ).toBe(false);
    // The same steps as a plain turn are below the long-turn bar of 15.
    expect(shouldRetrospect({ ...turn(8), trigger: "steps" }, {})).toBe(false);
  });

  test("a round whose deliver_task was accepted reviews the whole card, as a delivered card", async () => {
    const cardTurn: RetroTurn = {
      ownerUserId: "u1",
      agentId: "bot",
      threadId: "t1",
      runId: "r1",
      request: "整理动作清单",
      reply: "已交付",
      steps: traceStepsOf(work(9)),
      failed: false,
      trigger: "card_accepted",
    };
    const asked: string[] = [];
    const { observe, seen, logs } = harness({
      deliveredCard: async (runId) => {
        asked.push(runId);
        return "card-1";
      },
      cardTurn: async (taskId, current) => {
        asked.push(`${taskId}:${current.runId}:${current.events.length}`);
        return cardTurn;
      },
    });
    const events = [
      ...work(8),
      ...call("d", "deliver_task", { items: [] }, '{"delivered":true}'),
    ];
    const outcome = await observe(turnOf(events));
    expect(outcome).toMatchObject({ outcome: "saved" });
    expect(asked).toEqual(["r1", `card-1:r1:${events.length}`]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      trigger: "card_delivered",
      request: "整理动作清单",
    });
    expect(seen[0]?.steps).toHaveLength(9);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      type: "retrospect",
      outcome: "saved",
      trigger: "card_delivered",
      runId: "r1",
      agentId: "bot",
    });
  });

  test("a hand-in the gate bounced is not a delivery: the round is judged as an ordinary turn", async () => {
    const { observe, seen } = harness({ deliveredCard: async () => null });
    await observe(
      turnOf([
        ...work(8),
        ...call("d", "deliver_task", {}, '{"bounced":true}'),
      ]),
    );
    // A card's round that was bounced is not a delivery, and is not called one.
    expect(seen[0]?.trigger).toBe("card_turn");
  });

  test("a person's own chat turn never asks about a card", async () => {
    let asked = 0;
    const { observe, seen } = harness({
      deliveredCard: async () => {
        asked += 1;
        return "card-1";
      },
    });
    await observe(
      turnOf([...work(3), ...call("d", "deliver_task", {}, "{}")], {
        kind: "chat",
      }),
    );
    expect(asked).toBe(0);
    expect(seen[0]?.trigger).toBe("steps");
  });

  test("a failed turn is not reviewed, and still says so in the log", async () => {
    const { observe, seen, logs } = harness();
    expect(await observe(turnOf(work(20), { failed: true }))).toEqual({
      outcome: "skipped",
    });
    expect(seen).toEqual([]);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      outcome: "skipped",
      runId: "r1",
    });
  });

  test("a failed turn that handed its card in is still reviewed, and the log says so", async () => {
    const { observe, seen, logs } = harness({
      deliveredCard: async () => "card-1",
      cardTurn: async (taskId, current) => ({
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: current.runId,
        request: "做汇总表",
        reply: "",
        steps: traceStepsOf(current.events),
        failed: false,
        cardId: taskId,
        trigger: "card_delivered",
      }),
    });
    const events = [
      ...work(8),
      ...call("d", "deliver_task", {}, '{"delivered":true,"taskId":"card-1"}'),
    ];
    expect(await observe(turnOf(events, { failed: true }))).toMatchObject({
      outcome: "saved",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ trigger: "card_delivered", failed: false });
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      outcome: "saved",
      trigger: "card_delivered",
      cardId: "card-1",
      failedButDelivered: true,
    });
  });

  test("a failed turn whose delivery was bounced or refused is skipped as failed", async () => {
    for (const answer of ['{"bounced":true}', "Refused. not allowed", "?"]) {
      // 被挡回、被拒的交付不写 `delivered` 行：库里读不到这一轮的交付。
      const { observe, seen, logs } = harness({
        deliveredCard: async () => null,
      });
      const events = [...work(8), ...call("d", "deliver_task", {}, answer)];
      expect(await observe(turnOf(events, { failed: true }))).toEqual({
        outcome: "skipped",
      });
      expect(seen).toEqual([]);
      const logged = JSON.parse(logs[0] ?? "{}");
      expect(logged).toMatchObject({ outcome: "skipped", reason: "failed" });
      expect(logged.failedButDelivered).toBeUndefined();
    }
  });

  /** 一轮真实的样子：开头、文字、几步活、交付、交付之后的一次错误。 */
  const realisticRun = (deliverAnswer: string, deliverAs: "start" | "chunk") =>
    [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m0",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m0", delta: "好的" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m0" },
      ...work(8),
      ...(deliverAs === "start"
        ? call("d", "deliver_task", { items: [] }, deliverAnswer)
        : ([
            {
              type: EventType.TOOL_CALL_CHUNK,
              toolCallId: "d",
              toolCallName: "deliver_task",
              delta: "{}",
            },
            {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: "d",
              messageId: "m-d",
              content: deliverAnswer,
            },
          ] as unknown as BaseEvent[])),
      {
        type: EventType.RUN_ERROR,
        message: "private provider sentence about the request",
        code: "stream_stalled",
      },
    ] as unknown as BaseEvent[];

  test("a turn whose only error came after an accepted delivery is not failed now: it is a delivered card, and the log says what the error was", async () => {
    const { observe, seen, logs } = harness({
      deliveredCard: async () => "card-1",
      cardTurn: async (taskId, current) => cardRound(taskId, current),
    });
    const events = realisticRun(
      '{"delivered":true,"taskId":"card-1"}',
      "start",
    ).map((event) =>
      event.type === EventType.RUN_ERROR
        ? ({ ...event, message: RUN_ENDED_EARLY } as BaseEvent)
        : event,
    );
    // 服务器不再把这样的一轮记成失败：failed 为 false，不走 failedButDelivered 那条路。
    expect(await observe(turnOf(events, { failed: false }))).toMatchObject({
      outcome: "saved",
    });
    expect(seen[0]).toMatchObject({ trigger: "card_delivered", failed: false });
    const logged = JSON.parse(logs[0] ?? "{}");
    expect(logged).toMatchObject({
      outcome: "saved",
      trigger: "card_delivered",
      cardId: "card-1",
      runError: "stream_stalled",
      runErrorKind: "ended_early",
      runErrorAfterDelivery: true,
    });
    expect(logged.failedButDelivered).toBeUndefined();
    // 没失败，失败轮才有的那几项不带；错误原文不进日志。
    expect(logged.deliverSeen).toBeUndefined();
    expect(logs[0]).not.toContain(RUN_ENDED_EARLY);
  });

  test("the failed-but-delivered path still logs the new run error fields; an error with no delivery says so", async () => {
    const { observe, logs } = harness({ deliveredCard: async () => "card-1" });
    const delivered = realisticRun(
      '{"delivered":true,"taskId":"card-1"}',
      "start",
    );
    await observe(turnOf(delivered, { failed: true }));
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      failedButDelivered: true,
      runErrorKind: "other",
      runErrorAfterDelivery: true,
    });
    const early = harness({ deliveredCard: async () => null });
    await early.observe(
      turnOf(
        [
          ...work(8),
          {
            type: EventType.RUN_ERROR,
            message: SEGMENT_LIMIT_MESSAGE,
            code: "x",
          } as BaseEvent,
        ],
        { failed: true },
      ),
    );
    expect(JSON.parse(early.logs[0] ?? "{}")).toMatchObject({
      reason: "failed",
      runErrorKind: "segment_limit",
      runErrorAfterDelivery: false,
    });
  });

  test("runErrorKindOf tells the kinds apart by the headless constants and has nothing without an error", () => {
    const err = (message: string) =>
      [{ type: EventType.RUN_ERROR, message }] as unknown as BaseEvent[];
    expect(runErrorKindOf(err(RUN_ENDED_EARLY))).toBe("ended_early");
    expect(runErrorKindOf(err(SEGMENT_LIMIT_MESSAGE))).toBe("segment_limit");
    expect(runErrorKindOf(err("provider 529 overloaded"))).toBe("other");
    expect(runErrorKindOf([])).toBeUndefined();
  });

  const cardRound = (
    taskId: string,
    current: { runId: string; events: readonly BaseEvent[] },
  ): RetroTurn => ({
    ownerUserId: "u1",
    agentId: "bot",
    threadId: "t1",
    runId: current.runId,
    request: "做汇总表",
    reply: "",
    steps: traceStepsOf(current.events),
    failed: false,
    cardId: taskId,
    trigger: "card_delivered",
  });

  test("a failed turn whose delivered answer cannot be read from the events is still a delivered card: the stored delivery row says so", async () => {
    for (const shape of ["start", "chunk"] as const) {
      const asked: string[] = [];
      const { observe, seen, logs } = harness({
        deliveredCard: async (runId) => {
          asked.push(runId);
          return "card-1";
        },
        cardTurn: async (taskId, current) => cardRound(taskId, current),
      });
      // 答复被包了一层、不是裸的 JSON：事件里认不出，库里的行认得。
      const events = realisticRun(
        'Tool result: {"delivered":true,"taskId":"card-1"}',
        shape,
      );
      expect(await observe(turnOf(events, { failed: true }))).toMatchObject({
        outcome: "saved",
      });
      expect(asked[0]).toBe("r1");
      expect(seen[0]).toMatchObject({ trigger: "card_delivered" });
      const logged = JSON.parse(logs[0] ?? "{}");
      expect(logged).toMatchObject({
        outcome: "saved",
        trigger: "card_delivered",
        cardId: "card-1",
        failedButDelivered: true,
        runError: "stream_stalled",
        deliverSeen: true,
        deliveredRow: true,
        eventCount: events.length,
      });
      // 诊断里没有错误原文。
      expect(logs[0]).not.toContain("private provider sentence");
    }
  });

  test("a failed turn with no deliver call at all and no delivery row stays skipped as failed, with the diagnosis", async () => {
    const { observe, seen, logs } = harness();
    const events = [
      ...work(8),
      { type: EventType.RUN_ERROR, message: "x" },
    ] as unknown as BaseEvent[];
    expect(await observe(turnOf(events, { failed: true }))).toEqual({
      outcome: "skipped",
    });
    expect(seen).toEqual([]);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      outcome: "skipped",
      reason: "failed",
      runError: "RUN_ERROR",
      deliverSeen: false,
      deliveredRow: false,
      eventCount: events.length,
    });
  });

  test("a bounced delivery in a failed turn is skipped as failed: the call is seen, the row is not there", async () => {
    const { observe, seen, logs } = harness({
      deliveredCard: async () => null,
    });
    const events = realisticRun('{"bounced":true,"reason":"x"}', "start");
    expect(await observe(turnOf(events, { failed: true }))).toEqual({
      outcome: "skipped",
    });
    expect(seen).toEqual([]);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      reason: "failed",
      deliverSeen: true,
      deliveredRow: false,
    });
  });

  test("a failed turn whose delivery row cannot be read still counts an accepted answer in its own events", async () => {
    const { observe, logs } = harness({
      deliveredCard: async () => {
        throw new Error("db down");
      },
      cardTurn: async (taskId, current) => cardRound(taskId, current),
    });
    const events = realisticRun(
      '{"delivered":true,"taskId":"card-1"}',
      "start",
    );
    await observe(turnOf(events, { failed: true }));
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      failedButDelivered: true,
      deliveredRow: false,
    });
  });

  test("a turn that did not fail carries no diagnosis fields", async () => {
    const { observe, logs } = harness();
    await observe(turnOf(work(8)));
    const logged = JSON.parse(logs[0] ?? "{}");
    for (const key of ["runError", "deliverSeen", "deliveredRow", "eventCount"])
      expect(logged).not.toHaveProperty(key);
  });

  test("a turn that did not fail keeps its log line without the failed-but-delivered mark", async () => {
    const { observe, logs } = harness();
    await observe(
      turnOf([
        ...work(8),
        ...call("d", "deliver_task", {}, '{"delivered":true}'),
      ]),
    );
    expect(JSON.parse(logs[0] ?? "{}").failedButDelivered).toBeUndefined();
  });

  test("a card that cannot be read falls back to the round itself, and a marker that throws changes nothing", async () => {
    const { observe, seen, logs } = harness({
      deliveredCard: async () => {
        throw new Error("db down");
      },
      markUsed: async () => {
        throw new Error("nope");
      },
    });
    const events = [
      ...work(8),
      ...call("d", "deliver_task", {}, '{"delivered":true}'),
    ];
    expect(await observe(turnOf(events))).toMatchObject({ outcome: "saved" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trigger).toBe("card_turn");
    expect(logs).toHaveLength(1);
  });
});

/** 交付成功时 `deliver_task` 的答复：带着卡号。 */
const delivery = (taskId: string) =>
  call(
    "deliver",
    "deliver_task",
    { items: [] },
    `{"delivered":true,"taskId":"${taskId}"}`,
  );

describe("a card of several rounds is reviewed once, whichever round handed it in", () => {
  /**
   * 一张卡的几轮：库里记着哪一轮交付了、哪些轮是这张卡的。复盘函数照产品的门槛判（步数不够就是 skipped），
   * 看板卡的轨迹是这张卡已经做过的步数。
   */
  function board(cardSteps: () => number) {
    const delivered = new Set<string>();
    const rounds = new Map<string, string>();
    const reviewed: RetroTurn[] = [];
    const attempts: RetroTurn[] = [];
    const { observe, logs } = harness({
      retrospect: async (turn): Promise<RetroOutcome> => {
        attempts.push(turn);
        if (!shouldRetrospect(turn, {})) return { outcome: "skipped" };
        reviewed.push(turn);
        return { outcome: "saved", id: "auto-1", status: "active" };
      },
      deliveredCard: async (runId) =>
        delivered.has(runId) ? (rounds.get(runId) ?? null) : null,
      cardOfRound: async (runId) => {
        const card = rounds.get(runId);
        if (!card) return null;
        return [...delivered].some((run) => rounds.get(run) === card)
          ? card
          : null;
      },
      cardTurn: async (taskId, current) => ({
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: current.runId,
        request: "整理动作清单",
        reply: "好了",
        steps: traceStepsOf(work(cardSteps())),
        failed: false,
        cardId: taskId,
        trigger: "card_accepted",
      }),
    });
    return {
      observe,
      logs,
      reviewed,
      attempts,
      round: (runId: string, card: string | null, delivers = false) => {
        if (card) rounds.set(runId, card);
        if (delivers) delivered.add(runId);
      },
    };
  }
  const logOf = (logs: string[], runId: string) =>
    JSON.parse(logs.find((line) => line.includes(`"${runId}"`)) ?? "{}");

  test("handed in during the middle round: reviewed right there, and the later round does not review it again", async () => {
    const steps = 9;
    const { observe, logs, reviewed, round } = board(() => steps);
    round("r1", "card-1");
    expect(await observe(turnOf(work(3), { runId: "r1" }))).toEqual({
      outcome: "skipped",
    });
    round("r2", "card-1", true);
    expect(
      await observe(
        turnOf([...work(4, "m"), ...delivery("card-1")], { runId: "r2" }),
      ),
    ).toMatchObject({ outcome: "saved" });
    round("r3", "card-1");
    expect(await observe(turnOf(work(14, "z"), { runId: "r3" }))).toEqual({
      outcome: "skipped",
    });
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({
      trigger: "card_delivered",
      cardId: "card-1",
    });
    expect(logOf(logs, "r2")).toMatchObject({
      outcome: "saved",
      trigger: "card_delivered",
      cardId: "card-1",
    });
    // The round after the hand-in says why it did nothing, and it was not read as a plain 14-step turn.
    expect(logOf(logs, "r3")).toMatchObject({
      outcome: "skipped",
      trigger: "card_delivered",
      reason: "card_done",
    });
  });

  test("handed in with too little behind it, then more work in a later round: reviewed once, over the whole card", async () => {
    let steps = 3;
    const { observe, logs, reviewed, attempts, round } = board(() => steps);
    round("r1", "card-1", true);
    await observe(turnOf([...work(1), ...delivery("card-1")], { runId: "r1" }));
    expect(reviewed).toHaveLength(0);
    expect(logOf(logs, "r1")).toMatchObject({
      outcome: "skipped",
      trigger: "card_delivered",
      reason: "steps",
    });
    // The next round of the same card has no hand-in of its own; the card now has enough behind it.
    steps = 9;
    round("r2", "card-1");
    expect(await observe(turnOf(work(6), { runId: "r2" }))).toMatchObject({
      outcome: "saved",
    });
    round("r3", "card-1");
    await observe(turnOf(work(6, "y"), { runId: "r3" }));
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.cardId).toBe("card-1");
    expect(attempts.filter((turn) => turn.cardId === "card-1")).toHaveLength(2);
    expect(logOf(logs, "r2")).toMatchObject({
      outcome: "saved",
      trigger: "card_delivered",
    });
    expect(logOf(logs, "r3")).toMatchObject({ reason: "card_done" });
  });

  test("a round of a card nobody has handed in yet is a card turn, not a delivery", async () => {
    const { observe, attempts, round } = board(() => 9);
    round("r1", "card-1");
    await observe(turnOf(work(5), { runId: "r1" }));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ trigger: "card_turn" });
    expect(attempts[0]).not.toHaveProperty("cardId");
  });

  test("a hand-in not yet in the table when the round ends is read from the round's own answer", async () => {
    const asked: string[] = [];
    const { observe, seen } = harness({
      deliveredCard: async () => null,
      cardOfRound: async () => null,
      cardTurn: async (taskId) => {
        asked.push(taskId);
        return {
          ownerUserId: "u1",
          agentId: "bot",
          threadId: "t1",
          runId: "r1",
          request: "整理动作清单",
          reply: "好了",
          steps: traceStepsOf(work(9)),
          failed: false,
          cardId: taskId,
          trigger: "card_accepted",
        };
      },
    });
    await observe(turnOf([...work(8), ...delivery("card-7")]));
    expect(asked).toEqual(["card-7"]);
    expect(seen[0]).toMatchObject({ trigger: "card_delivered" });
  });

  test("work carried on in the same conversation after a hand-in, under a card of its own, still counts toward the delivered card", async () => {
    let steps = 3;
    const reviewed: RetroTurn[] = [];
    const attempts: RetroTurn[] = [];
    const { observe, logs } = harness({
      retrospect: async (turn): Promise<RetroOutcome> => {
        attempts.push(turn);
        if (!shouldRetrospect(turn, {})) return { outcome: "skipped" };
        reviewed.push(turn);
        return { outcome: "saved", id: "auto-1", status: "active" };
      },
      // r1 handed card-1 in with too little behind it; the later rounds were dispatched as new cards.
      deliveredCard: async (runId) => (runId === "r1" ? "card-1" : null),
      cardOfRound: async () => null,
      cardHandedInBefore: async () => "card-1",
      cardTurn: async (taskId, current) => ({
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: current.runId,
        request: "整理动作清单",
        reply: "好了",
        steps: traceStepsOf(work(steps)),
        failed: false,
        cardId: taskId,
        trigger: "card_accepted",
      }),
    });
    await observe(turnOf([...work(1), ...delivery("card-1")], { runId: "r1" }));
    expect(reviewed).toHaveLength(0);
    steps = 9;
    expect(await observe(turnOf(work(6), { runId: "r2" }))).toMatchObject({
      outcome: "saved",
    });
    await observe(turnOf(work(5, "y"), { runId: "r3" }));
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({
      trigger: "card_delivered",
      cardId: "card-1",
    });
    // r1 (too thin) and r2 (enough) were the card's; r3 is a 5-step card turn, below the card bar of 6.
    expect(attempts.map((turn) => turn.trigger)).toEqual([
      "card_delivered",
      "card_delivered",
      "card_turn",
    ]);
    expect(JSON.parse(logs[2] ?? "{}")).toMatchObject({
      trigger: "card_turn",
      reason: "steps",
    });
  });

  test("a card the conversation already reviewed does not swallow a long round of something else", async () => {
    const { observe, seen } = harness({
      deliveredCard: async () => null,
      cardOfRound: async () => null,
      cardHandedInBefore: async () => "card-1",
      cardTurn: async (taskId) => ({
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: "r1",
        request: "x",
        reply: "y",
        steps: traceStepsOf(work(9)),
        failed: false,
        cardId: taskId,
        trigger: "card_accepted",
      }),
    });
    await observe(turnOf(work(7), { runId: "r1" }));
    // card-1 is reviewed now; the next round of the conversation is judged on its own steps.
    await observe(turnOf(work(20, "q"), { runId: "r2" }));
    expect(seen.map((turn) => turn.trigger)).toEqual([
      "card_delivered",
      "card_turn",
    ]);
  });

  test("a skip that is not about the step count (cooldown, daily limit) closes the card too", async () => {
    let tries = 0;
    const { observe, logs } = harness({
      retrospect: async (turn): Promise<RetroOutcome> => {
        if (turn.trigger === "card_delivered") tries += 1;
        return { outcome: "skipped" };
      },
      deliveredCard: async () => "card-1",
      cardOfRound: async () => "card-1",
      cardTurn: async (taskId) => ({
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: "r1",
        request: "x",
        reply: "y",
        steps: traceStepsOf(work(9)),
        failed: false,
        cardId: taskId,
        trigger: "card_accepted",
      }),
    });
    await observe(turnOf([...work(8), ...delivery("card-1")], { runId: "r1" }));
    await observe(turnOf(work(2), { runId: "r2" }));
    expect(tries).toBe(1);
    expect(JSON.parse(logs[1] ?? "{}")).toMatchObject({ reason: "card_done" });
  });
});

describe("what the review model is told to write", () => {
  test("a handed-in card says so, and a long command is kept whole enough to repeat", () => {
    const command = `python3 -c "${"x".repeat(200)}"`;
    const turn: RetroTurn = {
      ownerUserId: "u1",
      agentId: "bot",
      threadId: "t",
      runId: "r",
      request: "x",
      reply: "y",
      steps: traceStepsOf(call("a", "computer_run_command", { command }, "{}")),
      failed: false,
      trigger: "card_delivered",
    };
    const prompt = retroPrompt(turn, []);
    expect(prompt).toContain("handed this work in");
    expect(prompt).toContain("x".repeat(150));
  });
});

describe("the cooldown is per person, employee and card", () => {
  const turn = (cardId?: string): RetroTurn => ({
    ownerUserId: "u1",
    agentId: "bot",
    threadId: "t",
    runId: "r",
    request: "x",
    reply: "y",
    steps: traceStepsOf(work(20)),
    failed: false,
    trigger: "steps",
    ...(cardId ? { cardId } : {}),
  });
  const make = () => {
    let calls = 0;
    const run = createRetrospector({
      database: {} as never,
      selfSkill: () => ({}) as never,
      modelFor: async () => ({}) as never,
      call: async () => {
        calls += 1;
        return { text: '{"skill":null}' };
      },
      limiter: { take: () => true },
      log: () => {},
    });
    return { run, calls: () => calls };
  };

  test("another card is not held back by the first one; the same card is", async () => {
    const { run, calls } = make();
    expect(await run(turn("card-a"))).toEqual({ outcome: "nothing" });
    expect(await run(turn("card-a"))).toEqual({ outcome: "skipped" });
    expect(await run(turn("card-b"))).toEqual({ outcome: "nothing" });
    expect(calls()).toBe(2);
  });

  test("without a card it is per person and employee, as before", async () => {
    const { run, calls } = make();
    expect(await run(turn())).toEqual({ outcome: "nothing" });
    expect(await run(turn())).toEqual({ outcome: "skipped" });
    expect(calls()).toBe(1);
  });
});

describe("a card's round that was never handed in is reviewed on the card bar", () => {
  test("13 steps, kind task, no hand-in: reviewed, and said not to be handed in", async () => {
    const { observe, logs } = harness({
      retrospect: async (turn) => {
        expect(shouldRetrospect(turn, {})).toBe(true);
        return { outcome: "saved", id: "auto-1", status: "active" };
      },
    });
    await observe(turnOf(work(13)));
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      outcome: "saved",
      trigger: "card_turn",
      steps: 13,
    });
    const prompt = retroPrompt(
      {
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: "r1",
        request: "x",
        reply: "y",
        steps: traceStepsOf(work(13)),
        failed: false,
        trigger: "card_turn",
      },
      [],
    );
    expect(prompt).toContain("was not handed in");
    expect(prompt).not.toContain("handed this work in and the server");
  });

  test("5 steps: skipped for steps, and does not count as a conclusion", async () => {
    const { observe, logs } = harness({
      retrospect: async (turn) =>
        shouldRetrospect(turn, {})
          ? { outcome: "saved", id: "a", status: "active" }
          : { outcome: "skipped" },
    });
    expect(await observe(turnOf(work(5)))).toEqual({ outcome: "skipped" });
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      trigger: "card_turn",
      reason: "steps",
    });
  });

  test("a plain chat turn of 13 steps still needs 15", async () => {
    const seen: RetroTurn[] = [];
    const { observe, logs } = harness({
      retrospect: async (turn) => {
        seen.push(turn);
        return shouldRetrospect(turn, {})
          ? { outcome: "saved", id: "a", status: "active" }
          : { outcome: "skipped" };
      },
    });
    expect(await observe(turnOf(work(13), { kind: "chat" }))).toEqual({
      outcome: "skipped",
    });
    expect(seen[0]?.trigger).toBe("steps");
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ reason: "steps" });
  });

  test("shouldRetrospect: card_turn uses the card bar, which can be set", () => {
    const turn = (steps: number): RetroTurn => ({
      ownerUserId: "u1",
      agentId: "bot",
      threadId: "t",
      runId: "r",
      request: "x",
      reply: "y",
      steps: traceStepsOf(work(steps)),
      failed: false,
      trigger: "card_turn",
    });
    expect(shouldRetrospect(turn(6), {})).toBe(true);
    expect(shouldRetrospect(turn(5), {})).toBe(false);
    expect(
      shouldRetrospect(turn(4), { XIONGBAO_RETRO_CARD_MIN_STEPS: "4" }),
    ).toBe(true);
  });
});

describe("a review has a total time limit", () => {
  const delivered = (runId: string) =>
    turnOf(
      [
        ...work(8),
        ...call(
          "d1",
          "deliver_task",
          {},
          '{"delivered":true,"taskId":"card-1"}',
        ),
      ],
      { runId },
    );

  test("the limit is 8 minutes, can be set, and `off` means none", () => {
    expect(RETRO_TOTAL_TIMEOUT_MS_DEFAULT).toBe(480_000);
    expect(retroTotalTimeoutMs({})).toBe(480_000);
    expect(
      retroTotalTimeoutMs({ XIONGBAO_RETRO_TOTAL_TIMEOUT_MS: "90000" }),
    ).toBe(90_000);
    expect(
      retroTotalTimeoutMs({ XIONGBAO_RETRO_TOTAL_TIMEOUT_MS: " OFF " }),
    ).toBe(undefined);
    expect(
      retroTotalTimeoutMs({ XIONGBAO_RETRO_TOTAL_TIMEOUT_MS: "abc" }),
    ).toBe(480_000);
    expect(retroTotalTimeoutMs({ XIONGBAO_RETRO_TOTAL_TIMEOUT_MS: "0" })).toBe(
      480_000,
    );
  });

  test("a review that never comes back is given up at the limit: one `timeout` row, no content, nothing remembered", async () => {
    let abandon: AbortSignal | undefined;
    let calls = 0;
    const { observe, logs } = harness({
      logStart: () => {},
      totalTimeoutMs: 30,
      cardTurn: async (id) => ({
        ownerUserId: "u1",
        agentId: "bot",
        threadId: "t1",
        runId: "r1",
        request: "x",
        reply: "y",
        steps: traceStepsOf(work(8)),
        failed: false,
        cardId: id,
        trigger: "card_delivered",
      }),
      retrospect: (_turn, signal) => {
        calls += 1;
        abandon = signal;
        return new Promise<RetroOutcome>(() => {});
      },
    });
    const outcome = await observe(delivered("r1"));
    expect(outcome).toEqual({ outcome: "skipped" });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] as string)).toMatchObject({
      type: "retrospect",
      outcome: "timeout",
      runId: "r1",
      agentId: "bot",
      cardId: "card-1",
    });
    expect(logs[0]).not.toContain("把动作清单");
    expect(abandon?.aborted).toBe(true);
    // The card was not marked as reviewed: the next round of it is looked at.
    await observe(delivered("r2")).catch(() => {});
    expect(calls).toBe(2);
  });

  test("a hang before the review (reading the card) is also given up", async () => {
    const { observe, logs } = harness({
      logStart: () => {},
      totalTimeoutMs: 30,
      deliveredCard: () => new Promise<string | null>(() => {}),
    });
    await observe(delivered("r1"));
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
      type: "retrospect",
      outcome: "timeout",
    });
  });

  test("a review that finishes in time is logged as usual, and the timer does not fire later", async () => {
    const { observe, logs } = harness({
      logStart: () => {},
      totalTimeoutMs: 5_000,
    });
    await observe(turnOf(work(20)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] as string)).toMatchObject({
      type: "retrospect",
      outcome: "saved",
    });
  });

  test("`null` means no limit", async () => {
    const { observe, logs } = harness({
      logStart: () => {},
      totalTimeoutMs: null,
      retrospect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { outcome: "nothing" };
      },
    });
    await observe(turnOf(work(20)));
    expect(JSON.parse(logs[0] as string).outcome).toBe("nothing");
  });
});

describe("the observer says it was called", () => {
  test("one `retrospect-start` line with the run, no content, before anything else", async () => {
    const lines: string[] = [];
    const { observe, logs } = harness({ logStart: (line) => lines.push(line) });
    await observe(turnOf(work(20)));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: "retrospect-start",
      runId: "r1",
    });
    expect(lines[0]).not.toContain("汇总表");
    expect(logs).toHaveLength(1);
  });
});

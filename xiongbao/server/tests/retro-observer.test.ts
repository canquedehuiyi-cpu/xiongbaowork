import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import {
  CARD_DELIVERED_MIN_STEPS_DEFAULT,
  createRetroObserver,
  createRetrospector,
  type ObservedTurn,
  type RetroOutcome,
  type RetroTurn,
  retroCardMinSteps,
  retroPrompt,
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
    expect(seen[0]?.trigger).toBe("steps");
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
    expect(seen[0]?.trigger).toBe("steps");
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

  test("a round of a card nobody has handed in yet is an ordinary turn", async () => {
    const { observe, attempts, round } = board(() => 9);
    round("r1", "card-1");
    await observe(turnOf(work(5), { runId: "r1" }));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ trigger: "steps" });
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

import { describe, expect, test } from "bun:test";
import { LIGHT_MODEL_KEY, lightModelOf } from "../../shared/light-model";
import { isLightTurn, lightModelFor } from "../src/agents/light-model";
import { modelForRun } from "../src/copilot";
import { proactiveInitiator } from "../src/proactive/initiator";

/*
 * 期 1·1.5：员工设置里的「轻量模型」。巡检（主动检查）和跟进（员工给自己留的回头再看）这类轻量轮用它，
 * 不设就用平时的模型，不设回退默认。存在 agents.configuration.lightModel，不动表结构。
 */

describe("lightModelOf", () => {
  test("a non-empty string is the setting; anything else is unset", () => {
    expect(LIGHT_MODEL_KEY).toBe("lightModel");
    expect(lightModelOf({ lightModel: " gpt-mini " })).toBe("gpt-mini");
    for (const value of [
      undefined,
      null,
      "",
      "  ",
      5,
      {},
      { lightModel: "" },
      { lightModel: 3 },
      { hardModel: "x" },
    ])
      expect(lightModelOf(value)).toBeUndefined();
  });
});

describe("isLightTurn", () => {
  test("a proactive check-in and a follow-up are light", () => {
    expect(isLightTurn(proactiveInitiator("run-1"))).toBe(true);
    expect(isLightTurn({ kind: "routine", id: "follow-up:abc" })).toBe(true);
  });
  test("a person's turn, a routine firing and a goal's run are not", () => {
    expect(isLightTurn(undefined)).toBe(false);
    expect(isLightTurn(null)).toBe(false);
    expect(isLightTurn({ kind: "person" } as never)).toBe(false);
    expect(isLightTurn({ kind: "routine", id: "routine-9" })).toBe(false);
    expect(isLightTurn({ kind: "responsibility", id: "g" })).toBe(false);
  });
  test("a handoff takes the weight of what started the chain", () => {
    expect(
      isLightTurn({
        kind: "handoff",
        id: "bot-a",
        origin: proactiveInitiator("r"),
      }),
    ).toBe(true);
    expect(
      isLightTurn({
        kind: "handoff",
        id: "bot-a",
        origin: { kind: "routine", id: "routine-9" },
      }),
    ).toBe(false);
  });
});

describe("lightModelFor", () => {
  const light = proactiveInitiator("r");
  const make = (
    saved: string | undefined,
    allowed: string[] = ["mini", "big"],
  ) => {
    const reads: string[] = [];
    return {
      reads,
      deps: {
        read: async (agentId: string) => {
          reads.push(agentId);
          return saved;
        },
        allowed: async () => allowed,
      },
    };
  };

  test("a light turn on an employee with a light model uses it", async () => {
    const { deps } = make("mini");
    expect(await lightModelFor(deps, "bot", light)).toBe("mini");
  });

  test("not set: the usual model (undefined), not a made-up default", async () => {
    const { deps } = make(undefined);
    expect(await lightModelFor(deps, "bot", light)).toBeUndefined();
  });

  test("a turn that is not light never reads the setting", async () => {
    const { deps, reads } = make("mini");
    expect(await lightModelFor(deps, "bot", undefined)).toBeUndefined();
    expect(
      await lightModelFor(deps, "bot", { kind: "routine", id: "routine-9" }),
    ).toBeUndefined();
    expect(reads).toEqual([]);
  });

  test("no employee id: nothing to look up", async () => {
    const { deps, reads } = make("mini");
    expect(await lightModelFor(deps, undefined, light)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  test("a model the tenant no longer offers is not used", async () => {
    const { deps } = make("retired", ["mini"]);
    expect(await lightModelFor(deps, "bot", light)).toBeUndefined();
  });

  test("a failed read costs the setting, not the turn", async () => {
    const deps = {
      read: async () => {
        throw new Error("db down");
      },
      allowed: async () => ["mini"],
    };
    expect(await lightModelFor(deps, "bot", light)).toBeUndefined();
  });
});

describe("the employee reaches the model pick", () => {
  test("modelForRun hands the employee id to the pick", async () => {
    const seen: (string | undefined)[] = [];
    const base = { provider: "openai" as const, defaultModel: "big" };
    const run = await modelForRun(
      base,
      { threadId: "t", runId: "r" } as never,
      async (_input, agentId) => {
        seen.push(agentId);
        return { model: "mini", listed: true, forced: true };
      },
      "bot-7",
    );
    expect(seen).toEqual(["bot-7"]);
    expect(run.defaultModel).toBe("mini");
    expect(run.forced).toBe(true);
  });
});

// 上游 server/tests/provider-undecided.test.ts 的前两组（X5 移植）。第三组（插件路由按存储的提供商读行）随路由一起移植。
/**
 * "Which provider" has THREE ways of having no answer, and none of them is "Composio is active".
 *
 * `activeProvider` answers null when no key is set, when both keys are set and
 * `OPENBOT_BROKER_PROVIDER` names neither, and when the variable names a provider whose key is
 * unset. The entrypoint and the plugins routes both used to flatten all three with `?? "composio"`,
 * so a deployment part-way through a migration — both keys set, variable not yet set, which
 * `docs/plugins/arcade.md` calls legal — read its live Arcade rows through Composio's filter and
 * Composio's url parser. Those connections showed as absent and could not be revoked.
 *
 * What is asserted here: the three causes are told apart at the source; a deployment whose
 * configuration cannot name a provider takes the name from the rows it actually holds; rows
 * belonging to BOTH providers with nothing active is refused rather than resolved; and the plugins
 * routes read the one name the stores were built with instead of deciding a second time.
 */
import { describe, expect, test } from "bun:test";
import { providerDecision } from "../src/plugins/broker";
import { storedProvider } from "../src/plugins/provider-wiring";

describe("the three causes of an undecided provider are told apart", () => {
  test("no key at all is its own cause", () => {
    expect(providerDecision({})).toEqual({ kind: "unconfigured" });
  });

  test("one key and no variable is that provider, active", () => {
    expect(providerDecision({ arcadeApiKey: "k" })).toEqual({
      kind: "active",
      provider: "arcade",
    });
  });

  test("both keys with nothing named is ambiguous, not Composio", () => {
    expect(
      providerDecision({ composioApiKey: "c", arcadeApiKey: "a" }),
    ).toEqual({ kind: "ambiguous", configured: ["composio", "arcade"] });
  });

  test("a named provider whose key is unset is its own cause", () => {
    expect(
      providerDecision({ composioApiKey: "c", brokerProvider: "arcade" }),
    ).toEqual({ kind: "misnamed", named: "arcade" });
  });
});

describe("a deployment that cannot name a provider takes the name from its rows", () => {
  test("both keys, nothing named, Arcade rows: the rows are read as Arcade", () => {
    const decision = providerDecision({
      composioApiKey: "c",
      arcadeApiKey: "a",
    });
    expect(storedProvider(decision, ["arcade"])).toBe("arcade");
  });

  test("a key withdrawn after the fact still reads its own rows", () => {
    expect(storedProvider(providerDecision({}), ["arcade"])).toBe("arcade");
  });

  test("an active provider is the answer whatever the rows say", () => {
    expect(
      storedProvider(providerDecision({ composioApiKey: "c" }), ["composio"]),
    ).toBe("composio");
  });

  test("rows at both vendors and nothing active is refused, never resolved", () => {
    const decision = providerDecision({
      composioApiKey: "c",
      arcadeApiKey: "a",
    });
    expect(() => storedProvider(decision, ["composio", "arcade"])).toThrow(
      /OPENBOT_BROKER_PROVIDER/,
    );
    // It names the way out that exists — by hand, at a vendor — and never an unbuilt flow.
    let message = "";
    try {
      storedProvider(decision, ["composio", "arcade"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("手动删除对应的连接行");
    expect(message).not.toContain("sunset");
  });
});

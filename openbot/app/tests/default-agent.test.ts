import { describe, expect, test } from "bun:test";
import {
  defaultAgentId,
  defaultAgentProfile,
  PICKED_HARNESS_AGENT_ID,
} from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";

function agent(id: string, name = id): AgentProfile {
  return {
    avatarSeed: id,
    builtIn: id === "general-assistant",
    canManage: true,
    endpoint: id === PICKED_HARNESS_AGENT_ID ? "http://127.0.0.1:4201" : null,
    modelRef: null,
    persona: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    id,
    mine: true,
    name,
    roleDescription: "Role",
    systemOwned: false,
    title: name,
    visibility: "private",
  };
}

describe("default agent selection", () => {
  test("prefers the picked harness over the first visible agent", () => {
    const chosen = defaultAgentProfile([
      agent("general-assistant", "General Assistant"),
      agent(PICKED_HARNESS_AGENT_ID, "LangGraph"),
    ]);

    expect(chosen?.id).toBe(PICKED_HARNESS_AGENT_ID);
    expect(
      defaultAgentId([
        agent("general-assistant"),
        agent(PICKED_HARNESS_AGENT_ID),
      ]),
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  test("keeps the route-specific fallback when there is no picked harness", () => {
    const general = agent("general-assistant", "General Assistant");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([general, shared], shared)?.id).toBe(
      "shared-agent",
    );
  });

  test("falls back to the first agent when no picked harness or route fallback exists", () => {
    expect(
      defaultAgentId([agent("general-assistant"), agent("researcher")]),
    ).toBe("general-assistant");
  });

  test("the person's own 分身 comes before the route's shared fallback", () => {
    // Found on a real deployment: the home composer's default was the first shared coworker, a Bot
    // that belongs to nobody and so could never use the person's paired machine.
    const shared = {
      ...agent("general-assistant", "通用助手"),
      mine: false,
      visibility: "public" as const,
    };
    const avatar = agent("avatar-u1", "我的分身");

    expect(defaultAgentProfile([shared, avatar], shared)?.id).toBe("avatar-u1");
    expect(defaultAgentId([shared, avatar])).toBe("avatar-u1");
    // Only the person's own: somebody else's 分身 shared with them is not theirs to default to.
    expect(
      defaultAgentProfile([shared, { ...avatar, mine: false }], shared)?.id,
    ).toBe("general-assistant");
    // A package-picked harness is still the deployment's explicit choice.
    expect(
      defaultAgentProfile([avatar, agent(PICKED_HARNESS_AGENT_ID)], shared)?.id,
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  test("returns undefined when the roster is still absent", () => {
    expect(defaultAgentId(undefined)).toBeUndefined();
  });
});

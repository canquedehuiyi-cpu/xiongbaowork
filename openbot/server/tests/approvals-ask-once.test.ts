import { describe, expect, test } from "bun:test";
import { APPROVAL_GUIDANCE } from "@openbot/shared/bot-prompt";
import { builtInAgentConfiguration } from "../src/copilot";

/**
 * One ask for one consequential action.
 *
 * The person was asked twice for one delete: once by the Bot, on its own approval card, and again by
 * OpenBot's safety policy, which asks whatever came before. The policy's card names the exact action,
 * so it is the one that stays, and a Bot OpenBot runs is told not to ask first. That is safe only for
 * as long as the policy really asks about every action the Bot is told it asks about, which is what
 * the second half pins.
 */

const prompt = (() => {
  const configuration = builtInAgentConfiguration(
    {
      id: "personal-assistant",
      name: "Personal Assistant",
      type: "built_in",
      systemPrompt: "Help with everyday errands.",
    },
    { provider: "openai", defaultModel: "gpt-5.6-terra" },
    "openai-secret",
  );
  return "prompt" in configuration ? (configuration.prompt ?? "") : "";
})();

/*
 * M3: upstream's "a Bot OpenBot runs leaves the asking to OpenBot" cases are not here yet. They pin the
 * guidance against approvals/policy.ts's delete/archive/send/destructive floors, which the fork's policy
 * does not have until the plugins session's policy work lands; until then the guidance is not sent, and
 * this pins that, because telling a Bot not to ask while the gate does not either is the unsafe half.
 */
describe("until the policy asks about them, a Bot is not told OpenBot asks first", () => {
  test("the built-in prompt does not carry the approval guidance", () => {
    expect(APPROVAL_GUIDANCE).toContain("do not ask them first");
    expect(prompt).not.toContain(APPROVAL_GUIDANCE);
  });
});

// M3: upstream's "a send by keyboard asks, as a Send button does" waits for the approvals/policy.ts
// floors (plugins session).

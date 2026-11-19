import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Tool } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook } from "@testing-library/react";
import { BOT_CREATOR_SLUG } from "@/lib/agents/proposal";
import { type BotFacts, offerFor, useOfferedTo } from "@/lib/copilot/bot-offer";
import { OFFERED } from "@/lib/copilot/bot-tools";
import { settleReactWork } from "./settle-react-work";

/**
 * Drafting a coworker now goes through the server's staffing tools and a card the person confirms,
 * so the browser's own `save_bot` is no longer something a run is told it can call.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const tool = (name: string): Tool => ({
  name,
  description: "The built-in words.",
  parameters: { type: "object", properties: {} },
});

const CREATOR: BotFacts = {
  components: undefined,
  profile: undefined,
  capabilities: undefined,
  skills: new Set([BOT_CREATOR_SLUG]),
};

test("a bot with bot-creator is no longer offered save_bot", () => {
  renderHook(() => useOfferedTo(OFFERED));

  const names = offerFor(
    ["list_bots", "read_bot", "list_bot_skills", "save_bot"].map(tool),
    CREATOR,
  ).map((offered) => offered.name);

  expect(names).toEqual(["list_bots", "read_bot", "list_bot_skills"]);
});

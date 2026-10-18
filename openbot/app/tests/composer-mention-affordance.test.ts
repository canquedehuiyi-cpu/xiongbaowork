import { expect, test } from "bun:test";
import {
  AGENT_TRIGGER,
  COMMAND_TRIGGER,
} from "../src/components/channels/composer/draft";
import {
  type AgentOption,
  buildTriggers,
} from "../src/components/channels/composer/triggers";

/**
 * Ticket 019's loose end, closed by removing the promise rather than faking the routing.
 *
 * A one-coworker conversation is pinned to that coworker for the life of its thread: the send path
 * has no per-message target to honour, and giving one would be a change to the binding rather than to
 * the composer. The `@` trigger used to be registered regardless, so the key opened a menu whose only
 * entry was the one already answering — an affordance that says "you could pick somebody else" where
 * nothing could be picked. `buildTriggers` is the one place that decides which keys mean something,
 * so that is where the rule lives.
 */
const coworker = (id: string): AgentOption => ({
  id,
  name: `同事-${id}`,
  description: "",
});

const chars = (agents: AgentOption[]) =>
  buildTriggers({ agents, commands: [] }).map(
    (trigger) => (trigger as { char: string }).char,
  );

test("a roster with somebody to choose registers @", () => {
  expect(chars([coworker("a"), coworker("b")])).toContain(AGENT_TRIGGER);
});

test("a roster nobody can choose from registers no @, but keeps /", () => {
  const triggers = chars([]);
  expect(triggers).not.toContain(AGENT_TRIGGER);
  // The slash menu is a different promise and an honest one: it selects a skill's instruction for
  // THIS coworker, so it stands whether or not there is anybody else to talk to.
  expect(triggers).toContain(COMMAND_TRIGGER);
});

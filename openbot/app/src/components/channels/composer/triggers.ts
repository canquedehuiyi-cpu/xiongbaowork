import type { TriggerConfig, TriggerSuggestion } from "prompt-area/helpers";
import { commandTrigger, mentionTrigger } from "prompt-area/helpers";
import {
  AGENT_TRIGGER,
  COMMAND_TRIGGER,
  type CommandOption,
  CREW_CHIP_PREFIX,
} from "./draft";

/**
 * The composer's trigger registry.
 *
 * Adding a trigger means adding a factory here and passing its source down; composer rendering stays
 * independent of trigger semantics.
 */

export type AgentOption = {
  id: string;
  name: string;
  description?: string;
};

/**
 * One crew flow `@` can start, already named the way the menu should show it.
 *
 * A crew with several templates is several entries, so picking one never leaves the person guessing
 * which flow ran; the caller owns that wording.
 */
export type CrewOption = {
  templateId: string;
  label: string;
  description?: string;
};

/**
 * Narrows the agent roster to mention options, scoped to a channel's permitted agents when
 * `permittedIds` is given.
 *
 * Takes a structural shape so the composer stays independent of the queries module.
 */
export function toAgentOptions(
  profiles: readonly { id: string; name: string; title?: string }[] | undefined,
  permittedIds?: readonly string[],
): AgentOption[] {
  if (!profiles) {
    return [];
  }
  const permitted = permittedIds ? new Set(permittedIds) : null;
  return profiles
    .filter((profile) => !permitted || permitted.has(profile.id))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.title,
    }));
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * `@` selects the agent that answers this message, or the crew flow to start.
 *
 * `reopenOnChipClick` keeps an inserted mention editable without deleting and retyping.
 *
 * Crews come last in the list because a person typing a coworker's name should get the coworker:
 * a crew is a group of them, and its entry starts a run rather than a turn.
 */
export function agentTrigger(
  agents: readonly AgentOption[],
  crews: readonly CrewOption[] = [],
): TriggerConfig {
  return mentionTrigger({
    char: AGENT_TRIGGER,
    accessibilityLabel: "agent",
    reopenOnChipClick: true,
    emptyMessage: "No agents in this channel",
    onSearch: (query): TriggerSuggestion[] => [
      ...agents
        .filter((agent) => matches(query, agent.name, agent.description))
        .map((agent) => ({
          value: agent.id,
          label: agent.name,
          description: agent.description,
        })),
      ...crews
        .filter((crew) => matches(query, crew.label, crew.description))
        .map((crew) => ({
          value: `${CREW_CHIP_PREFIX}${crew.templateId}`,
          label: crew.label,
          description: crew.description,
        })),
    ],
    onSelect: (suggestion) => suggestion.label,
  });
}

/**
 * `/` is restricted to the start of a line, so a URL or a date in the middle of a sentence never
 * opens the dropdown. Selection resolves to a chip; `applyCommandChips` then rewrites the ones that
 * are really prompts or client actions.
 */
export function slashCommandTrigger(
  commands: readonly CommandOption[],
): TriggerConfig {
  return commandTrigger({
    char: COMMAND_TRIGGER,
    position: "start",
    accessibilityLabel: "command",
    emptyMessage: "No matching commands",
    onSearch: (query): TriggerSuggestion[] =>
      commands
        .filter((command) => matches(query, command.name, command.description))
        .map((command) => ({
          value: command.id,
          label: command.name,
          description: command.description,
        })),
    onSelect: (suggestion) => suggestion.label,
  });
}

export function buildTriggers({
  agents,
  commands,
  crews = [],
}: {
  agents: readonly AgentOption[];
  commands: readonly CommandOption[];
  crews?: readonly CrewOption[];
}): TriggerConfig[] {
  /*
   * No roster, no `@`. Registering the trigger with nothing behind it makes the key open an empty
   * menu that reads as "somebody else could answer this" and offers none — and in a conversation
   * pinned to one coworker that promise cannot be kept whatever is chosen: the message goes to the
   * coworker the thread belongs to. So the affordance goes away with the choice, rather than
   * standing there asking to be clicked.
   *
   * A crew is a reason to bring the key back on its own: picking one starts a run rather than
   * answering this message, so it keeps no promise the pinned thread would break.
   */
  return [
    ...(agents.length > 0 || crews.length > 0
      ? [agentTrigger(agents, crews)]
      : []),
    slashCommandTrigger(commands),
  ];
}

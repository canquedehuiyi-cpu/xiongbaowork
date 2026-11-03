import type { TriggerConfig, TriggerSuggestion } from "prompt-area/helpers";
import { commandTrigger, mentionTrigger } from "prompt-area/helpers";
import {
  AGENT_TRIGGER,
  COMMAND_TRIGGER,
  type CommandOption,
  CREW_CHIP_PREFIX,
  memberChipValue,
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
  /**
   * Set when this entry is the coworker listed under a Group rather than on its own (spec B1). It is
   * the same coworker either way: picking it addresses `id`, exactly as the plain entry does.
   */
  group?: { id: string; name: string };
};

/**
 * One Group as the `@` menu expands it (spec B1, D3): its name and the members this screen may name.
 *
 * Only members already on the screen's own roster are here — that roster is who this person can see
 * (or, in a conversation with several coworkers, who is in it) — so a Group never smuggles in a
 * coworker the plain list would not offer.
 */
export type GroupOption = {
  groupId: string;
  name: string;
  members: AgentOption[];
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

/**
 * Expands the workspace's Groups against a screen's roster.
 *
 * Members keep the order the person put them in. A member the roster does not hold is left out, and a
 * Group left with nobody is left out with it, rather than shown as a heading over an empty list.
 */
export function toGroupOptions(
  groups:
    | readonly {
        id: string;
        name: string;
        members: readonly { agentId: string; position: number }[];
      }[]
    | undefined,
  roster: readonly AgentOption[],
): GroupOption[] {
  if (!groups) {
    return [];
  }
  const byId = new Map(
    roster
      .filter((agent) => !agent.group)
      .map((agent) => [agent.id, agent] as const),
  );
  return groups.flatMap((group) => {
    const members = [...group.members]
      .sort((a, b) => a.position - b.position)
      .flatMap((member) => {
        const agent = byId.get(member.agentId);
        return agent ? [agent] : [];
      });
    return members.length > 0
      ? [{ groupId: group.id, name: group.name, members }]
      : [];
  });
}

/**
 * The roster `@` offers: every coworker on their own, then each Group's members under it.
 *
 * A member is an ordinary coworker entry labelled "成员 · 组名", so whatever a screen does with a picked
 * coworker — start a conversation, address one Bot in a group, hand work off in a 1:1 — it does with a
 * member too, without knowing Groups exist.
 */
export function withGroupMembers(
  roster: readonly AgentOption[],
  groups: readonly GroupOption[],
): AgentOption[] {
  return [
    ...roster,
    ...groups.flatMap((group) =>
      group.members.map((member) => ({
        ...member,
        group: { id: group.groupId, name: group.name },
      })),
    ),
  ];
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
    emptyMessage: "这个频道里还没有员工",
    onSearch: (query): TriggerSuggestion[] => [
      ...agents
        .filter((agent) =>
          matches(query, agent.name, agent.description, agent.group?.name),
        )
        .map((agent) => toSuggestion(agent)),
      ...crews
        .filter((crew) => matches(query, crew.label, crew.description))
        .map((crew) => ({
          value: `${CREW_CHIP_PREFIX}${crew.templateId}`,
          label: crew.label,
          description: crew.description,
        })),
    ],
    // A Group member's chip reads as the coworker it addresses, not as "成员 · 组名".
    onSelect: (suggestion) => {
      const data = suggestion.data as { name?: unknown } | undefined;
      return typeof data?.name === "string" ? data.name : suggestion.label;
    },
  });
}

function toSuggestion(agent: AgentOption): TriggerSuggestion {
  if (!agent.group) {
    return {
      value: agent.id,
      label: agent.name,
      description: agent.description,
    };
  }
  return {
    // Keyed per Group: the same coworker can sit on its own and under several Groups at once.
    value: memberChipValue(agent.group.id, agent.id),
    label: `${agent.name} · ${agent.group.name}`,
    description: agent.description
      ? `组「${agent.group.name}」成员 · ${agent.description}`
      : `组「${agent.group.name}」成员`,
    data: { name: agent.name },
  };
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
    emptyMessage: "没有匹配的命令",
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

import { expect, test } from "bun:test";
import { chip, type TriggerSuggestion, text } from "prompt-area/helpers";
import {
  AGENT_TRIGGER,
  COMMAND_TRIGGER,
  CREW_CHIP_PREFIX,
  chipAgentId,
  memberChipValue,
  toDraft,
} from "../src/components/channels/composer/draft";
import {
  type AgentOption,
  buildTriggers,
  type CrewOption,
  toGroupOptions,
  withGroupMembers,
} from "../src/components/channels/composer/triggers";
import { sendChannelDraft } from "../src/lib/channels/dispatch";

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
  avatarSeed: id,
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

/*
 * Spec B1 / D3: the `@` menu lists the workspace's Groups expanded into their members.
 *
 * A member is an ordinary coworker entry labelled "成员 · 组名": picking it addresses that coworker,
 * so every screen — the home composer, a group conversation, a 1:1 conversation's dispatch — routes it
 * exactly as it routes the plain entry. Members are intersected with the screen's own roster, so a
 * Group can never offer a coworker this person cannot see.
 */
const visibleRoster: AgentOption[] = [
  { id: "pinned", name: "小熊", description: "助理", avatarSeed: "pinned" },
  { id: "reviewer", name: "阿审", description: "审核", avatarSeed: "reviewer" },
  { id: "writer", name: "阿写", description: "写作", avatarSeed: "writer" },
];

const workspaceGroups = [
  {
    id: "g-rd",
    name: "研发组",
    description: null,
    // Out of order on purpose: the menu follows `position`, not the array.
    members: [
      { agentId: "writer", position: 2 },
      { agentId: "reviewer", position: 1 },
      // Somebody else's private coworker: listed in the Group, invisible to this person.
      { agentId: "hidden", position: 3 },
    ],
  },
  {
    id: "g-ghost",
    name: "隐形组",
    description: null,
    members: [{ agentId: "hidden", position: 1 }],
  },
];

const crews: CrewOption[] = [
  { templateId: "tpl-1", label: "研发组", description: "启动流程 · 3 步" },
];

function mentionMenu(query: string) {
  const groups = toGroupOptions(workspaceGroups, visibleRoster);
  const trigger = buildTriggers({
    agents: withGroupMembers(visibleRoster, groups),
    commands: [],
    crews,
  }).find(
    (candidate) => (candidate as { char: string }).char === AGENT_TRIGGER,
  );
  if (!trigger?.onSearch) throw new Error("@ is not registered");
  return trigger.onSearch(query, {
    signal: new AbortController().signal,
  }) as TriggerSuggestion[];
}

test("a Group expands into its visible members, in the order the person put them", () => {
  const groups = toGroupOptions(workspaceGroups, visibleRoster);
  expect(groups).toEqual([
    {
      groupId: "g-rd",
      name: "研发组",
      members: [visibleRoster[1], visibleRoster[2]],
    },
  ]);
  // A Group whose every member is invisible is not shown as a heading over nobody.
  expect(groups.some((group) => group.groupId === "g-ghost")).toBe(false);
  expect(toGroupOptions(undefined, visibleRoster)).toEqual([]);
});

test("the @ menu lists every coworker, then each Group's members labelled 成员 · 组名, then crews", () => {
  const menu = mentionMenu("");
  expect(menu.map((entry) => entry.label)).toEqual([
    "小熊",
    "阿审",
    "阿写",
    "阿审 · 研发组",
    "阿写 · 研发组",
    // The crew flow entry is untouched: same value, label and description as before Groups.
    "研发组",
  ]);
  const crew = menu.at(-1);
  expect(crew).toEqual({
    value: `${CREW_CHIP_PREFIX}tpl-1`,
    label: "研发组",
    description: "启动流程 · 3 步",
  });
  // Every row is distinct, so the menu can key them even when a coworker is listed twice.
  const values = menu.map((entry) => entry.value);
  expect(new Set(values).size).toBe(values.length);
  expect(
    menu.find((entry) => entry.label === "阿审 · 研发组")?.description,
  ).toBe("组「研发组」成员 · 审核");
});

test("an invisible member is absent from the @ menu, whatever is typed", () => {
  for (const query of ["", "hidden", "研发", "隐形"]) {
    const menu = mentionMenu(query);
    expect(menu.some((entry) => entry.value.includes("hidden"))).toBe(false);
    expect(menu.some((entry) => entry.label.includes("隐形组"))).toBe(false);
  }
});

test("typing matches a member by its own name or by its Group's name", () => {
  // The Group's name brings up its members, and the crew of the same name stays beside them.
  expect(mentionMenu("研发").map((entry) => entry.label)).toEqual([
    "阿审 · 研发组",
    "阿写 · 研发组",
    "研发组",
  ]);
  // The member's own name finds it both on its own and under its Group.
  expect(mentionMenu("阿审").map((entry) => entry.label)).toEqual([
    "阿审",
    "阿审 · 研发组",
  ]);
  expect(mentionMenu("没有这个人")).toEqual([]);
});

test("picking a Group member addresses that coworker and its chip reads as the coworker's name", () => {
  const member = mentionMenu("阿审").find(
    (entry) => entry.label === "阿审 · 研发组",
  );
  if (!member) throw new Error("member missing");
  const trigger = buildTriggers({
    agents: withGroupMembers(
      visibleRoster,
      toGroupOptions(workspaceGroups, visibleRoster),
    ),
    commands: [],
  })[0];
  expect(trigger?.onSelect?.(member)).toBe("阿审");

  const draft = toDraft([
    chip({ trigger: AGENT_TRIGGER, value: member.value, displayText: "阿审" }),
    text(" 帮我看看这份合同"),
  ]);
  expect(draft.agentId).toBe("reviewer");
  expect(draft.crewTemplateId).toBeNull();
  expect(draft.text).toBe("@阿审 帮我看看这份合同");
  // An agent id is recovered whole even if it carries the separator itself.
  expect(chipAgentId(memberChipValue("g:1", "agent:x"))).toBe("agent:x");
  expect(chipAgentId("plain-id")).toBe("plain-id");
});

test("in a 1:1 conversation a Group member goes through @dispatch, exactly as the plain entry does", async () => {
  const dispatched: string[] = [];
  let said = 0;
  const member = mentionMenu("阿写").find(
    (entry) => entry.label === "阿写 · 研发组",
  );
  if (!member) throw new Error("member missing");
  const draft = toDraft([
    chip({ trigger: AGENT_TRIGGER, value: member.value, displayText: "阿写" }),
    text(" 写一份周报"),
  ]);
  const sent = await sendChannelDraft(draft, {
    channel: { id: "c1", agentIds: ["pinned"] },
    pinnedAgentId: "pinned",
    newId: () => "m1",
    say: async () => {
      said += 1;
    },
    dispatch: async (input) => {
      dispatched.push(input.agentId);
      return { taskId: "t1", runId: "r1", queued: true };
    },
  });
  expect(sent.kind).toBe("dispatched");
  expect(dispatched).toEqual(["writer"]);
  expect(said).toBe(0);
});

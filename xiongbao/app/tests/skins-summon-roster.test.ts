/*
 * 召唤员工 Task 10: the skins' own employee lists hold what the default sidebar's 员工 holds — the
 * person's own employees. A preset original (summoned or not) and a 分身 still 待召唤 are summoned
 * on 人才市场, so they are not rows that would open an empty conversation with the original.
 */
import { expect, test } from "bun:test";
import { isOnRoster } from "@/components/app-sidebar/roster";
import type { AgentProfile } from "@/lib/agents/queries";
import { dotOrder } from "@/skins/opendots/sidebar";

const agent = (id: string, extra: Partial<AgentProfile> = {}) =>
  ({
    id,
    name: id,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    hidden: false,
    pinned: false,
    mine: true,
    ...extra,
  }) as AgentProfile;

const AGENTS = [
  agent("own"),
  agent("copy", { summonedFrom: "preset-lawyer", summonKind: null }),
  agent("preset-doctor", {
    mine: false,
    summonKind: "preset",
    summoned: false,
  }),
  agent("preset-lawyer", { mine: false, summonKind: "preset", summoned: true }),
  agent("avatar", { summonKind: "avatar", summoned: false }),
  agent("avatar-summoned", { summonKind: "avatar", summoned: true }),
  agent("colleague", { mine: false }),
];

test("on the roster: the person's own and other people's coworkers, not a preset or a 分身 still 待召唤", () => {
  expect(AGENTS.filter(isOnRoster).map((profile) => profile.id)).toEqual([
    "own",
    "copy",
    "avatar-summoned",
    "colleague",
  ]);
});

test("OpenDots' 我的员工 leaves out preset originals and a 分身 still 待召唤", () => {
  expect(dotOrder(AGENTS).map((profile) => profile.id)).toEqual([
    "own",
    "copy",
    "avatar-summoned",
    "colleague",
  ]);
});

import { expect, test } from "bun:test";
import type { AgentProfile } from "../src/agents/profile-types";
import { coworkerFaceAccess } from "../src/portraits/coworker-access";

/** A coworker's face answers to the coworker's own rules: seen as it is seen, changed as it is managed. */
const profile = (overrides: Partial<AgentProfile>) =>
  ({
    id: "bot",
    ownerUserId: "owner",
    visibility: "public",
    systemOwned: false,
    deletedAt: null,
    ...overrides,
  }) as AgentProfile;

const profiles = {
  mine: profile({ id: "mine", ownerUserId: "me" }),
  theirs: profile({ id: "theirs", ownerUserId: "someone" }),
  system: profile({ id: "system", ownerUserId: "me", systemOwned: true }),
  hiddenMine: profile({ id: "hidden-mine", ownerUserId: "me" }),
};
const access = coworkerFaceAccess({
  list: async (_actor, hidden) =>
    hidden
      ? [profiles.hiddenMine]
      : [profiles.mine, profiles.theirs, profiles.system],
  get: async (_actor, id) =>
    Object.values(profiles).find((entry) => entry.id === id) ?? null,
});
const me = { id: "me", email: "me@example.test", role: "user" as const };
const admin = {
  id: "boss",
  email: "boss@example.test",
  role: "admin" as const,
};

test("the faces one may see are the coworkers one may see, hidden ones included", async () => {
  expect([...(await access.visible(me))].sort()).toEqual([
    "hidden-mine",
    "mine",
    "system",
    "theirs",
  ]);
  expect(await access.canSee(me, "theirs")).toBe(true);
  expect(await access.canSee(me, "nobody")).toBe(false);
});

test("a face is changed by whoever may manage the coworker, never on a system coworker", async () => {
  expect(await access.canChange(me, "mine")).toBe(true);
  expect(await access.canChange(me, "theirs")).toBe(false);
  expect(await access.canChange(admin, "theirs")).toBe(true);
  expect(await access.canChange(me, "system")).toBe(false);
  expect(await access.canChange(me, "nobody")).toBe(false);
});

import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  tasks,
  users,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
import type { TaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { createWakerGroupRoutes } from "../src/waker-groups/routes";
import {
  createWakerGroupStore,
  WakerGroupMemberError,
  WakerGroupNameError,
  WakerGroupNameTakenError,
} from "../src/waker-groups/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 023 acceptance (spec D1-D4): a crew is a name over an ordered set of coworkers, and it
 * belongs to exactly one workspace.
 *
 * The routes are the real ones and the database enforces row-level security, because the thing worth
 * proving is not that the store filters — it never does — but that a tenant asking for a group id it
 * found somewhere else is handed nothing. `waker_group_members` has no tenant column of its own, so
 * that answer comes from 0070's EXISTS policy and nowhere else in the code.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenantA = `wg-${suite}-a`;
const tenantB = `wg-${suite}-b`;
const store = createWakerGroupStore(database);

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: `${suite}-tester`,
    email: `${suite}-tester@example.test`,
    name: "Tester",
    role: "owner",
  });
  await next();
};
const routes = createWakerGroupRoutes(store, requireUser);

/** The board, real routes again: a crew has to be something its screen can filter by. */
const board = createTaskRoutes(database, requireUser, {
  reviewed: async () => true,
  archived: async () => true,
} as unknown as TaskProjector);

const post = (body: unknown) =>
  new Request("http://openbot.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/*
 * The coworkers the roster is allowed to name.
 *
 * A crew may only be a name over coworkers this workspace can see, so the ids these tests write have
 * to exist — the row-level policy is what decides that, which is exactly the point of the check. Each
 * row is written inside its own workspace's frame, because the INSERT check refuses a row stamped for
 * somebody else.
 */
const ownedByA = [
  "agent-a",
  "agent-b",
  "agent-c",
  "agent-x",
  "agent-y",
  "agent-1",
  "agent-2",
  "board-1",
  "board-2",
];
const ownedByB = ["agent-of-b-only"];

await runAsTenant(tenantA, async () => {
  await database
    .insert(users)
    .values({ id: tenantA, email: `${tenantA}@example.test` })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values(
      ownedByA.map((id) => ({
        id,
        name: `${id} 号员工`,
        type: "built_in",
        configuration: {},
      })),
    )
    .onConflictDoNothing();
});
await runAsTenant(tenantB, async () => {
  await database
    .insert(users)
    .values({ id: tenantB, email: `${tenantB}@example.test` })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({
      id: ownedByB[0] ?? "",
      name: "别家的员工",
      type: "built_in",
      configuration: {},
    })
    .onConflictDoNothing();
});

/** Every crew the tests below name over an ordered set of coworkers. */
test("a crew keeps its members in the order they were put in", async () => {
  const group = await runAsTenant(tenantA, () =>
    store.create({
      name: "编程小组",
      description: "Backend, reviewer and QA.",
    }),
  );
  expect(group.members).toEqual([]);

  // Deliberately out of order: a pipeline crew reads as a sequence, so the position it was given is
  // the answer, not the order the roster happened to come back in.
  const sized = await runAsTenant(tenantA, () =>
    store.setMembers(group.id, ["agent-c", "agent-a", "agent-b"]),
  );
  expect(sized?.members.map((member) => member.agentId)).toEqual([
    "agent-c",
    "agent-a",
    "agent-b",
  ]);

  const listed = await runAsTenant(tenantA, () => store.list());
  expect(listed.map((entry) => entry.name)).toEqual(["编程小组"]);
  expect(listed[0]?.description).toBe("Backend, reviewer and QA.");
  expect(listed[0]?.members).toHaveLength(3);
});

test("a foreign workspace cannot see the crew, or the people in it", async () => {
  const group = await runAsTenant(tenantA, () =>
    store.create({ name: "私有小组" }),
  );
  await runAsTenant(tenantA, () =>
    store.setMembers(group.id, ["agent-x", "agent-y"]),
  );

  const theirs = await runAsTenant(tenantB, () => store.list());
  expect(theirs).toEqual([]);

  /*
   * The read that matters. The membership rows carry no tenant of their own, so the only thing
   * standing between a guessed group id and another workspace's roster is the policy migration 0070
   * wrote — an EXISTS against the group the row belongs to. Without this assertion that boundary is
   * shipped uncovered, and every other test here would still pass.
   */
  const borrowed = await runAsTenant(tenantB, () =>
    database
      .select()
      .from(wakerGroupMembers)
      .where(eq(wakerGroupMembers.groupId, group.id)),
  );
  expect(borrowed).toEqual([]);

  expect(await runAsTenant(tenantB, () => store.remove(group.id))).toBeFalse();
  expect(
    await runAsTenant(tenantB, () => store.setMembers(group.id, ["agent-z"])),
  ).toBeNull();
});

/**
 * The boundary the roster itself was missing (ticket 025's standards review).
 *
 * `waker_group_members.agent_id` is plain text, so a workspace could name a coworker it cannot see —
 * and the crew would then list somebody else's employee as one of its own, offer it as the owner of a
 * pipeline step, and filter the board by a person that workspace cannot even read. The check asks the
 * same visibility the picker's list is built under, so the two cannot disagree about what can be named.
 */
test("a crew cannot be pointed at another workspace's coworker", async () => {
  const group = await runAsTenant(tenantA, () =>
    store.create({ name: "越界小组" }),
  );
  await runAsTenant(tenantA, () =>
    store.setMembers(group.id, ["agent-a", "agent-b"]),
  );

  await expect(
    runAsTenant(tenantA, () =>
      store.setMembers(group.id, ["agent-a", ownedByB[0] ?? ""]),
    ),
  ).rejects.toBeInstanceOf(WakerGroupMemberError);

  /*
   * Refused, not half-applied. A roster rewritten as far as the first id and then abandoned would
   * leave the crew missing `agent-b` while the answer said nothing had changed — the shape of bug
   * that survives a review of the refusal alone.
   */
  const kept = await runAsTenant(tenantA, () => store.list());
  expect(
    kept
      .find((entry) => entry.id === group.id)
      ?.members.map((member) => member.agentId),
  ).toEqual(["agent-a", "agent-b"]);

  // And the same rule stands behind the route, with a sentence rather than a 500.
  const created = await runAsTenant(tenantA, async () =>
    (await routes.request(post({ name: "越界小组路由" }))).json(),
  );
  const response = await runAsTenant(
    tenantA,
    async () =>
      await routes.request(
        new Request(`http://openbot.test/${created.group.id}/members`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentIds: [ownedByB[0]] }),
        }),
      ),
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain(
    "has to be one this workspace can use",
  );
});

test("one workspace does not get to name two crews the same thing", async () => {
  await runAsTenant(tenantA, () => store.create({ name: "重名小组" }));

  await expect(
    runAsTenant(tenantA, () => store.create({ name: "重名小组" })),
  ).rejects.toBeInstanceOf(WakerGroupNameTakenError);

  // Two workspaces naming the same crew is not a collision: the index is per tenant, so the second
  // one keeps its own group with its own roster.
  const other = await runAsTenant(tenantB, () =>
    store.create({ name: "重名小组" }),
  );
  expect(other.name).toBe("重名小组");

  await expect(
    runAsTenant(tenantA, () => store.create({ name: "   " })),
  ).rejects.toBeInstanceOf(WakerGroupNameError);
});

test("the routes carry the same rules as the store", async () => {
  const created = await runAsTenant(tenantA, () =>
    routes.request(post({ name: "路线小组", description: "  " })),
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    group: { id: string; name: string; description: string | null };
  };
  expect(body.group.name).toBe("路线小组");
  // A blank purpose is the same as no purpose: it would otherwise render as an empty paragraph.
  expect(body.group.description).toBeNull();

  const clash = await runAsTenant(tenantA, () =>
    routes.request(post({ name: "路线小组" })),
  );
  expect(clash.status).toBe(409);

  const nameless = await runAsTenant(tenantA, () => routes.request(post({})));
  expect(nameless.status).toBe(400);

  const members = await runAsTenant(tenantA, () =>
    routes.request(
      new Request(`http://openbot.test/${body.group.id}/members`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds: ["agent-1", "agent-1", "agent-2"] }),
      }),
    ),
  );
  expect(members.status).toBe(200);
  const shaped = (await members.json()) as {
    group: { members: { agentId: string }[] };
  };
  expect(shaped.group.members.map((member) => member.agentId)).toEqual([
    "agent-1",
    "agent-2",
  ]);

  const stranger = await runAsTenant(tenantB, () =>
    routes.request(
      new Request(`http://openbot.test/${body.group.id}/members`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds: [] }),
      }),
    ),
  );
  expect(stranger.status).toBe(404);

  const retired = await runAsTenant(tenantA, () =>
    routes.request(
      new Request(`http://openbot.test/${body.group.id}`, { method: "DELETE" }),
    ),
  );
  expect(retired.status).toBe(200);
});

test("the board answers to a crew's name, not only to one coworker", async () => {
  const group = await runAsTenant(tenantA, () =>
    store.create({ name: "看板小组" }),
  );
  const roster = ["board-1", "board-2"];
  const crewed = await runAsTenant(tenantA, () =>
    store.setMembers(group.id, roster),
  );
  // The filter below uses the roster the write returned, not the one the create did: a crew is
  // narrowed by who is in it now.
  expect(crewed?.members.map((member) => member.agentId)).toEqual(roster);
  await runAsTenant(tenantA, () =>
    database.insert(tasks).values([
      {
        title: "Writes the migration",
        executorAgentId: "board-1",
        source: "chat",
      },
      { title: "Reviews it", executorAgentId: "board-2", source: "chat" },
      {
        title: "Somebody else's work",
        executorAgentId: "board-3",
        source: "chat",
      },
    ]),
  );

  const titles = async (path: string) => {
    const response = await runAsTenant(tenantA, () =>
      board.request(new Request(`http://openbot.test/${path}`)),
    );
    const body = (await response.json()) as { tasks: { title: string }[] };
    return body.tasks.map((task) => task.title).sort();
  };

  expect(
    await titles(
      `?executors=${crewed!.members.map((member) => member.agentId).join(",")}`,
    ),
  ).toEqual(["Reviews it", "Writes the migration"]);
  expect(await titles("?executors=board-1")).toEqual(["Writes the migration"]);
  // Unfiltered the third card is on the board; the crew narrows the same list rather than replacing it.
  expect(await titles("")).toEqual([
    "Reviews it",
    "Somebody else's work",
    "Writes the migration",
  ]);
  // A crew with nobody in it is an answer, not a missing filter.
  expect(await titles("?executors=")).toEqual([]);
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await runAsTenant(tenant, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, tenant));
      await database.delete(agents).where(eq(agents.tenantId, tenant));
      await database.delete(users).where(eq(users.id, tenant));
      // Members follow by cascade, and the policy admits only this tenant's rows.
      await database
        .delete(wakerGroups)
        .where(eq(wakerGroups.tenantId, tenant));
    });
  }
});

/**
 * The finding the standards review turned up: the row-level policy admits `system` in its WITH
 * CHECK — the platform scope writes through the same statement — so "came back in my list" is not
 * "mine". The store now compares the row's tenant before any write; this is the test for that, and
 * it was withdrawn once already for leaving residue, so it names itself and cleans itself up.
 */
test("a platform-owned crew is listed, and not one character writable", async () => {
  const platformName = `平台示例组-${suite}`;
  const [seeded] = await runAsTenant("system", () =>
    database
      .insert(wakerGroups)
      .values({ tenantId: "system", name: platformName, description: null })
      .returning({ id: wakerGroups.id }),
  );
  if (!seeded) throw new Error("could not seed the platform group");

  // Readable on purpose: a crew the platform ships is supposed to show up beside a person's own.
  const listed = await runAsTenant(tenantA, () => store.list());
  expect(listed.map((group) => group.name)).toContain(platformName);

  expect(
    await runAsTenant(tenantA, () =>
      store.setMembers(seeded.id, ["agent-should-not-stick"]),
    ),
  ).toBeNull();
  expect(await runAsTenant(tenantA, () => store.remove(seeded.id))).toBeFalse();

  const after = await runAsTenant(tenantA, () => store.list());
  expect(after.find((group) => group.id === seeded.id)?.members).toEqual([]);
});

afterAll(async () => {
  // `system` rows are visible to every tenant, so one left behind shows up in the next run's list
  // and breaks an assertion that compares a whole list for reasons that have nothing to do with
  // isolation. This suite's platform row is named after the suite, so it is findable here.
  await runAsTenant("system", () =>
    database
      .delete(wakerGroups)
      .where(eq(wakerGroups.name, `平台示例组-${suite}`)),
  );
});

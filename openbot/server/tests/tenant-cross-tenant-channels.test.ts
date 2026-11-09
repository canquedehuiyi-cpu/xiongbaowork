import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec test decision #7's conversation face: a stranger may not read, post to, or delete a channel
 * they are not in, and each refusal is a 404.
 *
 * The first case measures which layer actually guards the row. Every request runs in the signed-in
 * person's frame (the stub below opens it, as the real `requireUser` does), so a person's channel
 * is stamped with them and row security keeps a stranger from even seeing it: for that channel the
 * store's own membership join is never reached. So a second channel is kept in the shape this file
 * was written for before G01-E: stamped `system` (seeded by the platform, as legacy and catalogue
 * rows are), which every person's SELECT admits, with only the owner's membership. There the
 * membership join inside each store method is the only wall, and the same cases are asked of it.
 * A shared group (`team`, G01-E P11) is read only by its members, which the last cases pin.
 *
 * Deletion is the damage case. A stranger's DELETE that answered 404 while stamping `deleted_at`
 * would empty the conversation out of its owner's sidebar and leave them no signal it happened.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("tenant-cross-tenant-test"),
);
const suite = randomUUID().slice(0, 8);
const owner = `channel-tenant-${suite}-owner`;
const stranger = `channel-tenant-${suite}-stranger`;
const teammate = `channel-tenant-${suite}-teammate`;
const channelIds: string[] = [];
const agentIds: string[] = [];

const routesFor = (actorId: string) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, role: "user" as const });
    // A signed-in request runs in the person's own frame.
    await runAsTenant(actorId, () => next());
  };
  return createChannelRoutes(store, requireUser);
};

const call = (
  actorId: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
) =>
  routesFor(actorId).request(
    new Request(`http://openbot.test/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );

/**
 * The channel's own row, all of it, as one comparable string.
 *
 * Deliberately not a projection over named columns: this is the check that a refused write moved
 * nothing, and a check that lists fields is only as complete as the person who wrote the list.
 */
const rowOfChannel = () =>
  runAsTenant(owner, async () => {
    const [row] = await database
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return row;
  });

let channelId = "";
let groupId = "";
let legacyId = "";
let seenByStrangerDirectly: string | undefined;
let legacySeenByStrangerDirectly: string | undefined;

/** The legacy channel's own row, all of it, as one comparable string (see `rowOfChannel`). */
const rowOfLegacy = () =>
  runAsTenant(owner, async () => {
    const [row] = await database
      .select()
      .from(channels)
      .where(eq(channels.id, legacyId))
      .limit(1);
    return row;
  });

beforeAll(async () => {
  for (const tenantId of [owner, stranger, teammate]) {
    await runAsTenant(tenantId, () =>
      database.insert(users).values({
        id: tenantId,
        email: `${tenantId}@example.test`,
        name: "Cross-tenant channel fixture",
      }),
    );
  }

  // Written in the owner's own frame, as the owner's request would write them.
  const coworker = await runAsTenant(owner, () =>
    profileStore.create(
      { id: owner, role: "user" },
      {
        name: `Coworker ${suite}`,
        title: "Answers the mail",
        roleDescription: "Reads the inbox and drafts replies.",
        visibility: "private",
      },
    ),
  );
  agentIds.push(coworker.id);
  const channel = await runAsTenant(owner, () =>
    store.create({ id: owner, role: "user" }, [coworker.id]),
  );
  channelId = channel.id;
  channelIds.push(channel.id);

  // A shared group the owner started, with the teammate in it and the stranger not.
  const group = await runAsTenant(owner, async () => {
    const created = await store.create(
      { id: owner, role: "user" },
      [coworker.id],
      { shared: true },
    );
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: teammate,
      tenantId: TEAM_TENANT,
    });
    return created;
  });
  groupId = group.id;
  channelIds.push(group.id);

  seenByStrangerDirectly = await runAsTenant(stranger, async () => {
    const [row] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return row?.id;
  });

  /*
   * The legacy channel: `system`-stamped, every row of it, with only the owner in it. The stranger
   * keeps a mapping of their own to it, as somebody taken out of a conversation does (the store
   * leaves it; every read joins the membership), so the mapping join cannot stand in for the
   * membership join either.
   */
  legacyId = `channel-tenant-${suite}-legacy`;
  channelIds.push(legacyId);
  await runAsTenant("platform", async () => {
    await database.insert(channels).values({
      id: legacyId,
      name: "Legacy conversation",
      description: "Written before conversations had owners.",
      tenantId: "system",
    });
    await database.insert(channelMemberships).values({
      channelId: legacyId,
      userId: owner,
      tenantId: "system",
    });
    await database.insert(channelAgents).values({
      channelId: legacyId,
      agentId: coworker.id,
      tenantId: "system",
    });
    await database.insert(intelligenceChannelMappings).values([
      {
        userId: owner,
        channelId: legacyId,
        threadId: `${legacyId}-owner-thread`,
        tenantId: "system",
      },
      {
        userId: stranger,
        channelId: legacyId,
        threadId: `${legacyId}-stranger-thread`,
        tenantId: stranger,
      },
    ]);
  });
  legacySeenByStrangerDirectly = await runAsTenant(stranger, async () => {
    const [row] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, legacyId))
      .limit(1);
    return row?.id;
  });
});

afterAll(async () => {
  // Cleanup reaches whichever partition the fixture landed in, and two people's rows: the platform.
  await runAsTenant("platform", async () => {
    for (const id of channelIds) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    for (const id of agentIds) {
      await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
      await database.delete(agents).where(eq(agents.id, id));
    }
    for (const id of [owner, stranger, teammate]) {
      await database.delete(users).where(eq(users.id, id));
    }
  });
});

test("the owner reads the channel, and a stranger cannot even see the row in the database", async () => {
  const ownerRead = await call(owner, channelId);
  expect(ownerRead.status).toBe(200);

  /*
   * Recorded rather than assumed. This used to be the channel's id: the fixture ran unframed, the
   * row sat in the `system` partition every tenant's SELECT admits, and only the membership join
   * stood between a stranger and it. It flipped once every write and request ran in a person's
   * frame (G01-E): the row is the owner's, and row security turns the stranger away before the
   * store's membership join is ever asked. That join is what the legacy channel below is for.
   */
  expect(seenByStrangerDirectly).toBeUndefined();
});

test("on the legacy channel the stranger SELECTs the row, and only the store's membership join refuses them", async () => {
  // The owner, whose membership it is, reads it through the route: the fixture is reachable.
  expect((await call(owner, legacyId)).status).toBe(200);
  // The stranger sees the row itself: row security does not keep them out of a `system` row.
  expect(legacySeenByStrangerDirectly).toBe(legacyId);

  expect((await call(stranger, legacyId)).status).toBe(404);
  const list = (await (await call(stranger, "")).json()) as {
    channels: { id: string }[];
  };
  expect(list.channels.map((entry) => entry.id)).not.toContain(legacyId);
  expect(
    (await call(stranger, `${legacyId}/busy`, "POST", { busy: true })).status,
  ).toBe(404);
});

test("on the legacy channel a stranger's activity, read marker and delete are 404s that change nothing", async () => {
  const before = JSON.stringify(await rowOfLegacy());
  const membershipBefore = await runAsTenant(owner, () =>
    database
      .select()
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, legacyId)),
  );

  const activity = await call(stranger, `${legacyId}/activity`, "POST", {
    text: "standing at the window",
    agentId: null,
    at: new Date().toISOString(),
  });
  expect(activity.status).toBe(404);
  expect((await call(stranger, `${legacyId}/read`, "PUT")).status).toBe(404);
  expect(
    (await call(stranger, `${legacyId}/pin`, "PUT", { pinned: true })).status,
  ).toBe(404);
  expect((await call(stranger, legacyId, "DELETE")).status).toBe(404);

  // The whole channel row and every membership row are as they were: nothing stamped, nothing read.
  expect(JSON.stringify(await rowOfLegacy())).toBe(before);
  expect(
    await runAsTenant(owner, () =>
      database
        .select()
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, legacyId)),
    ),
  ).toEqual(membershipBefore);
});

test("a stranger's read is a 404 and the channel is absent from their list", async () => {
  const read = await call(stranger, channelId);
  expect(read.status).toBe(404);

  const list = await call(stranger, "");
  const body = (await list.json()) as { channels: { id: string }[] };
  expect(body.channels.map((entry) => entry.id)).not.toContain(channelId);
});

test("a stranger's busy signal on that channel is a 404 rather than a write", async () => {
  const busy = await call(stranger, `${channelId}/busy`, "POST", {
    busy: true,
  });
  expect(busy.status).toBe(404);
});

test("a stranger's activity post, sent well-formed, changes no column", async () => {
  /*
   * The body shape is the whole difficulty here, and it is why this case was wrong twice before it
   * was right: `parseActivityInput` runs before the route asks who is calling, and it requires `text`,
   * an ISO-8601 `at`, and `agentId` to be present as either a string or *null* -- leaving `agentId`
   * out is itself a 400. A fixture that gets the shape wrong answers 400 and would pass against a
   * route that ignored membership entirely, so it proves nothing about tenancy.
   */
  const before = JSON.stringify(await rowOfChannel());

  const activity = await call(stranger, `${channelId}/activity`, "POST", {
    text: "standing at the window",
    agentId: null,
    at: new Date().toISOString(),
  });
  expect(activity.status).toBe(404);

  /*
   * Compared as the whole row, not against one named column. The first version of this damage check
   * read `channels.lastActivityAt`, which is not a column: drizzle threw inside the check, and the
   * file reported a failure on a test whose status assertion had already passed. Naming no column
   * also means a write that moves some *other* field cannot slip past a check tuned to one.
   */
  expect(JSON.stringify(await rowOfChannel())).toBe(before);
});

test("a stranger's delete is a 404 that deleted nothing, and the owner may still delete it", async () => {
  const remove = await call(stranger, channelId, "DELETE");
  expect(remove.status).toBe(404);

  const [row] = await runAsTenant(owner, async () =>
    database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1),
  );
  expect(row?.deletedAt).toBeNull();

  const mine = await call(owner, channelId, "DELETE");
  expect(mine.status).toBe(204);
});

test("a shared group is read by its members and by nobody else", async () => {
  // Both members read it through the route, each in their own frame.
  expect((await call(owner, groupId)).status).toBe(200);
  expect((await call(teammate, groupId)).status).toBe(200);
  const teammateList = (await (await call(teammate, "")).json()) as {
    channels: { id: string }[];
  };
  expect(teammateList.channels.map((entry) => entry.id)).toContain(groupId);

  // The stranger gets the same 404 as for a channel that does not exist, and no roster row.
  expect((await call(stranger, groupId)).status).toBe(404);
  const strangerList = (await (await call(stranger, "")).json()) as {
    channels: { id: string }[];
  };
  expect(strangerList.channels.map((entry) => entry.id)).not.toContain(groupId);
  // Nor any of its rows, read straight from the tables in the stranger's frame.
  const seen = await runAsTenant(stranger, async () => ({
    channels: await database
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, groupId)),
    memberships: await database
      .select({ userId: channelMemberships.userId })
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, groupId)),
    bots: await database
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, groupId)),
  }));
  expect(seen).toEqual({ channels: [], memberships: [], bots: [] });

  // And a member who is not its creator cannot delete it for everybody: 404, nothing stamped.
  expect((await call(teammate, groupId, "DELETE")).status).toBe(404);
  const [row] = await runAsTenant(owner, () =>
    database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, groupId)),
  );
  expect(row?.deletedAt).toBeNull();
});

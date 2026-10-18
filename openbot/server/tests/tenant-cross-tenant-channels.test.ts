import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/app-variables";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec test decision #7's conversation face: a stranger may not read, post to, or delete a channel
 * they are not in, and each refusal is a 404.
 *
 * The first case measures which layer actually guards the row, because the answer is not the same as
 * it is for coworkers and tasks: `createChannelStore` never calls `runAsTenant`, so a channel is
 * written into the deployment's own `system` partition. What keeps a stranger out is the membership
 * join inside each store method, not row-level security. The route still has to answer 404, and this
 * is the seam where that answer is bought by the application alone.
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
const channelIds: string[] = [];
const agentIds: string[] = [];

const routesFor = (actorId: string) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, role: "user" as const });
    await next();
  };
  return createChannelRoutes(store, requireUser);
};

const call = (
  actorId: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
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
let seenByStrangerDirectly: string | undefined;

beforeAll(async () => {
  for (const tenantId of [owner, stranger]) {
    await database.insert(users).values({
      id: tenantId,
      email: `${tenantId}@example.test`,
      name: "Cross-tenant channel fixture",
    });
  }

  const coworker = await profileStore.create(
    { id: owner, role: "user" },
    {
      name: `Coworker ${suite}`,
      title: "Answers the mail",
      roleDescription: "Reads the inbox and drafts replies.",
      visibility: "private",
    },
  );
  agentIds.push(coworker.id);
  const channel = await store.create({ id: owner, role: "user" }, [
    coworker.id,
  ]);
  channelId = channel.id;
  channelIds.push(channel.id);

  seenByStrangerDirectly = await runAsTenant(stranger, async () => {
    const [row] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return row?.id;
  });
});

afterAll(async () => {
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
  for (const id of [owner, stranger]) {
    await database.delete(users).where(eq(users.id, id));
  }
});

test("the owner reads the channel, and a stranger can see the row in the database", async () => {
  const ownerRead = await call(owner, channelId);
  expect(ownerRead.status).toBe(200);

  /*
   * Recorded rather than assumed: `channels` sits in the `system` partition, which every tenant's
   * SELECT policy admits. If this ever flips to `undefined`, row-level security has started doing
   * work this file has been crediting to the membership join, and the tests below stop being about
   * the application's gate at all -- which is worth knowing before someone reads them as proof.
   */
  expect(seenByStrangerDirectly).toBe(channelId);
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

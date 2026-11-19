import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import { createAttachmentRoutes } from "../src/channels/attachments";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  attachments,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec test decision #7's file face: an attachment belongs to a conversation, and a caller outside
 * that conversation cannot read it — not as a 403 that confirms the file exists, and not as a 304.
 *
 * The revalidation case is the reason this file exists. `GET /api/attachments/:id` computes its ETag
 * from the id and answers `If-None-Match` *before* it selects the blob, which is what makes a 304
 * cost nothing on a transcript that revalidates every image on every paint. The same shortcut is
 * what would make it leak: an id-keyed validator answered without consulting the membership join
 * tells a stranger the file is there, in a body of zero bytes, and the cache line looks exactly like
 * the owner's. The 304 has to be earned by the same join the 200 is, so that is what gets asserted.
 *
 * The fixture is the owner's, written in the owner's frame, and each request runs in a tenant frame as
 * the real guard opens one. A stranger is asked twice: from their own frame, the production shape,
 * where row security already hides the row; and from the owner's frame, where row security would let
 * it through, so that `visibleToActor` alone is shown to be a whole guard and not leaning on RLS.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("attachment-tenant-test"),
);
const suite = randomUUID().slice(0, 8);
const owner = `attachment-tenant-${suite}-owner`;
const stranger = `attachment-tenant-${suite}-stranger`;
const channelIds: string[] = [];
const agentIds: string[] = [];
const attachmentIds: string[] = [];

const routesFor = (actorId: string, frameTenant: string = actorId) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      role: "user" as const,
    });
    await runAsTenant(frameTenant, () => next());
  };
  return createAttachmentRoutes(database, requireUser);
};

const read = (
  actorId: string,
  id: string,
  etag?: string,
  frameTenant: string = actorId,
) =>
  routesFor(actorId, frameTenant).request(
    new Request(`http://openbot.test/${id}`, {
      ...(etag ? { headers: { "if-none-match": etag } } : {}),
    }),
  );

let attachmentId = "";

beforeAll(async () => {
  for (const tenantId of [owner, stranger]) {
    await runAsTenant(tenantId, () =>
      database.insert(users).values({
        id: tenantId,
        email: `${tenantId}@example.test`,
        name: "Attachment tenancy fixture",
      }),
    );
  }

  // The owner's Bot, channel and sent file, written the way the owner's own request writes them.
  const inserted = await runAsTenant(owner, async () => {
    const coworker = await profileStore.create(
      { id: owner, role: "user" },
      {
        name: `Coworker ${suite}`,
        title: "Reads the mail",
        roleDescription: "Summarises what arrived.",
        visibility: "private",
      },
    );
    agentIds.push(coworker.id);
    const channel = await channelStore.create({ id: owner, role: "user" }, [
      coworker.id,
    ]);
    channelIds.push(channel.id);

    /*
     * `attachedAt` set is what makes this a sent file rather than one still staged in a composer. The
     * visibility predicate admits either to its uploader but only the sent one to another member, so
     * leaving it null would test the wrong half of the join.
     */
    const [inserted] = await database
      .insert(attachments)
      .values({
        channelId: channel.id,
        uploadedBy: owner,
        name: `${suite}.txt`,
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength("contents of a private file"),
        bytes: Buffer.from("contents of a private file"),
        attachedAt: new Date(),
      })
      .returning({ id: attachments.id });
    return inserted;
  });
  attachmentId = inserted!.id;
  attachmentIds.push(attachmentId);
});

afterAll(async () => {
  // Cleanup reaches whichever partition the fixture landed in, and two people's rows: the platform.
  await runAsTenant("platform", async () => {
    for (const id of attachmentIds) {
      await database.delete(attachments).where(eq(attachments.id, id));
    }
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
  await database.$client.close();
});

test("the uploader reads the file back, and its own revalidation is a 304", async () => {
  const fresh = await read(owner, attachmentId);
  expect(fresh.status).toBe(200);
  expect(await fresh.text()).toBe("contents of a private file");

  const revalidated = await read(owner, attachmentId, `"${attachmentId}"`);
  expect(revalidated.status).toBe(304);
});

for (const [where, frameTenant] of [
  ["from their own frame", stranger],
  ["even from the owner's frame", owner],
] as const) {
  test(`a stranger's plain read is a 404 rather than a 403, ${where}`, async () => {
    const response = await read(stranger, attachmentId, undefined, frameTenant);
    expect(response.status).toBe(404);
  });

  test(`a stranger who guesses the ETag gets a 404, not the cheap 304, ${where}`, async () => {
    /*
     * The validator is a string built from the id in the path, so this is not a stolen value — it is
     * arithmetic on something the attacker already has. A 304 here would still be a confirmation that
     * the file exists and is reachable at this id, delivered on the fastest path the route has.
     */
    const response = await read(
      stranger,
      attachmentId,
      `"${attachmentId}"`,
      frameTenant,
    );
    expect(response.status).toBe(404);
  });
}

test("an id that cannot be a uuid answers 404 instead of 500", async () => {
  /*
   * `attachments.id` is a `uuid` column, so arbitrary path text reaches Postgres as a comparison it
   * rejects with 22P02. Left to throw, that is a 500 — a status that says "there is a routing path to
   * a real row here", which is the oracle the rest of this file is built to close.
   */
  const response = await read(stranger, `${suite}-not-a-uuid`);
  expect(response.status).toBe(404);

  const revalidated = await read(stranger, `${suite}-not-a-uuid`, `"nope"`);
  expect(revalidated.status).toBe(404);
});

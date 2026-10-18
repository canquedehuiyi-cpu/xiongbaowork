import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/app-variables";
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
 * Like the channel seam it sits beside, this visibility is the application's, not the database's: the
 * rows are written without a tenant scope, so they land in the `system` partition every tenant can
 * read. `visibleToActor` is the whole of the guard.
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

const routesFor = (actorId: string) => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: actorId, role: "user" as const });
    await next();
  };
  return createAttachmentRoutes(database, requireUser);
};

const read = (actorId: string, id: string, etag?: string) =>
  routesFor(actorId).request(
    new Request(`http://openbot.test/${id}`, {
      ...(etag ? { headers: { "if-none-match": etag } } : {}),
    }),
  );

let attachmentId = "";

beforeAll(async () => {
  for (const tenantId of [owner, stranger]) {
    await database.insert(users).values({
      id: tenantId,
      email: `${tenantId}@example.test`,
      name: "Attachment tenancy fixture",
    });
  }

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
  attachmentId = inserted!.id;
  attachmentIds.push(attachmentId);
});

afterAll(async () => {
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

test("the uploader reads the file back, and its own revalidation is a 304", async () => {
  const fresh = await read(owner, attachmentId);
  expect(fresh.status).toBe(200);
  expect(await fresh.text()).toBe("contents of a private file");

  const revalidated = await read(owner, attachmentId, `"${attachmentId}"`);
  expect(revalidated.status).toBe(304);
});

test("a stranger's plain read is a 404 rather than a 403", async () => {
  const response = await read(stranger, attachmentId);
  expect(response.status).toBe(404);
});

test("a stranger who guesses the ETag gets a 404, not the cheap 304", async () => {
  /*
   * The validator is a string built from the id in the path, so this is not a stolen value — it is
   * arithmetic on something the attacker already has. A 304 here would still be a confirmation that
   * the file exists and is reachable at this id, delivered on the fastest path the route has.
   */
  const response = await read(stranger, attachmentId, `"${attachmentId}"`);
  expect(response.status).toBe(404);
});

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

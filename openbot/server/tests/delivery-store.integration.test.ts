import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import {
  deliveryBindings,
  deliveryChallenges,
  deliveryInbox,
  deliveryOutbox,
} from "../src/db/schema/delivery";
import { workItems } from "../src/db/schema/work";
import { createDeliveryStore } from "../src/delivery/store";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createDeliveryStore(db);
const prefix = `delivery-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const bot = `${prefix}-bot`;
const channel = `${prefix}-channel`;
const scope = {
  ownerUserId: owner,
  agentId: bot,
  channelId: channel,
  threadId: `${prefix}-thread`,
};
const workKeys: string[] = [];
/*
 * The frames production runs these in: a person's own request (link, unlink, challenge, device)
 * and the work done for them (inbox, outbox) run as that person; a webhook's lookup of which binding
 * a provider identity names, and an opt-out keyed by provider identity alone, run as the platform.
 */
const asOwner = <T>(work: () => T): T => runAsTenant(owner, work);
const asStranger = <T>(work: () => T): T => runAsTenant(stranger, work);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
beforeAll(async () => {
  await asOwner(() =>
    db.insert(users).values({ id: owner, email: `${owner}@example.test` }),
  );
  await asStranger(() =>
    db
      .insert(users)
      .values({ id: stranger, email: `${stranger}@example.test` }),
  );
  // The bot and the channel the deliveries are scoped to are the owner's.
  await asOwner(async () => {
    await db.insert(agents).values({
      id: bot,
      name: "Delivery test Bot",
      type: "built_in",
      configuration: {},
    });
    await db
      .insert(channels)
      .values({ id: channel, name: "Delivery test", description: "" });
  });
});
afterAll(async () => {
  // Cleanup spans both people's rows, which only the platform reaches.
  await asPlatform(async () => {
    if (workKeys.length)
      await db
        .delete(workItems)
        .where(
          and(
            inArray(workItems.kind, ["delivery.inbound", "delivery.outbound"]),
            inArray(workItems.key, workKeys),
          ),
        );
    await db.delete(users).where(inArray(users.id, [owner, stranger]));
    await db.delete(channels).where(eq(channels.id, channel));
    await db.delete(agents).where(eq(agents.id, bot));
  });
  await db.$client.end({ timeout: 5 });
});
test("verified provider identity cannot transfer between actors and disabled source stops matching", async () => {
  const input = {
    ...scope,
    transport: "slack" as const,
    identity: "U",
    realm: prefix,
    address: "D",
  };
  const binding = await asOwner(() => store.bind(input));
  await expect(
    asStranger(() => store.bind({ ...input, ownerUserId: stranger })),
  ).rejects.toThrow("another person");
  expect(
    (await asPlatform(() => store.findBinding("slack", prefix, "U", "D")))
      ?.ownerUserId,
  ).toBe(owner);
  await expect(
    asStranger(() => store.removeBinding(stranger, binding.id)),
  ).rejects.toThrow("not found");
  await asOwner(() => store.removeBinding(owner, binding.id));
  expect(
    await asPlatform(() => store.findBinding("slack", prefix, "U", "D")),
  ).toBeNull();
});
test("one-use challenges compare expiry against database clock and refuse a different owner", async () => {
  const id = await asOwner(() => store.challenge(scope, "sms", "+15551234567"));
  expect(await asStranger(() => store.readChallenge(id, stranger))).toBeNull();
  await asOwner(async () => {
    const consumed = await Promise.all([
      store.consumeChallenge(id, owner),
      store.consumeChallenge(id, owner),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(await store.readChallenge(id, owner)).toBeNull();
    const expired = await store.challenge(scope, "slack", null);
    await db
      .update(deliveryChallenges)
      .set({ expiresAt: new Date(0) })
      .where(eq(deliveryChallenges.id, expired));
    expect(await store.consumeChallenge(expired, owner)).toBe(false);
  });
});
test("duplicate inbound webhook inserts exactly one durable turn even under concurrency", async () => {
  await asOwner(async () => {
    const input = {
      ...scope,
      bindingId: null,
      source: "slack" as const,
      realm: prefix,
      externalId: "event-1",
      text: "Hi",
    };
    const results = await Promise.all([
      store.offerInbox(input),
      store.offerInbox(input),
    ]);
    expect(results.filter((result) => result.queued)).toHaveLength(1);
    const rows = await db
      .select()
      .from(deliveryInbox)
      .where(eq(deliveryInbox.ownerUserId, owner));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("Expected inbox row");
    workKeys.push(row.id);
    expect(
      await db
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "delivery.inbound"),
            eq(workItems.key, row.id),
          ),
        ),
    ).toHaveLength(1);
  });
});
test("outbound dedupe and atomic send transition preserve provider id, errors and status", async () => {
  await asOwner(async () => {
    const input = {
      ...scope,
      dedupeKey: `${prefix}:reply`,
      bindingId: null,
      deviceId: null,
      transport: "slack" as const,
      text: "Reply",
      kind: "reply" as const,
      requestId: null,
    };
    const offered = await Promise.all([
      store.offerOutbox(input),
      store.offerOutbox(input),
    ]);
    const row = offered.find((value) => value !== null);
    if (!row) throw new Error("Expected outbox row");
    workKeys.push(row.id);
    expect(offered.filter(Boolean)).toHaveLength(1);
    const started = await Promise.all([
      store.startOutbox(row.id),
      store.startOutbox(row.id),
    ]);
    expect(started.filter(Boolean)).toHaveLength(1);
    await store.setOutbox(
      row.id,
      "failed",
      "Provider unavailable",
      "provider-id",
    );
    expect(await store.outbox(row.id)).toMatchObject({
      state: "failed",
      error: "Provider unavailable",
      providerId: "provider-id",
    });
    expect(await store.startOutbox(row.id)).toBeNull();
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.ownerUserId, owner)),
    ).toHaveLength(1);
  });
});
/*
 * The Twilio status callback carries only a MessageSid (G01-C). Which outbox row that names is asked
 * as `platform`, and each row is updated in the tenant stamped on it, confirmed by its owner: a row
 * that names nobody, or names somebody other than its owner, is left exactly as it was. Called with
 * no frame, as the public webhook calls it, and inside a stranger's frame to show that the caller's
 * frame redirects nothing.
 */
test("an SMS status callback updates each outbox row in its own tenant and never as system", async () => {
  const sid = (label: string) => `${prefix}-sid-${label}`;
  const row = (label: string, tenantId: string) => ({
    tenantId,
    id: `${prefix}-sms-${label}`,
    ...scope,
    dedupeKey: `${prefix}:sms:${label}`,
    bindingId: null,
    deviceId: null,
    transport: "sms" as const,
    text: "Text",
    kind: "reply" as const,
    requestId: null,
    state: "sent" as const,
    providerId: sid(label),
  });
  const rows = [
    row("owned", owner),
    row("system", "system"),
    row("platform", "platform"),
    row("stranger", stranger),
  ];
  await runAsTenant("platform", () => db.insert(deliveryOutbox).values(rows));
  const read = (label: string) =>
    runAsTenant("platform", () =>
      db
        .select({
          tenantId: deliveryOutbox.tenantId,
          state: deliveryOutbox.state,
          error: deliveryOutbox.error,
        })
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.id, `${prefix}-sms-${label}`)),
    ).then(([found]) => found);
  try {
    await store.updateSmsStatus(sid("owned"), "delivered", null);
    expect(await read("owned")).toEqual({
      tenantId: owner,
      state: "delivered",
      error: null,
    });
    await runAsTenant(stranger, () =>
      store.updateSmsStatus(sid("owned"), "failed", "30003"),
    );
    expect(await read("owned")).toEqual({
      tenantId: owner,
      state: "failed",
      error: "30003",
    });
    for (const label of ["system", "platform", "stranger"]) {
      await store.updateSmsStatus(sid(label), "delivered", null);
      expect(await read(label)).toMatchObject({ state: "sent", error: null });
    }
  } finally {
    await runAsTenant("platform", () =>
      db.delete(deliveryOutbox).where(
        inArray(
          deliveryOutbox.id,
          rows.map((value) => value.id),
        ),
      ),
    );
  }
});

test("a paired chat turn is recorded once, running, and never queued", async () => {
  await asOwner(async () => {
    const binding = await store.bind({
      ...scope,
      transport: "slack",
      realm: `${prefix}-T`,
      identity: "UPAIR",
      address: "UPAIR",
    });
    const input = {
      ...scope,
      bindingId: binding.id,
      source: "slack" as const,
      realm: `${prefix}-T`,
      externalId: "opentag-thread:m1",
      text: "Hi",
    };
    const [first, second] = await Promise.all([
      store.recordInbox(input),
      store.recordInbox(input),
    ]);
    const recorded = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(recorded?.state).toBe("running");
    expect(
      await db
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "delivery.inbound"),
            eq(workItems.key, recorded?.id ?? ""),
          ),
        ),
    ).toHaveLength(0);
    expect(await store.botIdentity(bot)).toEqual({
      agentId: bot,
      name: "Delivery test Bot",
    });
  });
});
test("SMS STOP keeps the binding connected but marked; START clears it", async () => {
  await asOwner(() =>
    store.bind({
      ...scope,
      transport: "sms",
      realm: `${prefix}-AC`,
      identity: "+15557654321",
      address: "+15557654321",
    }),
  );
  // STOP and START arrive by provider identity alone, which the webhook resolves as the platform.
  await asPlatform(async () => {
    expect(
      await store.setSmsOptOut(`${prefix}-AC`, "+15557654321", true),
    ).toEqual([
      expect.objectContaining({ ownerUserId: owner, channelId: channel }),
    ]);
    const optedOut = await store.findBinding(
      "sms",
      `${prefix}-AC`,
      "+15557654321",
    );
    expect(optedOut?.optedOutAt).toBeInstanceOf(Date);
    expect(optedOut?.enabled).toBe(true);
    await store.setSmsOptOut(`${prefix}-AC`, "+15557654321", false);
    expect(
      (await store.findBinding("sms", `${prefix}-AC`, "+15557654321"))
        ?.optedOutAt,
    ).toBeNull();
  });
});
test("a push token registered by one person cannot be moved to another person's account", async () => {
  const token = `ExponentPushToken[${prefix.replace(/[^A-Za-z0-9]/g, "")}]`;
  const projectId = randomUUID();
  const ownersDevice = randomUUID();
  await store.registerDevice({
    id: ownersDevice,
    ownerUserId: owner,
    token,
    projectId,
    platform: "ios",
  });
  await expect(
    store.registerDevice({
      id: randomUUID(),
      ownerUserId: stranger,
      token,
      projectId,
      platform: "ios",
    }),
  ).rejects.toThrow("already registered to another account");
  expect(await store.devices(owner)).toEqual([
    expect.objectContaining({ id: ownersDevice, token }),
  ]);
  expect(await store.devices(stranger)).toEqual([]);
  // The same person registering the same phone again keeps it.
  await store.registerDevice({
    id: ownersDevice,
    ownerUserId: owner,
    token,
    projectId,
    platform: "ios",
  });
  // After the owner signs out on the phone, the next person to sign in there takes the token.
  await store.removeDevice(owner, ownersDevice);
  const next = randomUUID();
  await store.registerDevice({
    id: next,
    ownerUserId: stranger,
    token,
    projectId,
    platform: "ios",
  });
  expect(await store.devices(stranger)).toEqual([
    expect.objectContaining({ id: next, token }),
  ]);
  expect(await store.devices(owner)).toEqual([]);
});

/*
 * Migration 0114 (G01): bindings linked before the link routes ran in the owner's frame carry the
 * stamp of nobody (`system`, `platform`, empty), and delivery refuses those since G01-B. The
 * migration restamps them to their owner. `delivery_bindings` has FORCE RLS, so the statement only
 * reaches those rows as the platform writer; this runs the migration file itself from a frame that
 * could not reach them (the empty one a migrator arrives with), as this NOBYPASSRLS role, inside a
 * transaction that is rolled back so no other file's bindings are touched.
 */
test("migration 0114 restamps bindings of nobody's to their owner, and only those", async () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      "..",
      "recovery",
      "recovery-20261018-v1",
      "sql",
      "0114_delivery_binding_owner_tenant.sql",
    ),
    "utf8",
  );
  const realm = `${prefix}-0114`;
  // Nobody's three ways, and one stamped with a person who is not the owner: a conflict, not a legacy default.
  const stamps = ["system", "platform", "", stranger];
  const rollback = new Error("rollback the migration fixture");
  let seen: { frame: unknown; rows: unknown[] } | undefined;
  await expect(
    db.$client.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', 'platform', true)`;
      for (const [index, stamp] of stamps.entries())
        await tx`insert into delivery_bindings (tenant_id, id, owner_user_id, channel_id, agent_id, thread_id, transport, identity, realm, address) values (${stamp}, ${`${realm}-${index}`}, ${owner}, ${channel}, ${bot}, ${scope.threadId}, 'slack', ${`U${index}`}, ${realm}, 'D')`;
      await tx`select set_config('app.tenant_id', '', true)`;
      await tx.unsafe(migration);
      const [frame] =
        await tx`select current_setting('app.tenant_id', true) as tenant`;
      await tx`select set_config('app.tenant_id', 'platform', true)`;
      const rows =
        await tx`select id, tenant_id from delivery_bindings where realm = ${realm} order by id`;
      seen = {
        frame: (frame as { tenant: unknown }).tenant,
        rows: Array.from(rows as ArrayLike<unknown>),
      };
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  // The frame the migration found is the frame it leaves, so a later migration in the same run does not inherit `platform`.
  expect(seen?.frame).toBe("");
  expect(seen?.rows).toEqual([
    { id: `${realm}-0`, tenant_id: owner },
    { id: `${realm}-1`, tenant_id: owner },
    { id: `${realm}-2`, tenant_id: owner },
    { id: `${realm}-3`, tenant_id: stranger },
  ]);
  // Rolled back: nothing of the fixture is left for anybody.
  expect(
    await runAsTenant("platform", () =>
      db
        .select({ id: deliveryBindings.id })
        .from(deliveryBindings)
        .where(eq(deliveryBindings.realm, realm)),
    ),
  ).toEqual([]);
});

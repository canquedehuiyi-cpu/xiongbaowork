import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { packageChannelId } from "../src/tenant/provisioning";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 031, as one acceptance: apply a brand package to a workspace and the person owns its
 * conversations.
 *
 * Three rows per channel are needed and each one was missing at some point during this bug's life, so
 * all three are asserted together: the channel itself (in that person's tenant, under an id that
 * cannot collide with another tenant's copy of the same declaration), the membership, and the thread
 * mapping. The mapping is the one that made a fix look impossible -- with it absent the channel is
 * invisible to its own owner even when the other two are perfect, which is how "the package seeded the
 * channels" and "nobody can open one" were both true at once.
 *
 * This runs the real package through the real store rather than a hand-built fixture, because every
 * part of that chain is a place the omission could hide.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const person = `pkg-channels-${suite}`;
const loaded = await loadTenantPackage("../examples/qoderwake");
const expected = loaded.channels.map((channel) =>
  packageChannelId(person, channel.id),
);

/*
 * The platform scope, because that is what a catalogue write is: the package's agents and skills are
 * shared rows, and another test file may have stamped them under its own tenant. The per-person
 * channel writes the sync makes afterwards run in that person's scope no matter what wraps the call.
 */
const applyPackage = () =>
  runAsTenant("platform", async () =>
    synchronizeTenantPackage(database, loaded, [person]),
  );

await database.insert(users).values({
  id: person,
  email: `${person}@example.test`,
  name: "Package channel fixture",
});
await applyPackage();

afterAll(async () => {
  // Scoped to this fixture's person: the package's own agents and skills are shared rows other tests
  // read, and taking them out from under them would trade one red for another.
  await runAsTenant(person, async () => {
    await database
      .delete(channelMemberships)
      .where(eq(channelMemberships.userId, person));
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.userId, person));
    await database
      .delete(channels)
      .where(
        inArray(channels.id, [
          ...expected,
          ...loaded.channels.map((c) => c.id),
        ]),
      );
  });
  await database.delete(users).where(eq(users.id, person));
  await database.$client.close();
});

test("a package applied for a person creates that person's copy of each declared channel", async () => {
  const rows = await runAsTenant(person, async () =>
    database
      .select({ id: channels.id, tenantId: channels.tenantId })
      .from(channels)
      .where(inArray(channels.id, expected)),
  );

  expect(rows.map((row) => row.id).sort()).toEqual([...expected].sort());
  // Not the platform's partition: two people each declaring `operations` cannot share a row, and a
  // shared row is one person reading another's messages.
  for (const row of rows) expect(row.tenantId).toBe(person);
});

test("each copy has a member and a thread, and that is what makes it openable", async () => {
  for (const channelId of expected) {
    const [membership] = await runAsTenant(person, async () =>
      database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId))
        .limit(1),
    );
    expect(membership?.userId).toBe(person);

    const [mapping] = await runAsTenant(person, async () =>
      database
        .select({ threadId: intelligenceChannelMappings.threadId })
        .from(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, channelId))
        .limit(1),
    );
    expect(typeof mapping?.threadId).toBe("string");
  }
});

test("every join the read path needs from the channel's own side is there for that person", async () => {
  /*
   * Asserted through the tables the store joins, not through `store.list` itself: the list also
   * filters by which coworkers the caller may see, and on a clean database even an administrator gets
   * nothing back for these channels -- which is D11's undecided corner (are a package's coworkers
   * public to everyone in the workspace?), not a missing membership. Asserting either answer here would
   * freeze a decision nobody has made.
   *
   * What this does pin is the thing ticket 031 was about: membership and thread mapping exist for the
   * person the package was applied for, so the read path's own joins no longer drop the channel. The
   * end-to-end read was verified against a running deployment, where the three package channels answer
   * 200 instead of "Could not load this channel", and that is recorded rather than encoded.
   */
  for (const channelId of expected) {
    const joined = await runAsTenant(person, async () =>
      database
        .select({
          member: channelMemberships.userId,
          thread: intelligenceChannelMappings.threadId,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, person),
          ),
        )
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, channels.id),
            eq(intelligenceChannelMappings.userId, person),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .where(eq(channels.id, channelId)),
    );

    expect(joined.length).toBeGreaterThan(0);
    expect(joined.every((row) => row.member === person)).toBe(true);
    expect(joined.every((row) => typeof row.thread === "string")).toBe(true);
  }
});

test("applying the same package twice does not add a second copy of anything", async () => {
  await applyPackage();

  const rows = await runAsTenant(person, async () =>
    database
      .select({ id: channels.id })
      .from(channels)
      .where(inArray(channels.id, expected)),
  );
  const memberships = await runAsTenant(person, async () =>
    database
      .select({ channelId: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, person)),
  );

  expect(rows.length).toBe(expected.length);
  expect(memberships.length).toBe(expected.length);
});

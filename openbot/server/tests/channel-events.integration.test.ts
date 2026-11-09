import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PgRaw } from "drizzle-orm/pg-core/query-builders/raw";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  announceTaskUpdate,
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
  type ChannelEventHub,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import {
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase, type Database } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

function event(overrides: Partial<ChannelActivityEvent> = {}) {
  return {
    channelId: "channel_1",
    memberIds: ["user-1"],
    lastMessage: "Said something.",
    lastMessageAt: "2026-08-15T10:00:00.000Z",
    lastMessageAgentId: null,
    ...overrides,
  } satisfies ChannelActivityEvent;
}

describe("channel event hub", () => {
  test("delivers only to the members of the channel", () => {
    const hub = createChannelEventHub();
    const member: string[] = [];
    const stranger: string[] = [];
    hub.register("user-1", (payload) => member.push(payload));
    hub.register("user-2", (payload) => stranger.push(payload));

    hub.deliver(event({ memberIds: ["user-1"] }));

    expect(member).toHaveLength(1);
    expect(JSON.parse(member[0] as string).lastMessage).toBe("Said something.");
    // Membership is what authorises delivery, so somebody outside the channel hears nothing.
    expect(stranger).toEqual([]);
  });

  test("reaches every connection a person has open", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(`tab-a:${payload}`));
    hub.register("user-1", (payload) => received.push(`tab-b:${payload}`));

    hub.deliver(event());

    expect(received).toHaveLength(2);
    expect(hub.connectionCount("user-1")).toBe(2);
  });

  test("a resync reaches every connection, whoever it belongs to", () => {
    // Everybody, not a member list: the events that were lost named their own members.
    const hub = createChannelEventHub();
    const first: string[] = [];
    const second: string[] = [];
    const other: string[] = [];
    hub.register("user-1", (payload) => first.push(payload));
    hub.register("user-1", (payload) => second.push(payload));
    hub.register("user-2", (payload) => other.push(payload));

    hub.resyncAll();

    expect(first).toEqual(['{"resync":true}']);
    expect(second).toEqual(['{"resync":true}']);
    expect(other).toEqual(['{"resync":true}']);
  });

  test("a detached connection receives no resync", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    const detach = hub.register("user-1", (payload) => received.push(payload));
    detach();

    hub.resyncAll();

    expect(received).toEqual([]);
  });

  test("one failing connection does not deny the resync to the rest", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", () => {
      throw new Error("this connection is closing");
    });
    hub.register("user-1", (payload) => received.push(payload));

    expect(() => hub.resyncAll()).not.toThrow();
    expect(received).toEqual(['{"resync":true}']);
  });

  test("stops delivering once a connection detaches, and forgets the person", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    const detach = hub.register("user-1", (payload) => received.push(payload));

    detach();
    hub.deliver(event());

    expect(received).toEqual([]);
    // Dropped rather than left as an empty set, so a long-lived process does not grow one per
    // person who has ever connected.
    expect(hub.connectionCount("user-1")).toBe(0);
  });

  test("one failing connection does not deny the event to the rest", () => {
    const hub = createChannelEventHub();
    const healthy: string[] = [];
    hub.register("user-1", () => {
      throw new Error("this socket is closing");
    });
    hub.register("user-1", (payload) => healthy.push(payload));

    expect(() => hub.deliver(event())).not.toThrow();
    expect(healthy).toHaveLength(1);
  });
});

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const testPrefix = `channel-events-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  // Cleanup spans several people's rows and deployment rows, which only the platform reaches.
  await runAsTenant("platform", async () => {
    for (const channelId of createdChannelIds.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, channelId));
      await database.delete(channels).where(eq(channels.id, channelId));
    }
    for (const packageId of createdPackageIds.splice(0)) {
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, packageId));
    }
    for (const agentId of createdAgentIds.splice(0)) {
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.agentId, agentId));
      await database.delete(agents).where(eq(agents.id, agentId));
    }
    for (const userId of createdUserIds.splice(0)) {
      await database.delete(users).where(eq(users.id, userId));
    }
  });
});

/** As a signed-in request runs: inside the person's own tenant. */
function as<T>(actor: AgentActor, work: () => T): T {
  return runAsTenant(actor.id, work);
}

afterAll(async () => {
  await database.$client.close();
});

/**
 * Delivery goes through Postgres so it survives more than one server instance. This proves the round
 * trip a second instance would take: a write announces, and a listener that shares nothing with the
 * writer but the database hears it.
 */
describe("channel activity delivery", () => {
  test("announces a recorded message to a listener on its own connection", async () => {
    const id = `${testPrefix}-user-${randomUUID()}`;
    await runAsTenant(id, () =>
      database.insert(users).values({
        id,
        email: `${id}@example.test`,
        name: "Channel Events Test User",
      }),
    );
    createdUserIds.push(id);
    const owner: AgentActor = { id, role: "user" };
    await as(owner, async () => {
      const profile = await profileStore.create(owner, {
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription: "Review receipts.",
        visibility: "private",
      });
      createdAgentIds.push(profile.id);
      const channel = await store.create(owner, [profile.id]);
      createdChannelIds.push(channel.id);

      const hub = createChannelEventHub();
      const delivered: ChannelActivityEvent[] = [];
      const arrived = new Promise<void>((resolve) => {
        hub.register(owner.id, (payload) => {
          delivered.push(JSON.parse(payload));
          resolve();
        });
      });
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await store.recordActivity(owner, channel.id, {
          agentId: profile.id,
          at: new Date(),
          text: "Categorized three expenses.",
        });
        await Promise.race([
          arrived,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("no event within 5s")), 5000),
          ),
        ]);
      } finally {
        await listener.stop();
      }

      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        channelId: channel.id,
        lastMessage: "Categorized three expenses.",
        lastMessageAgentId: profile.id,
        memberIds: [owner.id],
      });
    });
  });

  /*
   * A Bot's reply is what a browser notification shows when it lands while OpenBot is out of sight:
   * its first line, as plain text. The roster's preview collapses every line into one, so it cannot
   * say where the first one ends.
   */
  test("a Bot's reply carries its first line as plain text, and a person's message carries none", async () => {
    const owner = await createTestUser("Channel Events Test User");
    const profile = await profileStore.create(owner, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private",
    });
    createdAgentIds.push(profile.id);
    const channel = await store.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    const hub = createChannelEventHub();
    const replies: ChannelActivityEvent[] = [];
    let heardReply = () => {};
    const replied = new Promise<void>((resolve) => {
      heardReply = resolve;
    });
    hub.register(owner.id, (payload) => {
      const event: ChannelActivityEvent = JSON.parse(payload);
      if (event.lastMessage === null) return;
      replies.push(event);
      if (event.lastMessageAgentId !== null) heardReply();
    });
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      const asked = new Date();
      await store.recordActivity(owner, channel.id, {
        agentId: null,
        at: asked,
        text: "Sort my receipts\nfrom March",
      });
      await store.recordActivity(owner, channel.id, {
        agentId: profile.id,
        at: new Date(asked.getTime() + 1000),
        text: "\n\nCategorized **three** expenses.\n\nThe receipts are in [Drive](https://drive.example.test/march).",
      });
      await within5s(replied);
    } finally {
      await listener.stop();
    }

    const person = replies.find((event) => event.lastMessageAgentId === null);
    const bot = replies.find((event) => event.lastMessageAgentId !== null);
    // A person's message has no first line to notify with: the key is absent, not just empty.
    expect(person).toBeDefined();
    expect(person).not.toHaveProperty("firstLine");
    expect(bot).toMatchObject({
      lastMessage: "Categorized three expenses. The receipts are in Drive.",
      firstLine: "Categorized three expenses.",
    });
  });
});

async function createTestUser(name: string): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name,
    }),
  );
  createdUserIds.push(id);
  return { id, role: "user" };
}

/** A channel with two members, which is what makes "who hears this" a question worth asking. */
async function createSharedChannel(owner: AgentActor, other: AgentActor) {
  /*
   * A shared group (G01-E P11): the only way two people are in one conversation. The owner makes
   * it (`team`) and admits the second member with a `team` membership, as `addMember` does in the
   * owner's request. A row stamped with the owner that names somebody else is refused (0128).
   */
  const channel = await as(owner, async () => {
    const profile = await profileStore.create(owner, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "public",
    });
    createdAgentIds.push(profile.id);
    const made = await store.create(owner, [profile.id], { shared: true });
    createdChannelIds.push(made.id);
    // `create` writes the creator's membership only; the second member is added directly.
    await database.insert(channelMemberships).values({
      channelId: made.id,
      userId: other.id,
      tenantId: TEAM_TENANT,
    });
    return made;
  });
  // The second member's own thread mapping, which the roster join requires: theirs, in their frame.
  await as(other, () =>
    database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: channel.id,
      // thread_id is globally unique, so the second member's mapping needs one of its own.
      threadId: randomUUID(),
    }),
  );
  return channel;
}

/** Collect what each person's connection hears, and a promise that settles when one of them does. */
function watch(hub: ChannelEventHub, userIds: string[]) {
  const heard = new Map<string, ChannelActivityEvent[]>();
  let announce = () => {};
  const anything = new Promise<void>((resolve) => {
    announce = resolve;
  });
  for (const userId of userIds) {
    heard.set(userId, []);
    hub.register(userId, (payload) => {
      heard.get(userId)?.push(JSON.parse(payload));
      announce();
    });
  }
  const of = (userId: string) => heard.get(userId) ?? [];
  return { of, anything };
}

function within5s(arrived: Promise<void>) {
  return Promise.race([
    arrived,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("no event within 5s")), 5000),
    ),
  ]);
}

/**
 * Two changes a roster has to hear about that are not a message: a channel that is gone, and a pin.
 *
 * They differ in who is owed the news. A deletion hides the channel for everybody in it, so every
 * member's tabs need telling; a pin belongs to one member's own membership row, so telling anybody
 * else would show them a pin they did not make.
 */
describe("channel change delivery", () => {
  test("announces a deleted channel to every member, exactly once", async () => {
    const owner = await createTestUser("Deleting Member");
    const other = await createTestUser("Other Member");
    await as(owner, async () => {
      const channel = await createSharedChannel(owner, other);

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id, other.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await store.softDelete(owner, channel.id);
        await within5s(watched.anything);
      } finally {
        await listener.stop();
      }

      // One announcement, heard by both members: a soft delete hides the row for everyone in it.
      expect(watched.of(owner.id)).toHaveLength(1);
      expect(watched.of(other.id)).toHaveLength(1);
      expect(watched.of(owner.id)[0]).toMatchObject({
        channelId: channel.id,
        deleted: true,
      });
      expect(watched.of(owner.id)[0]?.memberIds?.sort()).toEqual(
        [owner.id, other.id].sort(),
      );
    });
  });

  test("announces nothing for a delete the deployment package refuses", async () => {
    const owner = await createTestUser("Refused Member");
    // The package is a deployment row; the channel it defines is this member's.
    const [deploymentPackage] = await runAsTenant("platform", () =>
      database
        .insert(deploymentPackages)
        .values({
          tenantId: `${testPrefix}-tenant-${randomUUID()}`,
          sourcePath: "/tmp/none",
          checksum: "0",
        })
        .returning({ id: deploymentPackages.id }),
    );
    if (!deploymentPackage) throw new Error("package row was not created");
    createdPackageIds.push(deploymentPackage.id);
    await as(owner, async () => {
      const channelId = `${testPrefix}-package-channel-${randomUUID()}`;
      await database.insert(channels).values({
        id: channelId,
        name: "Package channel",
        description: "Defined by the tenant package.",
        packageId: deploymentPackage.id,
      });
      createdChannelIds.push(channelId);
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: owner.id });

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await expect(store.softDelete(owner, channelId)).rejects.toBeInstanceOf(
          ChannelPackageOwnedError,
        );
        // The refusal rolls the transaction back, so there is nothing to wait for. A window long
        // enough for a notify that did happen to arrive is what makes the empty assertion mean
        // something.
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await listener.stop();
      }

      // The channel is still there for everybody, so telling a roster it is gone would be a lie.
      expect(watched.of(owner.id)).toEqual([]);
    });
  });

  test("tells the pinning member's own tabs and nobody else's", async () => {
    const owner = await createTestUser("Pinning Member");
    const other = await createTestUser("Other Member");
    await as(owner, async () => {
      const channel = await createSharedChannel(owner, other);

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id, other.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await store.setPinned(owner, channel.id, true);
        await within5s(watched.anything);
      } finally {
        await listener.stop();
      }

      expect(watched.of(owner.id)).toHaveLength(1);
      expect(watched.of(owner.id)[0]).toMatchObject({
        channelId: channel.id,
        pinned: true,
        memberIds: [owner.id],
      });
      /*
       * The half worth having a test for. A pin lives on one membership row, and the hub delivers by
       * `memberIds`, so naming anybody else here would put a pin on their roster that they did not
       * make. Both members are watching the same hub through the same notify, so an event that
       * included the other member would already be in this array.
       */
      expect(watched.of(other.id)).toEqual([]);
    });
  });

  /*
   * A write refused because the channel is deleted announces nothing either.
   *
   * The listener is attached after the delete, so the delete's own announcement is not what these
   * observe: what is being asserted is that a later report about a hidden channel is silent. A notify
   * here would send every member's browser off to refetch a roster for a row it cannot show.
   */
  test("announces nothing for activity reported on a deleted channel", async () => {
    const owner = await createTestUser("Deleted Channel Member");
    const other = await createTestUser("Other Member");
    await as(owner, async () => {
      const channel = await createSharedChannel(owner, other);
      await store.softDelete(owner, channel.id);

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id, other.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await expect(
          store.recordActivity(owner, channel.id, {
            agentId: null,
            at: new Date(),
            text: "Said into a channel that is gone.",
          }),
        ).rejects.toBeInstanceOf(ChannelNotFoundError);
        // The refusal rolls back, so there is nothing to wait for; the window is what makes an empty
        // assertion mean something.
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await listener.stop();
      }

      expect(watched.of(owner.id)).toEqual([]);
      expect(watched.of(other.id)).toEqual([]);
    });
  });

  test("announces nothing for deleting a channel already deleted", async () => {
    const owner = await createTestUser("Twice-Deleting Member");
    const other = await createTestUser("Other Member");
    await as(owner, async () => {
      const channel = await createSharedChannel(owner, other);
      await store.softDelete(owner, channel.id);

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id, other.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await expect(store.softDelete(owner, channel.id)).resolves.toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await listener.stop();
      }

      expect(watched.of(owner.id)).toEqual([]);
      expect(watched.of(other.id)).toEqual([]);
    });
  });

  test("announces nothing for a pin on a deleted channel", async () => {
    const owner = await createTestUser("Pinning Member");
    await as(owner, async () => {
      const channel = await createSharedChannel(
        owner,
        await createTestUser("Other Member"),
      );
      await store.softDelete(owner, channel.id);

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await expect(
          store.setPinned(owner, channel.id, true),
        ).rejects.toBeInstanceOf(ChannelNotFoundError);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await listener.stop();
      }

      expect(watched.of(owner.id)).toEqual([]);
    });
  });

  test("announces an unpin the same way", async () => {
    const owner = await createTestUser("Unpinning Member");
    const other = await createTestUser("Other Member");
    await as(owner, async () => {
      const channel = await createSharedChannel(owner, other);
      await store.setPinned(owner, channel.id, true);

      const hub = createChannelEventHub();
      const watched = watch(hub, [owner.id, other.id]);
      const listener = await startChannelActivityListener(databaseUrl, hub);

      try {
        await store.setPinned(owner, channel.id, false);
        await within5s(watched.anything);
      } finally {
        await listener.stop();
      }

      expect(watched.of(owner.id)).toHaveLength(1);
      expect(watched.of(owner.id)[0]).toMatchObject({
        channelId: channel.id,
        pinned: false,
      });
      expect(watched.of(other.id)).toEqual([]);
    });
  });
});

/**
 * An announcement made while this server's subscription is down is lost, and the connection that
 * dropped is not the browser's — so the client's own `onopen` recovery never fires and the roster
 * goes on rendering a channel that no longer resolves.
 *
 * The drop is real rather than simulated: the backend is terminated and held down until
 * `pg_stat_activity` shows it gone, so the announcement lands in a gap known to exist. Compare
 * "catches up when its subscription comes back" in policy-fanout.integration.test.ts.
 */
describe("a server whose subscription dropped", () => {
  test("tells its connections to refetch when the subscription comes back", async () => {
    const hub = createChannelEventHub();
    // The browser's end, registered once and never touched again: its socket does not drop.
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(payload));

    const before = new Set(await listenBackendPids());
    const listener = await startChannelActivityListener(databaseUrl, hub);
    try {
      await until(async () => (await ourPids(before)).length === 1);

      // Control: while connected, an announcement arrives. Without this the test could pass on a
      // hub that was never wired to the database at all.
      await announce(event({ channelId: "channel_connected" }));
      await until(() =>
        received.some((raw) => raw.includes("channel_connected")),
      );
      expect(received.some((raw) => raw.includes("channel_connected"))).toBe(
        true,
      );

      // Terminated in a loop, because the driver reconnects in tens of milliseconds. The publish
      // happens only once no LISTEN backend of ours is connected.
      let published = false;
      const holdUntil = Date.now() + 5_000;
      while (Date.now() < holdUntil && !published) {
        for (const pid of await ourPids(before)) {
          await database.$client`select pg_terminate_backend(${pid})`;
        }
        if ((await ourPids(before)).length === 0) {
          await announce(
            event({ channelId: "channel_in_the_gap", deleted: true }),
          );
          published = true;
        }
      }
      expect(published).toBe(true);

      // The subscription is live again, proven by an event that arrives after it.
      await until(async () => (await ourPids(before)).length === 1);
      await until(async () => {
        await announce(event({ channelId: "channel_after" }));
        return received.some((raw) => raw.includes("channel_after"));
      }, 10_000);
      expect(received.some((raw) => raw.includes("channel_after"))).toBe(true);

      // The lost announcement is not recoverable and is deliberately not asserted for. What must
      // reach the browser is the instruction to ask again.
      expect(received.some((raw) => raw.includes("channel_in_the_gap"))).toBe(
        false,
      );
      expect(received).toContain('{"resync":true}');
    } finally {
      await listener.stop().catch(() => undefined);
    }
  }, 30_000);
});

/**
 * Backends subscribed to THIS topic, scoped by name rather than `listen%` so that terminating them
 * can never reach the action policy listener's subscription running beside it.
 */
async function listenBackendPids(): Promise<number[]> {
  const rows = await database.$client<{ pid: number }[]>`
    select pid from pg_stat_activity
    where query = ${`listen "${CHANNEL_ACTIVITY_TOPIC}"`} and pid <> pg_backend_pid()`;
  return rows.map((row) => Number(row.pid));
}

/** The listener this test started: the topic filter excludes the policy listener, `before` the rest. */
async function ourPids(before: Set<number>): Promise<number[]> {
  return (await listenBackendPids()).filter((pid) => !before.has(pid));
}

function announce(activity: ChannelActivityEvent) {
  return database.$client`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(activity)})`;
}

/** Polled rather than slept, so the test is neither flaky nor slow. As policy-fanout does. */
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The task board rides the same rail. drizzle's `execute` is lazy — a `PgRaw` whose statement runs
 * only when `then` is called — so the projector's old `void database.execute(...)` built a NOTIFY
 * and never sent it: a second instance's board never moved.
 */
describe("task board announcements", () => {
  /** A real drizzle `PgRaw`, the object `execute` answers with, around a statement we can watch. */
  function rawExecuting(run: () => Promise<unknown>) {
    return {
      execute: () =>
        new PgRaw(
          run,
          sql`select 1`,
          { sql: "select 1", params: [] },
          (r) => r,
        ),
    } as unknown as Pick<Database, "execute">;
  }

  test("drizzle's raw query runs nothing until it is awaited, and the helper runs it", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return [];
    };
    // The premise: a voided `PgRaw` never executes.
    void new PgRaw(
      run,
      sql`select 1`,
      { sql: "select 1", params: [] },
      (r) => r,
    );
    await Promise.resolve();
    expect(runs).toBe(0);

    await announceTaskUpdate(rawExecuting(run), "tenant-lazy");
    expect(runs).toBe(1);
  });

  test("a failed announcement is logged as one JSON line, never thrown or left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const secret = "password=do-not-log-me";
      const failing = rawExecuting(() =>
        Promise.reject(Object.assign(new Error(secret), { code: "57P01" })),
      );
      await expect(
        announceTaskUpdate(failing, "tenant-failing"),
      ).resolves.toBeUndefined();

      const throwing = {
        execute: () => {
          throw new Error(secret);
        },
      } as unknown as Pick<Database, "execute">;
      await expect(
        announceTaskUpdate(throwing, "tenant-throwing"),
      ).resolves.toBeUndefined();

      // A rejection nobody handled is reported after the microtask queue drains.
      await new Promise((resolve) => setImmediate(resolve));

      expect(logged).toHaveBeenCalledTimes(2);
      const lines = logged.mock.calls.map((call) => String(call[0]));
      expect(JSON.parse(lines[0] as string)).toEqual({
        type: "task-board-announce-failed",
        tenantId: "tenant-failing",
        error: "Error",
        code: "57P01",
      });
      expect(JSON.parse(lines[1] as string)).toEqual({
        type: "task-board-announce-failed",
        tenantId: "tenant-throwing",
        error: "Error",
      });
      for (const line of lines) expect(line).not.toContain(secret);
      expect(unhandled).toEqual([]);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("reaches a listener on its own connection, from inside a tenant frame", async () => {
    const tenantId = `${testPrefix}-tenant-${randomUUID()}`;
    const hub = createChannelEventHub();
    const received: ChannelActivityEvent[] = [];
    hub.register(tenantId, (payload) => received.push(JSON.parse(payload)));
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      // Called the way the projector calls it: synchronously, inside the tenant's frame, and not
      // awaited by the caller. The helper must still send the NOTIFY.
      const sent = runAsTenant(tenantId, () =>
        announceTaskUpdate(database, tenantId),
      );
      await until(() => received.length > 0);
      await sent;
    } finally {
      await listener.stop();
    }

    expect(received).toEqual([
      {
        channelId: "",
        memberIds: [tenantId],
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        taskUpdated: true,
      },
    ]);
  });

  test("reaches a listener when its caller has no tenant frame at all", async () => {
    // The projector announces after its own frame has closed, so a background caller with no frame
    // of its own is the case that matters: with no frame the statement would be refused unsent.
    const tenantId = `${testPrefix}-tenant-${randomUUID()}`;
    const hub = createChannelEventHub();
    const received: ChannelActivityEvent[] = [];
    hub.register(tenantId, (payload) => received.push(JSON.parse(payload)));
    const listener = await startChannelActivityListener(databaseUrl, hub);
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      const sent = announceTaskUpdate(database, tenantId);
      await until(() => received.length > 0);
      await sent;
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await listener.stop();
    }

    expect(received).toEqual([
      {
        channelId: "",
        memberIds: [tenantId],
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        taskUpdated: true,
      },
    ]);
  });
});

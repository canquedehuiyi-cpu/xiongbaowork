import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { FIRING_FRAME, frameFiring } from "@openbot/shared/routine-firing";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import {
  CHANNEL_SUMMARY_KIND,
  type ChannelTitler,
  offerChannelsAwaitingSummary,
  SUMMARY_TENANT_UNRESOLVED,
  summariseClaimedChannels,
  type ThreadTranscript,
} from "../src/channels/summary";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { TEAM_TENANT } from "../src/db/schema/tenant";
import { currentTenant, runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

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
const queue = createWorkQueue(database);

const testPrefix = `channel-summary-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/*
 * As `platform`: a conversation, its Bot and its queued naming are each written in their person's
 * tenant (G01), and a read or a tear-down from no frame sees only `system` rows and misses them all.
 */
const asPlatform = <T>(fn: () => T): T => runAsTenant("platform", fn);

afterEach(async () => {
  await asPlatform(clearCreated);
});

async function clearCreated() {
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(workItems).where(eq(workItems.key, channelId));
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
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
}

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Channel Summary Test User",
    }),
  );
  createdUserIds.push(id);
  return { id, role: "user" };
}

/** Inside the person's own tenant, which is where every request of theirs runs. */
async function createAgent(owner: AgentActor) {
  const profile = await runAsTenant(owner.id, () =>
    profileStore.create(owner, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private",
    }),
  );
  createdAgentIds.push(profile.id);
  return profile.id;
}

/** A channel somebody has actually said something in, which is the only kind worth naming. */
async function createUsedChannel(owner: AgentActor) {
  const agentId = await createAgent(owner);
  return await runAsTenant(owner.id, async () => {
    const channel = await store.create(owner, [agentId]);
    createdChannelIds.push(channel.id);
    await store.recordActivity(owner, channel.id, {
      text: "Which of these receipts count as travel?",
      agentId: null,
      at: new Date(),
    });
    return channel;
  });
}

/** A transcript with one question and one answer in it, which is what a title is made from. */
function transcriptOf(question: string, answer?: string): ThreadTranscript {
  return {
    getThreadMessages: async () => ({
      messages: [
        { role: "user", content: question },
        ...(answer ? [{ role: "assistant", content: answer }] : []),
      ],
    }),
  };
}

function titler(answer: string | null): ChannelTitler {
  return async () => answer;
}

async function summaryOf(channelId: string) {
  const [row] = await asPlatform(() =>
    database
      .select({ summary: channels.summary, summaryAt: channels.summaryAt })
      .from(channels)
      .where(eq(channels.id, channelId)),
  );
  return row;
}

/** The queue row for one conversation, wherever it was stamped. */
async function workFor(channelId: string) {
  const [row] = await asPlatform(() =>
    database
      .select({
        tenantId: workItems.tenantId,
        finishedAt: workItems.finishedAt,
        runAt: workItems.runAt,
        attempts: workItems.attempts,
        error: workItems.lastError,
      })
      .from(workItems)
      .where(eq(workItems.key, channelId)),
  );
  return row;
}

/**
 * Queue one conversation, by name.
 *
 * Deliberately not `offerChannelsAwaitingSummary`, which offers every unnamed conversation in the
 * database. A claim takes whatever is queued, so a test that offers the whole table and then claims
 * will happily write a fabricated title onto somebody's real conversation when the suite is pointed
 * at a database that has any — a development one, for instance. Tests that exercise the offer query
 * itself assert on what it returns and never claim.
 *
 * Offered from the conversation's own tenant, as the real offer does, so the row is that person's.
 */
async function offer(channelId: string) {
  const [row] = await asPlatform(() =>
    database
      .select({ tenantId: channels.tenantId })
      .from(channels)
      .where(eq(channels.id, channelId)),
  );
  // A conversation this file made always exists; offering one that does not would otherwise fall
  // back to the unframed `system` partition, which P16 removes.
  if (!row) throw new Error(`offer: no conversation ${channelId}`);
  await runAsTenant(row.tenantId, () =>
    queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channelId }),
  );
}

/**
 * The real offer, which asks as the platform and so offers EVERY person's unnamed conversation in
 * this database, other test files' leftovers included. Whatever it queued for a conversation this
 * file did not make is taken off the queue again before the test goes on: left there it would sit
 * ahead of this file's own work (older `run_at`, claimed first), and a later claim would read and
 * title somebody else's conversation. Each id it returns had no work row before this call, so the
 * rows deleted are exactly the ones it just made.
 */
async function offerAll(limit = 200): Promise<{ offered: string[] }> {
  const result = await offerChannelsAwaitingSummary({
    database,
    queue,
    limit,
  });
  const foreign = result.offered.filter(
    (id) => !createdChannelIds.includes(id),
  );
  if (foreign.length > 0) {
    await asPlatform(() =>
      database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, CHANNEL_SUMMARY_KIND),
            inArray(workItems.key, foreign),
          ),
        ),
    );
  }
  return result;
}

const options = (overrides: {
  transcript?: ThreadTranscript;
  title?: ChannelTitler;
  owner?: string;
}) => ({
  database,
  queue,
  transcript: overrides.transcript ?? transcriptOf("Which receipts?"),
  title: overrides.title ?? titler("Travel receipt rules"),
  owner: overrides.owner ?? `test-${randomUUID()}`,
});

describe("offering conversations to be named", () => {
  test("offers one that has been used and has no name yet", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);

    const { offered } = await offerAll();

    expect(offered).toContain(channel.id);
  });

  test("does not offer a channel nobody has said anything in", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await runAsTenant(owner.id, () =>
      store.create(owner, [agentId]),
    );
    createdChannelIds.push(channel.id);

    const { offered } = await offerAll();

    // There is nothing for a model to read, and asking it to name an empty thread spends money to
    // produce a guess.
    expect(offered).not.toContain(channel.id);
  });

  test("offering the same conversation twice leaves one piece of work", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);

    await offerAll();
    await offerAll();

    const rows = await asPlatform(() =>
      database
        .select({ key: workItems.key, tenantId: workItems.tenantId })
        .from(workItems)
        .where(eq(workItems.key, channel.id)),
    );
    expect(rows).toHaveLength(1);
    // Offered as the conversation's person, not as the platform that asked which needed naming.
    expect(rows[0]?.tenantId).toBe(owner.id);
  });

  /*
   * A pass offers at most `limit` conversations, twenty by default, and a conversation it could not
   * name keeps no summary, so it stays in the set the pass reads. Offering it again while its settled
   * work row stands does nothing, but it still used one of those places. Twenty such conversations
   * ahead of a new one left nothing for it, pass after pass.
   */
  test("does not spend a place on a conversation whose settled work still stands", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    // Settled without a name, the way a model that answers with nothing leaves it.
    await summariseClaimedChannels(options({ title: titler(null) }));
    expect((await summaryOf(channel.id))?.summary).toBeNull();

    const { offered } = await offerAll();

    expect(offered).not.toContain(channel.id);
  });

  test("offers it again once its settled work has been forgotten", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    await summariseClaimedChannels(options({ title: titler(null) }));
    // What `forgetSettledSummaries` does once the finished row is an hour old.
    await asPlatform(() =>
      database.delete(workItems).where(eq(workItems.key, channel.id)),
    );

    const { offered } = await offerAll();

    expect(offered).toContain(channel.id);
  });
});

/**
 * What the first pass on a deployment with a history looks like.
 *
 * Every conversation ever used and never named is eligible at once, so the only thing standing
 * between a deploy and a model request per historical conversation is the claim limit. These pin
 * that limit as behaviour rather than leaving it a constant somebody can raise without noticing what
 * it is holding back.
 */
describe("a backlog of unnamed conversations", () => {
  test("names at most one batch per pass, not one per conversation", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const made: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const channel = await runAsTenant(owner.id, async () => {
        const created = await store.create(owner, [agentId]);
        createdChannelIds.push(created.id);
        await store.recordActivity(owner, created.id, {
          text: `Question ${index}`,
          agentId: null,
          at: new Date(),
        });
        return created;
      });
      made.push(channel.id);
    }
    for (const id of made) await offer(id);

    let calls = 0;
    const counting = options({
      title: async () => {
        calls += 1;
        return "A title";
      },
    });

    const first = await summariseClaimedChannels({ ...counting, limit: 2 });
    expect(first.written).toHaveLength(2);
    expect(calls).toBe(2);

    const second = await summariseClaimedChannels({ ...counting, limit: 2 });
    expect(second.written).toHaveLength(2);
    // The next batch, not the first one again.
    expect(second.written.some((id) => first.written.includes(id))).toBe(false);
    expect(calls).toBe(4);
  });
});

describe("naming a claimed conversation", () => {
  test("writes the title and stamps when it was written", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    const report = await summariseClaimedChannels(
      options({
        transcript: transcriptOf(
          "Which of these receipts count as travel?",
          "The three flights and the hotel do.",
        ),
        title: titler("Travel receipt rules"),
      }),
    );

    expect(report.written).toContain(channel.id);
    const row = await summaryOf(channel.id);
    expect(row?.summary).toBe("Travel receipt rules");
    expect(row?.summaryAt).toBeInstanceOf(Date);
  });

  test("titles a routine-opened channel from the instruction, not the firing frame", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    let excerptSeen = "";
    await summariseClaimedChannels(
      options({
        // A channel a routine opened has its first message framed, not typed by a person: see
        // `shared/routine-firing.ts`. The title has to come from the instruction inside the frame.
        transcript: transcriptOf(frameFiring("Post the standup summary.")),
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Standup summary";
        },
      }),
    );

    expect(excerptSeen).toContain("Post the standup summary.");
    expect(excerptSeen).not.toContain(FIRING_FRAME[0]);
    expect((await summaryOf(channel.id))?.summary).toBe("Standup summary");
  });

  test("two replicas racing for the same conversation name it once", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    /*
     * Overlapping, not sequential. Two sweeps run one after the other pass just as happily with the
     * row-level locking removed, so they prove the conditional update and nothing about the claim.
     * These two are in flight together on separate pooled connections, which is what `for update
     * skip locked` is there for: the second finds nothing to take rather than waiting behind the
     * first and then doing the work twice.
     */
    const [left, right] = await Promise.all([
      summariseClaimedChannels(options({ title: titler("Left title") })),
      summariseClaimedChannels(options({ title: titler("Right title") })),
    ]);

    expect([...left.written, ...right.written]).toEqual([channel.id]);
    expect(left.considered + right.considered).toBe(1);
    const written = (await summaryOf(channel.id))?.summary;
    expect(["Left title", "Right title"]).toContain(written);
  });

  test("never overwrites a name the conversation already has", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await asPlatform(() =>
      database
        .update(channels)
        .set({ summary: "Named already", summaryAt: new Date() })
        .where(eq(channels.id, channel.id)),
    );
    // Offered before it was named, which is exactly the race two replicas produce.
    await offer(channel.id);

    await summariseClaimedChannels(
      options({ title: titler("A second opinion") }),
    );

    expect((await summaryOf(channel.id))?.summary).toBe("Named already");
  });

  test("leaves the conversation unnamed when the model has no answer", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    const report = await summariseClaimedChannels(
      options({ title: titler(null) }),
    );

    // A deployment with no model key reaches this on every pass. Nothing is written, nothing is
    // broken, and the roster keeps drawing the Bot's name.
    expect(report.written).not.toContain(channel.id);
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("comes back later when the conversation is not readable yet", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    // What a conversation looks like in the seconds between somebody sending a message and
    // Intelligence holding it. Finishing the work here is how an ordinary conversation ends up
    // never named at all.
    const report = await summariseClaimedChannels(
      options({
        transcript: { getThreadMessages: async () => ({ messages: [] }) },
      }),
    );

    expect(report.skipped).toContainEqual({
      channelId: channel.id,
      reason: "not readable yet",
    });
    const item = await workFor(channel.id);
    expect(item?.finishedAt).toBeNull();
    expect(item?.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("a conversation that no longer exists is dropped, not retried", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    // The channel goes while its naming is still queued. A queue key is not a foreign key, so the
    // work outlives the thing it was about — which happens for real on a delete, and happens on
    // every integration test that seeds a channel and tears it down.
    await asPlatform(() =>
      database.delete(channels).where(eq(channels.id, channel.id)),
    );

    await summariseClaimedChannels(options({}));

    const item = await workFor(channel.id);
    // Finished rather than released: nothing about a deleted conversation is different in fifteen
    // seconds, and retrying it to the attempt cap burns a model call's worth of work each time.
    expect(item?.finishedAt).not.toBeNull();
    expect(item?.attempts).toBe(1);
  });

  test("a soft-deleted conversation is dropped the same way", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    await asPlatform(() =>
      database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channel.id)),
    );

    await summariseClaimedChannels(options({}));

    const item = await workFor(channel.id);
    expect(item?.finishedAt).not.toBeNull();
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("stays inside the NOTIFY payload limit on a crowded channel", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    // The title is short and fixed; the term that grows is the member list the payload carries, so
    // that is the term the test grows. `pg_notify` refuses a payload over 8000 bytes outright, and
    // it refuses it inside the transaction that writes the title.
    const crowd = [];
    for (let index = 0; index < 40; index += 1) {
      const member = await createUser();
      crowd.push(member.id);
      // Members of the owner's own channel, stamped with the owner. Seeded by the platform: no
      // person frame may write a row stamped with one person that names another (0128, G01-E P11
      // review), and `addMember` now adds people only to a shared `team` group. The rows, and the
      // member list the payload carries, are what they were.
      await runAsTenant("platform", () =>
        database
          .insert(channelMemberships)
          .values({
            channelId: channel.id,
            userId: member.id,
            tenantId: owner.id,
          }),
      );
    }

    await offer(channel.id);
    const report = await summariseClaimedChannels(
      options({ title: titler("Travel receipt rules") }),
    );

    expect(report.written).toContain(channel.id);
    // Recorded rather than merely survived: this is the number that says how much room is left, and
    // it is what a later change adding a field to the event has to be measured against.
    const payload = JSON.stringify({
      channelId: channel.id,
      memberIds: [owner.id, ...crowd],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      summary: "Travel receipt rules",
    });
    expect(payload.length).toBeLessThan(8000);
  });

  test("a model that fails leaves the work to be tried again", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    await summariseClaimedChannels(
      options({
        title: async () => {
          throw new Error("the model is unreachable");
        },
      }),
    );

    expect((await summaryOf(channel.id))?.summary).toBeNull();
    const item = await workFor(channel.id);
    expect(item?.attempts).toBe(1);
    expect(item?.error).toContain("the model is unreachable");
  });

  test("flattens and shortens whatever the model answers with", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    await summariseClaimedChannels(
      options({ title: titler('  "Travel\nreceipt   rules"  ') }),
    );

    // The quotes a model wraps a title in, the newline, and the run of spaces all go: a roster row
    // is one line of plain text.
    expect((await summaryOf(channel.id))?.summary).toBe("Travel receipt rules");
  });
});

/**
 * G01: naming a conversation runs as the conversation's own tenant.
 *
 * The loop is a timer and has no tenant. Before this it asked "which conversations need a name" as
 * `system`, which sees only the platform's own, and would have read and written whatever it found as
 * `system` too. It now asks that one question as the platform, offers each conversation from the
 * tenant stamped on it, and reads the thread and writes the title in that tenant's frame. A
 * conversation or a queue row stamped as nobody's is never named.
 */
describe("G01: whose conversation the loop is naming", () => {
  /** A conversation written straight to the tables from `frame`, stamped with whatever that is. */
  async function rawChannel(owner: AgentActor, frame: string) {
    const id = `${testPrefix}-raw-${randomUUID()}`;
    const write = async () => {
      await database.insert(channels).values({
        id,
        name: "Raw",
        description: "Raw",
        lastMessageAt: new Date(),
      });
      await database
        .insert(channelMemberships)
        .values({ channelId: id, userId: owner.id });
      await database.insert(intelligenceChannelMappings).values({
        userId: owner.id,
        channelId: id,
        threadId: `${id}-thread`,
      });
    };
    // The database stamps the session's tenant. A `system` row is made in an explicit `system`
    // frame, the same stamp the legacy unframed fallback gave, so the file also runs with the guard
    // set to `throw`.
    await runAsTenant(frame, write);
    createdChannelIds.push(id);
    return id;
  }

  /** Every read and every title, with the frame it happened in. */
  function watching(titleFor: string) {
    const reads: { userId: string; tenant: string }[] = [];
    const titled: string[] = [];
    return {
      reads,
      titled,
      transcript: {
        getThreadMessages: async ({ userId }: { userId: string }) => {
          reads.push({ userId, tenant: currentTenant() });
          return { messages: [{ role: "user", content: "Which receipts?" }] };
        },
      } satisfies ThreadTranscript,
      title: async () => {
        titled.push(currentTenant());
        return titleFor;
      },
    };
  }

  /** Passes until each of `ids` has left the queue one way or another, or five passes. */
  async function sweepUntilSettled(
    ids: string[],
    overrides: Parameters<typeof options>[0],
  ) {
    const reasons = new Map<string, string>();
    for (let pass = 0; pass < 5; pass += 1) {
      const report = await summariseClaimedChannels(options(overrides));
      for (const id of report.written) reasons.set(id, "written");
      for (const { channelId, reason } of report.skipped)
        reasons.set(channelId, reason);
      if (ids.every((id) => reasons.has(id))) break;
    }
    return reasons;
  }

  test("a conversation is offered, read and named as its own person, and nobody else sees it", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const channel = await createUsedChannel(alice);
    await offer(channel.id);
    expect((await workFor(channel.id))?.tenantId).toBe(alice.id);

    const seen = watching("Alice's receipts");
    const reasons = await sweepUntilSettled([channel.id], seen);

    expect(reasons.get(channel.id)).toBe("written");
    // Her thread, read as her; the model asked from her frame.
    expect(seen.reads.filter((read) => read.userId === alice.id)).toEqual([
      { userId: alice.id, tenant: alice.id },
    ]);
    expect(seen.reads.some((read) => read.userId === bob.id)).toBe(false);
    expect(seen.titled).toContain(alice.id);

    const asAlice = await runAsTenant(alice.id, () =>
      database
        .select({ summary: channels.summary, tenantId: channels.tenantId })
        .from(channels)
        .where(eq(channels.id, channel.id)),
    );
    expect(asAlice).toEqual([
      { summary: "Alice's receipts", tenantId: alice.id },
    ]);

    // Another tenant reads none of it: not the conversation, not its queued work.
    const asBob = await runAsTenant(bob.id, async () => ({
      channel: await database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, channel.id)),
      work: await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(eq(workItems.key, channel.id)),
    }));
    expect(asBob).toEqual({ channel: [], work: [] });
  });

  test("a conversation stamped as nobody's is never offered and never named, even when queued", async () => {
    const alice = await createUser();
    const asSystem = await rawChannel(alice, "system");
    const asPlatformRow = await rawChannel(alice, "platform");
    const asSystemForAlice = await rawChannel(alice, "system");
    // The shared tenant is nobody's too (G01-E): a group conversation stamped `team` has no one
    // person to name it for. Only `platform` may write a row stamped with another tenant.
    const asTeam = `${testPrefix}-raw-${randomUUID()}`;
    await asPlatform(async () => {
      await database.insert(channels).values({
        id: asTeam,
        name: "Raw",
        description: "Raw",
        lastMessageAt: new Date(),
        tenantId: TEAM_TENANT,
      });
      await database
        .insert(channelMemberships)
        .values({ channelId: asTeam, userId: alice.id, tenantId: TEAM_TENANT });
      await database.insert(intelligenceChannelMappings).values({
        userId: alice.id,
        channelId: asTeam,
        threadId: `${asTeam}-thread`,
        tenantId: TEAM_TENANT,
      });
    });
    createdChannelIds.push(asTeam);

    // `offerAll`, not the bare offer: it takes back what it queued for other files' conversations, so
    // the passes below claim only these four rows and title nobody else's conversation.
    const { offered } = await offerAll();
    expect(offered).not.toContain(asSystem);
    expect(offered).not.toContain(asPlatformRow);
    expect(offered).not.toContain(asSystemForAlice);
    expect(offered).not.toContain(asTeam);

    // Queued anyway: from the `system` frame, from the platform's, and from Alice's for a `system`
    // channel.
    await runAsTenant("system", () =>
      queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: asSystem }),
    );
    await asPlatform(() =>
      queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: asPlatformRow }),
    );
    await runAsTenant(alice.id, () =>
      queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: asSystemForAlice }),
    );

    // And one stamped `team`, which no frame can offer: written as the platform, stamped explicitly.
    await asPlatform(() =>
      database.insert(workItems).values({
        kind: CHANNEL_SUMMARY_KIND,
        key: asTeam,
        payload: { channelId: asTeam },
        tenantId: TEAM_TENANT,
      }),
    );

    const seen = watching("Nobody's title");
    const ids = [asSystem, asPlatformRow, asSystemForAlice, asTeam];
    const reasons = await sweepUntilSettled(ids, seen);

    for (const id of ids) {
      expect(reasons.get(id)).toBe(SUMMARY_TENANT_UNRESOLVED);
      expect((await summaryOf(id))?.summary).toBeNull();
      // Finished, not retried: nothing about whose it is changes on the next pass.
      const work = await workFor(id);
      expect(work?.finishedAt).not.toBeNull();
      // And the reason stays on the row, so a dropped row is something somebody can find.
      expect(work?.error).toBe(SUMMARY_TENANT_UNRESOLVED);
    }
    // Nobody's thread was read on anybody's behalf.
    expect(seen.reads.some((read) => read.userId === alice.id)).toBe(false);
  });

  test("work filed under one person never names another's conversation or reads another's thread", async () => {
    const alice = await createUser();
    const bob = await createUser();

    // Bob's queue row for Alice's conversation: from his frame it is not even there.
    const hers = await createUsedChannel(alice);
    await runAsTenant(bob.id, () =>
      queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: hers.id }),
    );

    // Alice's conversation where the only thread on it is Bob's.
    const borrowed = await createUsedChannel(alice);
    await asPlatform(() =>
      database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, borrowed.id)),
    );
    /*
     * Rows stamped with Alice that name Bob. Alice's own frame can no longer write them (0128 refuses
     * a row stamped with one person that names another, and deletes the old ones), so the platform
     * seeds them, standing for a row that got there anyway: the loop must still refuse to name it.
     */
    await runAsTenant("platform", async () => {
      await database
        .insert(channelMemberships)
        .values({ channelId: borrowed.id, userId: bob.id, tenantId: alice.id });
      await database.insert(intelligenceChannelMappings).values({
        userId: bob.id,
        channelId: borrowed.id,
        threadId: `${borrowed.id}-bob-thread`,
        tenantId: alice.id,
      });
    });
    await offer(borrowed.id);

    const seen = watching("Somebody else's title");
    const reasons = await sweepUntilSettled([hers.id, borrowed.id], seen);

    expect(reasons.get(hers.id)).toBe("nothing to name it with");
    expect(reasons.get(borrowed.id)).toBe("not readable yet");
    expect((await summaryOf(hers.id))?.summary).toBeNull();
    expect((await summaryOf(borrowed.id))?.summary).toBeNull();
    expect(
      seen.reads.some(
        (read) => read.userId === alice.id || read.userId === bob.id,
      ),
    ).toBe(false);
  });
});

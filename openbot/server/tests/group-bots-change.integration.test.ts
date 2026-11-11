import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
  GroupRefusedError,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const prefix = `gbots-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
    for (const id of createdChannels.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    if (createdAgents.length) {
      const ids = createdAgents.splice(0);
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, ids));
      await database.delete(agents).where(inArray(agents.id, ids));
    }
    for (const id of createdUsers.splice(0))
      await database.delete(users).where(eq(users.id, id));
  });
});
afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "Bots Test" }),
  );
  createdUsers.push(id);
  return { id, role: "user" };
}

const as = <T>(actor: AgentActor, work: () => T): T =>
  runAsTenant(actor.id, work);

async function bot(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Tester",
    roleDescription: "Answer briefly.",
    visibility: "private",
  });
  createdAgents.push(profile.id);
  return profile.id;
}

function groups() {
  return createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: `${prefix}-replica`,
    roster: async (ownerUserId, channelId) => {
      const actor: AgentActor = { id: ownerUserId, role: "user" };
      const channel = await channelStore.get(actor, channelId);
      if (!channel || channel.agentIds.length < 2) return null;
      const bots = [];
      for (const agentId of channel.agentIds) {
        const profile = await profileStore.get(actor, agentId);
        if (profile) bots.push({ id: agentId, name: profile.name });
      }
      return bots;
    },
    runTurn: async () => ({ replyText: "ok" }),
    caps: { maxDepth: 1, maxPerRun: 2 },
    mayAddress: async () => true,
    auditStore: { insert: async () => {} },
    createChannel: async (ownerUserId, agentIds, options) => {
      const channel = await channelStore.create(
        { id: ownerUserId, role: "user" },
        agentIds,
        options,
      );
      createdChannels.push(channel.id);
      return channel;
    },
    canUseBot: async (ownerUserId, agentId) =>
      Boolean(
        await profileStore.get({ id: ownerUserId, role: "user" }, agentId),
      ),
    progressEveryMs: 0,
  });
}

/** A group of two of the creator's bots, made the way a person makes one. */
async function groupOf(owner: AgentActor, names: string[]) {
  const ids: string[] = [];
  for (const name of names) ids.push(await bot(owner, name));
  const conversations = groups();
  const channel = await conversations.create(owner.id, { agentIds: ids });
  return { conversations, channelId: channel.id, ids };
}

async function botsOf(actor: AgentActor, channelId: string) {
  const channel = await as(actor, () => channelStore.get(actor, channelId));
  return channel?.agentIds.slice().sort() ?? [];
}

describe("changing the bots of an existing group", () => {
  test("the creator adds a bot and it answers last", async () => {
    const owner = await person();
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
      ]);
      const extra = await bot(owner, "Linus");
      const result = await conversations.addBots(owner.id, channelId, [extra]);
      expect(result).toEqual({ added: [extra] });
      expect(await conversations.store.order(channelId)).toEqual([
        ...ids,
        extra,
      ]);
      expect(await botsOf(owner, channelId)).toEqual([...ids, extra].sort());
      const rows = await database.execute(
        sql`select count(*)::int as n from group_bot_threads where channel_id = ${channelId}`,
      );
      expect(Number((rows[0] as { n: number }).n)).toBe(3);
    });
  });

  test("a bot the creator cannot run is refused by name", async () => {
    const owner = await person();
    const stranger = await person();
    const foreign = await as(stranger, () => bot(stranger, "Private"));
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
      ]);
      const refusal = await conversations
        .addBots(owner.id, channelId, [foreign])
        .then(
          () => null,
          (error: Error) => error,
        );
      expect(refusal).toBeInstanceOf(GroupRefusedError);
      expect(refusal?.message).toContain(foreign);
      expect(await botsOf(owner, channelId)).toEqual(ids.slice().sort());
      expect(await conversations.store.order(channelId)).toEqual(ids);
    });
  });

  test("removing a bot drops it from the roster and its thread row", async () => {
    const owner = await person();
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
        "Linus",
      ]);
      const [first = "", second = "", third = ""] = ids;
      expect(
        await conversations.removeBots(owner.id, channelId, [second]),
      ).toEqual({ removed: [second] });
      expect(await botsOf(owner, channelId)).toEqual([first, third].sort());
      expect(await conversations.store.order(channelId)).toEqual([
        first,
        third,
      ]);
    });
  });

  test("removing down to one bot is refused", async () => {
    const owner = await person();
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
      ]);
      await expect(
        conversations.removeBots(owner.id, channelId, [ids[0] ?? ""]),
      ).rejects.toBeInstanceOf(GroupRefusedError);
      expect(await botsOf(owner, channelId)).toEqual(ids.slice().sort());
    });
  });

  test("reorder rewrites the answer order without adding rows", async () => {
    const owner = await person();
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
        "Linus",
      ]);
      const flipped = ids.slice().reverse();
      await conversations.reorder(owner.id, channelId, flipped);
      expect(await conversations.store.order(channelId)).toEqual(flipped);
      const rows = await database.execute(
        sql`select count(*)::int as n from group_bot_threads where channel_id = ${channelId}`,
      );
      expect(Number((rows[0] as { n: number }).n)).toBe(3);
    });
  });

  test("reorder must be a permutation of the current bots", async () => {
    const owner = await person();
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
      ]);
      const extra = await bot(owner, "Linus");
      await expect(
        conversations.reorder(owner.id, channelId, [ids[0] ?? ""]),
      ).rejects.toBeInstanceOf(GroupRefusedError);
      await expect(
        conversations.reorder(owner.id, channelId, [...ids, extra]),
      ).rejects.toBeInstanceOf(GroupRefusedError);
      expect(await conversations.store.order(channelId)).toEqual(ids);
    });
  });

  test("a member who is not the creator cannot change bots", async () => {
    const owner = await person();
    const member = await person();
    const { conversations, channelId, ids } = await as(owner, async () => {
      const made = await groupOf(owner, ["Ada", "Grace"]);
      await made.conversations.addMember(owner.id, made.channelId, {
        email: `${member.id}@example.test`,
      });
      return made;
    });
    const spare = await as(member, () => bot(member, "Mine"));
    await as(member, async () => {
      await expect(
        conversations.addBots(member.id, channelId, [spare]),
      ).rejects.toBeInstanceOf(GroupRefusedError);
      await expect(
        conversations.removeBots(member.id, channelId, [ids[0] ?? ""]),
      ).rejects.toBeInstanceOf(GroupRefusedError);
      await expect(
        conversations.reorder(member.id, channelId, ids.slice().reverse()),
      ).rejects.toBeInstanceOf(GroupRefusedError);
    });
    expect(await botsOf(owner, channelId)).toEqual(ids.slice().sort());
    expect(await as(owner, () => conversations.store.order(channelId))).toEqual(
      ids,
    );
  });

  test("the routes drive the three changes as the signed-in person", async () => {
    const owner = await person();
    await as(owner, async () => {
      const { conversations, channelId, ids } = await groupOf(owner, [
        "Ada",
        "Grace",
      ]);
      const extra = await bot(owner, "Linus");
      const routes = createGroupRoutes(conversations, async (context, next) => {
        context.set("actor", owner);
        await next();
      });
      const call = (method: string, path: string, agentIds: string[]) =>
        routes.request(`/${channelId}/${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentIds }),
        });
      expect((await call("POST", "bots", [extra])).status).toBe(200);
      expect(await conversations.store.order(channelId)).toEqual([
        ...ids,
        extra,
      ]);
      const flipped = [extra, ...ids];
      expect((await call("PUT", "order", flipped)).status).toBe(204);
      expect(await conversations.store.order(channelId)).toEqual(flipped);
      expect((await call("DELETE", "bots", [extra])).status).toBe(200);
      expect(await botsOf(owner, channelId)).toEqual(ids.slice().sort());
      expect((await call("DELETE", "bots", [ids[0] ?? ""])).status).toBe(400);
    });
  });
});

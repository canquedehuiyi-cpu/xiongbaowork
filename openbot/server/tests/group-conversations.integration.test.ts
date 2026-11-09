import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import {
  and,
  asc,
  eq,
  inArray,
  like,
  sql,
} from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput } from "../src/audit";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
  GROUP_TURN_KIND,
  GroupNotFoundError,
  GroupRefusedError,
  groupSourceForRun,
} from "../src/channels/group";
import {
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  groupMessages,
  intelligenceChannelMappings,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { createPrivateShareCheck } from "../src/proactive/private-share";
import {
  createTeamBots,
} from "../src/team-bots/team-bots";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { createTaskProjector } from "../src/tasks/projector";
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
const prefix = `group-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];

afterEach(async () => {
  // Cleanup spans several people's rows and the queue's, which only the platform reaches.
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
    for (const id of createdUsers.splice(0)) {
      // The cards are the tenant's own rows, so only its own frame may delete them.
      await runAsTenant(id, async () => {
        await database.delete(tasks).where(eq(tasks.tenantId, id));
      });
      await database.delete(users).where(eq(users.id, id));
    }
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
      .values({ id, email: `${id}@example.test`, name: "Group Test" }),
  );
  createdUsers.push(id);
  return { id, role: "user" };
}

/** As a signed-in request runs: inside the person's own tenant. */
function as<T>(actor: AgentActor, work: () => T): T {
  return runAsTenant(actor.id, work);
}
async function bot(
  owner: AgentActor,
  name: string,
  visibility: "private" | "public" = "private",
) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Tester",
    roleDescription: "Answer briefly.",
    visibility,
  });
  createdAgents.push(profile.id);
  return profile.id;
}

function service(options: {
  replies: Record<
    string,
    (input: Parameters<TurnRunner>[0]) => string | Promise<string>
  >;
  maxDepth?: number;
  granted?: boolean;
  auditFails?: boolean;
  privateShare?: Parameters<typeof createGroupConversations>[0]["privateShare"];
  listenForConsent?: Parameters<
    typeof createGroupConversations
  >[0]["listenForConsent"];
  activity?: Parameters<typeof createGroupConversations>[0]["activity"];
  /** The board, attached only by the cases that are about the cards it holds. */
  board?: Parameters<typeof createGroupConversations>[0]["board"];
}) {
  const calls: Parameters<TurnRunner>[0][] = [];
  const audit: AuditEventInput[] = [];
  const conversations = createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: `${prefix}-replica`,
    // The production wiring's roster, against the real channel and profile stores.
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
    runTurn: async (input) => {
      calls.push(input);
      const reply = options.replies[input.agentId];
      if (!reply) throw new Error(`unexpected Bot ${input.agentId}`);
      return { replyText: await reply(input) };
    },
    caps: { maxDepth: options.maxDepth ?? 1, maxPerRun: 2 },
    mayAddress: async () => options.granted ?? true,
    auditStore: {
      insert: async (event) => {
        if (options.auditFails) throw new Error("audit store unavailable");
        audit.push(event);
      },
    },
    createChannel: async (ownerUserId, agentIds, channelOptions) => {
      const channel = await channelStore.create(
        { id: ownerUserId, role: "user" },
        agentIds,
        channelOptions,
      );
      createdChannels.push(channel.id);
      return channel;
    },
    progressEveryMs: 0,
    ...(options.privateShare ? { privateShare: options.privateShare } : {}),
    ...(options.listenForConsent
      ? { listenForConsent: options.listenForConsent }
      : {}),
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.board ? { board: options.board } : {}),
  });
  return { conversations, calls, audit };
}

async function drain(conversations: { sweep(): Promise<boolean> }) {
  for (let i = 0; i < 10 && (await conversations.sweep()); i++) {}
}

/**
 * Everything of a group's transcript `reader` can SELECT straight from the tables, in their own
 * frame: every column of the shared rows, and any private row (0128) they can reach. What a member
 * may not read must not be in here, whatever the service's own projection hides.
 */
async function rawTranscript(reader: AgentActor, channelId: string) {
  return as(reader, async () =>
    JSON.stringify({
      shared: await database.execute(
        sql`select * from group_messages where channel_id = ${channelId}`,
      ),
      held: await database.execute(
        sql`select p.* from group_message_private p join group_messages m on m.id = p.message_id where m.channel_id = ${channelId}`,
      ),
      everyHeld: await database.execute(
        sql`select * from group_message_private`,
      ),
    }),
  );
}

/** A queued item as the platform reads it: ended (finished) or handed back (an error kept). */
async function itemState(key: string) {
  const [row] = await runAsTenant("platform", () =>
    database
      .select({
        finishedAt: workItems.finishedAt,
        lastError: workItems.lastError,
      })
      .from(workItems)
      .where(eq(workItems.key, key)),
  );
  return row
    ? { finished: row.finishedAt !== null, lastError: row.lastError }
    : null;
}

/** A person's sign-in email, read in their own frame as their request would. */
async function emailOf(actor: AgentActor) {
  const [row] = await as(actor, () =>
    database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actor.id)),
  );
  return row?.email ?? "";
}

describe("group conversations in PostgreSQL", () => {
  test("two Bots answer one person, see each other, and answer each other within the depth cap", async () => {
    const owner = await person();
    await as(owner, async () => {
      const named = new Map([
        [await bot(owner, "Ada"), "Ada"],
        [await bot(owner, "Grace"), "Grace"],
      ]);
      // The group answers in its roster order, which is the channel's Bot order.
      const [ada = "", grace = ""] = [...named.keys()].sort();
      const A = named.get(ada) ?? "";
      const G = named.get(grace) ?? "";
      const channel = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(channel.id);
      const { conversations, calls, audit } = service({
        replies: {
          [ada]: () => `Draft ready. @${G} can you check the numbers?`,
          [grace]: (input) =>
            input.initiator?.kind === "handoff"
              ? `Numbers checked. @${A} looks right.`
              : "I will review the draft.",
        },
      });

      const messageId = `${prefix}-m1`;
      await conversations.send(owner.id, channel.id, {
        id: messageId,
        text: "Plan the launch",
      });
      await drain(conversations);

      // Person turn: the first Bot then the second, then the second again because the first addressed
      // it (depth 1). Its mention back is at the depth cap, so it is refused and audited, not run.
      expect(calls.map((call) => call.agentId)).toEqual([ada, grace, grace]);
      expect(calls[0]?.threadId).not.toBe(calls[1]?.threadId);
      expect(calls[1]?.threadId).toBe(calls[2]?.threadId);
      expect(String(calls[1]?.userMessage?.content)).toContain(
        `"speaker":"${A}"`,
      );
      expect(calls[2]?.initiator).toEqual({
        kind: "handoff",
        id: ada,
        origin: { kind: "person" },
      });
      expect(String(calls[2]?.userMessage?.content)).toContain(
        `${A} addressed you`,
      );

      const { messages, bots } = await conversations.list(owner.id, channel.id);
      expect(bots.map((row) => row.name).sort()).toEqual(["Ada", "Grace"]);
      expect(
        messages.map((row) => [row.agentId, row.status, row.text]),
      ).toEqual([
        [null, "completed", "Plan the launch"],
        [ada, "completed", `Draft ready. @${G} can you check the numbers?`],
        [grace, "completed", "I will review the draft."],
        [grace, "completed", `Numbers checked. @${A} looks right.`],
      ]);
      expect(audit.map((event) => event.eventType)).toEqual([
        "agent.handoff_offered",
        "agent.handoff_refused",
      ]);
      expect(audit[1]?.payload.reason).toBe("depth_cap");

      // A group Bot's thread authorises its own coordination callbacks, and no one else's.
      const threadId = calls[0]?.threadId ?? "";
      expect(
        await groupSourceForRun(database, {
          threadId,
          actorId: owner.id,
          botId: ada,
        }),
      ).toEqual({ channelId: channel.id, botId: ada });
      expect(
        await groupSourceForRun(database, {
          threadId,
          actorId: owner.id,
          botId: grace,
        }),
      ).toBeNull();

      // Resending the same message is one message, not a second turn.
      await conversations.send(owner.id, channel.id, {
        id: messageId,
        text: "Plan the launch",
      });
      await drain(conversations);
      expect(calls).toHaveLength(3);
    });
  });

  test("a person's message that starts with a skill's command states it for each Bot's turn, and a peer's never does", async () => {
    const owner = await person();
    const named = new Map([
      [await bot(owner, "Ada"), "Ada"],
      [await bot(owner, "Grace"), "Grace"],
    ]);
    const [ada = "", grace = ""] = [...named.keys()].sort();
    const G = named.get(grace) ?? "";
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    const { conversations, calls } = service({
      replies: {
        // A peer reply that starts with a command and hands on: the hop it starts picks nothing.
        [ada]: () => `/pirate-haiku @${G} your turn`,
        [grace]: () => "Arrr.",
      },
    });

    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-skill`,
      text: "/pirate-haiku write about my morning coffee",
    });
    await drain(conversations);

    // The Bot's message starts with the group's framing, so the command is stated beside it. Which
    // skill it is, and whether the Bot holds it, the server's runtime decides (picked-skill.ts).
    expect(String(calls[0]?.userMessage?.content)).toStartWith("You are ");
    expect(calls.map((call) => [call.agentId, call.skill])).toEqual([
      [ada, "pirate-haiku"],
      [grace, "pirate-haiku"],
      [grace, undefined],
    ]);

    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-no-skill`,
      text: "please /pirate-haiku about tea",
    });
    await drain(conversations);
    expect(calls.slice(3).map((call) => call.skill)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("another person cannot read, post into, or borrow the group's threads", async () => {
    const owner = await person();
    const stranger = await person();
    const { ada, grace, channel } = await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const channel = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(channel.id);
      return { ada, grace, channel };
    });
    const { conversations, calls } = service({
      replies: { [ada]: () => "hi", [grace]: () => "hello" },
    });
    await expect(
      as(stranger, () => conversations.list(stranger.id, channel.id)),
    ).rejects.toThrow(GroupNotFoundError);
    await expect(
      as(stranger, () =>
        conversations.send(stranger.id, channel.id, {
          id: `${prefix}-intruder`,
          text: "let me in",
        }),
      ),
    ).rejects.toThrow(GroupNotFoundError);
    await expect(
      as(owner, () =>
        conversations.send(owner.id, channel.id, {
          id: `${prefix}-wrong-bot`,
          text: "only you",
          agentId: "not-in-this-group",
        }),
      ),
    ).rejects.toThrow(GroupRefusedError);

    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-only-ada`,
        text: "only Ada please",
        agentId: ada,
      }),
    );
    await drain(conversations);
    expect(calls.map((call) => call.agentId)).toEqual([ada]);
    expect(
      await as(stranger, () =>
        groupSourceForRun(database, {
          threadId: calls[0]?.threadId,
          actorId: stranger.id,
          botId: ada,
        }),
      ),
    ).toBeNull();

    // Over HTTP the refusal is the same not-found as a channel that does not exist.
    const routes = createGroupRoutes(conversations, async (context, next) => {
      const id = context.req.header("x-test-user") ?? "";
      context.set("actor", { id } as never);
      // As `requireUser` in production: the request runs inside the signed-in person's tenant.
      await runAsTenant(id, () => next());
    });
    const asStranger = await routes.request(`/${channel.id}`, {
      headers: { "x-test-user": stranger.id },
    });
    expect(asStranger.status).toBe(404);
    const asOwner = await routes.request(`/${channel.id}`, {
      headers: { "x-test-user": owner.id },
    });
    expect(asOwner.status).toBe(200);
    expect(
      ((await asOwner.json()) as { messages: unknown[] }).messages,
    ).toHaveLength(2);
  });

  test("without a Bot-to-Bot grant a mention is audited and refused", async () => {
    const owner = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const channel = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(channel.id);
      const { conversations, calls, audit } = service({
        granted: false,
        replies: { [ada]: () => "@Grace over to you", [grace]: () => "ok" },
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-ungranted`,
        text: "go",
        agentId: ada,
      });
      await drain(conversations);
      expect(calls.map((call) => call.agentId)).toEqual([ada]);
      expect(audit.map((event) => event.payload.reason)).toEqual([
        "not_granted",
      ]);
      // The queue is nobody's tenant: what is in it is the platform's question.
      expect(
        (
          await runAsTenant("platform", () =>
            database
              .select()
              .from(workItems)
              .where(eq(workItems.kind, GROUP_TURN_KIND)),
          )
        ).filter((row) => row.key.startsWith(prefix) && row.key.includes(">")),
      ).toEqual([]);
    });
  });
  test("a fault after a reply is saved still posts its consent cards and hands it on", async () => {
    const owner = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const channel = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(channel.id);
      const { conversations, calls } = service({
        replies: { [ada]: () => "@Grace over to you", [grace]: () => "ok" },
        // Only Ada's saved reply fails to reach the activity feed; the person's message still does.
        activity: async (_turn, agentId) => {
          if (agentId === ada) throw new Error("activity feed unavailable");
        },
        listenForConsent: (_ownerUserId, agentId) => () =>
          agentId === ada
            ? [
                {
                  botId: ada,
                  serverId: "gmail",
                  message: "Ada needs your mail.",
                },
              ]
            : [],
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-activity-fault`,
        text: "go",
        agentId: ada,
      });
      await drain(conversations);
      const { messages } = await conversations.list(owner.id, channel.id);
      expect(
        messages.find((row) => row.agentId === ada && !row.consent),
      ).toMatchObject({
        status: "completed",
        text: "@Grace over to you",
      });
      expect(messages.some((row) => row.consent?.serverId === "gmail")).toBe(
        true,
      );
      expect(calls.some((call) => call.agentId === grace)).toBe(true);
    });
  });

  test("a fault handing a saved reply on does not write over the reply", async () => {
    const owner = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const channel = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(channel.id);
      const { conversations } = service({
        auditFails: true,
        replies: { [ada]: () => "@Grace over to you", [grace]: () => "ok" },
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-relay-fault`,
        text: "go",
        agentId: ada,
      });
      await drain(conversations);
      const reply = (
        await conversations.list(owner.id, channel.id)
      ).messages.find((row) => row.agentId === ada);
      expect(reply).toMatchObject({
        status: "completed",
        text: "@Grace over to you",
      });
    });
  });
  test("Bots answer in the order chosen, or in the order a message names them", async () => {
    const owner = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const linus = await bot(owner, "Linus");
      const { conversations, calls } = service({
        replies: { [ada]: () => "a", [grace]: () => "g", [linus]: () => "l" },
      });
      const channel = await conversations.create(owner.id, {
        agentIds: [linus, ada, grace],
      });
      expect(
        (await conversations.list(owner.id, channel.id)).bots.map((b) => b.id),
      ).toEqual([linus, ada, grace]);
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-all`,
        text: "everyone",
      });
      await drain(conversations);
      expect(calls.map((call) => call.agentId)).toEqual([linus, ada, grace]);
      calls.length = 0;
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-named`,
        text: "@Grace first, then @Ada",
      });
      await drain(conversations);
      expect(calls.map((call) => call.agentId)).toEqual([grace, ada]);
    });
  });

  test("partial text is visible while a Bot runs, an approval resumes into the row, and a relayed answer is attributed", async () => {
    const owner = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      let seenMidRun = "";
      let channelId = "";
      const { conversations, calls } = service({
        replies: {
          [ada]: async (input) => {
            input.onText?.("Hal");
            // The partial text is written asynchronously (flush() does not await store.progress), so
            // a fixed sleep could read the row before it lands. Wait (bounded) for it instead; if it
            // never lands the assertion below still fails.
            const deadline = Date.now() + 2000;
            for (;;) {
              seenMidRun =
                (await conversations.list(owner.id, channelId)).messages.at(-1)
                  ?.text ?? "";
              if (seenMidRun === "Hal" || Date.now() > deadline) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return "Hallo";
          },
          [grace]: () => {
            throw new HeadlessToolSuspension("Waiting for your approval.", {
              kind: "approval",
              approvalId: `${prefix}-approval`,
            });
          },
        },
      });
      const channel = await conversations.create(owner.id, {
        agentIds: [ada, grace],
      });
      channelId = channel.id;
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-stream`,
        text: "hello",
      });
      await drain(conversations);
      expect(seenMidRun).toBe("Hal");
      let { messages } = await conversations.list(owner.id, channel.id);
      expect(messages.map((row) => row.status)).toEqual([
        "completed",
        "completed",
        "waiting",
      ]);

      await conversations.continueWaiting(`${prefix}-approval`, async () => ({
        replyText: "Approved and done.",
      }));
      ({ messages } = await conversations.list(owner.id, channel.id));
      expect(messages.at(-1)).toMatchObject({
        agentId: grace,
        status: "completed",
        text: "Approved and done.",
      });

      const adaThread = calls[0]?.threadId ?? "";
      const relayed = {
        threadId: adaThread,
        actorId: owner.id,
        agentId: grace,
        text: "Grace's answer, relayed.",
      };
      expect(await conversations.announceHandoff(relayed)).toBe(true);
      expect(await conversations.announceHandoff(relayed)).toBe(true);
      ({ messages } = await conversations.list(owner.id, channel.id));
      const lines = messages.filter((row) => row.text === relayed.text);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ agentId: ada, answeredBy: grace });
      expect(
        await conversations.announceHandoff({
          ...relayed,
          threadId: "not-a-group",
        }),
      ).toBe(false);
    });
  });

  test("a member can add another signed-in person, who then reads the shared transcript", async () => {
    const owner = await person();
    const teammate = await person();
    // Each person's request runs in their own frame; the group is stamped `team` (G01-E P11).
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    const { conversations } = service({
      replies: { [ada]: () => "a", [grace]: () => "g" },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, {
        agentIds: [ada, grace],
      }),
    );
    await expect(
      as(teammate, () => conversations.list(teammate.id, channel.id)),
    ).rejects.toThrow(GroupNotFoundError);
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, {
        email: email.toUpperCase(),
      }),
    );
    const seen = await as(teammate, () =>
      conversations.list(teammate.id, channel.id),
    );
    // The owner's private Bots stay private: the teammate reads, but cannot run them.
    expect(seen.bots).toEqual([]);
    await expect(
      as(teammate, () =>
        conversations.addMember(teammate.id, channel.id, {
          email: "nobody@example.test",
        }),
      ),
    ).rejects.toThrow(GroupRefusedError);
  });
  test("with another person in the group, a reply waits for the owner's permission before anyone sees it", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    let decision: "pending" | "approved" | "denied" = "pending";
    const opened: unknown[] = [];
    const privateShare = createPrivateShareCheck({
      approvals: {
        open: async (action) => {
          opened.push(action);
          return { id: `${prefix}-share`, status: decision } as never;
        },
        list: async () => [],
        rules: async () => [],
      },
    });
    const { conversations } = service({
      replies: {
        [ada]: (input) =>
          String(input.userMessage?.content).includes("everyone")
            ? "From your notes: the launch slipped."
            : "All quiet.",
      },
      privateShare,
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, {
        agentIds: [ada, grace],
      }),
    );

    // Alone in the group, nothing is asked.
    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-alone`,
        text: "status?",
        agentId: ada,
      }),
    );
    await as(owner, () => drain(conversations));
    expect(opened).toHaveLength(0);

    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );
    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-shared`,
        text: "status for everyone?",
        agentId: ada,
      }),
    );
    await as(owner, () => drain(conversations));
    const seen = await as(teammate, () =>
      conversations.list(teammate.id, channel.id),
    );
    const held = seen.messages.at(-1);
    expect(held).toMatchObject({ agentId: ada, status: "waiting", text: "" });
    expect(JSON.stringify(seen)).not.toContain("launch slipped");
    // Not through the service only: no row the teammate can select holds the held reply (0128).
    expect(await rawTranscript(teammate, channel.id)).not.toContain(
      "launch slipped",
    );
    // The owner, whose reply it is, holds it in their own private row.
    expect(await rawTranscript(owner, channel.id)).toContain("launch slipped");

    decision = "approved";
    // The owner decides, in their own frame: the waiting row is theirs.
    await as(owner, () =>
      conversations.continueWaiting(`${prefix}-share`, async () => {
        throw new Error("a held reply is shown, not re-run");
      }),
    );
    const after = await as(teammate, () =>
      conversations.list(teammate.id, channel.id),
    );
    expect(after.messages.at(-1)).toMatchObject({
      status: "completed",
      text: "From your notes: the launch slipped.",
    });
    // Allowed, the final text is in the shared row the teammate selects, and the hold is gone.
    const shown = await as(teammate, () =>
      database
        .select({ text: groupMessages.text, status: groupMessages.status })
        .from(groupMessages)
        .where(eq(groupMessages.id, held?.id ?? "")),
    );
    expect(shown).toEqual([
      { text: "From your notes: the launch slipped.", status: "completed" },
    ]);
    const [left] = await runAsTenant("platform", () =>
      database.execute(
        sql`select count(*)::int as n from group_message_private where message_id = ${held?.id ?? ""}`,
      ),
    );
    expect(left).toEqual({ n: 0 });
  });
  test("a reply held for the owner's permission still hands off to the Bot it names", async () => {
    const owner = await person();
    const teammate = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      let decision: "pending" | "approved" = "pending";
      const privateShare = createPrivateShareCheck({
        approvals: {
          open: async () =>
            ({ id: `${prefix}-held-relay`, status: decision }) as never,
          list: async () => [],
          rules: async () => [],
        },
      });
      const { conversations, audit } = service({
        replies: {
          [ada]: () => "Over to you, @Grace.",
          [grace]: () => "On it.",
        },
        privateShare,
      });
      const channel = await conversations.create(owner.id, {
        agentIds: [ada, grace],
      });
      const [row] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, teammate.id));
      await conversations.addMember(owner.id, channel.id, {
        email: row?.email,
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-held-relay-send`,
        text: "ask grace",
        agentId: ada,
      });
      await drain(conversations);
      expect(
        audit.filter((event) => event.eventType === "agent.handoff_offered"),
      ).toHaveLength(0);

      decision = "approved";
      await conversations.continueWaiting(`${prefix}-held-relay`, async () => {
        throw new Error("a held reply is shown, not re-run");
      });
      await drain(conversations);
      expect(
        audit.filter((event) => event.eventType === "agent.handoff_offered"),
      ).toHaveLength(1);
      const after = await conversations.list(owner.id, channel.id);
      expect(after.messages.some((message) => message.text === "On it.")).toBe(
        true,
      );
    });
  });
  test("while a reply waits on the owner's permission, other members do not see it stream in", async () => {
    const owner = await person();
    const teammate = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const privateShare = createPrivateShareCheck({
        approvals: {
          open: async () =>
            ({ id: `${prefix}-stream-share`, status: "pending" }) as never,
          list: async () => [],
          rules: async () => [],
        },
      });
      let channelId = "";
      let teammateMidRun = "";
      let teammateRawMidRun = "";
      let ownerMidRun = "";
      const { conversations } = service({
        replies: {
          [ada]: async (input) => {
            input.onText?.("From your notes: the launch slipped.");
            // The partial text is written asynchronously, so wait (bounded) until the owner's view
            // shows it; only then is the teammate's view a meaningful check that it is withheld.
            const deadline = Date.now() + 2000;
            for (;;) {
              ownerMidRun = JSON.stringify(
                await conversations.list(owner.id, channelId),
              );
              if (ownerMidRun.includes("launch slipped")) break;
              if (Date.now() > deadline) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            // Read as the teammate's own request would be: in their frame.
            teammateMidRun = JSON.stringify(
              await as(teammate, () =>
                conversations.list(teammate.id, channelId),
              ),
            );
            // And straight from every table the teammate can select (0128).
            teammateRawMidRun = await rawTranscript(teammate, channelId);
            return "From your notes: the launch slipped.";
          },
        },
        privateShare,
      });
      const channel = await conversations.create(owner.id, {
        agentIds: [ada, grace],
      });
      channelId = channel.id;
      const [row] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, teammate.id));
      await conversations.addMember(owner.id, channel.id, {
        email: row?.email,
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-stream-private`,
        text: "status?",
        agentId: ada,
      });
      await drain(conversations);
      expect(teammateMidRun).not.toContain("launch slipped");
      expect(teammateRawMidRun).not.toContain("launch slipped");
      // Nor once it waits on the owner's permission.
      expect(await rawTranscript(teammate, channel.id)).not.toContain(
        "launch slipped",
      );
      // The owner, whose Bot it is, still watches the reply arrive.
      expect(ownerMidRun).toContain("launch slipped");
    });
  });

  test("a reply still waiting on its owner's permission is not handed to another person's Bot", async () => {
    const owner = await person();
    const teammate = await person();
    await as(owner, async () => {
      // Bots the teammate may use too, so the teammate can address them in the group. Made public
      // by their owner, which moves them to `team` (G01-E P8b) where the teammate's frame reads them.
      const ada = await bot(owner, "Ada", "public");
      const grace = await bot(owner, "Grace", "public");
      const privateShare = createPrivateShareCheck({
        approvals: {
          open: async () =>
            ({ id: `${prefix}-handed-share`, status: "pending" }) as never,
          list: async () => [],
          rules: async () => [],
        },
      });
      let channelId = "";
      let graceSaw = "";
      const { conversations } = service({
        replies: {
          [ada]: async (input) => {
            input.onText?.("From your notes: the launch slipped.");
            await new Promise((resolve) => setTimeout(resolve, 30));
            // Meanwhile the teammate asks Grace from their own request, and another replica runs
            // that turn (in the teammate's frame, from the queued item's stamp). That replica's
            // worker is nobody's (`platform`), not nested in this owner's turn: a sweep running
            // inside one person's frame may not take up another person's work (runAsClaimedTenant).
            await as(teammate, () =>
              conversations.send(teammate.id, channelId, {
                id: `${prefix}-handed-teammate`,
                text: "what is the status?",
                agentId: grace,
              }),
            );
            await runAsTenant("platform", () => conversations.sweep());
            return "From your notes: the launch slipped.";
          },
          [grace]: (input) => {
            graceSaw = JSON.stringify(input.userMessage?.content ?? "");
            return "I do not know yet.";
          },
        },
        privateShare,
      });
      const channel = await conversations.create(owner.id, {
        agentIds: [ada, grace],
      });
      channelId = channel.id;
      const [row] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, teammate.id));
      await conversations.addMember(owner.id, channel.id, {
        email: row?.email,
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-handed-private`,
        text: "status?",
        agentId: ada,
      });
      await drain(conversations);
      expect(graceSaw).toContain("what is the status?");
      expect(graceSaw).not.toContain("launch slipped");
    });
  });

  test("a peer turn resumed after an approval keeps its depth in the Bot-to-Bot chain", async () => {
    const owner = await person();
    await as(owner, async () => {
      const ada = await bot(owner, "Ada");
      const grace = await bot(owner, "Grace");
      const { conversations, audit } = service({
        replies: {
          [ada]: () => "Over to you, @Grace.",
          [grace]: () => {
            throw new HeadlessToolSuspension("Waiting for your approval.", {
              kind: "approval",
              approvalId: `${prefix}-peer-approval`,
            });
          },
        },
        maxDepth: 1,
      });
      const channel = await conversations.create(owner.id, {
        agentIds: [ada, grace],
      });
      await conversations.send(owner.id, channel.id, {
        id: `${prefix}-chain`,
        text: "start",
        agentId: ada,
      });
      await drain(conversations);
      // Grace's turn is one hop deep, and paused.
      expect(
        audit.filter((event) => event.eventType === "agent.handoff_offered"),
      ).toHaveLength(1);

      await conversations.continueWaiting(
        `${prefix}-peer-approval`,
        async () => ({
          replyText: "Done. Back to you, @Ada.",
        }),
      );
      // Answering Ada would be a second hop, past the cap of one: refused, not offered.
      const toAda = audit.filter(
        (event) =>
          (event.payload as { to?: string; target?: string }).to === ada ||
          (event.payload as { target?: string }).target === ada,
      );
      expect(toAda.map((event) => event.eventType)).toEqual([
        "agent.handoff_refused",
      ]);
      expect(toAda[0]?.payload).toMatchObject({
        reason: "depth_cap",
        depth: 1,
      });
    });
  });

  test("a reply resumed after an approval waits on the owner's permission before the group sees it", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    let decision: "pending" | "approved" = "pending";
    const opened: unknown[] = [];
    const privateShare = createPrivateShareCheck({
      approvals: {
        open: async (action) => {
          opened.push(action);
          return { id: `${prefix}-resumed-share`, status: decision } as never;
        },
        list: async () => [],
        rules: async () => [],
      },
    });
    const { conversations } = service({
      replies: {
        [ada]: () => {
          throw new HeadlessToolSuspension("Waiting for your approval.", {
            kind: "approval",
            approvalId: `${prefix}-resumed-tool`,
          });
        },
      },
      privateShare,
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );
    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-resumed`,
        text: "check my calendar",
        agentId: ada,
      }),
    );
    await runAsTenant("platform", () => drain(conversations));
    expect(opened).toHaveLength(0);

    // The owner allows the tool; the resumed turn answers from their private notes.
    const resumed = await as(owner, () =>
      conversations.continueWaiting(`${prefix}-resumed-tool`, async () => ({
        replyText: "From your notes: the hearing is on Tuesday.",
      })),
    );
    // Held like a reply that finished in one go, and nothing is reported shown.
    expect(opened).toHaveLength(1);
    expect(resumed).toEqual({ replyText: "" });
    const seen = await as(teammate, () =>
      conversations.list(teammate.id, channel.id),
    );
    expect(seen.messages.at(-1)).toMatchObject({
      agentId: ada,
      status: "waiting",
      text: "",
    });
    expect(JSON.stringify(seen)).not.toContain("hearing is on Tuesday");
    expect(await rawTranscript(teammate, channel.id)).not.toContain(
      "hearing is on Tuesday",
    );
    expect(await rawTranscript(owner, channel.id)).toContain(
      "hearing is on Tuesday",
    );

    decision = "approved";
    await as(owner, () =>
      conversations.continueWaiting(`${prefix}-resumed-share`, async () => {
        throw new Error("a held reply is shown, not re-run");
      }),
    );
    const after = await as(teammate, () =>
      conversations.list(teammate.id, channel.id),
    );
    expect(after.messages.at(-1)).toMatchObject({
      agentId: ada,
      status: "completed",
      text: "From your notes: the hearing is on Tuesday.",
    });
  });
  test("a held reply and a reply in progress are stamped with their sender, whatever frame writes them", async () => {
    const owner = await person();
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    const { conversations } = service({ replies: {} });
    const { store } = conversations;
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const turn = {
      ownerUserId: owner.id,
      channelId: channel.id,
      messageId: `${prefix}-stamped`,
      agentIds: [ada, grace],
      text: "hello",
    };
    await as(owner, async () => {
      await store.submit(turn);
      await store.start(turn, ada, null);
      await store.start(turn, grace, null);
    });
    // Written from the platform frame (admin or background work) rather than the sender's own.
    await runAsTenant("platform", async () => {
      await store.progress(`${turn.messageId}:${ada}`, "Half an answer");
      await store.finish(
        `${turn.messageId}:${grace}`,
        "Held answer",
        "waiting",
        {
          approvalId: `${prefix}-stamped-approval`,
        },
      );
    });
    const stamps = await runAsTenant("platform", () =>
      database.execute(
        sql`select message_id as "messageId", tenant_id as "tenantId" from group_message_private where message_id like ${`${turn.messageId}:%`} order by message_id`,
      ),
    );
    expect(
      Array.from(stamps as ArrayLike<{ messageId: string; tenantId: string }>)
        .map((row) => [row.messageId, row.tenantId])
        .sort(),
    ).toEqual(
      [
        [`${turn.messageId}:${ada}`, owner.id],
        [`${turn.messageId}:${grace}`, owner.id],
      ].sort(),
    );
    // So the sender finds both in their own frame.
    const listed = await as(owner, () => store.list(channel.id));
    expect(
      listed.find((row) => row.id === `${turn.messageId}:${ada}`)?.text,
    ).toBe("Half an answer");
    expect(
      (await as(owner, () => store.waitingFor(`${prefix}-stamped-approval`)))
        ?.id,
    ).toBe(`${turn.messageId}:${grace}`);
  });
  test("a Team Bot's consent card in a group turn is a line in the shared transcript", async () => {
    const owner = await person();
    const teammate = await person();
    // The owner makes and publishes the Bot in their own frame; it moves to `team` (G01-E P9).
    const teamBot = await as(owner, () => bot(owner, "Mailer"));
    const own = await as(teammate, () => bot(teammate, "Helper"));
    const teamBots = createTeamBots({
      database,
      connectedServers: async (userId) =>
        new Set(userId === teammate.id ? ["gmail"] : []),
    });
    await as(owner, async () => {
      await database
        .update(agentProfiles)
        .set({ roleDescription: "Sends mail." })
        .where(eq(agentProfiles.agentId, teamBot));
      await teamBots.publish(owner, teamBot, {
        audience: "team",
        emails: [],
        groups: [],
      });
    });
    const { conversations } = service({
      replies: {
        // Standing in for the granted tool the Bot would call during its turn.
        [teamBot]: async (input) => {
          const said = await teamBots
            .credentialActorFor(
              input.ownerUserId,
              teamBot,
            )("gmail/send")
            .then(
              () => "sent",
              () => "I need your permission to use your mail.",
            );
          return said;
        },
        [own]: () => "ok",
      },
      listenForConsent: (ownerUserId, agentId) =>
        teamBots.listenForConsent(ownerUserId, agentId),
    });
    // The teammate asks the team Bot from their own frame.
    await as(teammate, async () => {
      const channel = await conversations.create(teammate.id, {
        agentIds: [teamBot, own],
      });
      await conversations.send(teammate.id, channel.id, {
        id: `${prefix}-consent`,
        text: "mail the team",
        agentId: teamBot,
      });
      await drain(conversations);
      const { messages, people } = await conversations.list(
        teammate.id,
        channel.id,
      );
      expect(messages.at(-1)).toMatchObject({
        agentId: teamBot,
        consent: { botId: teamBot, serverId: "gmail" },
      });
      expect(people.map((row) => row.userId)).toEqual([teammate.id]);
    });
  });

  test("the person who made a group can take someone out; others can only leave", async () => {
    const owner = await person();
    const second = await person();
    const third = await person();
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    const { conversations } = service({
      replies: { [ada]: () => "a", [grace]: () => "g" },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, {
        agentIds: [ada, grace],
      }),
    );
    for (const member of [second, third]) {
      const email = await emailOf(member);
      await as(owner, () =>
        conversations.addMember(owner.id, channel.id, {
          email,
        }),
      );
    }
    expect(
      (
        await as(owner, () => conversations.list(owner.id, channel.id))
      ).people.map((p) => [p.userId, p.creator]),
    ).toEqual([
      [owner.id, true],
      [second.id, false],
      [third.id, false],
    ]);
    await expect(
      as(second, () =>
        conversations.removeMember(second.id, channel.id, third.id),
      ),
    ).rejects.toThrow(GroupRefusedError);
    await expect(
      as(owner, () =>
        conversations.removeMember(owner.id, channel.id, owner.id),
      ),
    ).rejects.toThrow(GroupRefusedError);
    await as(second, () =>
      conversations.removeMember(second.id, channel.id, second.id),
    );
    await as(owner, () =>
      conversations.removeMember(owner.id, channel.id, third.id),
    );
    for (const gone of [second, third])
      await expect(
        as(gone, () => conversations.list(gone.id, channel.id)),
      ).rejects.toThrow(GroupNotFoundError);
  });

  /**
   * G01-E P11: a group is a `team` conversation, read by each member in their own frame. Every
   * call below runs as the person whose request it would be, so row security (not the store's
   * joins alone) is what decides who reads what.
   */
  test("an invitee reads the group, its people and its transcript; a stranger and a removed member read nothing", async () => {
    const owner = await person();
    const teammate = await person();
    const stranger = await person();
    const ada = await as(owner, () => bot(owner, "Ada", "public"));
    const grace = await as(owner, () => bot(owner, "Grace", "public"));
    const { conversations } = service({
      replies: { [ada]: () => "Ada here.", [grace]: () => "Grace here." },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );
    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-shared-transcript`,
        text: "hello, both",
      }),
    );
    await as(owner, () => drain(conversations));

    // Stamped `team`, every row of it, and the creator recorded by the database.
    const stamps = await runAsTenant("platform", () =>
      database.execute(
        sql`select (select tenant_id from channels where id = ${channel.id}) as channel,
                   (select created_by from channels where id = ${channel.id}) as creator,
                   (select array_agg(distinct tenant_id) from channel_memberships where channel_id = ${channel.id}) as memberships,
                   (select array_agg(distinct tenant_id) from channel_agents where channel_id = ${channel.id}) as bots,
                   (select array_agg(distinct tenant_id) from group_messages where channel_id = ${channel.id}) as messages,
                   (select array_agg(distinct tenant_id) from group_bot_threads where channel_id = ${channel.id}) as threads`,
      ),
    );
    expect(stamps[0]).toEqual({
      channel: "team",
      creator: owner.id,
      memberships: ["team"],
      bots: ["team"],
      messages: ["team"],
      threads: ["team"],
    });

    const seen = await as(teammate, () =>
      conversations.list(teammate.id, channel.id),
    );
    expect(seen.bots.map((entry) => entry.id).sort()).toEqual(
      [ada, grace].sort(),
    );
    expect(seen.people.map((entry) => [entry.userId, entry.creator])).toEqual([
      [owner.id, true],
      [teammate.id, false],
    ]);
    expect(seen.messages.map((message) => message.text)).toEqual([
      "hello, both",
      "Ada here.",
      "Grace here.",
    ]);
    // The teammate's roster has it too, through a mapping written in the teammate's own frame.
    expect(
      (await as(teammate, () => channelStore.list(teammate))).channels.map(
        (entry) => entry.id,
      ),
    ).toContain(channel.id);
    const [mapping] = await runAsTenant("platform", () =>
      database
        .select({ tenantId: intelligenceChannelMappings.tenantId })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.channelId, channel.id),
            eq(intelligenceChannelMappings.userId, teammate.id),
          ),
        ),
    );
    expect(mapping?.tenantId).toBe(teammate.id);

    // The teammate posts too, and their line is theirs.
    await as(teammate, () =>
      conversations.send(teammate.id, channel.id, {
        id: `${prefix}-teammate-line`,
        text: "and me",
        agentId: ada,
      }),
    );
    await drain(conversations);
    expect(
      (
        await as(owner, () => conversations.list(owner.id, channel.id))
      ).messages.some(
        (message) =>
          message.text === "and me" && message.ownerUserId === teammate.id,
      ),
    ).toBe(true);

    // A stranger reads none of it, through the service or straight from the tables.
    await expect(
      as(stranger, () => conversations.list(stranger.id, channel.id)),
    ).rejects.toThrow(GroupNotFoundError);
    await expect(
      as(stranger, () =>
        conversations.send(stranger.id, channel.id, {
          id: `${prefix}-stranger-line`,
          text: "let me in",
        }),
      ),
    ).rejects.toThrow(GroupNotFoundError);
    const strangerSees = await as(stranger, () =>
      database.execute(
        sql`select (select count(*) from channels where id = ${channel.id})::int as channels,
                   (select count(*) from channel_memberships where channel_id = ${channel.id})::int as memberships,
                   (select count(*) from group_messages where channel_id = ${channel.id})::int as messages,
                   (select count(*) from group_bot_threads where channel_id = ${channel.id})::int as threads`,
      ),
    );
    expect(strangerSees[0]).toEqual({
      channels: 0,
      memberships: 0,
      messages: 0,
      threads: 0,
    });
    expect(
      await as(stranger, () => channelStore.get(stranger, channel.id)),
    ).toBeNull();

    // Taken out by the person who started it, the teammate loses all of it.
    await as(owner, () =>
      conversations.removeMember(owner.id, channel.id, teammate.id),
    );
    await expect(
      as(teammate, () => conversations.list(teammate.id, channel.id)),
    ).rejects.toThrow(GroupNotFoundError);
    const removedSees = await as(teammate, () =>
      database.execute(
        sql`select (select count(*) from channels where id = ${channel.id})::int as channels,
                   (select count(*) from group_messages where channel_id = ${channel.id})::int as messages`,
      ),
    );
    expect(removedSees[0]).toEqual({ channels: 0, messages: 0 });
    expect(
      (await as(teammate, () => channelStore.list(teammate))).channels.map(
        (entry) => entry.id,
      ),
    ).not.toContain(channel.id);
  });

  test("only the person who started a group deletes it; a member cannot, and a non-owner resumes no one's wait", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    const approvalId = `${prefix}-owners-wait`;
    const { conversations } = service({
      replies: {
        [ada]: () => {
          throw new HeadlessToolSuspension("Waiting for your approval.", {
            kind: "approval",
            approvalId,
          });
        },
        [grace]: () => "g",
      },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );
    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-owners-wait-send`,
        text: "do the thing",
        agentId: ada,
      }),
    );
    await as(owner, () => drain(conversations));

    // The waiting row is the owner's to resume: the teammate reads it, but it is not theirs.
    expect(
      (await as(owner, () => conversations.store.waitingFor(approvalId)))
        ?.ownerUserId,
    ).toBe(owner.id);
    expect(
      await as(teammate, () => conversations.store.waitingFor(approvalId)),
    ).toBeNull();
    let ran = false;
    await as(teammate, () =>
      conversations.continueWaiting(approvalId, async () => {
        ran = true;
        return { replyText: "resumed by the wrong person" };
      }),
    );
    // Not a group turn of the teammate's, so it ran as a plain continuation and wrote nothing here.
    expect(ran).toBe(true);
    expect(
      JSON.stringify(
        await as(owner, () => conversations.list(owner.id, channel.id)),
      ),
    ).not.toContain("resumed by the wrong person");

    // A member cannot delete the group for everybody, through the store or straight at the row.
    await expect(
      as(teammate, () => channelStore.softDelete(teammate, channel.id)),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
    const refusal = await as(teammate, async () => {
      await database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channel.id));
    }).then(
      () => null,
      (error: { cause?: { message?: string } }) => error.cause?.message,
    );
    // The row guard's refusal (0122), not some unrelated failure.
    expect(refusal).toContain("only the creator deletes or restores");
    expect(
      await as(teammate, () => channelStore.get(teammate, channel.id)),
    ).not.toBeNull();
    // They can leave it, which takes it off their roster only.
    await as(teammate, () =>
      conversations.removeMember(teammate.id, channel.id, teammate.id),
    );
    expect(
      await as(teammate, () => channelStore.get(teammate, channel.id)),
    ).toBeNull();
    expect(
      await as(owner, () => channelStore.get(owner, channel.id)),
    ).not.toBeNull();

    // The person who started it can.
    await expect(
      as(owner, () => channelStore.softDelete(owner, channel.id)),
    ).resolves.toBe(true);
    expect(
      await as(owner, () => channelStore.get(owner, channel.id)),
    ).toBeNull();
  });

  /*
   * P11 review: a person's key in a group (their membership, their mapping) is global, so a row
   * holding it that they cannot see would lock them out with nothing said. 0128 refuses such a row
   * from anybody but `platform` and deletes the old ones; these are planted as `platform` to stand
   * for one that got there anyway, and the store must say so instead of reporting success.
   */
  test("an invitee whose place is held by a row they cannot read is not reported added, and their read fails loudly", async () => {
    const owner = await person();
    const teammate = await person();
    const squatter = await person();
    const ada = await as(owner, () => bot(owner, "Ada", "public"));
    const grace = await as(owner, () => bot(owner, "Grace", "public"));
    const { conversations } = service({
      replies: { [ada]: () => "a", [grace]: () => "g" },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);

    // The squatter tries it from their own frame: refused by the database (0128).
    const planted = await as(squatter, () =>
      database
        .insert(channelMemberships)
        .values({ channelId: channel.id, userId: teammate.id })
        .then(
          () => "written",
          (error: { cause?: { errno?: string } }) => error.cause?.errno,
        ),
    );
    expect(planted).toBe("42501");

    // A membership key held by a row the inviter cannot see: the add is refused, not a 201.
    await runAsTenant("platform", () =>
      database.insert(channelMemberships).values({
        channelId: channel.id,
        userId: teammate.id,
        tenantId: squatter.id,
      }),
    );
    await expect(
      as(owner, () => conversations.addMember(owner.id, channel.id, { email })),
    ).rejects.toThrow("their place in it is taken");
    await expect(
      as(teammate, () => conversations.list(teammate.id, channel.id)),
    ).rejects.toThrow(GroupNotFoundError);
    await runAsTenant("platform", () =>
      database
        .delete(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channel.id),
            eq(channelMemberships.userId, teammate.id),
          ),
        ),
    );
    // With the key free the add writes the membership, and adding them again is the same fact.
    expect(
      await as(owner, () =>
        conversations.addMember(owner.id, channel.id, { email }),
      ),
    ).toEqual({ userId: teammate.id });
    expect(
      await as(owner, () =>
        conversations.addMember(owner.id, channel.id, { email }),
      ),
    ).toEqual({ userId: teammate.id });

    // A mapping key held by a row the invitee cannot see: their first read fails loudly, rather
    // than the group silently not existing for one of its members.
    await runAsTenant("platform", () =>
      database.insert(intelligenceChannelMappings).values({
        channelId: channel.id,
        userId: teammate.id,
        threadId: `${prefix}-squatted-thread`,
        tenantId: squatter.id,
      }),
    );
    await expect(
      as(teammate, () => channelStore.get(teammate, channel.id)),
    ).rejects.toThrow("held by a row they cannot read");
    await runAsTenant("platform", () =>
      database
        .delete(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.channelId, channel.id),
            eq(intelligenceChannelMappings.userId, teammate.id),
          ),
        ),
    );
    expect(
      (await as(teammate, () => channelStore.get(teammate, channel.id)))?.id,
    ).toBe(channel.id);
  });

  test("a member cannot send under the id of somebody else's Bot reply, hand-off or consent card", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada", "public"));
    const grace = await as(owner, () => bot(owner, "Grace", "public"));
    const { conversations, calls, audit } = service({
      replies: {
        [ada]: () => "Over to you, @Grace.",
        [grace]: () => "Grace here.",
      },
      // Standing in for a Team Bot asking the owner for their mail during Ada's turn.
      listenForConsent: (ownerUserId, agentId) => () =>
        ownerUserId === owner.id && agentId === ada
          ? [{ botId: ada, serverId: "gmail", message: "Ada needs your mail." }]
          : [],
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );
    const question = `${prefix}-squat-q`;
    await as(owner, () =>
      conversations.send(owner.id, channel.id, {
        id: question,
        text: "Ada first, then Grace?",
      }),
    );

    // Every member reads the message id and the Bots, so they know every id the server derives from
    // them: each Bot's reply, the hand-off Ada's reply makes, and the consent card her turn raises.
    const derived = [
      `${question}:${grace}`,
      `${question}:${ada}>${grace}`,
      `${question}:${ada}:consent:gmail`,
    ];
    for (const id of derived) {
      await expect(
        as(teammate, () =>
          conversations.send(teammate.id, channel.id, {
            id,
            text: "squat",
            agentId: ada,
          }),
        ),
      ).rejects.toThrow("A message id cannot contain");
      // Nor past the service, straight into the store.
      await expect(
        as(teammate, () =>
          conversations.store.submit({
            ownerUserId: teammate.id,
            channelId: channel.id,
            messageId: id,
            agentIds: [ada],
            text: "squat",
          }),
        ),
      ).rejects.toThrow(GroupRefusedError);
    }
    // The route answers the same refusal as a bad request.
    const routes = createGroupRoutes(conversations, async (context, next) => {
      context.set("actor", { id: teammate.id } as never);
      await runAsTenant(teammate.id, () => next());
    });
    const posted = await routes.request(`/${channel.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: derived[0], text: "squat", agentId: ada }),
    });
    expect(posted.status).toBe(400);

    await runAsTenant("platform", () => drain(conversations));
    // The owner's turn ran whole: both Bots, then Ada's hand-off to Grace, all as the owner.
    expect(
      calls.map((call) => [call.ownerUserId, call.userMessage?.id]),
    ).toEqual([
      [owner.id, `group-user:${question}:${ada}`],
      [owner.id, `group-user:${question}:${grace}`],
      [owner.id, `group-user:${question}:${ada}>${grace}:${grace}`],
    ]);
    expect(
      audit.filter((event) => event.eventType === "agent.handoff_offered"),
    ).toHaveLength(1);
    const { messages } = await as(owner, () =>
      conversations.list(owner.id, channel.id),
    );
    const byId = new Map(messages.map((message) => [message.id, message]));
    expect(byId.get(`${question}:${grace}`)).toMatchObject({
      ownerUserId: owner.id,
      agentId: grace,
      status: "completed",
      text: "Grace here.",
    });
    expect(byId.get(`${question}:${ada}>${grace}:${grace}`)).toMatchObject({
      ownerUserId: owner.id,
      agentId: grace,
      status: "completed",
    });
    expect(byId.get(`${question}:${ada}:consent:gmail`)).toMatchObject({
      ownerUserId: owner.id,
      agentId: ada,
      consent: { botId: ada, serverId: "gmail" },
    });
    expect(messages.some((message) => message.text === "squat")).toBe(false);
    expect(await itemState(question)).toEqual({
      finished: true,
      lastError: null,
    });
    expect(await itemState(`${question}:${ada}>${grace}`)).toEqual({
      finished: true,
      lastError: null,
    });
  });

  test("a Bot's place in a turn held by somebody else's row fails that Bot loudly, and the turn and the queue go on", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada", "public"));
    const grace = await as(owner, () => bot(owner, "Grace", "public"));
    const { conversations, calls } = service({
      replies: { [ada]: () => "Ada here.", [grace]: () => "Grace here." },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );

    // A row already in a Bot reply's place (written before ids were checked, or past the service):
    // one of the member's own (invisible to the sender) or a `team` one (visible, but theirs).
    for (const [variant, stamp] of [
      ["own", teammate.id],
      ["team", "team"],
    ] as const) {
      calls.length = 0;
      const messageId = `${prefix}-taken-${variant}`;
      const next = `${prefix}-taken-${variant}-next`;
      await as(owner, () =>
        conversations.send(owner.id, channel.id, {
          id: messageId,
          text: "hello both",
        }),
      );
      await as(teammate, () =>
        database.insert(groupMessages).values({
          id: `${messageId}:${ada}`,
          channelId: channel.id,
          ownerUserId: teammate.id,
          agentId: ada,
          text: "forged answer",
          tenantId: stamp,
        }),
      );
      await as(owner, () =>
        conversations.send(owner.id, channel.id, {
          id: next,
          text: "and again",
          agentId: ada,
        }),
      );
      // Drained as the server does, one sweep after another: the taken place stops neither.
      await runAsTenant("platform", () => drain(conversations));
      expect(calls.map((call) => call.userMessage?.id)).toEqual([
        `group-user:${messageId}:${grace}`,
        `group-user:${next}:${ada}`,
      ]);
      // Ended with the reason kept, not handed back for a retry that can only fail the same way.
      expect(await itemState(messageId)).toEqual({
        finished: true,
        lastError: expect.stringContaining("taken by another row"),
      });
      expect(await itemState(next)).toEqual({
        finished: true,
        lastError: null,
      });
      const [kept] = await runAsTenant("platform", () =>
        database
          .select({
            ownerUserId: groupMessages.ownerUserId,
            text: groupMessages.text,
          })
          .from(groupMessages)
          .where(eq(groupMessages.id, `${messageId}:${ada}`)),
      );
      expect(kept).toEqual({ ownerUserId: teammate.id, text: "forged answer" });
      const { messages } = await as(owner, () =>
        conversations.list(owner.id, channel.id),
      );
      expect(
        messages.find((message) => message.id === `${messageId}:${grace}`),
      ).toMatchObject({
        ownerUserId: owner.id,
        status: "completed",
        text: "Grace here.",
      });
    }

    // Nor can a member take another person's Bot thread key before their first turn (0128).
    const thread = await as(owner, () =>
      database
        .execute(
          sql`insert into group_bot_threads (owner_user_id, channel_id, agent_id, thread_id) values (${teammate.id}, ${channel.id}, ${ada}, ${`${prefix}-squat-thread`})`,
        )
        .then(
          () => "written",
          (error: { cause?: { errno?: string } }) => error.cause?.errno,
        ),
    );
    expect(thread).toBe("42501");
    calls.length = 0;
    await as(teammate, () =>
      conversations.send(teammate.id, channel.id, {
        id: `${prefix}-teammate-asks`,
        text: "hi Ada",
        agentId: ada,
      }),
    );
    await runAsTenant("platform", () => drain(conversations));
    expect(calls.map((call) => [call.ownerUserId, call.agentId])).toEqual([
      [teammate.id, ada],
    ]);
  });

  test("a turn queued by someone taken out of the group writes nothing into it", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada", "public"));
    const grace = await as(owner, () => bot(owner, "Grace", "public"));
    const { conversations, calls } = service({
      replies: { [ada]: () => "Ada here.", [grace]: () => "Grace here." },
    });
    const channel = await as(owner, () =>
      conversations.create(owner.id, { agentIds: [ada, grace] }),
    );
    const email = await emailOf(teammate);
    await as(owner, () =>
      conversations.addMember(owner.id, channel.id, { email }),
    );
    const messageId = `${prefix}-before-removal`;
    await as(teammate, () =>
      conversations.send(teammate.id, channel.id, {
        id: messageId,
        text: "one for the road",
        agentId: ada,
      }),
    );
    await as(owner, () =>
      conversations.removeMember(owner.id, channel.id, teammate.id),
    );
    await runAsTenant("platform", () => drain(conversations));

    expect(calls).toHaveLength(0);
    // No Bot row of that turn anywhere, under any stamp: the channel is not theirs to write into.
    const rows = await runAsTenant("platform", () =>
      database
        .select({ id: groupMessages.id, tenantId: groupMessages.tenantId })
        .from(groupMessages)
        .where(like(groupMessages.id, `${messageId}:%`)),
    );
    expect(rows).toEqual([]);
    // Ended, since no retry can make them a member again.
    expect(await itemState(messageId)).toEqual({
      finished: true,
      lastError: null,
    });
  });

  test("a queued turn whose payload names somebody other than its stamp is ended, never run", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await as(owner, () => bot(owner, "Ada"));
    const grace = await as(owner, () => bot(owner, "Grace"));
    const { conversations, calls, audit } = service({
      replies: { [ada]: () => "Ada here.", [grace]: () => "Grace here." },
    });
    // The owner's own two-Bot channel; the planted item is stamped with them but names the teammate.
    const channel = await as(owner, async () => {
      const made = await channelStore.create(owner, [ada, grace]);
      createdChannels.push(made.id);
      return made;
    });
    const key = `${prefix}-mismatched-item`;
    await as(owner, () =>
      database.insert(workItems).values({
        kind: GROUP_TURN_KIND,
        key,
        payload: {
          ownerUserId: teammate.id,
          channelId: channel.id,
          messageId: key,
          agentIds: [ada],
          text: "run me as someone else",
        },
      }),
    );
    expect(await runAsTenant("platform", () => conversations.sweep())).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
    expect(audit).toEqual([]);
    const rows = await runAsTenant("platform", () =>
      database
        .select({ id: groupMessages.id })
        .from(groupMessages)
        .where(like(groupMessages.id, `${key}%`)),
    );
    expect(rows).toEqual([]);
    expect(await itemState(key)).toEqual({ finished: true, lastError: null });
  });

  /**
   * Ticket 019, spec B1-B2: an ask in a group is board work, not only a transcript.
   *
   * A person who addressed two coworkers and got two answers did two pieces of work-asking, and the
   * board is where the rest of their day is tracked; a group whose answers never reach it is a place
   * work happens that nobody can see afterwards. The three things worth asserting are which coworker a
   * card belongs to, that a peer hop hangs under the coworker that asked it rather than becoming a
   * fourth loose card, and that a turn which never reached a model opens nothing at all.
   */
  describe("the task board", () => {
    const board = createTaskProjector(database);

    const cards = async (ownerId: string, channelId: string) =>
      await runAsTenant(ownerId, async () =>
        database
          .select({
            id: tasks.id,
            source: tasks.source,
            status: tasks.status,
            executorAgentId: tasks.executorAgentId,
            runRef: tasks.runRef,
            parentTaskId: tasks.parentTaskId,
          })
          .from(tasks)
          .where(eq(tasks.channelRef, channelId))
          // Created in the same millisecond as its neighbours, so the run reference is the only
          // tiebreaker that is stable between runs.
          .orderBy(asc(tasks.createdAt), asc(tasks.runRef)),
      );

    test("one message to two coworkers leaves one card each, and the hop hangs under its asker", async () => {
      const owner = await person();
      await as(owner, async () => {
        const named = new Map([
          [await bot(owner, "Ada"), "Ada"],
          [await bot(owner, "Grace"), "Grace"],
        ]);
        const [ada = "", grace = ""] = [...named.keys()].sort();
        const G = named.get(grace) ?? "";
        const A = named.get(ada) ?? "";
        const channel = await channelStore.create(owner, [ada, grace]);
        createdChannels.push(channel.id);
        const { conversations } = service({
          replies: {
            // Asked by the person only as a peer's `@Name` would be: Ada answers Grace's ask.
            [ada]: () => "Checked, and it stands.",
            [grace]: () => `See @${A}'s draft.`,
          },
          board,
        });

        await conversations.send(owner.id, channel.id, {
          id: `${prefix}-board-1`,
          text: `@${G} review this`,
        });
        await drain(conversations);

        const rows = await cards(owner.id, channel.id);
        // The person named one coworker, that one answered, and the one its reply named answered too:
        // two cards, and the second hangs under the first.
        expect(rows).toHaveLength(2);
        const ask = rows.find((row) => row.executorAgentId === grace);
        const hop = rows.find((row) => row.executorAgentId === ada);
        expect(ask?.source).toBe("chat");
        expect(hop?.source).toBe("handoff");
        expect(ask?.parentTaskId).toBeNull();
        expect(hop?.parentTaskId).toBe(ask?.id);
        expect(rows.every((row) => row.status === "awaiting_review")).toBe(
          true,
        );
      });
    });

    test("a coworker that addressed a peer hangs its card under the peer that asked", async () => {
      const owner = await person();
      await as(owner, async () => {
        const named = new Map([
          [await bot(owner, "Ada"), "Ada"],
          [await bot(owner, "Grace"), "Grace"],
        ]);
        const [ada = "", grace = ""] = [...named.keys()].sort();
        const channel = await channelStore.create(owner, [ada, grace]);
        createdChannels.push(channel.id);
        const { conversations } = service({
          replies: {
            [ada]: () => `Draft ready. @${named.get(grace)} check it?`,
            [grace]: () => "Numbers checked.",
          },
          board,
        });

        await conversations.send(owner.id, channel.id, {
          id: `${prefix}-board-2`,
          text: "Plan the launch",
        });
        await drain(conversations);

        const rows = await cards(owner.id, channel.id);
        // Both answer the person, then Grace answers Ada's ask: three cards, one of them a handoff.
        expect(rows).toHaveLength(3);
        expect(rows.filter((row) => row.source === "chat")).toHaveLength(2);
        const asker = rows.find((row) => row.executorAgentId === ada);
        const hop = rows.find((row) => row.source === "handoff");
        // The hop is under Ada's card, not under the person's own row and not a fourth loose card:
        // the ask came from Ada's reply, and that is the card a person follows to find its context.
        expect(hop?.parentTaskId).toBe(asker?.id);
        expect(hop?.executorAgentId).toBe(grace);
        expect(asker?.parentTaskId).toBeNull();
        expect(rows.every((row) => row.status === "awaiting_review")).toBe(
          true,
        );
      });
    });

    /**
     * A turn that failed while it was running still reports itself.
     *
     * The transcript already says the coworker could not answer, but the board is where a person
     * notices something went wrong at all; a card left `running` after the run died is ticket 032's
     * half-answer, and nobody is watching a group turn to correct it.
     */
    test("a turn that stops with an error closes its card as failed", async () => {
      const owner = await person();
      await as(owner, async () => {
        const ada = await bot(owner, "Ada");
        const grace = await bot(owner, "Grace");
        const channel = await channelStore.create(owner, [ada, grace]);
        createdChannels.push(channel.id);
        const { conversations } = service({
          replies: {
            [ada]: () => {
              throw new Error("模型的另一端断了");
            },
            [grace]: () => "I will take it from here.",
          },
          board,
        });

        await conversations.send(owner.id, channel.id, {
          id: `${prefix}-board-3`,
          text: "Build it",
        });
        // The first Bot's turn throws; the sweep's caller sees the error, so drain it the way the
        // server's loop does and let the second turn run after.
        while (await conversations.sweep().catch(() => false)) {}

        const rows = await cards(owner.id, channel.id);
        // Which card is which is what matters, not the order they were written in.
        expect(rows.find((row) => row.executorAgentId === ada)?.status).toBe(
          "failed",
        );
        expect(rows.find((row) => row.executorAgentId === grace)?.status).toBe(
          "awaiting_review",
        );
        // And nothing is left claiming work is still happening.
        expect(rows.filter((row) => row.status === "running")).toEqual([]);
      });
    });

    /**
     * Nothing ran, so nothing is on the board.
     *
     * Both of these are the shape the card must not take: the coworker left the conversation, or an
     * earlier attempt of the same row stopped with its outcome unsaved. A card opened before those
     * guards would tell the person a coworker answered a question it was never asked.
     */
    test("a turn that never reached a model opens no card", async () => {
      const owner = await person();
      await as(owner, async () => {
        const ada = await bot(owner, "Ada");
        const grace = await bot(owner, "Grace");
        const channel = await channelStore.create(owner, [ada, grace]);
        createdChannels.push(channel.id);
        const { conversations } = service({
          replies: {
            [ada]: () => "Answered.",
            // A Bot the roster no longer has is reached only by a handoff; the turn must be over before
            // its model call, so the run never starts.
            [grace]: () => "Answered too.",
          },
          board,
        });

        await conversations.send(owner.id, channel.id, {
          id: `${prefix}-board-4`,
          text: "Answer us",
        });
        await drain(conversations);
        const before = (await cards(owner.id, channel.id)).length;
        expect(before).toBe(2);

        // Re-sending the same message id is the retry that finds the row already settled: it must not
        // add a card, because no turn ran a second time.
        await conversations.send(owner.id, channel.id, {
          id: `${prefix}-board-4`,
          text: "Answer us",
        });
        await drain(conversations);
        expect((await cards(owner.id, channel.id)).length).toBe(before);
      });
    });
  });
});

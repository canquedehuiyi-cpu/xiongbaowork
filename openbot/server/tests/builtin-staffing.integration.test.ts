import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { readStaffingProposalAnswer } from "../../shared/staffing-proposal";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAuditStore } from "../src/audit";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  modelRegistry,
  staffingProposals,
  subscriptions,
  users,
} from "../src/db/schema";
import { createModelShelf } from "../src/models/routes";
import {
  callTool,
  listTools,
  useStaffingTools,
} from "../src/plugins/builtin-staffing";
import { catalogueEntry } from "../src/plugins/catalogue";
import { createPluginStore } from "../src/plugins/store";
import { createRoleTemplateStore } from "../src/roles/store";
import { createRoutineStore } from "../src/routines/store";
import { createStaffingProposalStore } from "../src/staffing/store";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 员工用「招聘与组群」起草提议：主人、员工、会话都取自这次运行，不取自参数；起草只写提议表，不建任何
 * 员工或群聊。每一条都看库里留下了什么。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `bst-${suite}-${name}`;

const profiles = createAgentProfileStore(database, undefined);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profiles, threadIdentity);
const plugins = createPluginStore({
  database,
  auditStore,
  credentials: {
    readSecret: async () => null,
  } as unknown as CredentialSecretReader & CredentialStore,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const groups = createGroupConversations({
  store: createGroupStore(database, () => threadIdentity.mint()),
  queue: createWorkQueue(database),
  owner: id("replica"),
  roster: async (ownerUserId, channelId) => {
    const actor = { id: ownerUserId, role: "user" as const };
    const channel = await channelStore.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) return null;
    const bots = [];
    for (const agentId of channel.agentIds) {
      const profile = await profiles.get(actor, agentId);
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  },
  runTurn: async () => ({ replyText: "ok" }),
  caps: { maxDepth: 1, maxPerRun: 2 },
  mayAddress: async () => true,
  auditStore,
  createChannel: (ownerUserId, agentIds, options) =>
    channelStore.create({ id: ownerUserId, role: "user" }, agentIds, options),
  canUseBot: async (ownerUserId, agentId) =>
    Boolean(await profiles.get({ id: ownerUserId, role: "user" }, agentId)),
  progressEveryMs: 0,
});
const proposals = createStaffingProposalStore(database);

const people: string[] = [];
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

async function person(name: string): Promise<AgentActor> {
  const userId = id(`${name}-${randomUUID().slice(0, 6)}`);
  await runAsTenant(userId, async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name });
    await database
      .insert(subscriptions)
      .values({ tenantId: userId, planId: "pro" });
  });
  people.push(userId);
  return { id: userId, role: "user" };
}

async function bot(
  owner: AgentActor,
  name: string,
  visibility: "private" | "public" = "private",
) {
  const profile = await runAsTenant(owner.id, () =>
    profiles.create(owner, {
      name,
      title: "员工",
      roleDescription: "回答问题。",
      visibility,
      systemPrompt: "回答问题。",
    }),
  );
  return profile.id;
}

/** 一次运行：主人、员工和会话都在这里，模型给的参数里说什么都不算。 */
const run = (owner: AgentActor, botId: string, threadId: string) => ({
  call: (tool: string, args: Record<string, unknown>) =>
    runAsTenant(owner.id, () =>
      callTool(
        { url: "builtin://staffing", actorId: owner.id, botId, threadId },
        tool,
        args,
      ),
    ),
});

const employee = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: "运营",
  roleDescription: "负责小红书的日常运营。",
  ...extra,
});

const proposalsOf = (ownerId: string) =>
  asPlatform(() =>
    database
      .select()
      .from(staffingProposals)
      .where(eq(staffingProposals.ownerId, ownerId)),
  );

const proposalRow = async (proposalId: string) =>
  (
    await asPlatform(() =>
      database
        .select()
        .from(staffingProposals)
        .where(eq(staffingProposals.id, proposalId)),
    )
  )[0];

const cardOf = (text: string) => {
  const answer = readStaffingProposalAnswer(text);
  if (!answer) throw new Error(`not a proposal answer: ${text}`);
  return answer;
};

const trailOf = (proposalId: string, eventType: string) =>
  asPlatform(() =>
    database
      .select({
        actorUserId: auditEvents.actorUserId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, eventType),
          eq(auditEvents.targetId, proposalId),
        ),
      ),
  );

/** 这个人名下的员工与他所在的对话，各有多少。 */
const holdings = (ownerId: string) =>
  asPlatform(async () => {
    const [bots] = await database
      .select({ n: count() })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(eq(agentProfiles.ownerUserId, ownerId));
    const [rooms] = await database
      .select({ n: count() })
      .from(channels)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channels.id),
      )
      .where(eq(channelMemberships.userId, ownerId));
    return { bots: bots?.n ?? 0, channels: rooms?.n ?? 0 };
  });

beforeAll(() => {
  useStaffingTools({
    database,
    proposals,
    profiles,
    plugins,
    composioConfigured: false,
    routines: createRoutineStore(database),
    groups,
    catalogue: createModelShelf({ database, environment: {} }),
    roleTemplates: createRoleTemplateStore({ database, profiles }),
    auditStore,
  });
});

afterAll(async () => {
  useStaffingTools(null);
  await asPlatform(async () => {
    const bots = (
      await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(inArray(agentProfiles.ownerUserId, people))
    ).map((row) => row.id);
    const memberOf = (
      await database
        .select({ id: channelMemberships.channelId })
        .from(channelMemberships)
        .where(inArray(channelMemberships.userId, people))
    ).map((row) => row.id);
    if (memberOf.length) {
      await database
        .delete(intelligenceChannelMappings)
        .where(inArray(intelligenceChannelMappings.channelId, memberOf));
      await database.delete(channels).where(inArray(channels.id, memberOf));
    }
    await database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, people));
    if (bots.length) {
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, bots));
      await database.delete(agents).where(inArray(agents.id, bots));
    }
    await database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, people));
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

describe("drafting staffing proposals from a run", () => {
  test("a proposal is owned by the person in the run, not by an argument", async () => {
    const owner = await person("owner");
    const other = await person("other");
    const helper = await bot(owner, "小管家");
    const thread = id(`thread-${randomUUID().slice(0, 6)}`);

    const answer = await run(owner, helper, thread).call(
      "propose_employee",
      employee("小红", {
        ownerId: other.id,
        proposedByAgentId: "someone-else",
      }),
    );

    expect(answer.isError).toBe(false);
    const { card, sentence } = cardOf(answer.text);
    expect(card.kind).toBe("employee");
    expect(card.title).toBe("小红");
    expect(sentence).toContain("不要说");
    const row = await proposalRow(card.proposalId);
    expect(row?.ownerId).toBe(owner.id);
    expect(row?.proposedByAgentId).toBe(helper);
    expect(row?.threadId).toBe(thread);
    expect(row?.status).toBe("pending");
    expect(await proposalsOf(other.id)).toEqual([]);
    const trail = await trailOf(card.proposalId, "staffing.proposal_created");
    expect(trail.length).toBe(1);
    expect(trail[0]?.actorUserId).toBe(owner.id);
    expect(trail[0]?.payload).toMatchObject({ proposalId: card.proposalId });
  });

  test("a model outside the catalogue is dropped and named", async () => {
    const owner = await person("models");
    const helper = await bot(owner, "小管家");
    const thread = id(`thread-${randomUUID().slice(0, 6)}`);
    const library = await runAsTenant(owner.id, async () => {
      const [model] = await database
        .insert(modelRegistry)
        .values({ provider: "openai", modelName: `gpt-${suite}` })
        .returning({ id: modelRegistry.id });
      if (!model) throw new Error("no model row");
      return model.id;
    });
    const stranger = randomUUID();

    const outside = await run(owner, helper, thread).call(
      "propose_employee",
      employee("外面的模型", { model: { modelRef: stranger } }),
    );
    const inside = await run(owner, helper, thread).call(
      "propose_employee",
      employee("库里的模型", { model: { modelRef: library } }),
    );

    const dropped = cardOf(outside.text);
    expect(dropped.sentence).toContain(stranger);
    const droppedDraft = (await proposalRow(dropped.card.proposalId))
      ?.draft as Record<string, unknown>;
    expect(droppedDraft.name).toBe("外面的模型");
    expect("model" in droppedDraft).toBe(false);
    const kept = cardOf(inside.text);
    const keptDraft = (await proposalRow(kept.card.proposalId))
      ?.draft as Record<string, unknown>;
    expect(keptDraft.model).toEqual({ modelRef: library });
  });

  test("a group with someone else's private bot is refused", async () => {
    const owner = await person("group-owner");
    const other = await person("group-other");
    const helper = await bot(owner, "小管家");
    const mine = await bot(owner, "甲");
    const theirs = await bot(other, "别人的私有员工");

    const answer = await run(
      owner,
      helper,
      id(`thread-${randomUUID().slice(0, 6)}`),
    ).call("propose_group", { name: "项目群", members: [mine, theirs] });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(theirs);
    expect(await proposalsOf(owner.id)).toEqual([]);
  });

  test("changing a group the person did not start is refused", async () => {
    const creator = await person("creator");
    const member = await person("member");
    const first = await bot(creator, "甲");
    const second = await bot(creator, "乙");
    const channel = await runAsTenant(creator.id, async () => {
      const made = await groups.create(creator.id, {
        agentIds: [first, second],
      });
      await groups.addMember(creator.id, made.id, {
        email: `${member.id}@example.test`,
      });
      return made;
    });
    const helper = await bot(member, "小管家");

    const answer = await run(
      member,
      helper,
      id(`thread-${randomUUID().slice(0, 6)}`),
    ).call("propose_group_change", {
      channelId: channel.id,
      name: "改个名",
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("发起");
    expect(await proposalsOf(member.id)).toEqual([]);
  });

  test("the sixth proposal in ten minutes in one conversation is refused, and another conversation is not", async () => {
    const owner = await person("busy");
    const helper = await bot(owner, "小管家");
    const busy = run(owner, helper, id(`thread-${randomUUID().slice(0, 6)}`));

    const answers = [];
    for (const index of [1, 2, 3, 4, 5, 6])
      answers.push(
        await busy.call("propose_employee", employee(`员工${index}`)),
      );

    expect(answers.map((answer) => answer.isError)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect((await proposalsOf(owner.id)).length).toBe(5);
    const elsewhere = await run(
      owner,
      helper,
      id(`thread-${randomUUID().slice(0, 6)}`),
    ).call("propose_employee", employee("另一段对话里的员工"));
    expect(elsewhere.isError).toBe(false);
    expect((await proposalsOf(owner.id)).length).toBe(6);
  });

  test("propose_* never creates a bot or a group", async () => {
    const owner = await person("drafts-only");
    const helper = await bot(owner, "小管家");
    const first = await bot(owner, "甲");
    const second = await bot(owner, "乙");
    const third = await bot(owner, "丙");
    const channel = await runAsTenant(owner.id, () =>
      groups.create(owner.id, { agentIds: [first, second] }),
    );
    const before = await holdings(owner.id);
    const drafting = run(
      owner,
      helper,
      id(`thread-${randomUUID().slice(0, 6)}`),
    );

    const answers = [
      await drafting.call("propose_employee", employee("新人")),
      await drafting.call("propose_employee_change", {
        agentId: first,
        set: { title: "组长" },
      }),
      await drafting.call("propose_group", {
        name: "新群",
        members: [first, third],
      }),
      await drafting.call("propose_group_change", {
        channelId: channel.id,
        add: [third],
      }),
    ];

    expect(answers.map((answer) => answer.isError)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(await holdings(owner.id)).toEqual(before);
    const kinds = (await proposalsOf(owner.id)).map((row) => row.kind).sort();
    expect(kinds).toEqual([
      "employee",
      "employee_change",
      "group",
      "group_change",
    ]);
  });

  test("proposal_status reads only the person's own proposal and audits an expiry once", async () => {
    const owner = await person("status");
    const other = await person("status-other");
    const helper = await bot(owner, "小管家");
    const otherHelper = await bot(other, "小管家");
    const thread = id(`thread-${randomUUID().slice(0, 6)}`);
    const drafted = cardOf(
      (
        await run(owner, helper, thread).call(
          "propose_employee",
          employee("小绿"),
        )
      ).text,
    );

    const pending = await run(owner, helper, thread).call("proposal_status", {
      proposalId: drafted.card.proposalId,
    });
    expect(pending.isError).toBe(false);
    expect(pending.text).toContain("等待");
    const stranger = await run(
      other,
      otherHelper,
      id(`thread-${randomUUID().slice(0, 6)}`),
    ).call("proposal_status", { proposalId: drafted.card.proposalId });
    expect(stranger.isError).toBe(true);

    await asPlatform(() =>
      database
        .update(staffingProposals)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(staffingProposals.id, drafted.card.proposalId)),
    );
    const lapsed = await run(owner, helper, thread).call("proposal_status", {
      proposalId: drafted.card.proposalId,
    });
    const again = await run(owner, helper, thread).call("proposal_status", {
      proposalId: drafted.card.proposalId,
    });

    expect(lapsed.text).toContain("过期");
    expect(again.text).toContain("过期");
    expect((await proposalRow(drafted.card.proposalId))?.status).toBe(
      "expired",
    );
    const trail = await trailOf(
      drafted.card.proposalId,
      "staffing.proposal_expired",
    );
    expect(trail.length).toBe(1);
    expect(trail[0]?.payload).toMatchObject({
      proposalId: drafted.card.proposalId,
    });
  });

  test("list_staff names the person's employees, the groups they started and the models they may pick", async () => {
    const owner = await person("roster");
    const helper = await bot(owner, "小管家");
    const first = await bot(owner, "甲");
    const second = await bot(owner, "乙");
    const channel = await runAsTenant(owner.id, () =>
      groups.create(owner.id, { agentIds: [first, second] }),
    );
    const library = await runAsTenant(owner.id, async () => {
      const [model] = await database
        .insert(modelRegistry)
        .values({
          provider: "openai",
          modelName: `gpt-${suite}-roster`,
          label: "我的模型",
        })
        .returning({ id: modelRegistry.id });
      if (!model) throw new Error("no model row");
      return model.id;
    });

    const answer = await run(
      owner,
      helper,
      id(`thread-${randomUUID().slice(0, 6)}`),
    ).call("list_staff", {});

    expect(answer.isError).toBe(false);
    for (const expected of [first, second, channel.id, library, "我的模型"])
      expect(answer.text).toContain(expected);
  });

  test("a run with nobody behind it drafts nothing", async () => {
    const answer = await callTool(
      { url: "builtin://staffing", botId: "bot" },
      "propose_employee",
      employee("无主"),
    );
    expect(answer.isError).toBe(true);
  });
});

describe("the staffing tools in the catalogue", () => {
  test("the catalogue lists every staffing tool as a read", async () => {
    const entry = catalogueEntry("staffing");
    const advertised = (await listTools()).map((tool) => tool.name);
    expect(advertised).toEqual([
      "list_staff",
      "propose_employee",
      "propose_employee_change",
      "propose_group",
      "propose_group_change",
      "proposal_status",
    ]);
    expect(entry?.host).toBe("builtin://staffing");
    expect(entry?.transport).toBe("builtin-staffing");
    expect(entry?.auth.kind).toBe("builtin");
    expect([...(entry?.readTools ?? [])]).toEqual(advertised);
    expect([...(entry?.writeTools ?? ["not-empty"])]).toEqual([]);
  });
});

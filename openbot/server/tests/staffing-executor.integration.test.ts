import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { type AuditStore, createAuditStore } from "../src/audit";
import type { AuthenticatedActor } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
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
  appAccessRequests,
  auditEvents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  mcpServers,
  mcpTools,
  modelRegistry,
  pluginGrants,
  portraits,
  routines,
  skills,
  staffingProposals,
  subscriptions,
  users,
} from "../src/db/schema";
import { sharedUseApprovals } from "../src/db/schema/shared-use";
import {
  createSharedAudience,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { createPortraitStore } from "../src/portraits/store";
import { createQuotaService, QuotaExceeded } from "../src/quota/limits";
import {
  createRoutineStore,
  RoutineLimitError,
  type RoutineStore,
} from "../src/routines/store";
import { parseDraft } from "../src/staffing/draft";
import {
  createStaffingExecutor,
  currentEmployeeVersion,
  currentGroupVersion,
  ProposalRefusedError,
  ProposalStaleError,
} from "../src/staffing/executor";
import {
  createStaffingProposalStore,
  ProposalNotFoundError,
} from "../src/staffing/store";
import type { ProposalKind } from "../src/staffing/types";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 确认一份提议之后，执行器以本人的身份把它变成真的员工与群聊：每一条都看库里留下了什么，不只看返回值。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `stx-${suite}-${name}`;

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

/** 第一次建定时任务时撞上启用上限，之后照常：用来看重试只重做失败的那一步。 */
let refuseNextRoutine = false;
const realRoutines = createRoutineStore(database);
const routineStore: RoutineStore = {
  ...realRoutines,
  async create(input) {
    if (refuseNextRoutine) {
      refuseNextRoutine = false;
      throw new RoutineLimitError("You already have 20 routines switched on.");
    }
    return realRoutines.create(input);
  },
};

/** 管理员对这些人关掉了「把员工公开给团队」；其余的能力都开着。 */
const teamBotsOff = new Set<string>();

/** 让某一种轨迹写不进去，看建好员工之后的意外：员工已经记在提议里，不会因此再建一个。 */
let failAuditFor: string | null = null;
const flakyAudit: AuditStore = {
  insert: async (event) => {
    if (event.eventType === failAuditFor)
      throw new Error("audit store unavailable");
    return auditStore.insert(event);
  },
};

const executor = createStaffingExecutor({
  database,
  mayUse: async (actorId, capability) =>
    !(capability === "teamBots" && teamBotsOff.has(actorId)),
  proposals,
  profiles,
  quota: createQuotaService(database),
  plugins,
  composioConfigured: true,
  routines: routineStore,
  channels: channelStore,
  groups,
  portraits: createPortraitStore(database),
  auditStore: flakyAudit,
});

const OPEN_APP = id("open-app");
const ADMIN_APP = id("admin-app");
const MAIL_APP = id("mail");
const DEPLOYMENT_SKILL = id("deployment-skill");
const ADMIN = id("admin");
const DEMOTED = id("demoted");
const people: string[] = [];
let releaseAdmin: (() => Promise<void>) | undefined;

const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

async function person(
  name: string,
  plan: "free" | "pro" = "pro",
): Promise<AuthenticatedActor> {
  const userId = id(`${name}-${randomUUID().slice(0, 6)}`);
  await runAsTenant(userId, async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name });
    await database
      .insert(subscriptions)
      .values({ tenantId: userId, planId: plan });
  });
  people.push(userId);
  return { id: userId, email: `${userId}@example.test`, role: "user" };
}

async function propose(
  owner: AuthenticatedActor,
  kind: ProposalKind,
  raw: unknown,
  baseVersion: string | null = null,
) {
  const parsed = parseDraft(kind, raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return runAsTenant(owner.id, () =>
    proposals.create({
      ownerId: owner.id,
      proposedByAgentId: `avatar-${owner.id}`,
      threadId: null,
      kind,
      draft: parsed.draft,
      baseVersion,
    }),
  );
}

const employee = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: "运营",
  roleDescription: "负责小红书的日常运营。",
  ...extra,
});

const stored = async (proposalId: string) =>
  (
    await asPlatform(() =>
      database
        .select({
          status: staffingProposals.status,
          result: staffingProposals.result,
        })
        .from(staffingProposals)
        .where(eq(staffingProposals.id, proposalId)),
    )
  )[0];

const ownedBots = (ownerId: string) =>
  asPlatform(() =>
    database
      .select({
        id: agentProfiles.agentId,
        modelRef: agentProfiles.modelRef,
        name: agents.name,
        title: agentProfiles.title,
      })
      .from(agentProfiles)
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .where(eq(agentProfiles.ownerUserId, ownerId)),
  );

const grantsOf = (agentId: string) =>
  asPlatform(() =>
    database
      .select({
        kind: pluginGrants.kind,
        ref: pluginGrants.ref,
        grantedAs: pluginGrants.grantedAs,
      })
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, agentId))
      .orderBy(pluginGrants.ref),
  );

const routinesOf = (ownerId: string) =>
  asPlatform(() =>
    database
      .select({
        agentId: routines.agentId,
        cron: routines.cron,
        title: routines.title,
      })
      .from(routines)
      .where(eq(routines.ownerUserId, ownerId)),
  );

const createdBot = async (proposalId: string) => {
  const row = await stored(proposalId);
  const items = (row?.result ?? []) as { step: string; target?: string }[];
  const created = items.find((item) => item.step === "create")?.target;
  if (!created) throw new Error("the proposal created no bot");
  return created;
};

/**
 * 「也给它招聘与组群能力」和别的应用一样按部署里的应用来给，所以部署里要有这个应用。本来没有时由本文件
 * 添加、由本文件删除（按行 id）。
 */
let addedStaffingRow: string | null = null;
beforeAll(async () => {
  await asPlatform(async () => {
    const [present] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.catalogueKey, "staffing"))
      .limit(1);
    const row =
      present ?? (await plugins.addServer({ key: "staffing", by: "boot" }));
    if (!present) addedStaffingRow = row.id;
  });
});
afterAll(async () => {
  const added = addedStaffingRow;
  if (added)
    await asPlatform(() =>
      database.delete(mcpServers).where(eq(mcpServers.id, added)),
    );
});

beforeAll(async () => {
  releaseAdmin = await seedAdministrator(database, ADMIN);
  await asPlatform(async () => {
    await database.insert(users).values({
      id: DEMOTED,
      email: `${DEMOTED}@example.test`,
      name: "former",
    });
    await setRole(database, DEMOTED, "user");
    for (const userId of [ADMIN, DEMOTED])
      await database
        .insert(subscriptions)
        .values({ tenantId: userId, planId: "pro" })
        .onConflictDoNothing();
    await database.insert(mcpServers).values([
      {
        id: OPEN_APP,
        tenantId: "team",
        title: "开放应用",
        vendor: "test",
        url: "https://example.invalid/open",
        provenance: "custom",
        ownerGrants: "any",
      },
      {
        id: ADMIN_APP,
        tenantId: "team",
        title: "管理员应用",
        vendor: "test",
        url: "https://example.invalid/admin",
        provenance: "custom",
        ownerGrants: "admin",
      },
      {
        id: MAIL_APP,
        tenantId: "team",
        title: "邮件",
        vendor: "Composio",
        url: `composio://${MAIL_APP}`,
        provenance: "composio",
        authScheme: "OAUTH2",
      },
    ]);
    await database.insert(mcpTools).values([
      {
        tenantId: "team",
        serverId: OPEN_APP,
        name: "search",
        description: "搜索。",
        effect: "read",
      },
      {
        tenantId: "team",
        serverId: OPEN_APP,
        name: "send",
        description: "发送。",
        effect: "write",
      },
      {
        tenantId: "team",
        serverId: ADMIN_APP,
        name: "lookup",
        description: "查找。",
        effect: "read",
      },
      {
        tenantId: "team",
        serverId: MAIL_APP,
        name: "LIST",
        description: "列出。",
        effect: "read",
      },
    ]);
    await database.insert(skills).values({
      tenantId: "system",
      id: DEPLOYMENT_SKILL,
      slug: DEPLOYMENT_SKILL,
      ownerUserId: null,
      title: "部署技能",
      summary: "部署的。",
      instructions: "照做。",
      origin: "catalogue",
    });
  });
});

afterAll(async () => {
  const everyone = [...people, ADMIN, DEMOTED];
  await asPlatform(async () => {
    const bots = (
      await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(inArray(agentProfiles.ownerUserId, everyone))
    ).map((row) => row.id);
    const memberOf = (
      await database
        .select({ id: channelMemberships.channelId })
        .from(channelMemberships)
        .where(inArray(channelMemberships.userId, everyone))
    ).map((row) => row.id);
    if (memberOf.length) {
      await database
        .delete(intelligenceChannelMappings)
        .where(inArray(intelligenceChannelMappings.channelId, memberOf));
      await database.delete(channels).where(inArray(channels.id, memberOf));
    }
    await database
      .delete(appAccessRequests)
      .where(inArray(appAccessRequests.requesterUserId, everyone));
    await database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, everyone));
    await database
      .delete(routines)
      .where(inArray(routines.ownerUserId, everyone));
    if (bots.length) {
      await database
        .delete(pluginGrants)
        .where(inArray(pluginGrants.agentId, bots));
      await database
        .delete(portraits)
        .where(inArray(portraits.subjectId, bots));
      await database
        .delete(agentProfiles)
        .where(inArray(agentProfiles.agentId, bots));
      await database.delete(agents).where(inArray(agents.id, bots));
    }
    await database.delete(skills).where(like(skills.slug, `stx-${suite}-%`));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [OPEN_APP, ADMIN_APP, MAIL_APP]));
    await database
      .delete(modelRegistry)
      .where(inArray(modelRegistry.tenantId, everyone));
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, everyone));
    await database.delete(users).where(inArray(users.id, [...people, DEMOTED]));
  });
  await releaseAdmin?.();
  await database.$client.close();
});

describe("applying a staffing proposal as the person", () => {
  test("an applied employee draft creates the bot with its model, skills, apps and routines", async () => {
    const owner = await person("owner");
    const slug = id(`own-skill-${randomUUID().slice(0, 6)}`);
    const modelRef = await runAsTenant(owner.id, async () => {
      await database.insert(skills).values({
        id: randomUUID(),
        slug,
        ownerUserId: owner.id,
        title: "我的技能",
        summary: "我写的。",
        instructions: "照做。",
      });
      const [model] = await database
        .insert(modelRegistry)
        .values({ provider: "openai", modelName: `gpt-${suite}` })
        .returning({ id: modelRegistry.id });
      if (!model) throw new Error("no model row");
      return model.id;
    });
    const proposal = await propose(
      owner,
      "employee",
      employee("小红书运营", {
        avatar: { preset: "cute" },
        model: { modelRef },
        skills: [slug],
        apps: [
          { app: OPEN_APP, actions: [] },
          { app: MAIL_APP, actions: [] },
        ],
        routines: [
          { title: "晨报", instruction: "总结昨天的进展。", cron: "0 9 * * *" },
        ],
      }),
    );

    const applied = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );

    expect(applied.status).toBe("applied");
    const row = await stored(proposal.id);
    expect(row?.status).toBe("applied");
    const botId = await createdBot(proposal.id);
    const bots = await ownedBots(owner.id);
    expect(bots).toEqual([
      { id: botId, modelRef, name: "小红书运营", title: "运营" },
    ]);
    expect(await grantsOf(botId)).toEqual([
      { kind: "mcp", ref: `${MAIL_APP}/LIST`, grantedAs: "owner" },
      { kind: "mcp", ref: `${OPEN_APP}/search`, grantedAs: "owner" },
      { kind: "skill", ref: slug, grantedAs: "admin" },
    ]);
    expect(await routinesOf(owner.id)).toEqual([
      { agentId: botId, cron: "0 9 * * *", title: "晨报" },
    ]);
    const [face] = await asPlatform(() =>
      database
        .select({ preset: portraits.preset })
        .from(portraits)
        .where(eq(portraits.subjectId, botId)),
    );
    expect(face?.preset).toBe("cute");
    const outcomes = (row?.result ?? []) as { step: string; outcome: string }[];
    expect(outcomes.map((item) => [item.step, item.outcome])).toEqual([
      ["create", "done"],
      ["model", "done"],
      ["avatar", "done"],
      ["skill", "done"],
      ["app", "done"],
      ["app", "needs_connection"],
      ["routine", "done"],
    ]);
    const trail = await asPlatform(() =>
      database
        .select({
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, owner.id),
            sql`${auditEvents.payload}->>'proposalId' = ${proposal.id}`,
          ),
        ),
    );
    expect(trail.map((event) => event.eventType).sort()).toEqual([
      "app_access.owner_granted",
      "app_access.owner_granted",
      "bot.created",
      "bot.updated",
      "staffing.proposal_applied",
    ]);
  });

  test("an app the person cannot give becomes an access request, not a grant", async () => {
    const owner = await person("asker");
    const proposal = await propose(
      owner,
      "employee",
      employee("助理", { apps: [{ app: ADMIN_APP, actions: [] }] }),
    );

    await runAsTenant(owner.id, () => executor.apply(owner, proposal.id));

    const botId = await createdBot(proposal.id);
    expect(await grantsOf(botId)).toEqual([]);
    const requests = await asPlatform(() =>
      database
        .select({
          serverId: appAccessRequests.serverId,
          kind: appAccessRequests.kind,
          status: appAccessRequests.status,
        })
        .from(appAccessRequests)
        .where(eq(appAccessRequests.botId, botId)),
    );
    expect(requests).toEqual([
      { serverId: ADMIN_APP, kind: "grant", status: "pending" },
    ]);
    const row = await stored(proposal.id);
    expect(row?.status).toBe("applied");
    expect(row?.result).toContainEqual(
      expect.objectContaining({
        step: "app",
        target: ADMIN_APP,
        outcome: "requested",
      }),
    );
  });

  test("a full plan creates nothing and keeps the proposal pending", async () => {
    const owner = await person("full", "free");
    const actor = { id: owner.id, role: "user" as const };
    await runAsTenant(owner.id, async () => {
      for (const name of ["一号", "二号"])
        await profiles.create(actor, {
          name,
          title: "员工",
          roleDescription: "占一个名额。",
          visibility: "private",
          systemPrompt: "占一个名额。",
        });
    });
    const proposal = await propose(owner, "employee", employee("三号"));

    const refusal = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(QuotaExceeded);
    expect((await ownedBots(owner.id)).map((bot) => bot.name).sort()).toEqual([
      "一号",
      "二号",
    ]);
    expect((await stored(proposal.id))?.status).toBe("pending");
  });

  test("a stale change applies nothing and the proposal stays pending", async () => {
    const owner = await person("stale");
    const actor = { id: owner.id, role: "user" as const };
    const bot = await runAsTenant(owner.id, () =>
      profiles.create(actor, {
        name: "小红",
        title: "原头衔",
        roleDescription: "写文案。",
        visibility: "private",
        systemPrompt: "写文案。",
      }),
    );
    const base = await runAsTenant(owner.id, () =>
      currentEmployeeVersion(database, bot.id),
    );
    const proposal = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, set: { title: "新头衔" } },
      base,
    );
    await Bun.sleep(5);
    await runAsTenant(owner.id, () =>
      profiles.update(actor, bot.id, {
        name: "小蓝",
        title: "原头衔",
        roleDescription: "写文案。",
        visibility: "private",
      }),
    );

    const refusal = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ProposalStaleError);
    expect(await ownedBots(owner.id)).toEqual([
      { id: bot.id, modelRef: null, name: "小蓝", title: "原头衔" },
    ]);
    expect((await stored(proposal.id))?.status).toBe("pending");
  });

  test("a member gone private fails the group by name", async () => {
    const owner = await person("group-owner");
    const other = await person("group-other");
    const mine = await runAsTenant(owner.id, () =>
      profiles.create(
        { id: owner.id, role: "user" },
        {
          name: "甲",
          title: "员工",
          roleDescription: "回答问题。",
          visibility: "private",
          systemPrompt: "回答问题。",
        },
      ),
    );
    const theirs = await runAsTenant(other.id, () =>
      profiles.create(
        { id: other.id, role: "user" },
        {
          name: "公开助理",
          title: "员工",
          roleDescription: "回答问题。",
          visibility: "public",
          systemPrompt: "回答问题。",
        },
      ),
    );
    const proposal = await propose(owner, "group", {
      name: "项目群",
      members: [mine.id, theirs.id],
    });
    await runAsTenant(other.id, () =>
      profiles.update({ id: other.id, role: "user" }, theirs.id, {
        name: "公开助理",
        title: "员工",
        roleDescription: "回答问题。",
        visibility: "private",
      }),
    );

    await runAsTenant(owner.id, () => executor.apply(owner, proposal.id));

    const row = await stored(proposal.id);
    expect(row?.status).toBe("partially_applied");
    const items = (row?.result ?? []) as {
      step: string;
      outcome: string;
      message?: string;
    }[];
    const group = items.find((item) => item.step === "group");
    expect(group?.outcome).toBe("failed");
    expect(group?.message).toContain(theirs.id);
    const memberships = await asPlatform(() =>
      database
        .select({ id: channelMemberships.channelId })
        .from(channelMemberships)
        .where(eq(channelMemberships.userId, owner.id)),
    );
    expect(memberships).toEqual([]);
  });

  test("a demoted admin's apply grants only what a member could", async () => {
    const asRequest = createAdminRequest(database);
    const draft = employee("管理员的员工", {
      skills: [DEPLOYMENT_SKILL],
      apps: [{ app: ADMIN_APP, actions: [] }],
    });
    const demoted: AuthenticatedActor = {
      id: DEMOTED,
      email: `${DEMOTED}@example.test`,
      role: "admin",
    };
    const admin: AuthenticatedActor = {
      id: ADMIN,
      email: `${ADMIN}@example.test`,
      role: "admin",
    };
    const fromDemoted = await propose(demoted, "employee", draft);
    const fromAdmin = await propose(admin, "employee", draft);

    await asRequest(DEMOTED, () => executor.apply(demoted, fromDemoted.id));
    await asRequest(ADMIN, () => executor.apply(admin, fromAdmin.id));

    const demotedBot = await createdBot(fromDemoted.id);
    expect(await grantsOf(demotedBot)).toEqual([]);
    const requested = await asPlatform(() =>
      database
        .select({ serverId: appAccessRequests.serverId })
        .from(appAccessRequests)
        .where(eq(appAccessRequests.botId, demotedBot)),
    );
    expect(requested).toEqual([{ serverId: ADMIN_APP }]);
    const demotedItems = (await stored(fromDemoted.id))?.result as {
      step: string;
      outcome: string;
    }[];
    expect(demotedItems.map((item) => [item.step, item.outcome])).toEqual([
      ["create", "done"],
      ["skill", "failed"],
      ["app", "requested"],
    ]);
    // The same draft from somebody who still holds the role grants both: the gate is the role, not the draft.
    const adminBot = await createdBot(fromAdmin.id);
    expect(await grantsOf(adminBot)).toEqual([
      { kind: "mcp", ref: `${ADMIN_APP}/lookup`, grantedAs: "admin" },
      { kind: "skill", ref: DEPLOYMENT_SKILL, grantedAs: "admin" },
    ]);
  });

  test("a failure right after the bot is created keeps it in the result and a second apply makes no duplicate", async () => {
    const owner = await person("trailfail");
    const proposal = await propose(owner, "employee", employee("记账员"));
    failAuditFor = "bot.created";
    try {
      // 意外照常交给路由；提议已经落定成部分完成。
      await expect(
        runAsTenant(owner.id, () => executor.apply(owner, proposal.id)),
      ).rejects.toThrow("audit store unavailable");
    } finally {
      failAuditFor = null;
    }

    const row = await stored(proposal.id);
    expect(row?.status).toBe("partially_applied");
    const botId = await createdBot(proposal.id);
    expect((await ownedBots(owner.id)).map((bot) => bot.id)).toEqual([botId]);
    await runAsTenant(owner.id, () => executor.apply(owner, proposal.id)).catch(
      () => undefined,
    );
    expect((await ownedBots(owner.id)).map((bot) => bot.id)).toEqual([botId]);
  });

  test("an admin giving a built-in app that only admins may give gets all its tools, like the owner path", async () => {
    const asRequest = createAdminRequest(database);
    const admin: AuthenticatedActor = {
      id: ADMIN,
      email: `${ADMIN}@example.test`,
      role: "admin",
    };
    const proposal = await propose(
      admin,
      "employee",
      employee("管理员的定时员工", {
        apps: [{ app: "routines", actions: [] }],
      }),
    );
    // A fresh database has no built-in rows (the server syncs them at boot), so the test brings its own
    // and takes away only what it added; where the row exists already, only the rule is set and put back.
    const serverId = "team:routines";
    const seeded = await asPlatform(async () => {
      const inserted = await database
        .insert(mcpServers)
        .values({
          id: serverId,
          tenantId: "team",
          title: "定时任务",
          vendor: "OpenBot",
          url: "builtin://routines",
          provenance: "first-party",
          catalogueKey: "routines",
        })
        .onConflictDoNothing()
        .returning({ id: mcpServers.id });
      await database
        .insert(mcpTools)
        .values(
          ["create_routine", "list_routines"].map((name) => ({
            tenantId: "team",
            serverId,
            name,
            description: "内置动作。",
          })),
        )
        .onConflictDoNothing();
      await database
        .update(mcpServers)
        .set({ ownerGrants: "admin" })
        .where(eq(mcpServers.id, serverId));
      return inserted.length > 0;
    });
    try {
      await asRequest(ADMIN, () => executor.apply(admin, proposal.id));
    } finally {
      await asPlatform(() =>
        seeded
          ? database.delete(mcpServers).where(eq(mcpServers.id, serverId))
          : database
              .update(mcpServers)
              .set({ ownerGrants: null })
              .where(eq(mcpServers.id, serverId)),
      );
    }

    const items = (await stored(proposal.id))?.result as {
      step: string;
      outcome: string;
    }[];
    expect(items.map((item) => [item.step, item.outcome])).toEqual([
      ["create", "done"],
      ["app", "done"],
    ]);
    const refs = (await grantsOf(await createdBot(proposal.id))).map(
      (grant) => grant.ref,
    );
    // Writes included: a built-in app is the platform's own, and a read-only filter would leave nothing here.
    expect(refs).toContain("routines/create_routine");
    expect(refs).toContain("routines/list_routines");
  });

  test("retry redoes only the failed steps", async () => {
    const owner = await person("retry");
    const proposal = await propose(
      owner,
      "employee",
      employee("周报员", {
        apps: [{ app: OPEN_APP, actions: [] }],
        routines: [
          { title: "周报", instruction: "写本周周报。", cron: "0 17 * * 5" },
        ],
      }),
    );
    refuseNextRoutine = true;

    const first = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );
    expect(first.status).toBe("partially_applied");
    expect(await routinesOf(owner.id)).toEqual([]);
    const botId = await createdBot(proposal.id);

    const second = await runAsTenant(owner.id, () =>
      executor.retry(owner, proposal.id),
    );

    expect(second.status).toBe("applied");
    expect((await stored(proposal.id))?.status).toBe("applied");
    expect((await ownedBots(owner.id)).map((bot) => bot.id)).toEqual([botId]);
    expect(await routinesOf(owner.id)).toEqual([
      { agentId: botId, cron: "0 17 * * 5", title: "周报" },
    ]);
    expect(await grantsOf(botId)).toEqual([
      { kind: "mcp", ref: `${OPEN_APP}/search`, grantedAs: "owner" },
    ]);
    const created = await asPlatform(() =>
      database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "bot.created"),
            sql`${auditEvents.payload}->>'proposalId' = ${proposal.id}`,
          ),
        ),
    );
    expect(created).toHaveLength(1);
  });

  test("staffing tools are granted only when asked", async () => {
    const owner = await person("staffing");
    const without = await propose(owner, "employee", employee("普通员工"));
    const withTools = await propose(
      owner,
      "employee",
      employee("招聘助理", { staffingTools: true }),
    );

    await runAsTenant(owner.id, () => executor.apply(owner, without.id));
    await runAsTenant(owner.id, () => executor.apply(owner, withTools.id));

    const staffingRefs = async (agentId: string) =>
      (await grantsOf(agentId))
        .map((grant) => grant.ref)
        .filter((ref) => ref.startsWith("staffing/"));
    expect(await staffingRefs(await createdBot(without.id))).toEqual([]);
    expect(await staffingRefs(await createdBot(withTools.id))).toEqual([
      "staffing/list_staff",
      "staffing/proposal_status",
      "staffing/propose_employee",
      "staffing/propose_employee_change",
      "staffing/propose_group",
      "staffing/propose_group_change",
    ]);
  });

  test("someone else's proposal is refused and nothing changes", async () => {
    const owner = await person("mine");
    const stranger = await person("stranger");
    const proposal = await propose(owner, "employee", employee("别人的员工"));

    const refusal = await runAsTenant(stranger.id, () =>
      executor.apply(stranger, proposal.id),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ProposalNotFoundError);
    expect(await ownedBots(owner.id)).toEqual([]);
    expect(await ownedBots(stranger.id)).toEqual([]);
    expect((await stored(proposal.id))?.status).toBe("pending");
  });

  test("a field too long for the create route refuses the proposal and keeps it pending", async () => {
    const owner = await person("long");
    // 41 个表情：草稿按字数算是 41，创建员工那条路径按 UTF-16 算是 82，超过 80。
    const proposal = await propose(
      owner,
      "employee",
      employee("😀".repeat(41)),
    );

    const refusal = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ProposalRefusedError);
    expect((refusal as Error).message).toBe("名字需要 1 到 80 个字符。");
    expect(await ownedBots(owner.id)).toEqual([]);
    expect((await stored(proposal.id))?.status).toBe("pending");
  });

  test("a change merges a partial persona over the current one", async () => {
    const owner = await person("persona");
    const actor = { id: owner.id, role: "user" as const };
    const bot = await runAsTenant(owner.id, () =>
      profiles.create(actor, {
        name: "小红",
        title: "运营",
        roleDescription: "写文案。",
        visibility: "private",
        systemPrompt: "写文案。",
        persona: { tone: "活泼", principles: "诚实", habits: "早起" },
      }),
    );
    const base = await runAsTenant(owner.id, () =>
      currentEmployeeVersion(database, bot.id),
    );
    const proposal = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, set: { title: "主编", persona: { tone: "沉稳" } } },
      base,
    );

    const applied = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );

    expect(applied.status).toBe("applied");
    const [row] = await asPlatform(() =>
      database
        .select({ title: agentProfiles.title, persona: agentProfiles.persona })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, bot.id)),
    );
    expect(row).toEqual({
      title: "主编",
      persona: { tone: "沉稳", principles: "诚实", habits: "早起" },
    });
  });

  test("a group change keeps going after one step is refused", async () => {
    const owner = await person("group-change");
    const stranger = await person("group-stranger");
    const actor = { id: owner.id, role: "user" as const };
    const make = (who: AuthenticatedActor, name: string) =>
      runAsTenant(who.id, () =>
        profiles.create(
          { id: who.id, role: "user" },
          {
            name,
            title: "员工",
            roleDescription: "回答问题。",
            visibility: "private",
            systemPrompt: "回答问题。",
          },
        ),
      );
    const first = await make(owner, "甲");
    const second = await make(owner, "乙");
    const third = await make(owner, "丙");
    const foreign = await make(stranger, "外人");
    const channel = await runAsTenant(owner.id, () =>
      groups.create(owner.id, { agentIds: [first.id, second.id, third.id] }),
    );
    const base = await runAsTenant(owner.id, () =>
      currentGroupVersion(database, groups.store, owner.id, channel.id),
    );
    const proposal = await propose(
      owner,
      "group_change",
      {
        channelId: channel.id,
        name: "新群名",
        add: [foreign.id],
        remove: [third.id],
      },
      base,
    );

    await runAsTenant(owner.id, () => executor.apply(owner, proposal.id));

    const row = await stored(proposal.id);
    expect(row?.status).toBe("partially_applied");
    const items = (row?.result ?? []) as {
      step: string;
      outcome: string;
      message?: string;
    }[];
    expect(items.map((item) => [item.step, item.outcome])).toEqual([
      ["rename", "done"],
      ["add", "failed"],
      ["remove", "done"],
    ]);
    expect(items[1]?.message).toBe(
      `你没有权限使用员工 ${foreign.id}，无法加进群里。`,
    );
    const [named] = await asPlatform(() =>
      database
        .select({ title: channels.title })
        .from(channels)
        .where(eq(channels.id, channel.id)),
    );
    expect(named?.title).toBe("新群名");
    const bots = await runAsTenant(owner.id, () =>
      channelStore.get(actor, channel.id),
    );
    expect(bots?.agentIds.slice().sort()).toEqual([first.id, second.id].sort());
  });

  test("actions the person cannot give are named rather than dropped silently", async () => {
    const owner = await person("actions");
    const proposal = await propose(
      owner,
      "employee",
      employee("只读员工", {
        apps: [{ app: OPEN_APP, actions: ["search", "send"] }],
      }),
    );

    await runAsTenant(owner.id, () => executor.apply(owner, proposal.id));

    const botId = await createdBot(proposal.id);
    expect(await grantsOf(botId)).toEqual([
      { kind: "mcp", ref: `${OPEN_APP}/search`, grantedAs: "owner" },
    ]);
    const row = await stored(proposal.id);
    const app = (
      (row?.result ?? []) as {
        step: string;
        outcome: string;
        message?: string;
      }[]
    ).find((item) => item.step === "app");
    expect(app?.outcome).toBe("done");
    expect(app?.message).toContain("send");
  });

  test("a person without team bots cannot publish an employee through a proposal", async () => {
    const owner = await person("no-team");
    teamBotsOff.add(owner.id);
    const actor = { id: owner.id, role: "user" as const };
    const proposal = await propose(
      owner,
      "employee",
      employee("公开员工", { visibility: "public" }),
    );

    const refusal = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ProposalRefusedError);
    expect((refusal as Error).message).toContain("公开");
    expect(await ownedBots(owner.id)).toEqual([]);
    expect((await stored(proposal.id))?.status).toBe("pending");

    const bot = await runAsTenant(owner.id, () =>
      profiles.create(actor, {
        name: "私有员工",
        title: "员工",
        roleDescription: "回答问题。",
        visibility: "private",
        systemPrompt: "回答问题。",
      }),
    );
    const base = await runAsTenant(owner.id, () =>
      currentEmployeeVersion(database, bot.id),
    );
    const change = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, set: { visibility: "public" } },
      base,
    );

    await runAsTenant(owner.id, () => executor.apply(owner, change.id));

    const changed = await stored(change.id);
    expect(changed?.status).toBe("partially_applied");
    const update = (
      (changed?.result ?? []) as {
        step: string;
        outcome: string;
        message?: string;
      }[]
    ).find((item) => item.step === "update");
    expect(update?.outcome).toBe("failed");
    expect(update?.message).toContain("公开");
    const [visible] = await asPlatform(() =>
      database
        .select({ visibility: agentProfiles.visibility })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, bot.id)),
    );
    expect(visible?.visibility).toBe("private");
  });
});

describe("apps and versions an employee change touches", () => {
  const sharedStore = createSharedUseStore(database);
  const withShared = createStaffingExecutor({
    database,
    proposals,
    profiles,
    quota: createQuotaService(database),
    plugins,
    composioConfigured: true,
    routines: routineStore,
    channels: channelStore,
    groups,
    portraits: createPortraitStore(database),
    auditStore,
    shared: {
      store: sharedStore,
      audience: createSharedAudience(database, sharedStore, auditStore),
    },
  });
  const READS = id("reads");
  const SHARED_APP = id("shared");

  beforeAll(async () => {
    await asPlatform(async () => {
      await database.insert(mcpServers).values([
        {
          id: READS,
          tenantId: "team",
          title: "只读应用",
          vendor: "test",
          url: "https://example.invalid/reads",
          provenance: "custom",
          ownerGrants: "any",
        },
        {
          id: SHARED_APP,
          tenantId: "team",
          title: "团队邮箱",
          vendor: "Composio",
          url: `composio://${SHARED_APP}`,
          provenance: "composio",
          authScheme: "OAUTH2",
          ownerGrants: "any",
          accountMode: "shared",
          sharedVendorUserId: `openbot-deployment:${suite}:S`,
          sharedConnectedAt: new Date(),
          sharedConnectedBy: ADMIN,
          sharedVerified: true,
        },
      ]);
      await database.insert(mcpTools).values([
        {
          tenantId: "team",
          serverId: READS,
          name: "search",
          description: "搜索。",
          effect: "read",
        },
        {
          tenantId: "team",
          serverId: READS,
          name: "list",
          description: "列出。",
          effect: "read",
        },
        {
          tenantId: "team",
          serverId: SHARED_APP,
          name: "LIST",
          description: "列出。",
          effect: "read",
        },
      ]);
    });
  });

  afterAll(async () => {
    await asPlatform(async () => {
      await database
        .delete(sharedUseApprovals)
        .where(inArray(sharedUseApprovals.serverId, [SHARED_APP]));
      await database
        .delete(pluginGrants)
        .where(
          sql`${pluginGrants.ref} like ${`${READS}/%`} or ${pluginGrants.ref} like ${`${SHARED_APP}/%`}`,
        );
      await database
        .delete(mcpServers)
        .where(inArray(mcpServers.id, [READS, SHARED_APP]));
    });
  });

  /** 本人自己的私有员工，带上已经给了的应用动作。 */
  async function botWith(owner: AuthenticatedActor, refs: string[] = []) {
    const bot = await runAsTenant(owner.id, () =>
      profiles.create(
        { id: owner.id, role: "user" },
        {
          name: "小红",
          title: "运营",
          roleDescription: "写文案。",
          visibility: "private",
          systemPrompt: "写文案。",
        },
      ),
    );
    await runAsTenant(owner.id, async () => {
      for (const ref of refs)
        await plugins.grant("mcp", ref, bot.id, owner.email, { as: "owner" });
    });
    const base = await runAsTenant(owner.id, () =>
      currentEmployeeVersion(database, bot.id),
    );
    return { bot, base };
  }

  test("a shared app the person may give gets its audience approval with the grant", async () => {
    const owner = await person("shared");
    const proposal = await propose(
      owner,
      "employee",
      employee("邮箱助理", { apps: [{ app: SHARED_APP, actions: [] }] }),
    );

    await runAsTenant(owner.id, () => withShared.apply(owner, proposal.id));

    const botId = await createdBot(proposal.id);
    expect(await grantsOf(botId)).toEqual([
      { kind: "mcp", ref: `${SHARED_APP}/LIST`, grantedAs: "owner" },
    ]);
    const approvals = await asPlatform(() =>
      database
        .select({ serverId: sharedUseApprovals.serverId })
        .from(sharedUseApprovals)
        .where(eq(sharedUseApprovals.agentId, botId)),
    );
    expect(approvals).toEqual([{ serverId: SHARED_APP }]);
  });

  test("two changes drafted on one version cannot both apply", async () => {
    const owner = await person("race");
    const { bot, base } = await botWith(owner);
    const first = await propose(
      owner,
      "employee_change",
      {
        agentId: bot.id,
        set: { title: "甲方头衔", roleDescription: "甲方职责。" },
      },
      base,
    );
    const second = await propose(
      owner,
      "employee_change",
      {
        agentId: bot.id,
        set: { title: "乙方头衔", roleDescription: "乙方职责。" },
      },
      base,
    );

    const outcomes = await Promise.all(
      [first, second].map((proposal) =>
        runAsTenant(owner.id, () => withShared.apply(owner, proposal.id)).then(
          (applied) => applied.status,
          (error: unknown) => error,
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === "applied")).toHaveLength(1);
    const stale = outcomes.filter(
      (outcome) => outcome instanceof ProposalStaleError,
    );
    expect(stale).toHaveLength(1);
    const winner = outcomes[0] === "applied" ? "甲方" : "乙方";
    const [row] = await asPlatform(() =>
      database
        .select({
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
        })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, bot.id)),
    );
    expect(row).toEqual({
      title: `${winner}头衔`,
      roleDescription: `${winner}职责。`,
    });
    const statuses = [
      (await stored(first.id))?.status,
      (await stored(second.id))?.status,
    ].sort();
    expect(statuses).toEqual(["applied", "pending"]);
  });

  test("a change adds the missing action of an app the employee partly holds", async () => {
    const owner = await person("partial");
    const { bot, base } = await botWith(owner, [`${READS}/search`]);
    const proposal = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, set: { apps: [{ app: READS, actions: ["list"] }] } },
      base,
    );

    const applied = await runAsTenant(owner.id, () =>
      withShared.apply(owner, proposal.id),
    );

    expect(applied.status).toBe("applied");
    expect(await grantsOf(bot.id)).toEqual([
      { kind: "mcp", ref: `${READS}/list`, grantedAs: "owner" },
      { kind: "mcp", ref: `${READS}/search`, grantedAs: "owner" },
    ]);
  });

  test("removing named actions of an app keeps the others", async () => {
    const owner = await person("remove");
    const { bot, base } = await botWith(owner, [
      `${READS}/search`,
      `${READS}/list`,
    ]);
    const some = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, appsRemove: [{ app: READS, actions: ["list"] }] },
      base,
    );

    await runAsTenant(owner.id, () => withShared.apply(owner, some.id));

    expect((await stored(some.id))?.status).toBe("applied");
    expect(await grantsOf(bot.id)).toEqual([
      { kind: "mcp", ref: `${READS}/search`, grantedAs: "owner" },
    ]);

    const all = await propose(
      owner,
      "employee_change",
      { agentId: bot.id, appsRemove: [{ app: READS, actions: [] }] },
      base,
    );
    await runAsTenant(owner.id, () => withShared.apply(owner, all.id));

    expect((await stored(all.id))?.status).toBe("applied");
    expect(await grantsOf(bot.id)).toEqual([]);
  });
});

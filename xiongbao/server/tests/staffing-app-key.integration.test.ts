import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { readStaffingProposalAnswer } from "../../shared/staffing-proposal";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAuditStore } from "../src/audit";
import type { AuthenticatedActor } from "../src/auth/guards";
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
  mcpServers,
  mcpTools,
  pluginGrants,
  portraits,
  staffingProposals,
  subscriptions,
  users,
} from "../src/db/schema";
import { createModelShelf } from "../src/models/routes";
import {
  callTool,
  type StaffingToolDeps,
  useStaffingTools,
} from "../src/plugins/builtin-staffing";
import { createPluginStore } from "../src/plugins/store";
import { createPortraitStore } from "../src/portraits/store";
import { createQuotaService } from "../src/quota/limits";
import { createRoleTemplateStore } from "../src/roles/store";
import { createRoutineStore } from "../src/routines/store";
import { parseDraft } from "../src/staffing/draft";
import { createStaffingExecutor } from "../src/staffing/executor";
import { createStaffingProposalStore } from "../src/staffing/store";
import { runAsTenant } from "../src/tenant/context";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 员工起草时可以用任何叫法点名一个应用（标题、别名），但草稿、卡片、收回、连接页认的都是应用的键：
 * 起草时存进草稿的是键，执行后「需要先连接」那一项的对象也是键——卡片上的「去连接」按它打开
 * `/connections/$key`，按别名打开就是一个找不到的页面。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `sak-${suite}-${name}`;

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
  roster: async () => null,
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
const routineStore = createRoutineStore(database);

const toolDeps: StaffingToolDeps = {
  database,
  proposals,
  profiles,
  plugins,
  composioConfigured: true,
  routines: routineStore,
  groups,
  catalogue: createModelShelf({ database, environment: {} }),
  roleTemplates: createRoleTemplateStore({ database, profiles }),
  auditStore,
};

const executor = createStaffingExecutor({
  database,
  mayUse: async () => true,
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
});

/** 一个本人能直接给的应用，与一个要先连自己账号的应用；标题带上本文件的后缀，免得和别的文件的行同名。 */
const OPEN_APP = id("open-app");
const OPEN_TITLE = `别名应用-${suite}`;
const MAIL_APP = id("mail");
const MAIL_TITLE = `邮件-${suite}`;

const people: string[] = [];
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

async function person(name: string): Promise<AuthenticatedActor> {
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
  return { id: userId, email: `${userId}@example.test`, role: "user" };
}

async function bot(owner: AgentActor, name: string) {
  const profile = await runAsTenant(owner.id, () =>
    profiles.create(owner, {
      name,
      title: "员工",
      roleDescription: "回答问题。",
      visibility: "private",
      systemPrompt: "回答问题。",
    }),
  );
  return profile.id;
}

/** 这个人问这个应用时，部署认的键。 */
async function keyOf(owner: AgentActor, app: string): Promise<string> {
  const inspected = await runAsTenant(owner.id, () =>
    plugins.inspectApp({
      app,
      agentId: "",
      userId: owner.id,
      composioConfigured: true,
      ownerView: true,
    }),
  );
  if (!inspected) throw new Error(`no app for ${app}`);
  return inspected.access.key;
}

beforeAll(async () => {
  await asPlatform(async () => {
    await database.insert(mcpServers).values([
      {
        id: OPEN_APP,
        tenantId: "team",
        title: OPEN_TITLE,
        vendor: "test",
        url: "https://example.invalid/open",
        provenance: "custom",
        ownerGrants: "any",
      },
      {
        id: MAIL_APP,
        tenantId: "team",
        title: MAIL_TITLE,
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
        serverId: MAIL_APP,
        name: "LIST",
        description: "列出。",
        effect: "read",
      },
    ]);
  });
  useStaffingTools(toolDeps);
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
    await database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, people));
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
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [OPEN_APP, MAIL_APP]));
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

describe("apps in a staffing proposal are named by their key", () => {
  test("a draft that names an app by its title stores the app's key", async () => {
    const owner = await person("draft");
    const helper = await bot(owner, "小管家");
    const key = await keyOf(owner, OPEN_TITLE);
    expect(key).not.toBe(OPEN_TITLE);

    const answer = await runAsTenant(owner.id, () =>
      callTool(
        {
          url: "builtin://staffing",
          actorId: owner.id,
          botId: helper,
          threadId: id("thread"),
        },
        "propose_employee",
        {
          name: "带别名应用的员工",
          title: "运营",
          roleDescription: "负责日常运营。",
          apps: [{ app: OPEN_TITLE, actions: [] }],
        },
      ),
    );

    const read = readStaffingProposalAnswer(answer.text);
    if (!read) throw new Error(`not a proposal answer: ${answer.text}`);
    const [row] = await asPlatform(() =>
      database
        .select({ draft: staffingProposals.draft })
        .from(staffingProposals)
        .where(eq(staffingProposals.id, read.card.proposalId)),
    );
    if (!row) throw new Error("the proposal was not stored");
    expect((row.draft as { apps: unknown }).apps).toEqual([
      { app: key, actions: [] },
    ]);
  });

  test("an app that waits on a connection names the key the connection page opens", async () => {
    const owner = await person("apply");
    const key = await keyOf(owner, MAIL_TITLE);
    expect(key).not.toBe(MAIL_TITLE);
    // 起草前就存下的草稿（或手写的）仍可能带着叫法：执行时也按键回报。
    const parsed = parseDraft("employee", {
      name: "要连账号的员工",
      title: "助理",
      roleDescription: "整理邮件。",
      apps: [{ app: MAIL_TITLE, actions: [] }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const proposal = await runAsTenant(owner.id, () =>
      proposals.create({
        ownerId: owner.id,
        proposedByAgentId: `avatar-${owner.id}`,
        threadId: null,
        kind: "employee",
        draft: parsed.draft,
        baseVersion: null,
      }),
    );

    const applied = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );

    const waiting = (applied.result ?? []).filter(
      (item) => item.outcome === "needs_connection",
    );
    expect(waiting.map((item) => [item.step, item.target])).toEqual([
      ["app", key],
    ]);
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { readStaffingProposalAnswer } from "../../shared/staffing-proposal";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
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
  appAccessRequests,
  enterpriseSettings,
  mcpServers,
  pluginGrants,
  staffingProposals,
  subscriptions,
  users,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import { createModelShelf } from "../src/models/routes";
import {
  callTool,
  listTools,
  type StaffingToolDeps,
  useStaffingTools,
} from "../src/plugins/builtin-staffing";
import { createPluginStore } from "../src/plugins/store";
import { createPortraitStore } from "../src/portraits/store";
import { createRoleTemplateStore } from "../src/roles/store";
import { createRoutineStore } from "../src/routines/store";
import {
  backfillStaffingForAvatars,
  ensureStaffingServer,
  type StaffingAppMemory,
  staffingAppMemory,
  staffingBackfillDeps,
} from "../src/staffing/default-grant";
import { parseDraft } from "../src/staffing/draft";
import { createStaffingExecutor } from "../src/staffing/executor";
import {
  createStaffingProposalStore,
  STALE_APPLYING_MS,
} from "../src/staffing/store";
import { runAsTenant } from "../src/tenant/context";
import {
  avatarAgentId,
  provisionTenant,
  STAFFING_REFS,
  staffingGivenSetting,
} from "../src/tenant/provisioning";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 「招聘与组群」与别的应用过同一道「给」：管理员把它收归自己（`owner_grants = admin`）或删掉它时，卡片上的
 * 勾选与小管家的默认授予都不给；团队版里管理员删掉的应用不会在下一次启动时被加回来。起草与查状态：新员工
 * 不带工作指令，普通员工的指令改动被剔除，查状态时停得太久的执行落定。每一条都看库里留下了什么。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `sgt-${suite}-${name}`;
const asPlatform = <T>(work: () => Promise<T>) => runAsTenant("platform", work);

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
  canUseBot: async () => true,
  progressEveryMs: 0,
});
const proposals = createStaffingProposalStore(database);
const routineStore = createRoutineStore(database);
const approvals = createApprovalService(
  createApprovalStore(database),
  undefined,
  undefined,
  { settlement: "database" },
);
const executor = createStaffingExecutor({
  database,
  mayUse: async () => true,
  proposals,
  profiles,
  plugins,
  composioConfigured: false,
  routines: routineStore,
  channels: channelStore,
  groups,
  portraits: createPortraitStore(database),
  auditStore,
});
const toolDeps: StaffingToolDeps = {
  database,
  proposals,
  profiles,
  plugins,
  composioConfigured: false,
  routines: routineStore,
  groups,
  catalogue: createModelShelf({ database, environment: {} }),
  roleTemplates: createRoleTemplateStore({ database, profiles }),
  auditStore,
};

const people: string[] = [];

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

const employee = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: "运营",
  roleDescription: "负责小红书的日常运营。",
  ...extra,
});

async function propose(owner: AuthenticatedActor, raw: unknown) {
  const parsed = parseDraft("employee", raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return runAsTenant(owner.id, () =>
    proposals.create({
      ownerId: owner.id,
      proposedByAgentId: `avatar-${owner.id}`,
      threadId: null,
      kind: "employee",
      draft: parsed.draft,
      baseVersion: null,
    }),
  );
}

const staffingRefsOf = async (agentId: string) =>
  (
    await asPlatform(() =>
      database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, agentId),
            like(pluginGrants.ref, "staffing/%"),
          ),
        ),
    )
  )
    .map((row) => row.ref)
    .sort();

const createdBotOf = (result: { step: string; target?: string }[] | null) => {
  const created = result?.find((item) => item.step === "create")?.target;
  if (!created) throw new Error("the proposal created no bot");
  return created;
};

const givenMarker = async (avatarId: string) =>
  (
    await asPlatform(() =>
      database
        .select({ key: enterpriseSettings.key })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, staffingGivenSetting(avatarId))),
    )
  ).length > 0;

/** 部署里的「招聘与组群」应用行（没有为 undefined）。 */
const staffingRow = async () =>
  (
    await asPlatform(() =>
      database
        .select({ id: mcpServers.id, ownerGrants: mcpServers.ownerGrants })
        .from(mcpServers)
        .where(eq(mcpServers.catalogueKey, "staffing")),
    )
  )[0];

/** 管理员对「招聘与组群」的选择：`admin` 是只有管理员能给，null 是按默认（主人能给）。 */
async function ownerGrantsOfStaffing(value: "admin" | null) {
  await asPlatform(() =>
    database
      .update(mcpServers)
      .set({ ownerGrants: value })
      .where(eq(mcpServers.catalogueKey, "staffing")),
  );
}

/** 管理员删掉了「招聘与组群」这个应用。 */
async function adminDeletesStaffing() {
  const row = await staffingRow();
  if (row) await asPlatform(() => plugins.removeServer(row.id, "admin"));
}

/** 开始前部署里有没有这一行、管理员当时怎么选的；结束时照原样放回。 */
let before: { present: boolean; ownerGrants: "admin" | "any" | null } = {
  present: false,
  ownerGrants: null,
};

const backfill = (userId: string) =>
  runAsTenant(userId, () =>
    backfillStaffingForAvatars(
      staffingBackfillDeps(database, {
        store: plugins,
        disabled: (avatarId) => approvals.disabledTools(userId, avatarId),
      }),
    ),
  );

/** 升级前开通的分身：有分身、还没有招人的授予。 */
async function upgradedAvatar(name: string): Promise<string> {
  const owner = await person(name);
  await provisionTenant(database, { id: owner.id, email: owner.email });
  return owner.id;
}

beforeAll(async () => {
  useStaffingTools(toolDeps);
  const row = await staffingRow();
  before = {
    present: row !== undefined,
    ownerGrants: (row?.ownerGrants ?? null) as "admin" | "any" | null,
  };
  await asPlatform(async () => {
    const added =
      row ?? (await plugins.addServer({ key: "staffing", by: "boot" }));
    await plugins.refreshTools(added.id);
  });
});

afterEach(async () => {
  setEdition("team");
  await ownerGrantsOfStaffing(null);
  if (!(await staffingRow()))
    await asPlatform(async () => {
      const added = await plugins.addServer({ key: "staffing", by: "boot" });
      await plugins.refreshTools(added.id);
    });
});

afterAll(async () => {
  useStaffingTools(null);
  await asPlatform(async () => {
    const avatars = people.map(avatarAgentId);
    const owned = (
      await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(inArray(agentProfiles.ownerUserId, people))
    ).map((row) => row.id);
    const bots = [...new Set([...avatars, ...owned])];
    await database
      .delete(appAccessRequests)
      .where(inArray(appAccessRequests.requesterUserId, people));
    await database
      .delete(staffingProposals)
      .where(inArray(staffingProposals.ownerId, people));
    await database
      .delete(pluginGrants)
      .where(inArray(pluginGrants.agentId, bots));
    await database.delete(enterpriseSettings).where(
      inArray(
        enterpriseSettings.key,
        avatars.map((avatarId) => staffingGivenSetting(avatarId)),
      ),
    );
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, bots));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database
      .delete(subscriptions)
      .where(inArray(subscriptions.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
    const row = await staffingRow();
    if (!before.present && row) await plugins.removeServer(row.id, "boot");
    if (before.present && row)
      await database
        .update(mcpServers)
        .set({ ownerGrants: before.ownerGrants })
        .where(eq(mcpServers.id, row.id));
  });
});

// Last-registered, so it runs after the cleanup above has used the pool.
afterAll(async () => {
  await database.$client.close();
});

describe("the 「也给它招聘与组群能力」 step gives like any other app", () => {
  test("an app the person may give is given as theirs", async () => {
    const owner = await person("may-give");
    const proposal = await propose(
      owner,
      employee("招聘助理", { staffingTools: true }),
    );

    const applied = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );

    expect(applied.status).toBe("applied");
    expect(await staffingRefsOf(createdBotOf(applied.result))).toEqual(
      [...STAFFING_REFS].sort(),
    );
  });

  test("an app the administrator keeps to themselves is refused with the reason, and nothing is requested", async () => {
    await ownerGrantsOfStaffing("admin");
    const owner = await person("admin-only");
    const proposal = await propose(
      owner,
      employee("招聘助理", { staffingTools: true }),
    );

    const applied = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );

    expect(applied.status).toBe("partially_applied");
    const step = applied.result?.find((item) => item.step === "staffing_tools");
    expect(step?.outcome).toBe("failed");
    expect(step?.message).toBe("只有管理员可以把 招聘与组群 给员工。");
    expect(await staffingRefsOf(createdBotOf(applied.result))).toEqual([]);
    const requests = await asPlatform(() =>
      database
        .select({ id: appAccessRequests.id })
        .from(appAccessRequests)
        .where(eq(appAccessRequests.requesterUserId, owner.id)),
    );
    expect(requests).toEqual([]);
  });

  test("an app the administrator deleted is refused with the reason", async () => {
    await adminDeletesStaffing();
    const owner = await person("deleted");
    const proposal = await propose(
      owner,
      employee("招聘助理", { staffingTools: true }),
    );

    const applied = await runAsTenant(owner.id, () =>
      executor.apply(owner, proposal.id),
    );

    const step = applied.result?.find((item) => item.step === "staffing_tools");
    expect(step?.outcome).toBe("failed");
    expect(step?.message).toMatch(/[\p{Script=Han}]/u);
    expect(await staffingRefsOf(createdBotOf(applied.result))).toEqual([]);
  });
});

describe("the avatar's default grant follows the administrator's choice", () => {
  test("a new avatar is not granted while only administrators may give the app", async () => {
    await ownerGrantsOfStaffing("admin");
    const owner = await person("fresh-admin-only");

    await provisionTenant(
      database,
      { id: owner.id, email: owner.email },
      { withStaffing: true },
    );

    const avatarId = avatarAgentId(owner.id);
    expect(await staffingRefsOf(avatarId)).toEqual([]);
    // 没有记成处理过：管理员之后放开时，下一次读取再补。
    expect(await givenMarker(avatarId)).toBe(false);
  });

  test("an existing avatar is not backfilled while only administrators may give the app, and is once that changes", async () => {
    const userId = await upgradedAvatar("lazy-admin-only");
    const avatarId = avatarAgentId(userId);
    await ownerGrantsOfStaffing("admin");

    expect(await backfill(userId)).toBe(0);
    expect(await staffingRefsOf(avatarId)).toEqual([]);
    expect(await givenMarker(avatarId)).toBe(false);

    await ownerGrantsOfStaffing(null);
    expect(await backfill(userId)).toBe(1);
    expect(await staffingRefsOf(avatarId)).toEqual([...STAFFING_REFS].sort());
  });

  test("no avatar is granted an app the deployment does not have", async () => {
    await adminDeletesStaffing();
    const fresh = await person("fresh-deleted");
    const upgraded = await upgradedAvatar("lazy-deleted");

    await provisionTenant(
      database,
      { id: fresh.id, email: fresh.email },
      { withStaffing: true },
    );

    expect(await staffingRefsOf(avatarAgentId(fresh.id))).toEqual([]);
    expect(await backfill(upgraded)).toBe(0);
    expect(await staffingRefsOf(avatarAgentId(upgraded))).toEqual([]);
  });
});

describe("the startup step adds the app once in the team edition", () => {
  /** 部署记得的事，放在内存里：这里只看启动这一步怎么用它。 */
  const remembered = (): StaffingAppMemory & { value: boolean } => {
    const memory = {
      value: false,
      added: async () => memory.value,
      remember: async () => {
        memory.value = true;
      },
    };
    return memory;
  };

  test("an app the administrator deleted is not added back on the next boot", async () => {
    setEdition("team");
    const memory = remembered();
    await asPlatform(() => ensureStaffingServer(plugins, memory));
    expect(await staffingRow()).toBeDefined();
    expect(memory.value).toBe(true);

    await adminDeletesStaffing();
    await asPlatform(() => ensureStaffingServer(plugins, memory));

    expect(await staffingRow()).toBeUndefined();
  });

  test("the personal edition keeps it always there", async () => {
    setEdition("personal");
    const memory = remembered();
    memory.value = true;
    await adminDeletesStaffing();

    await asPlatform(() => ensureStaffingServer(plugins, memory));

    expect(await staffingRow()).toBeDefined();
  });

  test("the deployment remembers it added the app", async () => {
    const key = "staffing_app_added";
    const had = await asPlatform(() =>
      database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, key)),
    );
    await asPlatform(() =>
      database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, key)),
    );
    const memory = staffingAppMemory(database);
    try {
      expect(await asPlatform(() => memory.added())).toBe(false);
      await asPlatform(() => memory.remember());
      expect(await asPlatform(() => memory.added())).toBe(true);
    } finally {
      await asPlatform(async () => {
        await database
          .delete(enterpriseSettings)
          .where(eq(enterpriseSettings.key, key));
        const [row] = had;
        if (row)
          await database
            .insert(enterpriseSettings)
            .values({ key, value: row.value, updatedBy: "openbot:test" });
      });
    }
  });
});

describe("drafts carry instructions only where they are used", () => {
  const call = (
    owner: AuthenticatedActor,
    botId: string,
    tool: string,
    args: Record<string, unknown>,
  ) =>
    runAsTenant(owner.id, () =>
      callTool(
        {
          url: "builtin://staffing",
          actorId: owner.id,
          botId,
          threadId: id(`thread-${randomUUID().slice(0, 6)}`),
        },
        tool,
        args,
      ),
    );
  const draftOf = async (text: string) => {
    const answer = readStaffingProposalAnswer(text);
    if (!answer) throw new Error(`not a proposal answer: ${text}`);
    const [row] = await asPlatform(() =>
      database
        .select({ draft: staffingProposals.draft })
        .from(staffingProposals)
        .where(eq(staffingProposals.id, answer.card.proposalId)),
    );
    return {
      draft: row?.draft as Record<string, unknown>,
      sentence: answer.sentence,
    };
  };

  test("the employee tool offers no instructions, and a draft that brings some keeps none and says so", async () => {
    const owner = await person("new-instructions");
    const helper = await bot(owner, "小管家");
    const tools = await listTools();
    const schema = tools.find((tool) => tool.name === "propose_employee")
      ?.inputSchema as { properties: Record<string, unknown> };
    expect("instructions" in schema.properties).toBe(false);

    const answer = await call(
      owner,
      helper,
      "propose_employee",
      employee("小红", { instructions: "先看邮件。" }),
    );

    const { draft, sentence } = await draftOf(answer.text);
    expect("instructions" in draft).toBe(false);
    expect(sentence).toContain("新员工没有单独的工作指令");
  });

  test("a change to an ordinary employee's instructions is dropped and named", async () => {
    const owner = await person("change-instructions");
    const helper = await bot(owner, "小管家");
    const target = await bot(owner, "普通员工");

    const answer = await call(owner, helper, "propose_employee_change", {
      agentId: target,
      set: { title: "新头衔", instructions: "先看日程。" },
    });

    const { draft, sentence } = await draftOf(answer.text);
    expect(draft.set).toEqual({ title: "新头衔" });
    expect(sentence).toContain("这位员工没有单独的工作指令");
  });
});

describe("asking for a proposal's status", () => {
  test("settles one that has been applying too long", async () => {
    const owner = await person("status");
    const helper = await bot(owner, "小管家");
    const proposal = await propose(owner, employee("停住的"));
    await asPlatform(() =>
      database
        .update(staffingProposals)
        .set({
          status: "applying",
          updatedAt: sql`now() - make_interval(secs => ${(STALE_APPLYING_MS + 60_000) / 1000})`,
        })
        .where(eq(staffingProposals.id, proposal.id)),
    );

    const answer = await runAsTenant(owner.id, () =>
      callTool(
        {
          url: "builtin://staffing",
          actorId: owner.id,
          botId: helper,
          threadId: id("thread-status"),
        },
        "proposal_status",
        { proposalId: proposal.id },
      ),
    );

    expect(answer.text).toContain("等待用户在卡片上确认");
    const [row] = await asPlatform(() =>
      database
        .select({ status: staffingProposals.status })
        .from(staffingProposals)
        .where(eq(staffingProposals.id, proposal.id)),
    );
    expect(row?.status).toBe("pending");
  });
});

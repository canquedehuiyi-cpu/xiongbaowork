import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { type AuditInitiator, createAuditStore } from "../src/audit";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
  responsibilities,
  teamBotAudience,
  teamBotPublications,
  users,
} from "../src/db/schema";
import {
  sharedUseApprovals,
  sharedUseRequests,
} from "../src/db/schema/shared-use";
import type { ComposioBroker } from "../src/plugins/broker";
import type { SharedUseApproval } from "../src/plugins/shared-use";
import {
  createSharedAudience,
  createSharedUseStore,
  SharedUseFrameError,
  SharedUseRequestDecidedError,
} from "../src/plugins/shared-use-store";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { bindTestRoleWriter } from "./support/role-writer";

/**
 * 共享使用批准的存储与闸门（上游 `shared-use-store.integration.test.ts`，按 fork 的租户模型改写）。
 *
 * 上游的库没有租户，这里每一步都在某个人的帧里做，所以多断言了上游没有的那一半：批准写在员工主人名下，
 * 闸门在别人的调用里也按主人名下的批准判（只读），队友的调用不往主人名下写申请，别人租户里伪造的批准
 * 行不起作用，管理员不能在自己的帧里替别人的员工写批准。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `su-${suite}-${name}`;
const OWNER = id("owner");
const ADMIN = id("admin");
const NAMED = id("named");
const NEWHIRE = id("newhire");
const STRANGER = id("stranger");
const people = [OWNER, ADMIN, NAMED, NEWHIRE, STRANGER];
/** OWNER 的私人员工。 */
const BOT = id("bot");
/** OWNER 发布的团队员工（`team` 标记）。 */
const TEAM_BOT = id("team-bot");
/** 没有主人的公开员工（目录员工）。 */
const ORPHAN = id("orphan");
const bots = [BOT, TEAM_BOT, ORPHAN];
const toolkit = `su_${suite.replace(/-/g, "_")}`;
const APP = toolkit;
/** 同一个地址上的第二行（id 更大，所以不是应答行）。 */
const DUPLICATE = `${toolkit}_zz`;

const audit = createAuditStore(database);
const store = createSharedUseStore(database);
const { gate, admitsPerson } = createSharedAudience(database, store, audit);
let releaseRoleWriter: (() => Promise<void>) | undefined;

const ask = (
  actor: string,
  botId: string,
  options: { outside?: boolean; initiator?: AuditInitiator } = {},
) =>
  runAsTenant(actor, () =>
    gate({
      botId,
      serverId: APP,
      title: "Team GitHub",
      actorId: actor,
      initiator: options.initiator ?? { kind: "person" },
      outside: options.outside ?? false,
    }),
  );
const allowed = async (
  actor: string,
  botId: string,
  options: { outside?: boolean } = {},
) => (await ask(actor, botId, options)).allowed;

const approve = (botId: string, approval: SharedUseApproval, serverId = APP) =>
  runAsTenant(OWNER, () =>
    store.setApproval({ botId, serverId, by: ADMIN, approval }),
  );

const pendingFor = (botId: string) =>
  runAsTenant(OWNER, () => store.pendingFor(botId));

beforeAll(async () => {
  releaseRoleWriter = await bindTestRoleWriter(database);
  await asPlatform(async () => {
    await database.insert(users).values([
      { id: OWNER, email: `${OWNER}@example.test` },
      { id: ADMIN, email: `${ADMIN}@example.test` },
      { id: NAMED, email: `${NAMED}@example.test` },
      {
        id: NEWHIRE,
        email: `${NEWHIRE}@example.test`,
        groups: [`${suite}-platform`],
      },
      { id: STRANGER, email: `${STRANGER}@example.test` },
    ]);
    await setRole(database, ADMIN, "admin");
    for (const [row, stamp] of [
      [APP, "team"],
      [DUPLICATE, "team"],
    ] as const) {
      await database.insert(mcpServers).values({
        id: row,
        tenantId: stamp,
        title: "Team GitHub",
        vendor: "Composio",
        url: `composio://${toolkit}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: "shared",
        sharedVendorUserId: `openbot-deployment:${suite}:R`,
        sharedConnectedAt: new Date(),
        sharedConnectedBy: ADMIN,
        sharedVerified: true,
      });
    }
    await database.insert(agents).values([
      {
        id: BOT,
        tenantId: OWNER,
        name: "Triage",
        type: "built_in",
        configuration: {},
      },
      {
        id: TEAM_BOT,
        tenantId: "team",
        name: "Desk",
        type: "built_in",
        configuration: {},
      },
      {
        id: ORPHAN,
        tenantId: "system",
        name: "Catalogue",
        type: "built_in",
        configuration: {},
      },
    ]);
    await database.insert(agentProfiles).values([
      {
        agentId: BOT,
        tenantId: OWNER,
        ownerUserId: OWNER,
        title: "Triage",
        roleDescription: "分拣",
        avatarSeed: `${suite}-a`,
        visibility: "private",
      },
      {
        agentId: TEAM_BOT,
        tenantId: "team",
        ownerUserId: OWNER,
        title: "Desk",
        roleDescription: "前台",
        avatarSeed: `${suite}-b`,
        visibility: "private",
      },
    ]);
    await database.insert(teamBotPublications).values({
      agentId: TEAM_BOT,
      tenantId: "team",
      publishedBy: OWNER,
      audience: "people",
    });
    await database.insert(teamBotAudience).values([
      { agentId: TEAM_BOT, tenantId: "team", kind: "user", value: NAMED },
      {
        agentId: TEAM_BOT,
        tenantId: "team",
        kind: "group",
        value: `${suite}-platform`,
      },
    ]);
    await database.insert(pluginGrants).values([
      {
        tenantId: OWNER,
        kind: "mcp",
        ref: `${APP}/GITHUB_LIST_ISSUES`,
        agentId: BOT,
        grantedBy: ADMIN,
      },
      {
        tenantId: "team",
        kind: "mcp",
        ref: `${APP}/GITHUB_LIST_ISSUES`,
        agentId: TEAM_BOT,
        grantedBy: ADMIN,
      },
    ]);
  });
});

beforeEach(async () => {
  await asPlatform(async () => {
    await database
      .delete(sharedUseRequests)
      .where(inArray(sharedUseRequests.agentId, bots));
    await database
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.agentId, bots));
    await database
      .delete(teamBotAudience)
      .where(
        and(
          eq(teamBotAudience.agentId, TEAM_BOT),
          eq(teamBotAudience.value, STRANGER),
        ),
      );
  });
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(responsibilities)
      .where(inArray(responsibilities.agentId, bots));
    await database.delete(agents).where(inArray(agents.id, bots));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [APP, DUPLICATE]));
    await database.delete(users).where(inArray(users.id, people));
  });
  await releaseRoleWriter?.();
  await database.$client.close();
});

describe("the shared-use gate", () => {
  test("with no approval, even the owner is refused and one request is filed in the owner's name", async () => {
    const answer = await ask(OWNER, BOT);
    expect(answer).toMatchObject({
      allowed: false,
      refusal: "shared_account_not_approved",
    });
    if (!answer.allowed) expect(answer.why).toContain("管理员还没有批准");
    const pending = await pendingFor(BOT);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reason: "refused_call",
      requestedBy: OWNER,
      proposed: { audience: "owner", outsideInput: false, members: [] },
    });
    // 第二次被拒不再建第二条。
    await ask(OWNER, BOT);
    expect(await pendingFor(BOT)).toHaveLength(1);
  });

  test("an administrator is refused too while there is no approval", async () => {
    expect(await allowed(ADMIN, BOT)).toBe(false);
  });

  test("a teammate refused on a Team Bot writes nothing in the owner's name, or their own", async () => {
    const answer = await ask(NAMED, TEAM_BOT);
    expect(answer.allowed).toBe(false);
    if (!answer.allowed) expect(answer.why).toContain("请员工的主人");
    expect(await pendingFor(TEAM_BOT)).toEqual([]);
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseRequests)
          .where(eq(sharedUseRequests.agentId, TEAM_BOT)),
      ),
    ).toEqual([]);
  });

  test("owner-only admits the owner and an administrator, and refuses a teammate", async () => {
    await approve(TEAM_BOT, {
      audience: "owner",
      outsideInput: false,
      members: [],
    });
    expect(await allowed(OWNER, TEAM_BOT)).toBe(true);
    expect(await allowed(ADMIN, TEAM_BOT)).toBe(true);
    const teammate = await ask(NAMED, TEAM_BOT);
    expect(teammate).toMatchObject({
      allowed: false,
      refusal: "shared_audience",
    });
  });

  test("people admits the approved list and group members, and refuses someone added later", async () => {
    await approve(TEAM_BOT, {
      audience: "people",
      outsideInput: false,
      members: [
        { kind: "user", value: NAMED },
        { kind: "group", value: `${suite}-platform` },
      ],
    });
    expect(await allowed(NAMED, TEAM_BOT)).toBe(true);
    expect(await allowed(NEWHIRE, TEAM_BOT)).toBe(true);
    // 主人之后把 STRANGER 加进发布名单：批准是快照，要管理员再批准一次。
    await runAsTenant(OWNER, () =>
      database.insert(teamBotAudience).values({
        agentId: TEAM_BOT,
        tenantId: "team",
        kind: "user",
        value: STRANGER,
      }),
    );
    expect(await allowed(STRANGER, TEAM_BOT)).toBe(false);
  });

  test("team admits any signed-in person who reaches the Bot", async () => {
    await approve(TEAM_BOT, {
      audience: "team",
      outsideInput: false,
      members: [],
    });
    expect(await allowed(STRANGER, TEAM_BOT)).toBe(true);
    expect(await allowed(NAMED, TEAM_BOT)).toBe(true);
  });

  test("outside input needs an approval that allows it, even for the owner", async () => {
    await approve(BOT, { audience: "team", outsideInput: false, members: [] });
    expect(await allowed(OWNER, BOT, { outside: true })).toBe(false);
    expect(await allowed(OWNER, BOT)).toBe(true);
    await approve(BOT, { audience: "team", outsideInput: true, members: [] });
    expect(await allowed(OWNER, BOT, { outside: true })).toBe(true);
  });

  test("a Bot nobody owns is refused, and nothing is filed for it", async () => {
    const answer = await ask(ADMIN, ORPHAN);
    expect(answer).toMatchObject({
      allowed: false,
      refusal: "shared_no_owner",
    });
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseRequests)
          .where(eq(sharedUseRequests.agentId, ORPHAN)),
      ),
    ).toEqual([]);
  });

  test("an approval somebody writes in their own name for another person's Bot is never read", async () => {
    // 行安全允许任何人在自己名下写一行；闸门只在员工真正的主人名下读。
    await runAsTenant(STRANGER, () =>
      database.insert(sharedUseApprovals).values({
        agentId: TEAM_BOT,
        serverId: APP,
        audience: "team",
        outsideInput: true,
        approvedBy: STRANGER,
      }),
    );
    expect(await allowed(STRANGER, TEAM_BOT)).toBe(false);
    expect(await allowed(OWNER, TEAM_BOT)).toBe(false);
  });

  test("the person-facing question gives the gate's answer without filing anything", async () => {
    expect(
      await runAsTenant(NAMED, () =>
        admitsPerson({ botId: TEAM_BOT, serverId: APP, actorId: NAMED }),
      ),
    ).toBe(false);
    await approve(TEAM_BOT, {
      audience: "people",
      outsideInput: false,
      members: [{ kind: "user", value: NAMED }],
    });
    expect(
      await runAsTenant(NAMED, () =>
        admitsPerson({ botId: TEAM_BOT, serverId: APP, actorId: NAMED }),
      ),
    ).toBe(true);
    expect(
      await runAsTenant(STRANGER, () =>
        admitsPerson({ botId: TEAM_BOT, serverId: APP, actorId: STRANGER }),
      ),
    ).toBe(false);
    expect(await pendingFor(TEAM_BOT)).toEqual([]);
  });
});

describe("where approvals are written", () => {
  test("only in the Bot owner's frame: not an administrator's own, and never for a Bot nobody owns", async () => {
    const approval: SharedUseApproval = {
      audience: "team",
      outsideInput: false,
      members: [],
    };
    await expect(
      runAsTenant(ADMIN, () =>
        store.setApproval({ botId: BOT, serverId: APP, by: ADMIN, approval }),
      ),
    ).rejects.toBeInstanceOf(SharedUseFrameError);
    await expect(
      runAsTenant(ADMIN, () =>
        store.setApproval({
          botId: ORPHAN,
          serverId: APP,
          by: ADMIN,
          approval,
        }),
      ),
    ).rejects.toBeInstanceOf(SharedUseFrameError);
    await approve(BOT, approval);
    const [row] = await asPlatform(() =>
      database
        .select({ tenantId: sharedUseApprovals.tenantId })
        .from(sharedUseApprovals)
        .where(eq(sharedUseApprovals.agentId, BOT)),
    );
    expect(row?.tenantId).toBe(OWNER);
  });

  test("repeated people and groups store one exact membership", async () => {
    await approve(TEAM_BOT, {
      audience: "people",
      outsideInput: false,
      members: [
        { kind: "user", value: NAMED },
        { kind: "user", value: NAMED },
        { kind: "group", value: `${suite}-platform` },
        { kind: "group", value: NAMED },
      ],
    });
    const approval = await runAsTenant(OWNER, () =>
      store.approvalFor(TEAM_BOT, APP),
    );
    expect(approval?.members).toHaveLength(3);
    expect(await allowed(NAMED, TEAM_BOT)).toBe(true);
    expect(await allowed(STRANGER, TEAM_BOT)).toBe(false);
  });

  test("an approval written through a duplicate row is the one the gate reads by the answering row", async () => {
    expect(await runAsTenant(OWNER, () => store.appIdOf(DUPLICATE))).toBe(APP);
    await approve(
      BOT,
      { audience: "owner", outsideInput: false, members: [] },
      DUPLICATE,
    );
    expect(await allowed(OWNER, BOT)).toBe(true);
  });

  test("ending a Shared app's mode ends every approval for it, in every owner's name", async () => {
    await approve(BOT, { audience: "team", outsideInput: false, members: [] });
    const plugins = createPluginStore({
      database,
      auditStore: audit,
      credentials: { readSecret: async () => null } as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    });
    // 经账号模式切换的同一个写入口，在 platform 帧里（等同持有能力的管理员）；再切回 Shared。
    await asPlatform(() =>
      plugins.setAccountModeColumns(APP, "personal", null),
    );
    await asPlatform(() =>
      plugins.setAccountModeColumns(
        APP,
        "shared",
        `openbot-deployment:${suite}:R`,
      ),
    );
    await asPlatform(() =>
      database
        .update(mcpServers)
        .set({
          sharedConnectedAt: new Date(),
          sharedConnectedBy: ADMIN,
          sharedVerified: true,
        })
        .where(eq(mcpServers.id, APP)),
    );
    expect(
      await asPlatform(() =>
        database
          .select()
          .from(sharedUseApprovals)
          .where(eq(sharedUseApprovals.agentId, BOT)),
      ),
    ).toEqual([]);
    expect(await allowed(OWNER, BOT)).toBe(false);
  });
});

describe("requests and decisions", () => {
  test("the server proposes the Bot's exposure: a people-published Team Bot asks for its list", async () => {
    const filed = await runAsTenant(OWNER, async () =>
      store.fileRequest({
        botId: TEAM_BOT,
        serverId: APP,
        reason: "publish",
        requestedBy: OWNER,
        proposed: (await import("../src/plugins/shared-use")).exposureOf(
          await store.botFacts(TEAM_BOT),
        ),
      }),
    );
    expect(filed.created).toBe(true);
    const [pending] = await pendingFor(TEAM_BOT);
    expect(pending?.proposed).toEqual({
      audience: "people",
      outsideInput: false,
      members: [
        { kind: "user", value: NAMED },
        { kind: "group", value: `${suite}-platform` },
      ],
    });
    expect(pending?.ownerUserId).toBe(OWNER);
  });

  test("approving writes the proposed approval, members included, and a second decision is refused", async () => {
    await ask(OWNER, TEAM_BOT);
    const [pending] = await pendingFor(TEAM_BOT);
    expect(pending).toBeDefined();
    const decided = await runAsTenant(OWNER, () =>
      store.decide({
        id: pending?.id ?? "",
        by: ADMIN,
        decision: "approve",
      }),
    );
    expect(decided.status).toBe("approved");
    expect(decided.current?.audience).toBe("people");
    expect(await allowed(NAMED, TEAM_BOT)).toBe(true);
    expect(await allowed(NEWHIRE, TEAM_BOT)).toBe(true);
    await expect(
      runAsTenant(OWNER, () =>
        store.decide({
          id: pending?.id ?? "",
          by: ADMIN,
          decision: "decline",
        }),
      ),
    ).rejects.toBeInstanceOf(SharedUseRequestDecidedError);
  });

  test("a decision cannot be made from another person's frame", async () => {
    await ask(OWNER, BOT);
    const [pending] = await pendingFor(BOT);
    // 别人的帧里看不到这条申请，读起来和已经处理过一样。
    await expect(
      runAsTenant(STRANGER, () =>
        store.decide({
          id: pending?.id ?? "",
          by: STRANGER,
          decision: "approve",
        }),
      ),
    ).rejects.toBeInstanceOf(SharedUseRequestDecidedError);
    expect(await pendingFor(BOT)).toHaveLength(1);
  });

  test("the inbox, read as platform, lists every owner's pending requests with what they hold now", async () => {
    await ask(OWNER, BOT);
    await approve(TEAM_BOT, {
      audience: "owner",
      outsideInput: false,
      members: [],
    });
    await ask(OWNER, TEAM_BOT, { outside: true });
    const listed = await asPlatform(() => store.listRequests());
    const mine = listed.filter((row) => bots.includes(row.botId));
    expect(mine.map((row) => row.botId).sort()).toEqual([BOT, TEAM_BOT].sort());
    expect(mine.find((row) => row.botId === TEAM_BOT)?.current).toEqual({
      audience: "owner",
      outsideInput: false,
      members: [],
    });
    expect(mine.find((row) => row.botId === BOT)?.current).toBeNull();
  });

  test("a responsibility's sources are read, and one this frame cannot see is outside input", async () => {
    await runAsTenant(OWNER, () =>
      database.insert(responsibilities).values({
        id: id("mailgoal"),
        ownerUserId: OWNER,
        agentId: BOT,
        title: "x",
        instruction: "x",
        channelId: id("ch"),
        threadId: id("th"),
        successCriteria: "x",
        subscriptions: [{ source: "email", eventType: "*" }] as never,
      }),
    );
    expect(
      await runAsTenant(OWNER, () => store.sourcesOf(id("mailgoal"))),
    ).toEqual(["email"]);
    expect(
      await runAsTenant(STRANGER, () => store.sourcesOf(id("mailgoal"))),
    ).toEqual(["unknown"]);
    // 员工订阅了邮件，它的开放范围就是外部输入。
    expect(
      (await runAsTenant(OWNER, () => store.botFacts(BOT))).sources,
    ).toContain("email");
  });
});

describe("a call through the plugin store", () => {
  function plugins() {
    const reached: string[] = [];
    const plugin = createPluginStore({
      database,
      auditStore: audit,
      credentials: { readSecret: async () => null } as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      broker: {
        isConnected: async () => true,
      } as unknown as ComposioBroker,
      callVendor: async (connection) => {
        reached.push(connection.actorId ?? "");
        return { text: "ok", isError: false };
      },
      sharedUse: gate,
      responsibilitySources: store.sourcesOf,
    });
    return { plugin, reached };
  }

  beforeAll(async () => {
    await asPlatform(() =>
      database
        .insert(mcpTools)
        .values({
          serverId: APP,
          tenantId: "team",
          name: "GITHUB_LIST_ISSUES",
          description: "Lists issues.",
          effect: "read",
          version: "20260903_00",
        })
        .onConflictDoNothing(),
    );
  });

  const callAs = (
    plugin: ReturnType<typeof plugins>["plugin"],
    actor: string,
    botId: string,
    initiator: AuditInitiator = { kind: "person" },
  ) =>
    runAsTenant(actor, () =>
      plugin.callTool({
        ref: `${APP}/GITHUB_LIST_ISSUES`,
        args: {},
        botId,
        actorId: actor,
        initiator,
      }),
    );

  test("a teammate in the approved audience reaches the team account; one outside it does not", async () => {
    await approve(TEAM_BOT, {
      audience: "people",
      outsideInput: false,
      members: [{ kind: "user", value: NAMED }],
    });
    const { plugin, reached } = plugins();
    expect((await callAs(plugin, NAMED, TEAM_BOT)).isError).toBe(false);
    const refused = callAs(plugin, NEWHIRE, TEAM_BOT);
    await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
    await expect(refused).rejects.toThrow(/使用范围不包括/);
    expect(reached).toEqual([`openbot-deployment:${suite}:R`]);
    const trail = await asPlatform(() =>
      database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_rejected"),
            eq(auditEvents.targetId, `${APP}/GITHUB_LIST_ISSUES`),
          ),
        ),
    );
    expect(
      trail.map((entry) => (entry.payload as { refusal?: string }).refusal),
    ).toContain("shared_audience");
  });

  test("a responsibility subscribed to email is refused unless outside input was approved", async () => {
    await approve(BOT, { audience: "owner", outsideInput: false, members: [] });
    await runAsTenant(OWNER, () =>
      database
        .insert(responsibilities)
        .values({
          id: id("watch"),
          ownerUserId: OWNER,
          agentId: BOT,
          title: "x",
          instruction: "x",
          channelId: id("ch"),
          threadId: id("th"),
          successCriteria: "x",
          subscriptions: [{ source: "email", eventType: "*" }] as never,
        })
        .onConflictDoNothing(),
    );
    const { plugin, reached } = plugins();
    const duty: AuditInitiator = { kind: "responsibility", id: id("watch") };
    await expect(callAs(plugin, OWNER, BOT, duty)).rejects.toThrow(/外部输入/);
    // 被拒的调用在主人帧里，替主人申请了一条包含外部输入的批准。
    const [pending] = await pendingFor(BOT);
    expect(pending?.proposed.outsideInput).toBe(true);
    await approve(BOT, { audience: "owner", outsideInput: true, members: [] });
    expect((await callAs(plugin, OWNER, BOT, duty)).isError).toBe(false);
    // 团队账号：vendor 处是部署的团队身份，不是任何人自己的账号。
    expect(reached).toEqual([`openbot-deployment:${suite}:R`]);
  });
});

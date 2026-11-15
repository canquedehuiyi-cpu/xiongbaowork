import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppRegistry } from "../../runner/src/apps";
import { createDiscoverActions } from "../../runner/src/discover-actions";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  externalEmployeesAmong,
  externalHirerOf,
} from "../src/agents/acp/external";
import { createExternalAgentRoutes } from "../src/agents/acp/routes";
import { createAcpTurnStore } from "../src/agents/acp/turns";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import { createWakeUpStore, WakeUpRefusedError } from "../src/agents/wake-up";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  createGroupConversations,
  createGroupStore,
} from "../src/channels/group";
import { createGroupRoster } from "../src/channels/group-roster";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  acpTurns,
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  proactiveSettings,
  registeredDevices,
  responsibilities,
  routines,
  subscriptions,
  users,
} from "../src/db/schema";
import { DeviceOfflineError } from "../src/devices/channel";
import { createDeviceRoutes } from "../src/devices/routes";
import { createDeviceStore } from "../src/devices/store";
import { createProactiveStore } from "../src/proactive/store";
import { createQuotaService } from "../src/quota/limits";
import { createResponsibilityRoutes } from "../src/responsibilities/routes";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineStore } from "../src/routines/store";
import { runAsTenant } from "../src/tenant/context";
import { provisionTenant } from "../src/tenant/provisioning";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 招聘外部员工（Task 8）：`POST /api/agents/external` 只在本人配对的电脑上招、工作文件夹和本机智能体
 * 必须是这台电脑最近一次心跳报过的、custom 要确认它可能从不请求许可、名额满 402；招来的员工私有、只归
 * 招聘人、占一个员工名额。`PATCH` 只有招聘人能改；通用员工接口复制不了它、别人读不到它。发现接口问在线
 * 的电脑。例行任务、职责、主动工作、定时唤醒都不给它（409）。群组里只有招聘人能把它拉进、移出。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profiles, threadIdentity);
const deviceStore = createDeviceStore(database);
const quota = createQuotaService(database);
const auditStore: AuditStore = { async insert() {} };
const prefix = `acp-hire-${randomUUID()}`;
const tenants: string[] = [];
const groupIds: string[] = [];

afterEach(async () => {
  await runAsTenant("platform", async () => {
    for (const id of groupIds.splice(0)) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, id));
      await database.delete(channels).where(eq(channels.id, id));
    }
    for (const tenant of tenants.splice(0)) {
      const owned = await database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.tenantId, tenant));
      for (const { id } of owned) {
        await database
          .delete(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.channelId, id));
        await database.delete(channels).where(eq(channels.id, id));
      }
      await database
        .delete(responsibilities)
        .where(eq(responsibilities.ownerUserId, tenant));
      await database
        .delete(proactiveSettings)
        .where(eq(proactiveSettings.ownerUserId, tenant));
      await database.delete(routines).where(eq(routines.ownerUserId, tenant));
      const ownedAgents = await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, tenant));
      const ids = ownedAgents.map((row) => row.id);
      if (ids.length) {
        await database
          .delete(agentProfiles)
          .where(inArray(agentProfiles.agentId, ids));
        await database.delete(agents).where(inArray(agents.id, ids));
      }
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, tenant));
      await database
        .delete(subscriptions)
        .where(eq(subscriptions.tenantId, tenant));
      await database.delete(users).where(eq(users.id, tenant));
    }
  });
});
afterAll(async () => {
  await database.$client.close();
});

/** A signed-up person: a Free subscription and their 分身, as sign-up leaves them. */
async function person(): Promise<AgentActor & { email: string }> {
  const id = `${prefix}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  tenants.push(id);
  await runAsTenant(id, () =>
    database.insert(users).values({ id, email, name: "Hire Test" }),
  );
  await provisionTenant(database, { id, email });
  return { id, role: "user", email };
}

const folder = () => `fld_${randomBytes(16).toString("base64url")}`;
const app = () => `app_${randomBytes(16).toString("base64url")}`;

/** A computer in the person's tenant, as pairing and its last heartbeat left it. */
async function computer(
  owner: AgentActor,
  options: {
    pairedBy?: string | null;
    roots?: { ref: string; name: string }[];
    apps?: { ref: string; name: string }[];
  } = {},
) {
  const deviceId = `${prefix}-laptop-${randomUUID()}`;
  const roots = options.roots ?? [{ ref: folder(), name: "web" }];
  const apps = options.apps ?? [];
  await runAsTenant(owner.id, () =>
    database.insert(registeredDevices).values({
      tenantId: owner.id,
      deviceId,
      name: "我的电脑",
      tokenHash: randomUUID(),
      lastSeenAt: new Date(),
      roots,
      apps,
      pairedByUserId:
        options.pairedBy === undefined ? owner.id : options.pairedBy,
    }),
  );
  return { deviceId, workdirRef: roots[0]?.ref ?? folder(), apps };
}

const acpTurnStore = createAcpTurnStore(database);
/** What the cancel route handed the relay. */
const cancelsAsked: { tenantId: string; turnId: string }[] = [];

/** Everything a person reaches here, behind a guard that signs them in. */
function server(
  actor: AgentActor,
  discovery?: Parameters<typeof createDeviceRoutes>[4],
) {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: actor.role,
    });
    await runAsTenant(actor.id, next);
  };
  const routes = new Hono();
  routes.route(
    "/agents/external",
    createExternalAgentRoutes({
      database,
      profiles,
      devices: deviceStore,
      requireUser: guard,
      quota,
      auditStore,
      turns: acpTurnStore,
      cancelTurn: async (tenantId, turnId) => {
        cancelsAsked.push({ tenantId, turnId });
        return "cancelled";
      },
    }),
  );
  routes.route(
    "/agents",
    createAgentRoutes(profiles, guard, false, auditStore, new Set<string>()),
  );
  routes.route(
    "/devices",
    createDeviceRoutes(deviceStore, guard, undefined, undefined, discovery),
  );
  routes.route(
    "/routines",
    createRoutineRoutes(createRoutineStore(database), guard),
  );
  routes.route(
    "/responsibilities",
    createResponsibilityRoutes(
      createResponsibilityStore(database, {
        resolveTarget: async () => ({ threadId: randomUUID() }),
      }),
      { ingest: async () => undefined } as never,
      guard,
    ),
  );
  return routes;
}

function call(
  actor: AgentActor,
  method: string,
  path: string,
  body?: unknown,
  discovery?: Parameters<typeof createDeviceRoutes>[4],
) {
  return server(actor, discovery).request(
    new Request(`http://hire.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
  );
}

const RULES = {
  editInside: "direct",
  touchOutside: "ask",
  runCommand: "dangerous",
  network: "ask",
  push: "ask",
};

type Hired = {
  agent: {
    id: string;
    name: string;
    visibility: string;
    ownerUserId: string;
    type: string;
    external: Record<string, unknown>;
  };
  warnings?: string[];
};

async function hire(
  actor: AgentActor,
  device: { deviceId: string; workdirRef: string },
  extra: Record<string, unknown> = {},
) {
  return call(actor, "POST", "/agents/external", {
    deviceId: device.deviceId,
    harness: "codex",
    name: "小码",
    workdirRef: device.workdirRef,
    rules: RULES,
    ...extra,
  });
}

async function hired(
  actor: AgentActor,
  device: { deviceId: string; workdirRef: string },
  extra: Record<string, unknown> = {},
) {
  const response = await hire(actor, device, extra);
  expect(response.status).toBe(201);
  return (await response.json()) as Hired;
}

async function stored(agentId: string) {
  const [row] = await runAsTenant("platform", () =>
    database
      .select({
        type: agents.type,
        tenantId: agents.tenantId,
        configuration: agents.configuration,
        visibility: agentProfiles.visibility,
        ownerUserId: agentProfiles.ownerUserId,
        department: agentProfiles.department,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(eq(agents.id, agentId)),
  );
  return row;
}

describe("hiring an external employee", () => {
  test("created employee is private, owned by the hirer and counted against wakers", async () => {
    const owner = await person();
    const device = await computer(owner);
    const before = (await quota.usageFor(owner.id)).wakers;
    const { agent, warnings } = await hired(owner, device, {
      department: "研发",
      // Asked for public: an external employee is private whatever is sent.
      rules: { ...RULES, push: "direct" },
    });
    expect(warnings).toBeUndefined();
    expect(agent).toMatchObject({
      name: "小码",
      visibility: "private",
      ownerUserId: owner.id,
      type: "device_acp",
      external: {
        deviceId: device.deviceId,
        harness: "codex",
        workdirRef: device.workdirRef,
        rules: { ...RULES, push: "direct" },
      },
    });
    const row = await stored(agent.id);
    expect(row).toMatchObject({
      type: "device_acp",
      tenantId: owner.id,
      visibility: "private",
      ownerUserId: owner.id,
      department: "研发",
    });
    expect(row?.configuration).toEqual({
      deviceId: device.deviceId,
      harness: "codex",
      workdirRef: device.workdirRef,
      permissions: { ...RULES, push: "direct" },
    });
    expect((await quota.usageFor(owner.id)).wakers).toBe(before + 1);
    // Missing rules take the defaults.
    const second = await hired(owner, device, {
      name: "小克",
      harness: "claude-code",
      rules: { runCommand: "ask" },
    });
    expect(second.agent.external.rules).toEqual({
      ...RULES,
      runCommand: "ask",
    });
  });

  test("only on a computer you paired yourself", async () => {
    const owner = await person();
    const someone = await person();
    const theirs = await computer(owner, { pairedBy: someone.id });
    const refused = await hire(owner, theirs);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "只能在你自己配对的电脑上招。",
    );
    // A computer nobody has claimed yet is refused with how to claim it.
    const unclaimed = await computer(owner, { pairedBy: null });
    const notYet = await hire(owner, unclaimed);
    expect(notYet.status).toBe(403);
    expect(((await notYet.json()) as { error: string }).error).toContain(
      "认领",
    );
    // Another tenant's computer is not this person's at all.
    const elsewhere = await computer(someone);
    expect((await hire(owner, elsewhere)).status).toBe(404);
  });

  test("a working folder or own agent the computer did not report is refused", async () => {
    const owner = await person();
    const own = { ref: app(), name: "我的智能体" };
    const device = await computer(owner, { apps: [own] });
    const folderRefused = await hire(owner, {
      deviceId: device.deviceId,
      workdirRef: folder(),
    });
    expect(folderRefused.status).toBe(400);
    const appRefused = await hire(owner, device, {
      harness: "custom",
      appRef: app(),
      acknowledgeNoPermission: true,
    });
    expect(appRefused.status).toBe(400);
    const unknownRule = await hire(owner, device, {
      rules: { ...RULES, editInside: "dangerous" },
    });
    expect(unknownRule.status).toBe(400);
  });

  test("a custom agent is hired only once the hirer accepts it may never ask", async () => {
    const owner = await person();
    const own = { ref: app(), name: "我的智能体" };
    const device = await computer(owner, { apps: [own] });
    const unconfirmed = await hire(owner, device, {
      harness: "custom",
      appRef: own.ref,
    });
    expect(unconfirmed.status).toBe(400);
    const { agent } = await hired(owner, device, {
      harness: "custom",
      appRef: own.ref,
      acknowledgeNoPermission: true,
    });
    expect(agent.external).toMatchObject({
      harness: "custom",
      appRef: own.ref,
      noPermissionAcknowledged: true,
    });
    expect((await stored(agent.id))?.configuration).toMatchObject({
      appRef: own.ref,
      noPermissionAcknowledged: true,
    });
  });

  test("a Hermes hire says Hermes cannot guarantee asking", async () => {
    const owner = await person();
    const device = await computer(owner);
    const { warnings } = await hired(owner, device, { harness: "hermes" });
    expect(warnings).toEqual(["hermes_cannot_guarantee_ask"]);
  });

  test("a full plan refuses the hire with 402", async () => {
    const owner = await person();
    const device = await computer(owner);
    const { limits } = await quota.planFor(owner.id);
    const seats = typeof limits.wakers === "number" ? limits.wakers : 0;
    expect(seats).toBeGreaterThan(0);
    for (let i = 0; i < seats; i++)
      await hired(owner, device, { name: `员工${i}` });
    const refused = await hire(owner, device, { name: "多一个" });
    expect(refused.status).toBe(402);
  });
});

describe("an external employee's configuration", () => {
  test("only the hirer changes it, and never which agent it is", async () => {
    const owner = await person();
    const someone = await person();
    const device = await computer(owner, {
      roots: [
        { ref: folder(), name: "web" },
        { ref: folder(), name: "api" },
      ],
    });
    const { agent } = await hired(owner, device);
    const other = (
      await runAsTenant(owner.id, () =>
        database
          .select({ roots: registeredDevices.roots })
          .from(registeredDevices)
          .where(eq(registeredDevices.deviceId, device.deviceId)),
      )
    )[0]?.roots[1]?.ref as string;

    const changed = await call(owner, "PATCH", `/agents/external/${agent.id}`, {
      name: "小码二号",
      workdirRef: other,
      rules: { push: "direct" },
      department: "平台",
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as Hired).agent).toMatchObject({
      name: "小码二号",
      external: { workdirRef: other, rules: { ...RULES, push: "direct" } },
    });
    expect(await stored(agent.id)).toMatchObject({
      department: "平台",
      visibility: "private",
      configuration: {
        harness: "codex",
        workdirRef: other,
        permissions: { ...RULES, push: "direct" },
      },
    });

    expect(
      (
        await call(owner, "PATCH", `/agents/external/${agent.id}`, {
          harness: "claude-code",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, "PATCH", `/agents/external/${agent.id}`, {
          workdirRef: folder(),
        })
      ).status,
    ).toBe(400);
    // Somebody else: refused, and the generic routes do not even show it to them.
    expect(
      (
        await call(someone, "PATCH", `/agents/external/${agent.id}`, {
          rules: { push: "direct" },
        })
      ).status,
    ).toBe(403);
    expect((await call(someone, "GET", `/agents/${agent.id}`)).status).toBe(
      404,
    );
    expect(
      (
        await call(someone, "PATCH", `/agents/${agent.id}`, {
          name: "抢走",
          title: "x",
          roleDescription: "x",
          visibility: "private",
        })
      ).status,
    ).toBe(404);
    // An id that is no external employee is not found.
    expect(
      (
        await call(owner, "PATCH", `/agents/external/${prefix}-nobody`, {
          name: "x",
        })
      ).status,
    ).toBe(404);
  });

  test("the generic agent routes neither copy it nor make another, nor open it up", async () => {
    const owner = await person();
    const device = await computer(owner);
    const { agent } = await hired(owner, device);
    const copy = await call(owner, "POST", `/agents/${agent.id}/duplicate`);
    expect(copy.status).toBe(409);
    const made = await call(owner, "POST", "/agents", {
      name: "冒充",
      title: "外部员工",
      roleDescription: "x",
      visibility: "private",
      type: "device_acp",
      external: { deviceId: device.deviceId, harness: "codex" },
    });
    expect(made.status).toBe(409);
    const opened = await call(owner, "PATCH", `/agents/${agent.id}`, {
      name: "小码",
      title: "外部员工 · Codex",
      roleDescription: "x",
      visibility: "public",
    });
    expect(opened.status).toBe(409);
    expect((await stored(agent.id))?.visibility).toBe("private");
    // The only external employee its hirer has is the one hired.
    const mine = await runAsTenant(owner.id, () =>
      database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.type, "device_acp")),
    );
    expect(mine.map((row) => row.id)).toEqual([agent.id]);
    expect(await externalHirerOf(database, agent.id)).toBe(owner.id);
  });
});

describe("stopping an external employee's turn", () => {
  test("only its hirer can, and only a turn of that employee; anyone else gets 404", async () => {
    const owner = await person();
    const someone = await person();
    const device = await computer(owner);
    const { agent } = await hired(owner, device);
    const { agent: second } = await hired(owner, device, { name: "小测" });
    const turnId = `turn-${randomUUID()}`;
    await acpTurnStore.enqueue({
      tenantId: owner.id,
      agentId: agent.id,
      threadId: `thread-${randomUUID()}`,
      deviceId: device.deviceId,
      turnId,
      prompt: { content: [] },
    });
    try {
      cancelsAsked.length = 0;
      const path = `/agents/external/${agent.id}/turns/${turnId}/cancel`;
      // Someone else: as if neither existed.
      expect((await call(someone, "POST", path)).status).toBe(404);
      // The hirer, through another of their employees: not that one's turn.
      expect(
        (
          await call(
            owner,
            "POST",
            `/agents/external/${second.id}/turns/${turnId}/cancel`,
          )
        ).status,
      ).toBe(404);
      expect(cancelsAsked).toEqual([]);
      const done = await call(owner, "POST", path);
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ turnId, status: "cancelled" });
      expect(cancelsAsked).toEqual([{ tenantId: owner.id, turnId }]);
    } finally {
      await runAsTenant(owner.id, () =>
        database.delete(acpTurns).where(eq(acpTurns.turnId, turnId)),
      );
    }
  });
});

describe("finding what a computer has", () => {
  test("asks the connected computer and keeps only what it knows", async () => {
    const owner = await person();
    const device = await computer(owner);
    const asked: unknown[] = [];
    const online = await call(
      owner,
      "GET",
      `/devices/${device.deviceId}/agents`,
      undefined,
      {
        isReachable: () => true,
        discover: async (target) => {
          asked.push(target);
          return [
            {
              harness: "codex",
              version: "0.40.0",
              installed: true,
              acpReady: true,
              signedIn: true,
              account: "someone@example.com",
            },
            {
              harness: "hermes",
              version: null,
              installed: false,
              acpReady: false,
              signedIn: null,
            },
            { harness: "rm -rf", installed: true },
          ];
        },
      },
    );
    expect(online.status).toBe(200);
    expect(await online.json()).toEqual({
      online: true,
      agents: [
        {
          harness: "codex",
          version: "0.40.0",
          installed: true,
          acpReady: true,
          signedIn: true,
        },
        {
          harness: "hermes",
          version: null,
          installed: false,
          acpReady: false,
          signedIn: null,
        },
      ],
    });
    expect(asked).toEqual([{ tenantId: owner.id, deviceId: device.deviceId }]);

    // What a real runner sends: its `agents.discover` action's output, `{agents: [...]}`.
    const scratch = mkdtempSync(join(tmpdir(), "acp-hire-discover-"));
    try {
      const answered = await createDiscoverActions({
        dataDir: scratch,
        registry: createAppRegistry({ dataDir: scratch }),
        agents: {
          which: (command) =>
            command === "codex" || command === "npx"
              ? `/usr/local/bin/${command}`
              : undefined,
          run: async (command, args) => ({
            code: 0,
            stdout:
              [command, ...args].join(" ") === "/usr/local/bin/codex --version"
                ? "codex-cli 0.169.0\n"
                : "Logged in using ChatGPT\n",
            stderr: "",
            timedOut: false,
          }),
        },
      })("agents.discover", {});
      if (!answered.ok) throw new Error("the runner's discovery failed");
      const real = await call(
        owner,
        "GET",
        `/devices/${device.deviceId}/agents`,
        undefined,
        { isReachable: () => true, discover: async () => answered.output },
      );
      expect(real.status).toBe(200);
      expect(await real.json()).toEqual({
        online: true,
        agents: [
          {
            harness: "codex",
            version: "0.169.0",
            installed: true,
            acpReady: true,
            signedIn: true,
          },
          {
            harness: "claude-code",
            version: null,
            installed: false,
            acpReady: true,
            signedIn: null,
          },
          {
            harness: "hermes",
            version: null,
            installed: false,
            acpReady: false,
            signedIn: null,
          },
        ],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    const offline = await call(
      owner,
      "GET",
      `/devices/${device.deviceId}/agents`,
      undefined,
      {
        isReachable: () => false,
        discover: async () => {
          throw new Error("not asked");
        },
      },
    );
    expect(await offline.json()).toEqual({ online: false, agents: [] });
    const dropped = await call(
      owner,
      "GET",
      `/devices/${device.deviceId}/agents`,
      undefined,
      {
        isReachable: () => true,
        discover: async () => {
          throw new DeviceOfflineError(device.deviceId);
        },
      },
    );
    expect(await dropped.json()).toEqual({ online: false, agents: [] });
    const someone = await person();
    expect(
      (await call(someone, "GET", `/devices/${device.deviceId}/agents`)).status,
    ).toBe(404);
  });
});

describe("work nobody asks for", () => {
  test("routines cannot be created for a device_acp employee", async () => {
    const owner = await person();
    const device = await computer(owner);
    const { agent } = await hired(owner, device);
    const response = await call(owner, "POST", "/routines", {
      agentId: agent.id,
      instruction: "每天早上检查一遍构建",
      cron: "0 9 * * *",
    });
    expect(response.status).toBe(409);
    const rows = await runAsTenant(owner.id, () =>
      database
        .select({ id: routines.id })
        .from(routines)
        .where(eq(routines.agentId, agent.id)),
    );
    expect(rows).toHaveLength(0);
  });

  test("duties, proactive work and wake-ups cannot be set up for a device_acp employee", async () => {
    const owner = await person();
    const device = await computer(owner);
    const { agent } = await hired(owner, device);
    const duty = await call(owner, "POST", "/responsibilities", {
      agentId: agent.id,
      channelId: "channel",
      title: "守着构建",
      instruction: "构建坏了就修",
      successCriteria: "构建是绿的",
    });
    expect(duty.status).toBe(409);
    await expect(
      runAsTenant(owner.id, () =>
        createProactiveStore(database).create(
          owner.id,
          { agentId: agent.id, channelId: "channel", subject: "构建" },
          randomUUID(),
        ),
      ),
    ).rejects.toThrow("外部员工现在只接有人发起的活");
    await expect(
      runAsTenant(owner.id, () =>
        createWakeUpStore(database).schedule({
          ownerUserId: owner.id,
          agentId: agent.id,
          reason: "过一小时再看",
          dueAt: new Date(Date.now() + 60 * 60_000),
        }),
      ),
    ).rejects.toBeInstanceOf(WakeUpRefusedError);
  });
});

describe("an external employee in a group", () => {
  function groups() {
    const store = createGroupStore(database, () => threadIdentity.mint());
    const actorFor = async (id: string): Promise<AgentActor> => ({
      id,
      role: "user",
    });
    return createGroupConversations({
      store,
      queue: createWorkQueue(database),
      owner: `${prefix}-replica`,
      roster: createGroupRoster({
        actorFor,
        channel: (actor, channelId) => channelStore.get(actor, channelId),
        profile: (actor, agentId) => profiles.get(actor, agentId),
        externalEmployees: (agentIds) =>
          externalEmployeesAmong(database, agentIds),
        members: (channelId) => store.members(channelId),
      }),
      runTurn: async () => ({ replyText: "" }),
      caps: { maxDepth: 0, maxPerRun: 0 },
      mayAddress: async () => false,
      auditStore,
      createChannel: (ownerUserId, agentIds, options) =>
        channelStore.create(
          { id: ownerUserId, role: "user" },
          agentIds,
          options,
        ),
      canUseBot: async (ownerUserId, agentId) =>
        Boolean(await profiles.get(await actorFor(ownerUserId), agentId)),
      externalHirer: (agentId) => externalHirerOf(database, agentId),
    });
  }

  async function bot(owner: AgentActor, name: string) {
    const profile = await runAsTenant(owner.id, () =>
      profiles.create(owner, {
        name,
        title: "Tester",
        roleDescription: "Answer briefly.",
        visibility: "private",
      }),
    );
    return profile.id;
  }

  test("only the hirer can add or remove an external employee in a group, even if someone else created the group", async () => {
    const creator = await person();
    const hirer = await person();
    const conversations = groups();
    const device = await computer(hirer);
    const { agent } = await hired(hirer, device);
    const writer = await bot(creator, "Writer");
    const reviewer = await bot(creator, "Reviewer");
    const channel = await runAsTenant(creator.id, () =>
      conversations.create(creator.id, { agentIds: [writer, reviewer] }),
    );
    groupIds.push(channel.id);
    await runAsTenant(creator.id, () =>
      conversations.addMember(creator.id, channel.id, { email: hirer.email }),
    );
    const roster = (reader: AgentActor) =>
      runAsTenant(reader.id, () => conversations.list(reader.id, channel.id));

    // The group's creator cannot bring someone else's external employee in.
    await expect(
      runAsTenant(creator.id, () =>
        conversations.addBots(creator.id, channel.id, [agent.id]),
      ),
    ).rejects.toThrow("外部员工只能由招它的人拉进群组");
    // Its hirer can, without having started the group.
    await runAsTenant(hirer.id, () =>
      conversations.addBots(hirer.id, channel.id, [agent.id]),
    );
    // Every member sees it, with its name, and can @ it; its profile stays the hirer's.
    for (const reader of [creator, hirer]) {
      const { bots } = (await roster(reader)) as {
        bots: { id: string; name: string }[];
      };
      expect(bots.map((b) => b.id)).toContain(agent.id);
      expect(bots.find((b) => b.id === agent.id)?.name).toBe("小码");
    }
    expect(
      await runAsTenant(creator.id, () => profiles.get(creator, agent.id)),
    ).toBeNull();
    // The hirer cannot change the creator's own Bots.
    await expect(
      runAsTenant(hirer.id, () =>
        conversations.removeBots(hirer.id, channel.id, [writer]),
      ),
    ).rejects.toThrow("只有发起这个群组的人才能调整群里的员工");
    // The creator cannot take it out; its hirer can.
    await expect(
      runAsTenant(creator.id, () =>
        conversations.removeBots(creator.id, channel.id, [agent.id]),
      ),
    ).rejects.toThrow("外部员工只能由招它的人移出群组");
    await runAsTenant(hirer.id, () =>
      conversations.removeBots(hirer.id, channel.id, [agent.id]),
    );
    const { bots } = (await roster(creator)) as { bots: { id: string }[] };
    expect(bots.map((b) => b.id)).not.toContain(agent.id);
    expect(
      await runAsTenant(creator.id, () => conversations.store.bots(channel.id)),
    ).not.toContain(agent.id);
  });

  test("it leaves the group's roster when its hirer leaves the group", async () => {
    const creator = await person();
    const hirer = await person();
    const conversations = groups();
    const device = await computer(hirer);
    const { agent } = await hired(hirer, device);
    const writer = await bot(creator, "Writer");
    const reviewer = await bot(creator, "Reviewer");
    const channel = await runAsTenant(creator.id, () =>
      conversations.create(creator.id, { agentIds: [writer, reviewer] }),
    );
    groupIds.push(channel.id);
    await runAsTenant(creator.id, () =>
      conversations.addMember(creator.id, channel.id, { email: hirer.email }),
    );
    await runAsTenant(hirer.id, () =>
      conversations.addBots(hirer.id, channel.id, [agent.id]),
    );
    await runAsTenant(hirer.id, () =>
      conversations.removeMember(hirer.id, channel.id, hirer.id),
    );
    const { bots } = (await runAsTenant(creator.id, () =>
      conversations.list(creator.id, channel.id),
    )) as { bots: { id: string }[] };
    expect(bots.map((b) => b.id)).not.toContain(agent.id);
    // Unlinked, not just hidden: no orphan link the creator cannot remove and the floor still counts.
    expect(
      await runAsTenant(creator.id, () => conversations.store.bots(channel.id)),
    ).toEqual(expect.not.arrayContaining([agent.id]));
    expect(
      await runAsTenant(creator.id, () => conversations.store.bots(channel.id)),
    ).toEqual(expect.arrayContaining([writer, reviewer]));
  });

  test("its link goes when the group's creator takes its hirer out", async () => {
    const creator = await person();
    const hirer = await person();
    const conversations = groups();
    const device = await computer(hirer);
    const { agent } = await hired(hirer, device);
    const writer = await bot(creator, "Writer");
    const reviewer = await bot(creator, "Reviewer");
    const channel = await runAsTenant(creator.id, () =>
      conversations.create(creator.id, { agentIds: [writer, reviewer] }),
    );
    groupIds.push(channel.id);
    await runAsTenant(creator.id, () =>
      conversations.addMember(creator.id, channel.id, { email: hirer.email }),
    );
    await runAsTenant(hirer.id, () =>
      conversations.addBots(hirer.id, channel.id, [agent.id]),
    );
    await runAsTenant(creator.id, () =>
      conversations.removeMember(creator.id, channel.id, hirer.id),
    );
    const left = await runAsTenant(creator.id, () =>
      conversations.store.bots(channel.id),
    );
    expect(left).not.toContain(agent.id);
    expect(left).toEqual(expect.arrayContaining([writer, reviewer]));
  });
});

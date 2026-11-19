import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import { computerKeyText } from "../src/computer/computer-key";
import type { ComputerProvider } from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { capabilitySettings, networkPolicies, users } from "../src/db/schema";
import { asPlatform } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * `/api/admin/enterprise` 照 `createApp` 装起来的样子（真实的企业管控、数据库和审计），由一个会话里还写着
 * admin、角色仓库里已经不是管理员的人来调用。
 *
 * 这里写的 `capability_settings`、`enterprise_settings`、`network_policies` 都没有行安全，路由本身只做
 * `requireAdmin`：会话说是管理员，就能改能力开关（单个和批量）、部署设置、网络策略，也能终止任何人的电脑。
 *
 * 每一条看三种人：降权的会话答 403「你的管理员身份没能确认，没有改变任何东西。」，库里什么都没变，电脑也
 * 没被停；持有能力的管理员照常成功；成员照旧得到路由原来的答复。`/me` 是任何人读自己能用什么，照常回答。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `dae-${suite}-${name}`;
const ADMIN = id("admin");
/** 会话里还是管理员、角色仓库里已经不是的人。 */
const DEMOTED = id("demoted");
const MEMBER = id("member");
const people = [ADMIN, DEMOTED, MEMBER];
/** 只有 MEMBER 在这个组里：组的开关和网络策略只影响这个套件自己的人。 */
const GROUP = `dae-group-${suite}`;
const STALE = "你的管理员身份没能确认，没有改变任何东西。";
const MEMBER_REFUSAL = { error: "Only an admin can do this." };

/** 被停掉的每一台电脑。 */
const stopped: string[] = [];
const provider = {
  name: "fake",
  isolation: "per-person",
  locate: async () => "http://unused",
  status: async (seat: { botId: string }) => ({
    botId: seat.botId,
    state: "ready",
  }),
  stop: async (target: { key: Parameters<typeof computerKeyText>[0] }) => {
    stopped.push(computerKeyText(target.key));
    return { wasRunning: true };
  },
  reset: async () => ({ cleared: false }),
  list: async () => [],
} as unknown as ComputerProvider;

let controls: EnterpriseControls;
let skillSharingBefore: boolean;

/** `createApp` 的第 1 到 13 个位置：配置、会话、角色仓库、轨迹读取，第 13 个是审计 store。 */
const args = Array.from({ length: 13 }) as never[];
args[0] = loadConfig(testEnvironment()) as never;
args[1] = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    // 会话自己带着角色，和组织身份源给出的会话一样：DEMOTED 的会话说 admin。
    getSession: async ({ headers }: { headers: Headers }) => {
      const actor = headers.get("x-actor");
      if (!actor) return null;
      return {
        user: {
          id: actor,
          email: `${actor}@dae.test`,
          role: actor === MEMBER ? "user" : "admin",
        },
      };
    },
  },
} as never;
// 角色仓库说的才是现在：只有 ADMIN 还是管理员。
args[2] = {
  rolesForUser: async (person: string) => [person === ADMIN ? "admin" : "user"],
} as never;
args[3] = createAuditReader(database) as never;
args[12] = auditStore as never;
const app = (createApp as (...given: never[]) => ReturnType<typeof createApp>)(
  ...args,
);

const request = (actor: string, method: string, path: string, body?: unknown) =>
  app.request(`http://openbot.test/api/admin/enterprise${path}`, {
    method,
    headers: { "content-type": "application/json", "x-actor": actor },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const answer = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

/** 部署的技能共享设置。部署的设置不属于任何人，所以按 platform 读。 */
const skillSharing = () =>
  asPlatform(async () => (await controls.store.settings()).skillSharing);

/** 这个套件的组留下的开关和网络策略，加上部署的技能共享设置。 */
const state = async () => ({
  capabilities: await asPlatform(() =>
    database
      .select({
        capability: capabilitySettings.capability,
        allowed: capabilitySettings.allowed,
      })
      .from(capabilitySettings)
      .where(eq(capabilitySettings.scopeId, GROUP)),
  ),
  network: await asPlatform(() =>
    database
      .select({ mode: networkPolicies.mode })
      .from(networkPolicies)
      .where(eq(networkPolicies.scopeId, GROUP)),
  ),
  skillSharing: await skillSharing(),
});

beforeAll(async () => {
  await asPlatform(() =>
    database.insert(users).values(
      people.map((person) => ({
        id: person,
        email: `${person}@dae.test`,
        groups: person === MEMBER ? [GROUP] : [],
      })),
    ),
  );
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    provider,
    env: {},
  });
  skillSharingBefore = await skillSharing();
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(capabilitySettings)
      .where(eq(capabilitySettings.scopeId, GROUP));
    await database
      .delete(networkPolicies)
      .where(eq(networkPolicies.scopeId, GROUP));
  });
  if ((await skillSharing()) !== skillSharingBefore)
    await asPlatform(() =>
      controls.store.setSetting(
        "skillSharing",
        skillSharingBefore,
        "dae-cleanup",
      ),
    );
  await controls.stop();
  await asPlatform(() =>
    database.delete(users).where(inArray(users.id, people)),
  );
  await database.$client.end({ timeout: 5 });
});

type Call = { name: string; method: string; path: string; body?: unknown };

/** 写路径，每一条带着一个持有能力的管理员会成功的请求。 */
const writes: Call[] = [
  {
    name: "a capability switch",
    method: "PUT",
    path: "/capabilities",
    body: {
      capability: "cloudBrowser",
      scopeKind: "group",
      scopeId: GROUP,
      allowed: true,
    },
  },
  {
    name: "several capability switches saved together",
    method: "POST",
    path: "/capabilities/batch",
    body: {
      changes: [
        {
          capability: "cloudNetwork",
          scopeKind: "group",
          scopeId: GROUP,
          allowed: true,
        },
      ],
    },
  },
  {
    name: "a deployment setting",
    method: "PUT",
    path: "/settings/skillSharing",
    // 值在发送时才定：取当前值的反面，见下面的 `send`。
  },
  {
    name: "a network policy",
    method: "PUT",
    path: "/network",
    body: {
      scopeKind: "group",
      scopeId: GROUP,
      mode: "allowlist_only",
      rules: [],
    },
  },
  {
    name: "removing a network policy",
    method: "DELETE",
    path: `/network/group?group=${GROUP}`,
  },
  {
    name: "terminating somebody's computers",
    method: "POST",
    path: `/people/${MEMBER}/terminate-computers`,
  },
  {
    name: "terminating inactive computers",
    method: "POST",
    path: "/computers/terminate-inactive",
  },
];

/** 设置的值每次取当前值的反面，这样修前降权会话的写入一定看得出来。 */
const send = async (actor: string, call: Call) =>
  request(
    actor,
    call.method,
    call.path,
    call.path === "/settings/skillSharing"
      ? { value: !(await skillSharing()) }
      : call.body,
  );

describe("a session that still says admin after the role was withdrawn", () => {
  test.each(writes)("is refused $name, and nothing changes", async (call) => {
    if (call.name === "removing a network policy") {
      // Something there to remove, put there by an administrator holding the capability.
      const saved = await request(ADMIN, "PUT", "/network", {
        scopeKind: "group",
        scopeId: GROUP,
        mode: "allowlist_only",
        rules: [],
      });
      expect(saved.status).toBe(200);
    }
    const before = await state();
    stopped.length = 0;

    expect(await answer(await send(DEMOTED, call))).toEqual({
      status: 403,
      body: { error: STALE },
    });
    expect(await state()).toEqual(before);
    expect(stopped).toEqual([]);
  });

  test("is refused the deployment's settings", async () => {
    expect(await answer(await request(DEMOTED, "GET", ""))).toEqual({
      status: 403,
      body: { error: STALE },
    });
  });

  test("still reads what it may use itself", async () => {
    const response = await request(DEMOTED, "GET", "/me");

    expect(response.status).toBe(200);
  });
});

describe("a member", () => {
  test.each(writes)(
    "still gets the route's own answer to $name",
    async (call) => {
      const before = await state();
      stopped.length = 0;

      expect(await answer(await send(MEMBER, call))).toEqual({
        status: 403,
        body: MEMBER_REFUSAL,
      });
      expect(await state()).toEqual(before);
      expect(stopped).toEqual([]);
    },
  );
});

describe("an administrator holding the capability", () => {
  test("still switches a capability on for a group", async () => {
    const response = await request(ADMIN, "PUT", "/capabilities", {
      capability: "cloudBrowser",
      scopeKind: "group",
      scopeId: GROUP,
      allowed: true,
    });

    expect(response.status).toBe(200);
    expect((await state()).capabilities).toContainEqual({
      capability: "cloudBrowser",
      allowed: true,
    });
  });

  test("still saves several switches together", async () => {
    const response = await request(ADMIN, "POST", "/capabilities/batch", {
      changes: [
        {
          capability: "cloudNetwork",
          scopeKind: "group",
          scopeId: GROUP,
          allowed: true,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect((await state()).capabilities).toContainEqual({
      capability: "cloudNetwork",
      allowed: true,
    });
  });

  test("still changes a deployment setting", async () => {
    const before = await skillSharing();

    const response = await request(ADMIN, "PUT", "/settings/skillSharing", {
      value: !before,
    });

    expect(response.status).toBe(200);
    expect(await skillSharing()).toBe(!before);
  });

  test("still saves and removes a network policy", async () => {
    const saved = await request(ADMIN, "PUT", "/network", {
      scopeKind: "group",
      scopeId: GROUP,
      mode: "allowlist_only",
      rules: [],
    });
    expect(saved.status).toBe(200);
    expect((await state()).network).toEqual([{ mode: "allowlist_only" }]);

    const removed = await request(
      ADMIN,
      "DELETE",
      `/network/group?group=${GROUP}`,
    );
    expect(removed.status).toBe(200);
    expect((await state()).network).toEqual([]);
  });

  test("still terminates somebody's computers", async () => {
    stopped.length = 0;

    const response = await request(
      ADMIN,
      "POST",
      `/people/${MEMBER}/terminate-computers`,
    );

    expect(response.status).toBe(200);
    expect(stopped).toEqual([`person:${MEMBER}`]);
  });

  test("still reads the deployment's settings", async () => {
    const response = await request(ADMIN, "GET", "");

    expect(response.status).toBe(200);
  });
});

import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { RegisteredIdentityProvider } from "../src/auth/identity-provider-store";
import type { ComponentStore } from "../src/components/store";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { loadConfig } from "../src/config";
import type { PeopleStore, Person } from "../src/people/store";
import type { PackageStatusReader } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

/**
 * `createApp` 里 `plugins/*` 以外、原来只看会话角色的管理员路径，由一个会话里还写着 admin、角色仓库里
 * 已经不是管理员的人来调用。
 *
 * 会话自己带着角色时守卫直接用它，管理员能力却是 `adminCapability` 每次请求重新读角色之后才给的。两者
 * 不一致时，只看会话角色的路径会让这个人继续做管理员的事，而下面这些路径数据库都不拦：
 *
 * - 改别人的角色（`POST /api/admin/people/:userId/role`）：走专用的角色写入器，没有行安全。降权的会话能把
 *   自己写回管理员，此后它就是真管理员了。
 * - 删除身份提供方：`sso_providers` 没有行安全。
 * - 改整个部署的电脑边界（`PUT /api/computers/policy`）：以 `platform` 写。
 * - 停止、重置、更新任何人的电脑（`POST /api/computers/fleet`）：没有数据库这一层。
 * - 组件的数据函数、授予、发布、草稿：组件那几张表没有行安全。
 * - 自动学习的设置（接了 Intelligence 时）：`learning_settings` 没有行安全。
 * - 读全员名单、身份提供方、配置包、管理员状态、电脑清单和边界、学习设置：只读，但读到的是全部署的东西。
 *
 * 每一条都看三种人：降权的会话答 403「你的管理员身份没能确认，没有改变任何东西。」，store 和电脑都没被
 * 碰到；持有能力的管理员照常成功；成员照旧得到路由原来的答复。
 */
const ADMIN = "dw-admin";
/** 会话里还是管理员、角色仓库里已经不是的人。 */
const DEMOTED = "dw-demoted";
const MEMBER = "dw-member";
const STALE = "你的管理员身份没能确认，没有改变任何东西。";
const MEMBER_REFUSAL = { error: "Only an admin can do this." };

function person(id: string, role: "admin" | "user"): Person {
  return {
    id,
    email: `${id}@example.test`,
    name: id,
    image: null,
    role,
    providers: ["google"],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
  };
}

const PROVIDER: RegisteredIdentityProvider = {
  providerId: "acme-okta",
  issuer: "https://acme.okta.example",
  domain: "acme.example",
  kind: "oidc",
} as never;

/** 每次装一套新的：store、电脑和边界都是新的，每条测试只看自己留下的调用。 */
function build() {
  /** 写路径被碰到的每一件事，按先后。 */
  const touched: string[] = [];

  const people: PeopleStore = {
    list: async () => {
      touched.push("people.list");
      return {
        people: [person(ADMIN, "admin"), person(DEMOTED, "user")],
        nextCursor: null,
      };
    },
    find: async (userId) =>
      [ADMIN, DEMOTED, MEMBER].includes(userId)
        ? person(userId, userId === ADMIN ? "admin" : "user")
        : undefined,
    setRole: async (userId, role) => {
      touched.push(`setRole:${userId}:${role}`);
    },
    revoke: async (userId) => {
      touched.push(`revoke:${userId}`);
    },
    retireOwned: async (userId) => {
      touched.push(`retireOwned:${userId}`);
    },
    restore: async (userId) => {
      touched.push(`restore:${userId}`);
    },
    isRevoked: async () => false,
  };

  const identityProviders = {
    list: async () => {
      touched.push("providers.list");
      return [PROVIDER];
    },
    remove: async (providerId: string) => {
      touched.push(`providers.remove:${providerId}`);
      return true;
    },
  };

  const gateway = {
    stopTarget: async () => {
      touched.push("fleet.stop");
      return { wasRunning: true };
    },
    resetTarget: async () => {
      touched.push("fleet.reset");
      return { cleared: true };
    },
    updateTarget: async () => {
      touched.push("fleet.update");
      return { updated: true };
    },
    computers: async () => {
      touched.push("fleet.list");
      return { isolation: "per-person", computers: [] };
    },
  } as unknown as ComputerGateway;
  const policy = createPolicyStore(DEFAULT_ACTION_POLICY);

  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      touched.push(`components.${name}:${args.slice(0, 2).join(":")}`);
    };
  const components = {
    grantFunction: record("grantFunction"),
    revokeFunction: record("revokeFunction"),
    grant: record("grant"),
    revoke: record("revoke"),
    publish: record("publish"),
    unpublish: record("unpublish"),
    saveDraft: record("saveDraft"),
  } as unknown as ComponentStore;

  const packageStatus: PackageStatusReader = {
    active: async () => {
      touched.push("package.active");
      return null;
    },
  } as never;

  const settings = { enabled: false, defaultTarget: null, agents: {} };
  const learning = {
    store: {
      read: async () => {
        touched.push("learning.read");
        return settings;
      },
      write: async (next: unknown) => {
        touched.push("learning.write");
        return next;
      },
    },
  };

  /*
   * `createApp` 的位置参数：1 配置、2 会话、3 角色仓库、6 配置包、8 电脑网关、9 边界、14 组件 store、
   * 18 成员 store、19 身份提供方、37 自动学习，其余不给。
   */
  const args = Array.from({ length: 37 }) as never[];
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
            email: `${actor}@example.test`,
            role: actor === MEMBER ? "user" : "admin",
          },
        };
      },
    },
  } as never;
  // 角色仓库说的才是现在：只有 ADMIN 还是管理员。
  args[2] = {
    rolesForUser: async (id: string) => [id === ADMIN ? "admin" : "user"],
  } as never;
  args[5] = packageStatus as never;
  args[7] = gateway as never;
  args[8] = policy as never;
  args[13] = components as never;
  args[17] = people as never;
  args[18] = identityProviders as never;
  args[36] = learning as never;
  const app = (
    createApp as (...given: never[]) => ReturnType<typeof createApp>
  )(...args);

  const request = (
    actor: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(`http://openbot.test${path}`, {
      method,
      headers: { "content-type": "application/json", "x-actor": actor },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return { request, touched, policy };
}

type Call = { method: string; path: string; body?: unknown };

/** 每一条路径，带着一个持有能力的管理员会成功的请求，以及成功时会碰到的东西。 */
const writes: { name: string; call: Call; reaches: string[] }[] = [
  {
    name: "a role change",
    call: {
      method: "POST",
      path: `/api/admin/people/${DEMOTED}/role`,
      body: { role: "admin" },
    },
    reaches: [`setRole:${DEMOTED}:admin`],
  },
  {
    name: "removing an identity provider",
    call: {
      method: "DELETE",
      path: `/api/admin/identity-providers/${PROVIDER.providerId}`,
    },
    reaches: [`providers.remove:${PROVIDER.providerId}`],
  },
  {
    name: "stopping a computer on the fleet",
    call: {
      method: "POST",
      path: "/api/computers/fleet",
      body: { action: "stop", computer: `person:${ADMIN}` },
    },
    reaches: ["fleet.stop"],
  },
  {
    name: "resetting a computer on the fleet",
    call: {
      method: "POST",
      path: "/api/computers/fleet",
      body: { action: "reset", computer: `person:${ADMIN}` },
    },
    reaches: ["fleet.reset"],
  },
  {
    name: "updating a computer on the fleet",
    call: {
      method: "POST",
      path: "/api/computers/fleet",
      body: { action: "update", computer: `person:${ADMIN}` },
    },
    reaches: ["fleet.update"],
  },
  {
    name: "choosing who approves learned skills",
    call: {
      method: "PUT",
      path: "/api/admin/learning/personal-review",
      body: { personalReview: "people" },
    },
    reaches: ["learning.read", "learning.write"],
  },
  {
    name: "giving a component a data function",
    call: {
      method: "POST",
      path: "/api/components/showActivityReport/functions",
      body: { function: "botActivity" },
    },
    reaches: ["components.grantFunction:showActivityReport:botActivity"],
  },
  {
    name: "taking a data function back",
    call: {
      method: "DELETE",
      path: "/api/components/showActivityReport/functions/botActivity",
    },
    reaches: ["components.revokeFunction:showActivityReport:botActivity"],
  },
  {
    name: "letting a Bot use a component",
    call: {
      method: "POST",
      path: "/api/components/showActivityReport/grants",
      body: { agentId: "some-bot" },
    },
    reaches: ["components.grant:showActivityReport:some-bot"],
  },
  {
    name: "holding a Bot back from a component",
    call: {
      method: "DELETE",
      path: "/api/components/showActivityReport/grants/some-bot",
    },
    reaches: ["components.revoke:showActivityReport:some-bot"],
  },
  {
    name: "publishing a component",
    call: {
      method: "POST",
      path: "/api/components/showActivityReport/publication",
      body: { published: true },
    },
    reaches: [`components.publish:showActivityReport:${ADMIN}@example.test`],
  },
  {
    name: "saving a component's draft",
    call: {
      method: "PUT",
      path: "/api/components/showActivityReport/draft",
      body: { description: "A new description." },
    },
    reaches: [`components.saveDraft:showActivityReport:A new description.`],
  },
];

/** 只读，但读到的是全部署的东西。 */
const reads: { name: string; path: string; reaches: string[] }[] = [
  {
    name: "the people list",
    path: "/api/admin/people",
    reaches: ["people.list"],
  },
  {
    name: "the identity providers",
    path: "/api/admin/identity-providers",
    reaches: ["providers.list"],
  },
  {
    name: "the tenant package",
    path: "/api/admin/package",
    reaches: ["package.active"],
  },
  { name: "the admin status", path: "/api/admin/status", reaches: [] },
  { name: "the fleet", path: "/api/computers/fleet", reaches: ["fleet.list"] },
  {
    name: "the fleet through a Bot's path",
    path: "/api/computers/some-bot/computers",
    reaches: ["fleet.list"],
  },
  { name: "the computer boundary", path: "/api/computers/policy", reaches: [] },
  {
    name: "the learning settings",
    path: "/api/admin/learning/settings",
    reaches: ["learning.read"],
  },
];

const send = (
  request: ReturnType<typeof build>["request"],
  actor: string,
  call: Call,
) => request(actor, call.method, call.path, call.body);

describe("an admin whose role was withdrawn, outside the plugin routes", () => {
  test.each(writes)(
    "is refused $name, and nothing is touched",
    async ({ call }) => {
      const { request, touched } = build();

      const response = await send(request, DEMOTED, call);

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 403,
        body: { error: STALE },
      });
      expect(touched).toEqual([]);
    },
  );

  test.each(reads)("is refused $name", async ({ path }) => {
    const { request, touched } = build();

    const response = await request(DEMOTED, "GET", path);

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { error: STALE },
    });
    expect(touched).toEqual([]);
  });

  // 最要紧的一条：降权的会话一次请求就能把自己写回管理员，之后就不再是会话和角色不一致的问题了。
  test("cannot write itself back as an administrator", async () => {
    const { request, touched } = build();

    const response = await request(
      DEMOTED,
      "POST",
      `/api/admin/people/${DEMOTED}/role`,
      { role: "admin" },
    );

    expect(response.status).toBe(403);
    expect(touched).toEqual([]);
  });

  test("cannot change the deployment's computer boundary", async () => {
    const { request, policy } = build();

    const response = await request(DEMOTED, "PUT", "/api/computers/policy", {
      mode: "enforce",
      deny: [],
      allow: [],
    });

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { error: STALE },
    });
    expect(policy.get()).toEqual(DEFAULT_ACTION_POLICY);
  });
});

describe("an administrator holding the capability", () => {
  test.each(writes)("still succeeds at $name", async ({ call, reaches }) => {
    const { request, touched } = build();

    const response = await send(request, ADMIN, call);

    expect(response.status).toBe(200);
    expect(touched).toEqual(reaches);
  });

  test.each(reads)("still reads $name", async ({ path, reaches }) => {
    const { request, touched } = build();

    const response = await request(ADMIN, "GET", path);

    expect(response.status).toBe(200);
    expect(touched).toEqual(reaches);
  });

  test("still changes the computer boundary", async () => {
    const { request, policy } = build();

    const response = await request(ADMIN, "PUT", "/api/computers/policy", {
      mode: "enforce",
      deny: [],
      allow: [],
    });

    expect(response.status).toBe(200);
    expect(policy.get()).toEqual({
      mode: "enforce",
      deny: [],
      allow: [],
      labels: {},
    });
  });
});

describe("a member", () => {
  test.each(writes)(
    "still gets the route's own answer to $name",
    async ({ call }) => {
      const { request, touched } = build();

      const response = await send(request, MEMBER, call);

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 403,
        body: MEMBER_REFUSAL,
      });
      expect(touched).toEqual([]);
    },
  );

  test.each(reads)(
    "still gets the route's own answer to $name",
    async ({ path }) => {
      const { request, touched } = build();

      const response = await request(MEMBER, "GET", path);

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 403,
        body: MEMBER_REFUSAL,
      });
      expect(touched).toEqual([]);
    },
  );

  test("still gets the route's own answer to the computer boundary", async () => {
    const { request, policy } = build();

    const response = await request(MEMBER, "PUT", "/api/computers/policy", {
      mode: "enforce",
      deny: [],
      allow: [],
    });

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: MEMBER_REFUSAL,
    });
    expect(policy.get()).toEqual(DEFAULT_ACTION_POLICY);
  });
});

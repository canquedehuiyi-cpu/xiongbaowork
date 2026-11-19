import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BrokerProvider } from "../src/plugins/access";
import type { ComposioBroker } from "../src/plugins/broker";
import { CATALOGUE } from "../src/plugins/catalogue";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

/**
 * `GET /api/plugins` 的页面响应里，上游前端读而 fork 之前不给的三样（上游 `plugins-page-provider.test.ts`
 * 按 fork 接口改写）：
 *
 * - `provider`：这个部署的连接应用由哪一家提供，是个名字。页面要按它写「浏览 Composio」这类文案，从一行
 *   应用上推不出来。没有接 broker 时答 composio，和上游一样。
 * - `authorizesPerAction`：broker 是不是逐个动作授权。fork 没有并入逐个动作授权的两条路由
 *   （`GET /servers/:id/grants`、`POST /servers/:id/authorize`），页面按它画出来的按钮背后没有东西，所以
 *   即使 broker 声明了授权流程（Arcade）也答 false。
 * - 目录条目的 `oneStep`：连接之前不用先填任何东西（不需要账号，或 OAuth 客户端由部署自己注册）。个人版的
 *   连接页只列这些。
 *
 * 密钥和从密钥推出来的东西都不随这些字段出去：插件页任何登录的人都能打开。
 */
const VENDOR_KEY = "vendor-key-sentinel-0123456789";

async function pageFor(composio?: {
  broker: unknown;
  provider?: BrokerProvider;
}) {
  const store = {
    listServers: async () => [],
    listSkills: async () => [],
    // The page response carries the team block too (P4-4b); these tests are about the broker
    // shape, so an empty team list is all the stub owes.
    personTeams: async () => [],
  } as unknown as PluginStore;
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "page-reader",
      email: "page-reader@example.test",
      role: "user",
    } as never);
    await next();
  };
  const app = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      async () => true,
      undefined,
      composio
        ? {
            broker: composio.broker as ComposioBroker,
            ...(composio.provider ? { provider: composio.provider } : {}),
          }
        : undefined,
    ),
  );
  const response = await app.request("/api/plugins");
  expect(response.status).toBe(200);
  return (await response.json()) as {
    provider: string;
    authorizesPerAction: boolean;
    composioConfigured: boolean;
    catalogue: { key: string; auth: string; oneStep: boolean }[];
  } & Record<string, unknown>;
}

describe("the Plugins page names the active provider", () => {
  test("an Arcade deployment serves arcade", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY },
      provider: "arcade",
    });
    expect(page.provider).toBe("arcade");
  });

  test("a Composio deployment serves composio", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY },
      provider: "composio",
    });
    expect(page.provider).toBe("composio");
    expect(page.composioConfigured).toBe(true);
  });

  test("a broker handed in with no provider named is Composio's", async () => {
    const page = await pageFor({ broker: { key: VENDOR_KEY } });
    expect(page.provider).toBe("composio");
  });

  test("a deployment with no broker still serves composio", async () => {
    const page = await pageFor(undefined);
    expect(page.provider).toBe("composio");
    expect(page.composioConfigured).toBe(false);
  });

  test("the name travels, the key and anything derived from it do not", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY, grantIsLocal: true },
      provider: "arcade",
    });
    expect(Object.keys(page).sort()).toEqual(
      [
        "authorizesPerAction",
        "botsMayCallBack",
        "catalogue",
        "composioConfigured",
        "provider",
        "redirectUri",
        "servers",
        "skills",
        // P4-4b 起页面响应带团队块；键集锁定随之演进，多一个都是错。
        "teams",
      ].sort(),
    );
    const body = JSON.stringify(page);
    expect(body).not.toContain(VENDOR_KEY);
    expect(body).not.toContain("grantIsLocal");
  });
});

describe("the Plugins page never offers per-action authorization", () => {
  test("a broker that declares an authorization flow still serves false, because the routes behind it are not here", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY, authorizations: { status: () => {} } },
      provider: "arcade",
    });
    expect(page.authorizesPerAction).toBe(false);
  });

  test("a Composio deployment serves false", async () => {
    const page = await pageFor({
      broker: { key: VENDOR_KEY },
      provider: "composio",
    });
    expect(page.authorizesPerAction).toBe(false);
  });

  test("a deployment with no broker serves false", async () => {
    const page = await pageFor(undefined);
    expect(page.authorizesPerAction).toBe(false);
  });
});

describe("a catalogue entry says whether connecting needs nothing typed first", () => {
  test("every entry carries the answer, and it is the rule over the entry's own auth", async () => {
    const page = await pageFor(undefined);
    const served = new Map(
      page.catalogue.map((entry) => [entry.key, entry.oneStep]),
    );
    const expected = new Map(
      CATALOGUE.map((entry) => [
        entry.key,
        entry.host !== null &&
          (entry.auth.kind === "none" ||
            entry.auth.kind === "builtin" ||
            (entry.auth.kind === "user-oauth" &&
              entry.auth.clientRegistration === "dynamic")),
      ]),
    );
    expect(served).toEqual(expected);
  });

  test("an app that needs an administrator's key first is not one step", async () => {
    const page = await pageFor(undefined);
    const keyed = page.catalogue.filter(
      (entry) => entry.auth === "deployment-bearer",
    );
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.map((entry) => entry.oneStep)).toEqual(keyed.map(() => false));
  });

  test("OpenBot's own built-in apps are one step", async () => {
    const page = await pageFor(undefined);
    const builtin = page.catalogue.filter((entry) => entry.auth === "builtin");
    expect(builtin.length).toBeGreaterThan(0);
    expect(builtin.map((entry) => entry.oneStep)).toEqual(
      builtin.map(() => true),
    );
  });
});

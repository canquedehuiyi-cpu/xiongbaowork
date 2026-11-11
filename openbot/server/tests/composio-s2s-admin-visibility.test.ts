import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { BrokerApp } from "../src/plugins/broker";
import type { PluginStore } from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

/**
 * 部署专属客户端（#950）的两处服务端补充，供前端直接渲染：
 * - 应用目录带出「在等客户端」的应用（awaitingClient），管理员不用手填应用名；
 * - 插件页每个服务器带上针对请求者的 canConnect，前端不必自己拿 adminConnectOnly 和角色拼。
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

/** `createApp`'s positions 4-14 and 16-29; see the note in plugin-routes.test.ts. */
const UP_TO_PLUGIN_STORE = Array.from({ length: 11 }, () => undefined) as [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
];
const UP_TO_BROKER = Array.from({ length: 14 }, () => undefined) as [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
];

const SHOPIFY: BrokerApp = {
  slug: "shopify",
  name: "Shopify",
  description: "Commerce.",
  logo: null,
  categories: [],
  actionCount: 1,
  connection: {
    kind: "unsupported",
    reason: "needs a client",
    awaitsClient: true,
  },
};
const SLACK: BrokerApp = {
  ...SHOPIFY,
  slug: "slack",
  name: "Slack",
  connection: { kind: "consent" },
};

function appFor(role: "admin" | "user", held: string[] = []) {
  const store = {
    serverUrls: async () => [],
    listSkills: async () => [],
    deploymentClientToolkits: async () => new Set(held),
    listServers: async () => [
      { id: "composio-shopify", title: "Shopify", adminConnectOnly: true },
      { id: "composio-slack", title: "Slack", adminConnectOnly: false },
    ],
  } as unknown as PluginStore;
  return createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    ...UP_TO_PLUGIN_STORE,
    store,
    ...UP_TO_BROKER,
    { broker: { listApps: async () => [SHOPIFY, SLACK] } } as never,
  );
}

const get = (app: ReturnType<typeof appFor>, path: string) =>
  app.request(`http://openbot.test/api/plugins${path}`);

describe("目录带出在等客户端的应用", () => {
  test("没保存客户端时，应用不在 apps 里，但出现在 awaitingClient 里", async () => {
    const body = await (await get(appFor("admin"), "/composio/apps")).json();
    expect(body.apps.map((entry: { slug: string }) => entry.slug)).toEqual([
      "slack",
    ]);
    expect(body.awaitingClient).toEqual([{ slug: "shopify", name: "Shopify" }]);
  });

  test("保存了客户端以后，它进 apps，不再在 awaitingClient 里", async () => {
    const body = await (
      await get(appFor("admin", ["shopify"]), "/composio/apps")
    ).json();
    expect(body.apps.map((entry: { slug: string }) => entry.slug)).toEqual([
      "shopify",
      "slack",
    ]);
    expect(body.awaitingClient).toEqual([]);
  });

  test("搜索词同样作用于 awaitingClient", async () => {
    const body = await (
      await get(appFor("admin"), "/composio/apps?q=slack")
    ).json();
    expect(body.awaitingClient).toEqual([]);
  });

  test("成员仍然读不到目录", async () => {
    expect((await get(appFor("user"), "/composio/apps")).status).toBe(403);
  });
});

describe("插件页给出针对请求者的 canConnect", () => {
  test("管理员可以连接所有应用", async () => {
    const body = await (await get(appFor("admin"), "")).json();
    expect(
      body.servers.map((server: { id: string; canConnect: boolean }) => [
        server.id,
        server.canConnect,
      ]),
    ).toEqual([
      ["composio-shopify", true],
      ["composio-slack", true],
    ]);
  });

  test("成员连不了只有管理员能连接的应用，其余照常", async () => {
    const body = await (await get(appFor("user"), "")).json();
    expect(
      body.servers.map((server: { id: string; canConnect: boolean }) => [
        server.id,
        server.canConnect,
      ]),
    ).toEqual([
      ["composio-shopify", false],
      ["composio-slack", true],
    ]);
  });
});

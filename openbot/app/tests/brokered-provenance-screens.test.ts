import { describe, expect, test } from "bun:test";
import { connectsPerPerson as capabilityConnectsPerPerson } from "@/components/resources/capability-tabs";
import { howItConnects } from "@/components/resources/plugins-tab";
import { installedCards } from "@/lib/plugins/market";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { connectsPerPerson as assembleConnectsPerPerson } from "@/routes/_authed/_app/assemble.$agentId";

/*
 * 选用 Arcade 时应用行的 `provenance` 是 "arcade"。插件页的卡片与详情、员工能力页、装配页原来只把
 * "composio" 当成 broker 应用，Arcade 应用就读成「管理员按地址添加的插件」、归进「自定义」，也不提示本人先
 * 连接自己的账号。四处现在和已连接的账号页一样，共用 `isBrokeredProvenance`。
 */
const server = (
  provenance: string,
  authScheme: string | null = "OAUTH2",
): PluginServer =>
  ({
    id: `${provenance}-Gmail`,
    title: "Gmail",
    vendor: provenance,
    url: `${provenance}://Gmail`,
    summary: "",
    docsUrl: "",
    provenance,
    authScheme,
    tools: [],
    withdrawn: [],
  }) as unknown as PluginServer;

const page = (servers: PluginServer[]): PluginsPage =>
  ({ catalogue: [], servers, skills: [] }) as unknown as PluginsPage;

const cardOf = (row: PluginServer) => {
  const [card] = installedCards(page([row]), undefined);
  if (!card) throw new Error("no card");
  return card;
};

describe("an Arcade app on the plugin, capability and assembly screens", () => {
  test("is a third-party app each person connects their own account to, as a Composio one is", () => {
    for (const provenance of ["composio", "arcade"]) {
      expect(cardOf(server(provenance))).toMatchObject({
        category: "composio",
        perPerson: true,
      });
      expect(cardOf(server(provenance, "NO_AUTH")).perPerson).toBe(false);
    }
    expect(cardOf(server("custom", null))).toMatchObject({
      category: "custom",
      perPerson: false,
    });
  });

  test("its details say it is connected through the broker, not added by address", () => {
    expect(howItConnects(cardOf(server("arcade")))).toBe(
      howItConnects(cardOf(server("composio"))),
    );
    expect(howItConnects(cardOf(server("arcade")))).toBe(
      "通过熊宝连接，每个人连接自己的账号。",
    );
    expect(howItConnects(cardOf(server("arcade", "NO_AUTH")))).toBe(
      "通过熊宝连接，不需要账号。",
    );
    expect(howItConnects(cardOf(server("custom", null)))).toBe(
      "管理员按地址添加的插件。",
    );
  });

  test("the capability tabs and the assembly page ask the person to connect their own account first", () => {
    for (const connectsPerPerson of [
      capabilityConnectsPerPerson,
      assembleConnectsPerPerson,
    ]) {
      const arcade = server("arcade");
      expect(connectsPerPerson(arcade, page([arcade]))).toBe(true);
      const open = server("arcade", "NO_AUTH");
      expect(connectsPerPerson(open, page([open]))).toBe(false);
      const composio = server("composio");
      expect(connectsPerPerson(composio, page([composio]))).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { brokeredAccountsListedOn } from "@/lib/plugins/listed";
import { isBrokeredProvenance } from "@/lib/plugins/brokered";
import type { PluginServer } from "@/lib/plugins/queries";
import { connectionKindFor } from "@/components/manage/plugin-page";

/*
 * 选用 Arcade 之后，新启用的应用行 `provenance` 是 "arcade"（服务端 `BROKERED_PROFILE`，X5）。前端判断「这是不是
 * broker 应用」时只认 "composio"，Arcade 应用就从「已连接的账号」列表里掉出去，详情页说「这个部署没有叫这个
 * 名字的连接器」，管理员详情页退回成部署令牌的配置。三处现在共用一个判断。
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
    provenance,
    authScheme,
  }) as PluginServer;

describe("which rows are a broker's apps", () => {
  test("Composio and Arcade are brokers; a reviewed entry or a server added by URL is not", () => {
    expect(isBrokeredProvenance("composio")).toBe(true);
    expect(isBrokeredProvenance("arcade")).toBe(true);
    expect(isBrokeredProvenance("first-party")).toBe(false);
    expect(isBrokeredProvenance("custom")).toBe(false);
    expect(isBrokeredProvenance(undefined)).toBe(false);
  });

  test("the connected-accounts page lists an Arcade app as it lists a Composio one", () => {
    const listed = brokeredAccountsListedOn([
      server("composio"),
      server("arcade"),
      server("arcade", "NO_AUTH"),
      server("custom", null),
    ]);
    expect(listed.map((row) => row.provenance)).toEqual(["composio", "arcade"]);
  });

  test("the admin page reads an Arcade app as brokered, not as a deployment token", () => {
    expect(connectionKindFor(server("arcade"), undefined)).toBe("brokered");
    expect(connectionKindFor(server("composio"), undefined)).toBe("brokered");
    expect(connectionKindFor(server("custom", null), undefined)).toBe(
      "deployment-bearer",
    );
  });
});

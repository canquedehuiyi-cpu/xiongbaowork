import { describe, expect, test } from "bun:test";
import { connectorName, readToolName } from "./tool-name";

/*
 * 每个连接应用提供商的应用都按应用本身叫，不带提供商的前缀（X5 合入 M5a 后补上 Arcade）。服务器键是
 * `<提供商>-<应用>`：Composio 是 `composio-gmail`，Arcade 是 `arcade-Gmail`（Arcade 的应用名区分大小写，
 * 见 server/src/plugins/access.ts 的 `BROKERED_PROFILE`）。哪个提供商替部署持有授权是管理员的事，不是
 * 提问人的事。
 */
describe("a brokered app is named as the app, whichever broker holds it", () => {
  test("an Arcade app reads as the app, with no broker prefix", () => {
    expect(connectorName("arcade-Gmail")).toBe("Gmail");
    expect(connectorName("arcade-Gmail")).toBe(connectorName("composio-gmail"));
    expect(connectorName("arcade-GoogleCalendar")).toBe("Google Calendar");
  });

  test("an Arcade tool call reads the same way as the same Composio one", () => {
    expect(readToolName("mcp__arcade-Gmail__GMAIL_SEND_EMAIL")).toEqual(
      readToolName("mcp__composio-gmail__GMAIL_SEND_EMAIL"),
    );
    expect(readToolName("mcp__arcade-Gmail__GMAIL_SEND_EMAIL").detail).toBe(
      "Gmail",
    );
  });

  test("a server whose name only starts with the word is not taken for a broker", () => {
    expect(connectorName("arcade-")).toBe("Arcade");
    expect(connectorName("arcadegames")).toBe("Arcadegames");
  });
});

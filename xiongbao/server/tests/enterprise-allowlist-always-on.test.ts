import { afterEach, describe, expect, test } from "bun:test";
import { decideFromSnapshot, enterpriseChecks } from "../src/admin/controls";
import { DEFAULT_ENTERPRISE_SETTINGS } from "../src/admin/settings-store";
import type { PolicyContext } from "../src/computer/policy";
import { setEdition } from "../src/edition";

/*
 * 应用白名单对常开应用的豁免（M5a 预留给 X4 的位置，上游 `isAlwaysOn`）。fork 按版本判断：只有个人版里
 * Routines 常开、关不掉，白名单不拦它；团队版里 Routines 是管理员逐个授予的能力，白名单照样管它。所以接的是
 * `alwaysOnHere`，不是只看名字的 `isAlwaysOn`。
 */
const snapshot = () => ({
  rows: [],
  admins: new Set<string>(),
  groupsByUser: new Map<string, string[]>(),
  settings: {
    ...DEFAULT_ENTERPRISE_SETTINGS,
    mcpAllowlist: { enabled: true, servers: ["jira"] },
  },
  network: [],
  mcpAppOfRow: new Map<string, string>(),
  loadedAt: new Date(),
});

const call = (server: string): PolicyContext => ({
  tool: { name: `${server}__list_routines` },
  bot: { id: "bot" },
  actor: { id: "person" },
  page: { url: "", host: "" },
  intent: "read_tool",
  key: "",
  element: { ref: "", role: "", name: "", type: "" },
  file: { path: "", name: "", extension: "" },
  command: "",
  mcp: { server, tool: "list_routines", effect: "read" },
  initiator: { kind: "person", id: "" },
});

const allowlistCheck = (server: string) =>
  [...enterpriseChecks(snapshot(), call(server))].find(
    (check) => check.control === "app_allowlist",
  );

afterEach(() => setEdition("team"));

describe("the app allowlist and the always-on app", () => {
  test("on the personal edition, Routines is built in and the list never holds it back", () => {
    setEdition("personal");
    expect(allowlistCheck("routines")).toMatchObject({
      builtIn: true,
      approved: false,
      refusal: null,
    });
    expect(decideFromSnapshot(snapshot(), call("routines"))).toBeNull();
    // 别的应用照样要在名单上。
    expect(decideFromSnapshot(snapshot(), call("notion"))?.matched).toBe(
      "mcp_allowlist",
    );
  });

  test("on the team edition, Routines is an app like any other and the list holds it back", () => {
    setEdition("team");
    expect(allowlistCheck("routines")).toMatchObject({ builtIn: false });
    expect(decideFromSnapshot(snapshot(), call("routines"))?.matched).toBe(
      "mcp_allowlist",
    );
  });
});

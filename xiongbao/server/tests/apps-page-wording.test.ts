import { afterEach, describe, expect, test } from "bun:test";
import {
  appsPageZh,
  askAdminToZh,
  itsAppPage,
  setEdition,
} from "../src/edition";
import { listTools } from "../src/plugins/composio";
import {
  adminConnectOnlySentence,
  deploymentClientMissingSentence,
} from "../src/plugins/deployment-clients";
import { callTool as callDriveTool } from "../src/plugins/google-drive-rest";

/**
 * The personal edition has no Plugins page (upstream #1277). A sentence the browser shows that
 * sends somebody there names Connections instead, and one that tells the one person to ask an
 * admin tells them to take the step themselves. The team edition reads exactly as before.
 */

afterEach(() => setEdition("team"));

const driveConnection = { url: "https://drive.example.test" } as never;

describe("where a sentence sends somebody to set an app up", () => {
  test("the team edition names Plugins, as before", async () => {
    setEdition("team");
    const drive = await callDriveTool(driveConnection, "no_such_tool", {});
    expect(JSON.stringify(drive)).toContain("on the Plugins page");
    await expect(listTools({ url: "https://not-composio" })).rejects.toThrow(
      "on the Plugins page",
    );
    expect(itsAppPage()).toBe("its Plugins page");
    expect(appsPageZh()).toBe("插件页");
    expect(askAdminToZh("在插件页移除它")).toBe("请管理员在插件页移除它");
  });

  test("the personal edition names Connections, and asks nobody for an admin", async () => {
    setEdition("personal");
    const drive = await callDriveTool(driveConnection, "no_such_tool", {});
    expect(JSON.stringify(drive)).toContain("on the Connections page");
    expect(JSON.stringify(drive)).not.toContain("Plugins");
    await expect(listTools({ url: "https://not-composio" })).rejects.toThrow(
      "on the Connections page",
    );
    expect(appsPageZh()).toBe("连接页");
    expect(askAdminToZh("在连接页移除它")).toBe("请在连接页移除它");
    expect(deploymentClientMissingSentence("shopify")).toContain("连接页");
    expect(deploymentClientMissingSentence("shopify")).not.toContain("插件页");
  });

  test("the sentence about an app only an admin connects stays about the admin in both", () => {
    // There is one person in the personal edition, and they are its admin: nobody else to refuse.
    setEdition("personal");
    expect(adminConnectOnlySentence("Shopify")).toContain("管理员");
  });
});

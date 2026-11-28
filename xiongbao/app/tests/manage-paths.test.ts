import { describe, expect, test } from "bun:test";
import {
  managePaths,
  personalAdminRedirect,
  personalAppsAddress,
} from "@/lib/manage-paths";

/** The address a link goes to: its route with the params put in. */
function href(link: {
  to: string;
  params?: Record<string, string>;
  hash?: unknown;
}): string {
  const path = Object.entries(link.params ?? {}).reduce(
    (path, [name, value]) => path.replace(`$${name}`, value),
    link.to,
  );
  return typeof link.hash === "string" ? `${path}#${link.hash}` : path;
}

/*
 * 团队版在「管理」下；个人版（M5b 起与上游一致）应用在「连接」，其余在设置的个人版分页。
 */
describe("where the pages a person manages live", () => {
  test("in the team edition, under Admin", () => {
    const paths = managePaths("team");
    expect(href(paths.plugins())).toBe("/admin/plugins");
    expect(href(paths.plugin("notion"))).toBe("/admin/plugins/notion");
    expect(href(paths.pluginTool("notion", "search"))).toBe(
      "/admin/plugins/notion/tools/search",
    );
    expect(href(paths.pluginBot("notion", "bot-1"))).toBe(
      "/admin/plugins/notion/bots/bot-1",
    );
    expect(href(paths.brokerDirectory("composio"))).toBe(
      "/admin/plugins/composio",
    );
    expect(href(paths.skills())).toBe("/admin/skills");
    expect(href(paths.newSkill())).toBe("/admin/skills/new");
    expect(href(paths.skill("triage"))).toBe("/admin/skills/triage");
    expect(href(paths.credentials())).toBe("/admin/credentials");
    expect(href(paths.newCredential())).toBe("/admin/credentials/new");
    // 电脑与设备的团队的电脑一节，与 movedHref("/admin/computers") 同一处（U51）。
    expect(href(paths.computers())).toBe("/settings/devices#team-computers");
    expect(href(paths.audit())).toBe("/admin/audit");
    expect(paths.pluginsLabel).toBe("插件");
  });

  test("Arcade's directory has its own page under Admin", () => {
    expect(href(managePaths("team").brokerDirectory("arcade"))).toBe(
      "/admin/plugins/arcade",
    );
  });

  test("in the personal edition, apps under Connections and the rest under Settings", () => {
    const paths = managePaths("personal");
    expect(href(paths.plugins())).toBe("/connections");
    expect(href(paths.plugin("notion"))).toBe("/connections/notion");
    expect(href(paths.pluginTool("notion", "search"))).toBe(
      "/connections/notion",
    );
    expect(href(paths.pluginBot("notion", "bot-1"))).toBe(
      "/connections/notion",
    );
    expect(href(paths.brokerDirectory("composio"))).toBe(
      "/connections/browse/composio",
    );
    expect(href(paths.brokerDirectory("arcade"))).toBe(
      "/connections/browse/arcade",
    );
    expect(href(paths.skills())).toBe("/settings/skills");
    expect(href(paths.newSkill())).toBe("/settings/skills/new");
    expect(href(paths.skill("triage"))).toBe("/settings/skills/triage");
    expect(href(paths.credentials())).toBe("/settings/credentials");
    expect(href(paths.newCredential())).toBe("/settings/credentials/new");
    // 电脑与设备的你的员工的浏览器一节，与 movedHref("/settings/computer") 同一处（U52）。
    expect(href(paths.computers())).toBe("/settings/devices#this-computer");
    expect(href(paths.audit())).toBe("/settings/activity");
  });

  test("an old Admin address goes to the same page in the personal edition", () => {
    expect(personalAdminRedirect("/admin/plugins")).toBe("/connections");
    expect(personalAdminRedirect("/admin/plugins/notion")).toBe(
      "/connections/notion",
    );
    expect(personalAdminRedirect("/admin/plugins/composio")).toBe(
      "/connections/browse/composio",
    );
    expect(personalAdminRedirect("/admin/credentials/new")).toBe(
      "/settings/credentials/new",
    );
    expect(personalAdminRedirect("/admin/audit")).toBe("/settings/activity");
    // 电脑页的旧地址归 SETTINGS_MOVES（U51），这张表不再写它。
    expect(personalAdminRedirect("/admin/computers")).toBe("/settings");
    expect(personalAdminRedirect("/admin/enterprise")).toBe("/settings");
    expect(personalAppsAddress("/arcade/")).toBe("/connections/browse/arcade");
  });
});

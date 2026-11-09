import { describe, expect, test } from "bun:test";
import { managePaths } from "@/lib/manage-paths";

/** The address a link goes to: its route with the params put in. */
function href(link: { to: string; params?: Record<string, string> }): string {
  return Object.entries(link.params ?? {}).reduce(
    (path, [name, value]) => path.replace(`$${name}`, value),
    link.to,
  );
}

/*
 * 熊宝中文版只有团队版：个人版（以及它的 /connections、/settings/* 管理页）和 Arcade 目录有意不收。
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
    expect(href(paths.computers())).toBe("/admin/computers");
    expect(href(paths.audit())).toBe("/admin/audit");
    expect(paths.pluginsLabel).toBe("插件");
  });
});

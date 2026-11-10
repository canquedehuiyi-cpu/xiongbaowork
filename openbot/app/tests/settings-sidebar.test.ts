import { describe, expect, test } from "bun:test";
import { SETTINGS_SIDEBAR_ITEMS } from "../src/components/settings/settings-sidebar";

/*
 * Upstream puts 浏览器 right after its 审批 entry. This deployment's settings have no 审批 page yet
 * (see the M4 note in settings-sidebar.tsx), so 浏览器 follows 已连接的账号, the entry before it here.
 */
describe("settings sidebar", () => {
  test("浏览器 links to /settings/browsers, right after 已连接的账号", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const browsers = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("浏览器")];

    expect(browsers?.linkOptions).toEqual({ to: "/settings/browsers" });
    expect(titles.indexOf("浏览器")).toBe(titles.indexOf("已连接的账号") + 1);
  });

  test("学习 links to /settings/learning, right after 浏览器", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const learning = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("学习")];

    expect(learning?.linkOptions).toEqual({ to: "/settings/learning" });
    expect(titles.indexOf("学习")).toBe(titles.indexOf("浏览器") + 1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  SETTINGS_SIDEBAR_ITEMS,
  settingsSidebarItems,
} from "../src/components/settings/settings-sidebar";

/*
 * M5b：设置侧栏照上游 main 的分区，加上熊宝的「套餐与用量」「我的设备」。「已连接的账号」搬到了主导航的「连接」，
 * 所以原来「浏览器紧跟在已连接的账号后面」的断言改成按新分区的顺序校验。
 */
describe("settings sidebar", () => {
  test("分区依次是 通用、通知、审批、套餐与用量、我的设备、浏览器、学习、部署设置、密码、本机、组件展示、关于", () => {
    expect(SETTINGS_SIDEBAR_ITEMS.map((item) => item.title)).toEqual([
      "通用",
      "通知",
      "审批",
      "套餐与用量",
      "我的设备",
      "浏览器",
      "学习",
      "部署设置",
      "密码",
      "本机",
      "组件展示",
      "关于",
    ]);
  });

  test("已连接的账号不在设置里，它在「连接」", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    expect(titles).not.toContain("已连接的账号");
    expect(
      SETTINGS_SIDEBAR_ITEMS.some(
        (item) => item.linkOptions.to === "/settings/connected-accounts",
      ),
    ).toBeFalse();
  });

  test("审批、套餐与用量、我的设备各自指向自己的设置页", () => {
    const at = (title: string) =>
      SETTINGS_SIDEBAR_ITEMS.find((item) => item.title === title)?.linkOptions;
    expect(at("审批")).toEqual({ to: "/settings/approvals" });
    expect(at("套餐与用量")).toEqual({ to: "/settings/plans" });
    expect(at("我的设备")).toEqual({ to: "/settings/devices" });
  });

  test("浏览器 links to /settings/browsers, right after 我的设备", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const browsers = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("浏览器")];

    expect(browsers?.linkOptions).toEqual({ to: "/settings/browsers" });
    expect(titles.indexOf("浏览器")).toBe(titles.indexOf("我的设备") + 1);
  });

  test("学习 links to /settings/learning, right after 浏览器", () => {
    const titles = SETTINGS_SIDEBAR_ITEMS.map((item) => item.title);
    const learning = SETTINGS_SIDEBAR_ITEMS[titles.indexOf("学习")];

    expect(learning?.linkOptions).toEqual({ to: "/settings/learning" });
    expect(titles.indexOf("学习")).toBe(titles.indexOf("浏览器") + 1);
  });

  test("个人版多出密钥、技能、电脑、活动，密码叫已保存的登录；团队版没有这些", () => {
    const personal = settingsSidebarItems("personal").map((item) => item.title);
    expect(personal).toContain("已保存的登录");
    expect(personal).not.toContain("密码");
    expect(personal.slice(-4)).toEqual(["密钥", "技能", "电脑", "活动"]);
    expect(
      settingsSidebarItems("personal").find((item) => item.title === "活动")
        ?.linkOptions,
    ).toEqual({ to: "/settings/activity" });
    expect(settingsSidebarItems("team")).toBe(SETTINGS_SIDEBAR_ITEMS);
  });
});

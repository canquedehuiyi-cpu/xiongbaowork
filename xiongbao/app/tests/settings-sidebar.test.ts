import { describe, expect, test } from "bun:test";
import {
  activeTopic,
  legacyTail,
  settingsTopics,
} from "../src/components/settings/settings-sidebar";
import type { SettingsAudience } from "../src/lib/settings/audience";

const base: SettingsAudience = {
  edition: "team",
  isAdmin: false,
  maySetUp: false,
  ready: true,
};
const admin: SettingsAudience = { ...base, isAdmin: true, maySetUp: true };
const member: SettingsAudience = base;
const memberLocal: SettingsAudience = { ...base, maySetUp: true };
const personal: SettingsAudience = {
  ...base,
  edition: "personal",
  isAdmin: true,
  maySetUp: true,
};

const titles = (a: SettingsAudience) => settingsTopics(a).map((t) => t.title);

describe("设置侧栏的七个话题", () => {
  test("团队版管理员依次是 账户与外观、员工与模型、审批与安全、连接与技能、电脑与设备、主动与通知、团队管理", () => {
    expect(titles(admin)).toEqual([
      "账户与外观",
      "员工与模型",
      "审批与安全",
      "连接与技能",
      "电脑与设备",
      "主动与通知",
      "团队管理",
    ]);
  });

  test("成员和个人版没有团队管理", () => {
    expect(titles(member)).not.toContain("团队管理");
    expect(titles(personal)).not.toContain("团队管理");
    expect(titles(personal)).toHaveLength(6);
  });

  test("版本和用户还没读到时不画团队管理", () => {
    expect(titles({ ...admin, ready: false })).not.toContain("团队管理");
  });

  test("地址照 §5.2，过渡期仍指旧页", () => {
    const to = (id: string) =>
      settingsTopics(admin).find((t) => t.id === id)?.linkOptions;
    expect(to("account")).toEqual({ to: "/settings" });
    expect(to("models")).toEqual({ to: "/capabilities/models" });
    expect(to("approvals")).toEqual({ to: "/settings/approvals" });
    expect(to("connections")).toEqual({ to: "/connections" });
    expect(to("devices")).toEqual({ to: "/settings/devices" });
    expect(to("notifications")).toEqual({ to: "/settings/notifications" });
    expect(to("team")).toEqual({ to: "/admin" });
  });
});

describe("按归属亮灯", () => {
  test("/settings/plans、/settings/about 亮账户与外观；/settings 只在精确匹配时亮", () => {
    const topics = settingsTopics(admin);
    expect(activeTopic(topics, "/settings/plans")).toBe("account");
    expect(activeTopic(topics, "/settings/about")).toBe("account");
    expect(activeTopic(topics, "/settings")).toBe("account");
    expect(activeTopic(topics, "/settings/devices")).toBe("devices");
    expect(activeTopic(topics, "/settings/passwords")).toBeNull();
    expect(activeTopic(topics, "/settings/notifications")).toBe(
      "notifications",
    );
  });

  test("过渡期所有能打开部署设置的人，/settings/setup 都亮账户与外观", () => {
    for (const a of [admin, memberLocal, personal]) {
      expect(activeTopic(settingsTopics(a), "/settings/setup")).toBe("account");
    }
  });

  test("待办数挂在账户与外观上，别的话题都不挂", () => {
    for (const a of [admin, memberLocal, personal]) {
      expect(
        settingsTopics(a)
          .filter((t) => t.setupBadge)
          .map((t) => t.id),
      ).toEqual(["account"]);
    }
  });
});

describe("套餐与用量、关于、部署设置、电脑不再是侧栏项", () => {
  test("话题和过渡分组里都没有它们", () => {
    for (const a of [admin, member, personal]) {
      const all = [...titles(a), ...legacyTail(a).map((item) => item.title)];
      for (const gone of ["套餐与用量", "关于", "部署设置", "电脑", "我的设备"])
        expect(all).not.toContain(gone);
    }
  });
});

describe("过渡分组", () => {
  test("团队版是 学习、密码、组件展示", () => {
    expect(legacyTail(admin).map((i) => i.title)).toEqual([
      "学习",
      "密码",
      "组件展示",
    ]);
  });
  test("个人版另有密钥、技能、活动，密码叫已保存的登录", () => {
    expect(legacyTail(personal).map((i) => i.title)).toEqual([
      "学习",
      "已保存的登录",
      "组件展示",
      "密钥",
      "技能",
      "活动",
    ]);
  });
});

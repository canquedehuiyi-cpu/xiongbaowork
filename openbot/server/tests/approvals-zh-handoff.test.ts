import { describe, expect, test } from "bun:test";
import { decideAction, safetyRequirement } from "../src/approvals/policy";
import type {
  ApprovalCandidate,
  ApprovalRule,
  ApprovalTeamRule,
} from "../src/approvals/types";

/**
 * 中文页面上的凭据和付款（阶段 2f，#398 评审遗留）：电脑工具一侧，中文的字段标签、按钮文字和页面
 * 路径，与英文规则同一档交给本人；更长的中文按钮写法补进只给「允许一次」的底线。每个新词有正例，
 * 只读或无害的按钮和字段有反例。应用工具参数里的中文正文不在此列。
 *
 * 每个用例都带一条个人和一条团队的「全部总是允许」规则：规则放得再宽，交给本人的底线也不让路。
 */

const ALLOW_ALL_PERSONAL: ApprovalRule = {
  id: "rule-allow",
  ownerUserId: "owner",
  botId: "*",
  toolRef: "*",
  effect: "*",
  scope: "*",
  behaviour: "allow",
  revokedAt: null,
  createdAt: new Date(),
};
const ALLOW_ALL_TEAM: ApprovalTeamRule = {
  id: "team-allow",
  botId: "*",
  toolRef: "*",
  effect: "*",
  scope: "*",
  behaviour: "allow",
  revokedAt: null,
  createdAt: new Date(),
  createdBy: "admin",
} as ApprovalTeamRule;

const decide = (candidate: ApprovalCandidate) =>
  decideAction({
    candidate,
    team: [ALLOW_ALL_TEAM],
    personal: [ALLOW_ALL_PERSONAL],
    customRulesEnabled: true,
    autoReview: false,
    askBeforeChanges: false,
  });

const PAGE = "https://shop.example.cn/account";

function computer(
  toolRef: "computer_click" | "computer_type" | "computer_key",
  element: { name: string; role: string; type?: string },
  over: { args?: Record<string, unknown>; pageUrl?: string; key?: string } = {},
): ApprovalCandidate {
  const pageUrl = over.pageUrl ?? PAGE;
  return {
    actorId: "owner",
    botId: "bot",
    toolRef,
    effect: "write",
    scope: new URL(pageUrl).host,
    args: { ref: "e5", snapshotId: 3, ...over.args },
    target: { pageUrl, element: { ref: "e5", ...element }, snapshotId: 3 },
    subject: {
      runner: false,
      ...(over.key !== undefined ? { key: over.key } : {}),
    },
  };
}
/** 往一个输入框里填东西。填的内容是内容，不参与判定。 */
const typeInto = (name: string, role = "textbox", type?: string) =>
  computer(
    "computer_type",
    { name, role, ...(type ? { type } : {}) },
    { args: { text: "123456" } },
  );
const clickOn = (name: string, role = "button", pageUrl?: string) =>
  computer("computer_click", { name, role }, pageUrl ? { pageUrl } : {});
const pressOn = (name: string, key = "Enter") =>
  computer("computer_key", { name, role: "button" }, { args: { key }, key });

async function handedOff(candidate: ApprovalCandidate) {
  const outcome = await decide(candidate);
  return {
    behaviour: outcome.behaviour,
    source: outcome.source,
    id: safetyRequirement(candidate)?.id as string | undefined,
  };
}

describe("中文凭据字段交给本人", () => {
  test.each([
    ["新密码", "credentials"],
    ["确认密码", "credentials"],
    ["请再次输入新密码", "credentials"],
    ["登录密码", "credentials"],
    ["支付密码", "credentials"],
    ["交易密码", "credentials"],
    ["验证码", "credentials"],
    ["请输入短信验证码", "credentials"],
    ["动态码", "credentials"],
    ["动态口令", "credentials"],
    ["校验码", "credentials"],
    ["身份证号", "credentials"],
    ["身份证号码", "credentials"],
    ["银行卡号", "payments"],
    ["卡号", "payments"],
    ["信用卡号", "payments"],
    ["CVV", "payments"],
    ["CVV2", "payments"],
    ["CVC", "payments"],
    ["安全码", "payments"],
    ["卡背面三位安全码", "payments"],
  ])("往「%s」里填写交给本人（%s）", async (label, id) => {
    expect(await handedOff(typeInto(label))).toEqual({
      behaviour: "hand_off",
      source: "safety",
      id,
    });
  });

  test("在凭据字段里按键、点进凭据字段，也交给本人", async () => {
    expect(
      (
        await decide(
          computer(
            "computer_key",
            { name: "验证码", role: "textbox" },
            { args: { key: "Tab" }, key: "Tab" },
          ),
        )
      ).behaviour,
    ).toBe("hand_off");
    expect((await decide(clickOn("新密码", "textbox"))).behaviour).toBe(
      "hand_off",
    );
    // input 元素按类型认：type=password 以外的文本框也算输入框。
    expect((await decide(typeInto("支付密码", "input", "tel"))).behaviour).toBe(
      "hand_off",
    );
  });
});

describe("中文凭据和付款按钮交给本人", () => {
  test.each([
    ["修改密码", "credentials"],
    ["重置密码", "credentials"],
    ["设置支付密码", "credentials"],
    ["找回密码", "credentials"],
    ["忘记密码？", "credentials"],
    ["确认修改密码", "credentials"],
    ["获取验证码", "credentials"],
    ["发送验证码", "credentials"],
    ["重新获取验证码", "credentials"],
    ["开启两步验证", "credentials"],
    ["提交订单 ¥99", "payments"],
    ["提交订单 ￥1,299.00", "payments"],
    ["提交订单 共¥99", "payments"],
    ["提交订单 实付：¥45.50", "payments"],
    ["确认并支付", "payments"],
    ["确认并支付 ¥128.00", "payments"],
    ["同意并支付", "payments"],
    ["确认并付款", "payments"],
    ["绑定银行卡", "payments"],
    ["添加银行卡", "payments"],
  ])("点「%s」交给本人（%s）", async (name, id) => {
    expect(await handedOff(clickOn(name))).toEqual({
      behaviour: "hand_off",
      source: "safety",
      id,
    });
  });

  test("用 Enter 或空格按下这些按钮也交给本人", async () => {
    for (const [name, key] of [
      ["确认并支付", "Enter"],
      ["提交订单 ¥99", " "],
      ["修改密码", "Space"],
      ["获取验证码", "\r"],
    ] as const)
      expect({ name, key, ...(await handedOff(pressOn(name, key))) }).toEqual({
        name,
        key,
        behaviour: "hand_off",
        source: "safety",
        id:
          name === "修改密码" || name === "获取验证码"
            ? "credentials"
            : "payments",
      });
  });
});

describe("中文凭据页和付款页的路径交给本人", () => {
  test.each([
    ["https://passport.example.cn/user/修改密码", "credentials"],
    ["https://passport.example.cn/#/安全中心/支付密码", "credentials"],
    ["https://shop.example.cn/收银台?order=1", "payments"],
  ])("在 %s 上点「保存」交给本人（%s）", async (pageUrl, id) => {
    expect(await handedOff(clickOn("保存", "button", pageUrl))).toEqual({
      behaviour: "hand_off",
      source: "safety",
      id,
    });
  });

  test("查询串和片段里的中文不算页面路径", async () => {
    expect(
      (
        await decide(
          clickOn(
            "保存",
            "button",
            "https://example.cn/notes?title=修改密码#收银台",
          ),
        )
      ).behaviour,
    ).toBe("allow");
  });
});

describe("中文按钮的更长写法总是先问", () => {
  test.each([
    ["发送消息给张三", "outbound_send"],
    ["发送给张三", "outbound_send"],
    ["立即发送给李四", "outbound_send"],
    ["发送私信给王五", "outbound_send"],
    ["全部回复", "outbound_send"],
    ["回复全部", "outbound_send"],
    ["发布回答", "publish_post"],
    ["发布想法", "publish_post"],
    ["发布问题", "publish_post"],
    ["发表回答", "publish_post"],
    ["移到已删除邮件", "destructive_tool"],
    ["移至已删除", "destructive_tool"],
  ])("点「%s」先问（%s），只给允许一次", async (name, source) => {
    expect(await decide(clickOn(name))).toMatchObject({
      behaviour: "ask",
      source,
    });
  });
});

describe("只读或无害的按钮和字段不受影响", () => {
  test.each([
    "查看",
    "搜索",
    "已发送",
    "删除线",
    "购买记录",
    "订单详情",
    "查看订单",
    "发布时间",
    "回复全部设置",
    "支付记录",
    "密码管理说明",
  ])("点「%s」照常放行", async (name) => {
    expect(await decide(clickOn(name))).toMatchObject({ behaviour: "allow" });
  });

  test.each(["text", "paragraph", "StaticText", "generic", "heading"])(
    "点纯文本（%s）「密码强度说明」照常放行",
    async (role) => {
      expect(await decide(clickOn("密码强度说明", role))).toMatchObject({
        behaviour: "allow",
      });
    },
  );

  test.each(["搜索", "用户名", "昵称", "收货人", "订单备注", "主题"])(
    "往「%s」里填写照常放行",
    async (label) => {
      expect(await decide(typeInto(label))).toMatchObject({
        behaviour: "allow",
      });
    },
  );

  test("填进普通字段的内容里写了「新密码」「验证码」，不算", async () => {
    expect(
      await decide(
        computer(
          "computer_type",
          { name: "订单备注", role: "textbox" },
          { args: { text: "新密码和验证码稍后发你，支付方案见附件" } },
        ),
      ),
    ).toMatchObject({ behaviour: "allow" });
  });

  test("应用工具参数里的中文正文不交给本人", async () => {
    const appTool: ApprovalCandidate = {
      actorId: "owner",
      botId: "bot",
      toolRef: "mcp/crm/update_note",
      effect: "write",
      scope: "crm",
      args: {
        note: "客户想了解支付方案；新密码、验证码、银行卡号、身份证号都不要发在这里",
        title: "修改密码 提交订单 ¥99 确认并支付",
      },
      subject: { connector: true },
    };
    expect(safetyRequirement(appTool)).toBeUndefined();
    expect(await decide(appTool)).toMatchObject({ behaviour: "allow" });
  });

  test("读页面不交给本人", async () => {
    expect(
      safetyRequirement({
        ...typeInto("新密码"),
        toolRef: "computer_read",
        effect: "read",
      }),
    ).toBeUndefined();
  });
});

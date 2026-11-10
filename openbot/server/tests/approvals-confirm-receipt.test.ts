import { describe, expect, test } from "bun:test";
import { decideAction, safetyRequirement } from "../src/approvals/policy";
import type {
  ApprovalCandidate,
  ApprovalRule,
  ApprovalTeamRule,
} from "../src/approvals/types";

/**
 * 「确认收货」是动钱：在淘宝、京东、拼多多这类平台上，买家点下去，平台托管的货款就打给卖家，
 * 撤不回来。所以它和「提交订单」「微信支付」同一档，交给本人。
 *
 * 只认整段按钮文字：「确认收货地址」「待收货」「收货人」「延长收货」不动钱，照常放行。
 * 每个用例都带「全部总是允许」规则：规则放得再宽，交给本人的底线也不让路。
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

const PAGE = "https://buyertrade.example.cn/orders";

function computer(
  toolRef: "computer_click" | "computer_key",
  name: string,
  key?: string,
): ApprovalCandidate {
  return {
    actorId: "owner",
    botId: "bot",
    toolRef,
    effect: "write",
    scope: new URL(PAGE).host,
    args: { ref: "e5", snapshotId: 3, ...(key !== undefined ? { key } : {}) },
    target: {
      pageUrl: PAGE,
      element: { ref: "e5", name, role: "button" },
      snapshotId: 3,
    },
    subject: { runner: false, ...(key !== undefined ? { key } : {}) },
  };
}

async function handedOff(candidate: ApprovalCandidate) {
  const outcome = await decide(candidate);
  return {
    behaviour: outcome.behaviour,
    source: outcome.source,
    id: safetyRequirement(candidate)?.id as string | undefined,
  };
}

const PAYMENTS = {
  behaviour: "hand_off",
  source: "safety",
  id: "payments",
} as const;

describe("「确认收货」交给本人", () => {
  test.each([
    "确认收货",
    "立即确认收货",
    "去确认收货",
    "确认收货（2）",
    "确认收货(1件)",
    "确定，确认收货",
  ])("点「%s」交给本人（payments）", async (name) => {
    expect(await handedOff(computer("computer_click", name))).toEqual(PAYMENTS);
  });

  test("在「确认收货」上按 Enter 或空格也交给本人", async () => {
    for (const key of ["Enter", "\r", " "])
      expect({
        key,
        ...(await handedOff(computer("computer_key", "确认收货", key))),
      }).toEqual({ key, ...PAYMENTS });
  });

  test.each([
    "确认收货地址",
    "收货地址",
    "待收货",
    "收货人",
    "延长收货",
    "查看物流",
    "确认收货说明",
  ])("点「%s」照常放行", async (name) => {
    expect(await decide(computer("computer_click", name))).toMatchObject({
      behaviour: "allow",
    });
  });
});

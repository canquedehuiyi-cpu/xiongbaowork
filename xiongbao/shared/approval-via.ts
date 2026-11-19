/**
 * 一条审批是在哪里决定的（审批表的 `decided_via`，迁移 0229）。
 *
 * 规格（docs/specs/2026-11-16-im-channels.md 验收）：网页上显示「已由 某某 在 微信 批准」，微信里回数字时
 * 答「这条已由 某某 在 <渠道> 处理」。取值是现有的每一个决定入口：
 *
 * - `web`：网页 / 桌面 / 手机网页的 `POST /api/approvals/:id/decision`；
 * - `wechat`：微信里回数字（`server/src/delivery/wechat/decisions.ts`）；
 * - `slack` / `teams`：OpenTag 配对的 Slack、Teams 审批卡片（`server/src/delivery/opentag-agent.ts`）。
 *
 * 规则放行、还在等的审批没有来源（null）；0229 之前决定的旧数据也是 null，说的时候退回「网页」。
 * 以后加飞书等入口时，这里、迁移里的 CHECK 约束一起加。
 *
 * 一处声明，两边读：服务器（存库、微信回话）和浏览器（审批页）用同一份中文名。
 */
export const APPROVAL_VIAS = ["web", "wechat", "slack", "teams"] as const;
export type ApprovalVia = (typeof APPROVAL_VIAS)[number];

/** 每个渠道的中文叫法。 */
export const APPROVAL_VIA_NAMES: Record<ApprovalVia, string> = {
  web: "网页",
  wechat: "微信",
  slack: "Slack",
  teams: "Teams",
};

/** 说出来的渠道名：没记渠道（旧数据）或不认识的值退回「网页」。 */
export function approvalViaName(via: string | null | undefined): string {
  return (
    (via && (APPROVAL_VIA_NAMES as Record<string, string>)[via]) ||
    APPROVAL_VIA_NAMES.web
  );
}

/*
 * 微信主动推送的时间窗：微信只让回复在对方最近一次来信之后的一段时间里发出去。设置页的总览（`bind.ts`
 * `summary().windowOpen`）和出站（`transport.ts` `createWechatWindow`）用同一个常量、同一个判断。
 */
import type { WechatAccount } from "../../db/schema/wechat";

/** 主动推送能到微信的时间窗：最近一次入站之后多久。实测结果回来后只改这里。 */
export const WECHAT_PUSH_WINDOW_MS = 10 * 60 * 60 * 1000;

/** 这个账号现在能不能主动推：绑定着（没暂停、没断开）、有 `context_token`、最近一次入站还在时间窗内。 */
export function wechatWindowOpen(
  account: Pick<WechatAccount, "status" | "contextToken" | "lastInboundAt">,
  now: Date,
): boolean {
  return (
    account.status === "bound" &&
    Boolean(account.contextToken) &&
    account.lastInboundAt !== null &&
    now.getTime() - account.lastInboundAt.getTime() < WECHAT_PUSH_WINDOW_MS
  );
}

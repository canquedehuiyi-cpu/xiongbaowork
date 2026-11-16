/**
 * 投递进来的人话在对话里那条用户消息的 ID。
 *
 * 微信来的在 `delivery:` 后面多带一段 `wechat:`，前端靠它在对话里给这条消息标「来自微信」小字；
 * 其他渠道的 ID 保持原样（`delivery:<runId>`），行为不变。ID 随消息一起存进对话线程，重新打开也在。
 */
export const WECHAT_MESSAGE_ID_PREFIX = "delivery:wechat:";

export function deliveryMessageId(source: string, runId: string): string {
  return source === "wechat"
    ? `${WECHAT_MESSAGE_ID_PREFIX}${runId}`
    : `delivery:${runId}`;
}

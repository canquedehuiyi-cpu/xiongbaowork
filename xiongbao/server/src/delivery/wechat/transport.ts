/*
 * 微信 ClawBot 的发件箱出口（计划 2026-11-16-im-channels-wechat Task 8）：「等你确认」、进度、逾期、开收工清点
 * 经 `delivery_outbox` 发到这个人的微信，前提是本人在「消息发到哪里」里显式打开了微信（路由那道门在
 * `router.ts`，这里不再判）。
 *
 * 主动推送的时间窗：微信只让回复在对方最近一次来信之后的一段时间里发出去（`WECHAT_PUSH_WINDOW_MS`，按规格先用
 * 10 小时，真机实测的结果回来后只改这个常量）。窗口外不往微信发，手机推送和短信照常；漏发的提醒在账号行上
 * 记一笔（`missed_count`），下次入站时补一句「有 N 条提醒在熊宝里」。
 *  - 路由发件箱行之前先问窗口（`createWechatWindow`）：关着就不写微信那一行，漏发加一。
 *  - 发的时候 iLink 还是拒绝（`ret=-2` 等）或缺 `context_token`：当作窗口已关，行记 `failed`、漏发加一、不重试。
 *
 * 文字：审批、逾期提醒和交付待验收（后两种行上带结构化标记 `wechatPromptRef`）用 Task 7 的 `decisions.ts` 开编号提示并取文字，文字自带
 * 「【员工名】」；别的种类原样发，回复和提问前面加「【员工名】」。谁开出的提示谁发（`created`）：审批提示已经开着
 * （微信里那一轮随回复发过）就不再发第二次，行记 sent 并在 error 里说明；发送失败时本次新开的提示关掉。
 *
 * 在发件箱投递的帧里调用（这个人自己的租户帧）。令牌只交给 iLink，不进日志和错误。
 */

import type { WechatAccount } from "../../db/schema/wechat";
import {
  DeliveryProviderError,
  DeliveryRefusedError,
  readWechatPromptRef,
  type TextTransport,
} from "../types";
import { IlinkWindowClosedError } from "./ilink";
import {
  splitWechatText,
  WechatReplyUnavailableError,
  type WechatSend,
} from "./inbound";
import type { WechatStore } from "./store";

/** 主动推送能到微信的时间窗：最近一次入站之后多久。实测结果回来后只改这里。 */
export const WECHAT_PUSH_WINDOW_MS = 10 * 60 * 60 * 1000;

/** 这个账号现在能不能主动推：绑定着、有 `context_token`、最近一次入站还在时间窗内。 */
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

/** 路由在写微信那一行之前用：窗口开没开；没开时记一笔漏发。 */
export function createWechatWindow(deps: {
  wechat: Pick<WechatStore, "account" | "bumpMissed">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    async open(ownerUserId: string): Promise<boolean> {
      const account = await deps.wechat.account(ownerUserId);
      return Boolean(account && wechatWindowOpen(account, now()));
    },
    async missed(ownerUserId: string): Promise<void> {
      const account = await deps.wechat.account(ownerUserId);
      if (account) await deps.wechat.bumpMissed(account.id);
    },
  };
}

/** 带编号的提示文字（Task 7 `decisions.ts` 的开提示函数）。`created`：这条提示是本次调用新开的。 */
type Prompts = {
  openApprovalPrompt(
    userId: string,
    approvalId: string,
  ): Promise<{ code: string; text: string; created: boolean } | null>;
  openOverduePrompt(
    userId: string,
    taskId: string,
  ): Promise<{ code: string; text: string; created: boolean } | null>;
  openHandinPrompt(
    userId: string,
    taskId: string,
  ): Promise<{ code: string; text: string; created: boolean } | null>;
};

export type WechatTransportDeps = {
  wechat: Pick<
    WechatStore,
    "accountByIlinkUser" | "bumpMissed" | "closePrompt"
  >;
  send: WechatSend;
  /** 开提示的函数；装配时才有（它依赖更晚建好的服务），所以是取值函数。没有时审批、逾期按原文发。 */
  prompts?: () => Prompts | undefined;
};

export function createWechatTransport(
  deps: WechatTransportDeps,
): TextTransport {
  return {
    async send(input) {
      const account = await deps.wechat.accountByIlinkUser(input.address);
      const context = input.context;
      // 漏发只算提醒类，回复不算（和路由一致）。
      const countsAsMissed = context?.kind !== "reply";
      if (!account || (context && account.userId !== context.ownerUserId))
        throw new DeliveryRefusedError("微信账号已解绑或不属于这个人。");
      const missed = async () => {
        if (countsAsMissed) await deps.wechat.bumpMissed(account.id);
      };
      if (account.status === "paused")
        throw new DeliveryProviderError("wechat", "paused");
      // 缺 context_token 就是没来过信（或已解绑重绑）：和窗口已关一样处理。
      if (!account.contextToken) {
        await missed();
        throw new IlinkWindowClosedError();
      }

      let text = input.text;
      /** 本次新开的提示：发送失败要关掉，免得留下用户从没见过的编号。 */
      let opened: string | null = null;
      const prompts = deps.prompts?.();
      if (context && prompts) {
        if (context.kind === "approval" && context.requestId) {
          const prompt = await prompts.openApprovalPrompt(
            context.ownerUserId,
            context.requestId,
          );
          // 审批已经不在等批了（别处处理过）：没有什么可问的。
          if (!prompt)
            return {
              id: `wechat-${input.id}-settled`,
              status: "sent",
              note: "审批已在别处处理，没有发到微信。",
            };
          // 提示已经开着：微信里那一轮已随回复发过带编号的请求（或另一路刚开）。谁开的谁发，这里不重复。
          if (!prompt.created)
            return {
              id: `wechat-${input.id}-already-prompted`,
              status: "sent",
              note: "已在微信里发过这条审批，没有重复发送。",
            };
          opened = prompt.code;
          text = prompt.text;
        } else {
          const ref = readWechatPromptRef(context.requestId);
          if (context.kind === "overdue" && ref) {
            /*
             * 逾期提醒和交付待验收都会按每天上限重复发（再交一版也会再提醒），同一张卡的提示还开着时照发（编号
             * 不变）。
             */
            const prompt =
              ref.kind === "handin"
                ? await prompts.openHandinPrompt(context.ownerUserId, ref.ref)
                : await prompts.openOverduePrompt(context.ownerUserId, ref.ref);
            // 交上来的活已经不在等验收（别处验收过、退回了）：没有什么可问的。
            if (!prompt && ref.kind === "handin")
              return {
                id: `wechat-${input.id}-settled`,
                status: "sent",
                note: "这件活已在别处处理，没有发到微信。",
              };
            if (prompt) {
              text = prompt.text;
              if (prompt.created) opened = prompt.code;
            }
          }
        }
      }
      if (
        input.sender &&
        context &&
        (context.kind === "reply" || context.kind === "question")
      )
        text = `【${input.sender.name}】${text}`;

      try {
        for (const part of splitWechatText(text))
          await deps.send(account, {
            text: part,
            contextToken: account.contextToken,
          });
      } catch (error) {
        if (opened) await deps.wechat.closePrompt(account.userId, opened);
        if (error instanceof IlinkWindowClosedError) await missed();
        if (error instanceof WechatReplyUnavailableError)
          throw new DeliveryProviderError("wechat", "unavailable");
        throw error;
      }
      return { id: `wechat-${input.id}`, status: "sent" };
    },
  };
}

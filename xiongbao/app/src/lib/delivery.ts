import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "./client";
export type Reachability = {
  bindings: {
    id: string;
    transport: "slack" | "teams" | "sms";
    channelId: string;
    agentId: string;
    address: string;
    mentionId?: string | null;
    enabled: boolean;
    /** SMS only: the number replied STOP; texts resume after START. */
    optedOutAt?: string | null;
  }[];
  devices: { id: string; platform: "ios" | "android"; enabled: boolean }[];
  /** The server's `delivery_outbox` rows (server/src/delivery/types.ts), newest first. */
  deliveries: {
    id: string;
    transport: "slack" | "teams" | "sms" | "push" | "wechat";
    kind: "reply" | "question" | "approval" | "attention";
    state:
      | "queued"
      | "running"
      | "accepted"
      | "sent"
      | "delivered"
      | "failed"
      | "unknown"
      | "opted_out";
    error: string | null;
    createdAt: string;
    /**
     * Which receiver it went to. The server answers the whole outbox row, so these were always in
     * the response; declared optional because nothing here may assume an older server sends them.
     */
    bindingId?: string | null;
    deviceId?: string | null;
  }[];
  available: {
    slack: boolean;
    teams: boolean;
    sms: boolean;
    push: boolean;
    /** 这里开通了微信 ClawBot 扫码绑定。 */
    wechat: boolean;
  };
  /** 这个人的微信绑定（`server/src/delivery/wechat/bind.ts` 的 `summary`），没绑或没开通时是 null。 */
  wechat: WechatSummary | null;
};

/**
 * 设置页能看到的微信绑定状态，没有任何令牌和 id。
 *
 * `disconnected`：微信那边让绑定失效了（用户删了 ClawBot、接口报鉴权失败），要重新扫码。服务器的
 * `summary` 目前只回 `bound` / `paused`，失效的账号会标成 `unbound`、总览给 null；这个值是给计划
 * Review Focus 5 留的，服务器开始回它之前这一支不会走到。
 */
export type WechatSummary = {
  status: "bound" | "paused" | "disconnected";
  boundAt: string;
  /** 微信让我们暂停一阵（`ret=-14`），到时自动恢复。 */
  paused: boolean;
  /** 最近 10 小时里在微信里说过话：主动提醒还能发到微信。 */
  windowOpen: boolean;
};
export const deliveryKey = ["delivery"] as const;
export function deliveryQueryOptions() {
  return queryOptions({
    queryKey: deliveryKey,
    queryFn: async (): Promise<Reachability> => {
      const response = await client("/api/delivery", {
        fallback: "Could not load reachability",
      });
      return response.json();
    },
    refetchInterval: 10_000,
  });
}
/** A one-time `link <code>` message for the OpenTag app in Slack or Teams. */
export type ChatLink = {
  platform: "slack" | "teams";
  code: string;
  command: string;
  expiresInMinutes: number;
};
export async function startChatLink(target: {
  channelId: string;
  agentId: string;
  platform: "slack" | "teams";
}): Promise<ChatLink> {
  const response = await client("/api/delivery/opentag/start", {
    method: "POST",
    body: target,
    fallback: `Could not start linking ${target.platform === "teams" ? "Teams" : "Slack"}`,
  });
  return response.json();
}
export function startSms(target: {
  channelId: string;
  agentId: string;
  phone: string;
}) {
  return client<string>("/api/delivery/sms/start", "challengeId", {
    method: "POST",
    body: target,
    fallback: "Could not verify this phone",
  });
}
export function confirmSms(challengeId: string, code: string) {
  return client("/api/delivery/sms/confirm", {
    method: "POST",
    body: { challengeId, code },
    fallback: "Could not confirm this phone",
  });
}
export function removeDeliveryBinding(id: string) {
  return client(`/api/delivery/bindings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not disconnect",
  });
}
export function removePushDevice(id: string) {
  return client(`/api/delivery/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not remove this device",
  });
}

export function removePushDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removePushDevice,
    onSettled: () => queryClient.invalidateQueries({ queryKey: deliveryKey }),
  });
}

export function removeDeliveryBindingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: removeDeliveryBinding,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deliveryKey }),
  });
}

/**
 * Ask for a one-time `link <code>` message. No `queryClient`: nothing is linked until the code is
 * sent from Slack or Teams, so nothing cached has changed yet and there is nothing to invalidate.
 */
export function startChatLinkMutationOptions() {
  return mutationOptions({ mutationFn: startChatLink });
}

/**
 * Text a verification code to a phone. No `queryClient`, for the same reason as a link message: the
 * phone is not connected until the code comes back through `confirmSms`.
 */
export function startSmsMutationOptions() {
  return mutationOptions({ mutationFn: startSms });
}

export function confirmSmsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      challengeId,
      code,
    }: {
      challengeId: string;
      code: string;
    }) => confirmSms(challengeId, code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deliveryKey }),
  });
}

/** 一次扫码绑定：二维码（图片地址或二维码内容）和这次尝试的 id。 */
export type WechatBindStart = {
  attemptId: string;
  imageContent: string;
  expiresInMinutes: number;
};

/** 一张二维码走到哪了。`message` 是服务器写给人看的原因（过期、被别的账号绑了、没绑上）。 */
export type WechatBindAttempt = {
  status: "wait" | "scaned" | "bound" | "expired" | "taken" | "failed";
  message?: string;
};

/** 到了这几种，这张二维码就不会再变了，不用再问。 */
const WECHAT_ATTEMPT_FINISHED = new Set<WechatBindAttempt["status"]>([
  "bound",
  "expired",
  "taken",
  "failed",
]);

export function wechatAttemptFinished(status: WechatBindAttempt["status"]) {
  return WECHAT_ATTEMPT_FINISHED.has(status);
}

/**
 * 每 2 秒问一次服务器这张二维码的状态，结束了就停。键挂在 `deliveryKey` 下面：绑好后失效总览时
 * 顺带再问一次，服务器对结束了的尝试只照存下的结局答。
 */
export function wechatAttemptQueryOptions(attemptId: string) {
  return queryOptions({
    queryKey: [...deliveryKey, "wechat-attempt", attemptId] as const,
    queryFn: async (): Promise<WechatBindAttempt> => {
      const response = await client(
        `/api/delivery/wechat/attempts/${encodeURIComponent(attemptId)}`,
        { fallback: "没查到二维码的状态" },
      );
      return response.json();
    },
    refetchInterval: (query) =>
      query.state.data && wechatAttemptFinished(query.state.data.status)
        ? false
        : 2_000,
    refetchIntervalInBackground: true,
  });
}

/**
 * 要一张绑定用的二维码。不带 `queryClient`：扫码确认之前什么都没绑上，缓存里没有要失效的。
 */
export function startWechatBindMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<WechatBindStart> => {
      const response = await client("/api/delivery/wechat/start", {
        method: "POST",
        fallback: "没拿到二维码，请再试一次",
      });
      return response.json();
    },
  });
}

export function unbindWechatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      client("/api/delivery/wechat", {
        method: "DELETE",
        fallback: "没解绑成功，请再试一次",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deliveryKey }),
  });
}

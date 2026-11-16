export type DeliveryScope = {
  ownerUserId: string;
  channelId: string;
  agentId: string;
  threadId: string;
};
/** Chat platforms reached through the OpenTag pairing (Channels SDK front for Slack and Teams). */
export type ChatTransport = "slack" | "teams";
/** `wechat` 是微信 ClawBot：每个人自己扫码绑定，入站由长轮询器交给 `delivery/wechat/inbound.ts`。 */
export type BindingTransport = ChatTransport | "sms" | "wechat";
export type DeliveryBinding = DeliveryScope & {
  id: string;
  transport: BindingTransport;
  identity: string;
  realm: string;
  address: string;
  enabled: boolean;
  mentionId?: string | null;
  /** SMS only: the recipient replied STOP. Outbound is recorded `opted_out`, never sent. */
  optedOutAt?: Date | null;
};
export type PushDevice = {
  id: string;
  ownerUserId: string;
  token: string;
  projectId: string;
  platform: "ios" | "android";
  enabled: boolean;
};
export type DeliveryState =
  | "queued"
  | "running"
  | "accepted"
  | "sent"
  | "delivered"
  | "failed"
  | "unknown"
  /** The SMS recipient replied STOP (Twilio Advanced Opt-Out); nothing was sent. */
  | "opted_out";
export type DeliveryInbox = DeliveryScope & {
  id: string;
  bindingId: string | null;
  source: BindingTransport | "native";
  externalId: string;
  text: string;
  state: DeliveryState;
  error: string | null;
};
/**
 * What a delivery is about. `attention` is a ping: one message to a person that something their
 * Bots' check-ins found needs them, every Bot's items folded into it (proactive/ping.ts).
 *
 * `briefing` and `overdue` are the delivery loop's (spec 2026-11-15-delivery-loop §10): the start or
 * end briefing, folding every followed card into one message, and a reminder about one card that is
 * late (or not yet taken on). Like a ping, neither is about one conversation: each row is filed under
 * one the person can reach, and a tap opens the briefing page or the card, not a conversation.
 */
export type DeliveryKind =
  | "reply"
  | "question"
  | "approval"
  | "attention"
  | "briefing"
  | "overdue";
/** The kinds a person is told about outside any one conversation; each row carries its own heading. */
export const PERSON_DELIVERY_KINDS = [
  "attention",
  "briefing",
  "overdue",
] as const;
export type PersonDeliveryKind = (typeof PERSON_DELIVERY_KINDS)[number];
export type DeliveryOutbox = DeliveryScope & {
  id: string;
  bindingId: string | null;
  deviceId: string | null;
  transport: BindingTransport | "push";
  /**
   * What is sent. A ping's push row carries its title on the first line and its body after it,
   * since one row holds one text; every other push is titled "OpenBot".
   */
  text: string;
  kind: DeliveryKind;
  requestId: string | null;
  state: DeliveryState;
  providerId: string | null;
  error: string | null;
};
export type ProviderFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
/** The Bot a message speaks for, so a chat surface can post under that Bot's own name. */
export type DeliverySender = {
  agentId: string;
  name: string;
  avatarSeed?: string;
};
export type TextTransport = {
  send(input: {
    id: string;
    address: string;
    text: string;
    transport?: BindingTransport;
    sender?: DeliverySender;
    /** 只有微信的发件箱出口要：这一行是谁的、什么种类、关于哪件事（审批或卡片），好开编号提示。 */
    context?: {
      ownerUserId: string;
      kind: DeliveryKind;
      requestId: string | null;
    };
  }): Promise<{ id: string; status: "queued" | "sent" }>;
};
export class DeliveryRefusedError extends Error {
  override name = "DeliveryRefusedError";
}
export class DeliveryNotFoundError extends Error {
  override name = "DeliveryNotFoundError";
}
export class DeliveryProviderError extends Error {
  override name = "DeliveryProviderError";
  constructor(
    readonly provider: string,
    readonly code: string,
    readonly uncertain = false,
  ) {
    super(`${provider} delivery failed (${code}).`);
  }
}
export async function providerJson(
  provider: string,
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new DeliveryProviderError(
      provider,
      `HTTP_${response.status}`,
      response.status >= 500,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DeliveryProviderError(provider, "invalid_response", true);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new DeliveryProviderError(provider, "invalid_response", true);
  return body as Record<string, unknown>;
}

/**
 * 微信那一行的 `request_id` 可以带「这一行要换成带编号的提示」的结构化标记：`wechat-prompt:<种类>:<引用>`。
 * 微信行不走手机推送的深链，所以不占别的用途。
 */
export const WECHAT_PROMPT_REF = "wechat-prompt:";
export function wechatPromptRef(kind: "overdue", ref: string): string {
  return `${WECHAT_PROMPT_REF}${kind}:${ref}`;
}
export function readWechatPromptRef(
  requestId: string | null,
): { kind: "overdue"; ref: string } | null {
  if (!requestId?.startsWith(`${WECHAT_PROMPT_REF}overdue:`)) return null;
  return {
    kind: "overdue",
    ref: requestId.slice(`${WECHAT_PROMPT_REF}overdue:`.length),
  };
}

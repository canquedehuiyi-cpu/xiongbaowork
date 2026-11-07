import type { AgentProfile } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { Reachability } from "@/lib/delivery";
import {
  type ModelLibrary,
  modelChoiceName,
  poolChoiceName,
} from "@/lib/models/queries";

/**
 * The @Waker page's address: which view of the connected chats, and how it is narrowed.
 *
 * Every key is optional and omitted at its default, so a bare `/reachability` — every link and
 * bookmark that already exists — stays exactly what it was, and a narrowed view survives a reload,
 * the back button and a shared link.
 */
export type ChatType = "slack" | "teams" | "sms" | "device";
export type ChatStatus = "connected" | "failed" | "optedOut";
export type ReachabilitySearch = {
  view?: "cards";
  q?: string;
  type?: ChatType;
  model?: string;
  status?: ChatStatus;
};

const TYPES: readonly ChatType[] = ["slack", "teams", "sms", "device"];
const STATUSES: readonly ChatStatus[] = ["connected", "failed", "optedOut"];

export function reachabilitySearch(
  search: Record<string, unknown>,
): ReachabilitySearch {
  const out: ReachabilitySearch = {};
  if (search.view === "cards") out.view = "cards";
  if (typeof search.q === "string" && search.q.trim()) out.q = search.q;
  if (TYPES.includes(search.type as ChatType))
    out.type = search.type as ChatType;
  if (typeof search.model === "string" && search.model)
    out.model = search.model;
  if (STATUSES.includes(search.status as ChatStatus))
    out.status = search.status as ChatStatus;
  return out;
}

export const TYPE_LABELS: Record<ChatType, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "短信",
  device: "原生设备",
};

export const STATUS_LABELS: Record<ChatStatus, string> = {
  connected: "已连接",
  failed: "送达失败",
  optedOut: "已退订",
};

/** How an outbox state reads to a person; an unknown one is shown as the server said it. */
export const DELIVERY_STATE_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "发送中",
  accepted: "已受理",
  sent: "已发出",
  delivered: "已送达",
  failed: "送达失败",
  unknown: "状态未知",
  opted_out: "对方已退订",
};

export const DELIVERY_KIND_LABELS: Record<string, string> = {
  reply: "回复",
  question: "提问",
  approval: "审批请求",
};

export const TRANSPORT_LABELS: Record<string, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "短信",
  push: "原生推送",
};

type Delivery = Reachability["deliveries"][number];

/** One connected receiver, as a row of the 已接入聊天 table or a card. */
export type ChatRow = {
  id: string;
  kind: "binding" | "device";
  type: ChatType;
  /** What identifies it beyond its platform: the phone number, or the device platform. */
  detail: string | null;
  channelId: string | null;
  conversation: string;
  agentName: string;
  /** Null for a device, which belongs to the person rather than one coworker. */
  modelKey: string | null;
  modelName: string;
  status: ChatStatus;
  last: Delivery | null;
};

/**
 * Which model a coworker answers on, keyed so the filter can round-trip it through the URL.
 *
 * The same reading the coworker's own page gives (`wakers_.$agentId.tsx`): a remote coworker
 * chooses its model on its own server, an unbound built-in one runs on the deployment's model, and
 * a binding names a library entry or a platform pool model. A binding is resolved against the
 * viewer's library only; one it does not hold is named by kind rather than by id.
 */
export function modelOf(
  profile: AgentProfile | undefined,
  library: ModelLibrary | undefined,
): { key: string; name: string } {
  if (!profile) return { key: "unknown", name: "未知" };
  if (!profile.builtIn) return { key: "remote", name: "外部托管模型" };
  if (profile.platformModelRef) {
    const pooled = library?.pool.find(
      (model) => model.id === profile.platformModelRef,
    );
    return {
      key: `pool:${profile.platformModelRef}`,
      name: pooled ? poolChoiceName(pooled) : "平台体验模型",
    };
  }
  if (profile.modelRef) {
    const connected = library?.models.find(
      (model) => model.id === profile.modelRef,
    );
    return {
      key: `lib:${profile.modelRef}`,
      name: connected ? modelChoiceName(connected) : "模型库中的模型",
    };
  }
  return { key: "default", name: "部署默认模型" };
}

/**
 * The connected chats, from the delivery read and nothing invented.
 *
 * A disconnected binding is kept by the server with `enabled: false`; it is history, not a chat
 * that is connected, so it is left out as the old page left it out. A row's status is what the
 * server can actually tell: a number that replied STOP is opted out, a receiver whose latest
 * delivery failed is failing, and everything else is connected. Deliveries arrive newest first, so
 * the first one naming a receiver is its latest.
 */
export function chatRows(input: {
  reach: Reachability;
  channels: ChannelSummary[] | undefined;
  agents: AgentProfile[] | undefined;
  library: ModelLibrary | undefined;
}): ChatRow[] {
  const { reach, channels, agents, library } = input;
  const latest = (match: (delivery: Delivery) => boolean) =>
    reach.deliveries.find(match) ?? null;
  const rows: ChatRow[] = [];
  for (const binding of reach.bindings) {
    if (!binding.enabled) continue;
    const channel = channels?.find((entry) => entry.id === binding.channelId);
    const profile = agents?.find((entry) => entry.id === binding.agentId);
    const model = modelOf(profile, library);
    const last = latest((delivery) => delivery.bindingId === binding.id);
    rows.push({
      id: binding.id,
      kind: "binding",
      type: binding.transport,
      // A chat identity is an opaque platform id; only a phone number means something to read.
      detail: binding.transport === "sms" ? binding.address : null,
      channelId: binding.channelId,
      conversation: channel ? conversationLabel(channel) : "一段对话",
      agentName: profile?.name ?? binding.agentId,
      modelKey: model.key,
      modelName: model.name,
      status: binding.optedOutAt
        ? "optedOut"
        : last?.state === "failed"
          ? "failed"
          : "connected",
      last,
    });
  }
  for (const device of reach.devices) {
    if (!device.enabled) continue;
    const last = latest((delivery) => delivery.deviceId === device.id);
    rows.push({
      id: device.id,
      kind: "device",
      type: "device",
      detail: device.platform === "ios" ? "iOS" : "Android",
      channelId: null,
      conversation: "你的全部对话",
      agentName: "—",
      modelKey: null,
      modelName: "—",
      status: last?.state === "failed" ? "failed" : "connected",
      last,
    });
  }
  return rows;
}

export function filterRows(
  rows: ChatRow[],
  search: ReachabilitySearch,
): ChatRow[] {
  const needle = search.q?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (search.type && row.type !== search.type) return false;
    if (search.model && row.modelKey !== search.model) return false;
    if (search.status && row.status !== search.status) return false;
    if (!needle) return true;
    return [
      TYPE_LABELS[row.type],
      row.detail ?? "",
      row.conversation,
      row.agentName,
      row.modelName,
    ].some((text) => text.toLowerCase().includes(needle));
  });
}

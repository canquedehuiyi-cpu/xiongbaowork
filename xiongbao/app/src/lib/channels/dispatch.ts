import type { ComposerDraft } from "@/components/channels/composer/draft";
import {
  type AgentOption,
  toAgentOptions,
} from "@/components/channels/composer/triggers";
import { client } from "@/lib/client";

/**
 * `@` a coworker in a one-to-one conversation (spec B1–B3).
 *
 * A 1:1 channel is pinned to one coworker for the life of its thread, so a mention of THAT coworker
 * is just a message, and a mention of anybody else is a piece of work handed to them: it goes to
 * `POST /api/channels/:channelId/dispatch`, the server opens a card on the board with that coworker
 * as executor, and runs its turn on this channel's thread. The reply arrives in this transcript the
 * same way a relayed handoff does — see `channel-chat.tsx`.
 *
 * Pure functions plus one request, so the routing rule can be tested without mounting a channel.
 */

/**
 * Who `@` can name in this conversation.
 *
 * In a 1:1 conversation: every coworker the person can see (the roster is already filtered to that
 * on the server), so any of them can be handed a task. A conversation with several coworkers keeps
 * its own members, as before.
 */
export function mentionRoster(
  profiles: readonly { id: string; name: string; title?: string }[] | undefined,
  channelAgentIds: readonly string[],
): AgentOption[] {
  return channelAgentIds.length > 1
    ? toAgentOptions(profiles, channelAgentIds)
    : toAgentOptions(profiles);
}

export type ChannelDraftRoute =
  | { kind: "say" }
  | { kind: "dispatch"; agentId: string };

/**
 * Where a sent draft goes.
 *
 * Only a 1:1 conversation dispatches, and only for a coworker other than the pinned one: naming the
 * coworker you are already talking to is an ordinary message, and a conversation with several
 * coworkers is the group screen's to route.
 */
export function routeChannelDraft(
  draft: Pick<ComposerDraft, "agentId">,
  channel: { agentIds: readonly string[] },
  pinnedAgentId: string,
): ChannelDraftRoute {
  if (channel.agentIds.length > 1) return { kind: "say" };
  if (!draft.agentId || draft.agentId === pinnedAgentId) return { kind: "say" };
  return { kind: "dispatch", agentId: draft.agentId };
}

export type DispatchAccepted = {
  taskId: string;
  runId: string;
  queued: boolean;
};

/** Hand one message to a coworker. Throws the server's own sentence on refusal (404, 402, 400). */
export async function dispatchToWaker(input: {
  channelId: string;
  /** The client's id for this message; sending the same id again is the same dispatch. */
  id: string;
  agentId: string;
  text: string;
}): Promise<DispatchAccepted> {
  const response = await client(
    `/api/channels/${encodeURIComponent(input.channelId)}/dispatch`,
    {
      method: "POST",
      body: { id: input.id, agentId: input.agentId, text: input.text },
      fallback: "没能把这条消息派给这位员工。",
    },
  );
  return (await response.json()) as DispatchAccepted;
}

/** What the conversation says once a dispatch was accepted. */
export function dispatchedNotice(name: string): string {
  return `已派给 ${name}，任务已登记到任务看板，回复会出现在这段对话里。`;
}

/**
 * Send one draft from a 1:1 conversation: an ordinary turn, or a dispatch.
 *
 * A dispatch carries text only. Attachments and `/` skills belong to the pinned coworker's turn, so a
 * draft with files is refused here — before anything is sent — and the composer gives the words back.
 */
export async function sendChannelDraft(
  draft: ComposerDraft,
  input: {
    channel: { id: string; agentIds: readonly string[] };
    pinnedAgentId: string;
    newId: () => string;
    say: () => Promise<unknown>;
    dispatch?: typeof dispatchToWaker;
  },
): Promise<
  | { kind: "said" }
  | { kind: "dispatched"; agentId: string; accepted: DispatchAccepted }
> {
  const route = routeChannelDraft(draft, input.channel, input.pinnedAgentId);
  if (route.kind === "say") {
    await input.say();
    return { kind: "said" };
  }
  if (draft.attachments.length > 0)
    throw new Error("派活暂时只能发送文字，请先移除附件。");
  if (!draft.text.trim()) throw new Error("请写下要交给这位员工的事情。");
  const accepted = await (input.dispatch ?? dispatchToWaker)({
    channelId: input.channel.id,
    id: input.newId(),
    agentId: route.agentId,
    text: draft.text,
  });
  return { kind: "dispatched", agentId: route.agentId, accepted };
}

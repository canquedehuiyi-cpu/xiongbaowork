/**
 * One conversation with several Bots.
 *
 * An Intelligence thread admits exactly one agent, so a channel with two Bots cannot be one thread
 * with two speakers. Each Bot gets a thread of its own in the group (`group_bot_threads`), and every
 * turn runs through the ordinary headless AG-UI path (`toolkit/run-turn.ts`) into that thread, so
 * learning, governance, approvals and analytics apply to a group turn exactly as they do to a routine.
 * What the people in the channel read is `group_messages`: the shared transcript, one row per person
 * message and one per Bot reply, each attributed to its speaker.
 *
 * WHO MAY BE HERE. Channel membership, resolved per request and per Bot turn, never cached. A person
 * who is not a member gets the same not-found answer for a channel that exists as for one that does
 * not, and a Bot that stops being visible to the owner is skipped rather than run.
 *
 * BOTS ANSWERING EACH OTHER. A Bot that names a peer as `@Name` in its reply hands the conversation to
 * that peer, as one more queued turn. It is the handoff desk's authority and caps, not a second set:
 * the same Bot-to-Bot grant (`mayAddress`), the same depth cap (a person's message is depth zero and
 * each hop is one deeper), the same fan-out cap per reply, the same durable leased queue, and the same
 * `agent.handoff_*` audit rows. Nothing here orchestrates beyond that one rule.
 */
import { createHash } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { HeadlessToolSuspension } from "@xiongbao/toolkit/headless-tools";
import type { TurnRunner } from "@xiongbao/toolkit/run-turn";
import { and, asc, desc, eq, inArray, isNull, min, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  type PlanItem,
  readPlan,
  UPDATE_PLAN_TOOL,
} from "../../../shared/plan";
import { STEP_LIMIT_EVENT } from "../../../shared/step-limit";
import {
  joinReasoning,
  readStoredReasoning,
  type StoredReasoning,
} from "../../../shared/thinking";
import {
  TURN_ARTIFACTS_EVENT,
  type TurnArtifact,
} from "../../../shared/turn-artifacts";
import type { HandoffCaps } from "../agents/handoff";
import { delegationFreed as readDelegationFreed } from "../approvals/delegation-freed";
import type { ApprovalContinuation } from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  handoffInitiator,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../db/schema/core";
import {
  groupBotThreads,
  groupMessagePrivate,
  groupMessages,
} from "../db/schema/group";
import { TEAM_TENANT } from "../db/schema/tenant";
import { workItems } from "../db/schema/work";
import { leadingSkillCommand } from "../plugins/picked-skill";
import type { CheckPrivateShare } from "../proactive/private-share";
import {
  type AutoDeliveryReader,
  autoDeliverable,
} from "../tasks/auto-delivery";
import { type Delivery, firstSentenceOf } from "../tasks/delivery";
import { DELIVERY_EVENTS } from "../tasks/delivery-events";
import type { TaskProjector } from "../tasks/projector";
import {
  currentTenant,
  runAsClaimedTenant,
  runAsTenant,
} from "../tenant/context";
import {
  COMPACTION_DONE_EVENT,
  COMPACTION_FAILED_EVENT,
} from "../threads/compaction";
import { roundHungByEntry } from "../threads/unattended-card";
import type { WorkQueue } from "../work/queue";
import type { ChannelActivityEvent } from "./events";
import {
  GROUP_PERSON_SPEAKER,
  GROUP_TRANSCRIPT_HEADER,
} from "./group-transcript";

export const GROUP_TURN_KIND = "group.turn";

export type GroupMessage = typeof groupMessages.$inferSelect;
/**
 * A row as its own sender's frame reads it: plus what was held back for them (0128). A waiting
 * line's approval id is in there, and it is the one thing `list` has to hand back -- the page the
 * line links to needs a row to land on, and only the person who must decide has that row.
 */
export type GroupMessageWithHeld = GroupMessage & {
  held?: Record<string, unknown>;
};
export type GroupBot = {
  id: string;
  name: string;
  /**
   * An external employee's hirer (`device_acp`): its work, its card and its quota are that
   * person's, whoever in the group asked (spec §6).
   */
  hiredBy?: string;
  /** An external employee's agent (Codex, Claude Code…), for its mark: every member may read it. */
  harness?: "codex" | "claude-code" | "hermes" | "custom";
};

/**
 * One queued turn: who it is for, which Bots answer it, and how deep in a Bot-to-Bot chain it is.
 *
 * `depth` zero is a person's message. A peer turn carries the Bot that addressed it, so the trail and
 * the Bot's own framing say who handed it the conversation.
 */
export type GroupTurn = {
  ownerUserId: string;
  channelId: string;
  messageId: string;
  agentIds: string[];
  text: string;
  depth?: number;
  fromAgentId?: string;
  /**
   * The rest of a peer's reply when a hop carries only the part addressed to it (`relay`,
   * `addressedPart`): the peer's task is `text`, and this is what it was written next to -- context
   * for the task, not the task.
   */
  context?: string;
  /**
   * The question this message answers, when it is the person's answer to one a Bot here asked. The
   * transcript shows what they wrote; the Bot is told what it is an answer to, as a one-Bot
   * conversation tells it (`questionResponseMessage`).
   */
  inResponseTo?: string;
  /**
   * The followed card a person's decision on it said this message for (a 退回, `tasks/card-turns.ts`):
   * the addressed coworker's turn hangs on that card, not on the newest open one it holds here. Set by
   * server code only (`send`'s options), never from a request body.
   */
  taskId?: string;
};
const turnSchema = z.object({
  ownerUserId: z.string().min(1),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  agentIds: z.array(z.string().min(1)).min(1).max(20),
  text: z.string().min(1).max(16000),
  depth: z.number().int().nonnegative().optional(),
  fromAgentId: z.string().min(1).optional(),
  context: z.string().min(1).max(16000).optional(),
  inResponseTo: z.string().min(1).max(6000).optional(),
  taskId: z.string().uuid().optional(),
});

/**
 * The ids a person may give their own message.
 *
 * Every id the server derives in a group contains ':' -- a Bot's reply `<message>:<bot>`, a hand-off
 * `<reply>><peer>` (whose reply is one), a consent card `<reply>:consent:<server>`, a relayed answer
 * `handoff:<hash>` -- and message ids are global and readable by every member. So a person's own id
 * may contain neither ':' nor '>': otherwise a member who read another member's message id could
 * send under that message's Bot reply, hand-off or consent card id first, and the real one would
 * find its place taken (or its hand-off "already" queued) and never be written. The ids the app
 * mints are UUIDs, which contain neither.
 */
const PERSON_MESSAGE_ID = /^[^:>]+$/;
const PERSON_MESSAGE_ID_REFUSED = "A message id cannot contain ':' or '>'.";

/** Not a member, not a group, or gone. One answer for all three, so membership cannot be probed. */
export class GroupNotFoundError extends Error {
  constructor() {
    super("That group conversation was not found.");
    this.name = "GroupNotFoundError";
  }
}
/** A request that can never succeed as sent. */
export class GroupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupRefusedError";
  }
}

const MIN_GROUP_BOTS = 2;
const MAX_GROUP_BOTS = 20;
const CAP_REFUSED = `一个群最多 ${MAX_GROUP_BOTS} 位员工。`;
const FLOOR_REFUSED = `群里至少要留 ${MIN_GROUP_BOTS} 位员工。`;

export type GroupStore = {
  list(channelId: string): Promise<GroupMessageWithHeld[]>;
  thread(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<string>;
  /** A person's message, and its turn. Refuses an id a person may not choose (PERSON_MESSAGE_ID). */
  submit(turn: GroupTurn): Promise<void>;
  /**
   * The Bot's reply row for this turn, or what became of it: `taken` when the id is held by a row
   * that is not this turn's, so nothing about this Bot's answer is known or can be written.
   */
  start(
    turn: GroupTurn,
    agentId: string,
    threadId: string | null,
  ): Promise<"run" | "done" | "unknown" | "taken">;
  /**
   * The outcome of this turn's own Bot row. The shared row gets the status and the details every
   * member may read; a `waiting` row's text and other details are held for its sender alone
   * (`group_message_private`). Throws GroupNotFoundError when the row is no longer this frame's.
   */
  finish(
    id: string,
    text: string,
    status: GroupMessage["status"],
    details?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * The reply so far, while the Bot is still running: kept for its sender only, and shown by `list`
   * to them alone. A finished row is never overwritten.
   */
  progress(id: string, text: string): Promise<void>;
  /** Remember the order the person chose, by minting each Bot's thread in that order. */
  seedOrder(
    ownerUserId: string,
    channelId: string,
    agentIds: readonly string[],
  ): Promise<void>;
  /** The group's Bots in the order they were chosen. Bots with no thread yet are not listed. */
  order(channelId: string): Promise<string[]>;
  /** Every Bot linked to the group, as `channel_agents` holds them (not filtered by who may run them). */
  bots(channelId: string): Promise<string[]>;
  /** Link Bots to the group and give each a thread after the ones it already has, in the order given. */
  addBots(
    ownerUserId: string,
    channelId: string,
    agentIds: readonly string[],
  ): Promise<void>;
  /** Unlink Bots from the group and drop the caller's own thread rows for them. */
  removeBots(
    ownerUserId: string,
    channelId: string,
    agentIds: readonly string[],
  ): Promise<void>;
  /** Rewrite the caller's thread timestamps so the Bots answer in this order. */
  reorder(
    ownerUserId: string,
    channelId: string,
    agentIds: readonly string[],
  ): Promise<void>;
  /** The waiting row a paused approval belongs to, if it is a group turn's. */
  waitingFor(approvalId: string): Promise<GroupMessage | null>;
  /**
   * The peers among `peers` this conversation already lets this Bot hand work to without a new
   * approval: the framing says how to reach a peer, and a handoff the person has already allowed is
   * a way that works (`delegationFreed`).
   */
  delegationFreed(input: {
    ownerUserId: string;
    threadId: string;
    botId: string;
    peers: readonly string[];
  }): Promise<ReadonlySet<string>>;
  /** Which group thread a thread id is, for relaying an answer into the shared transcript. */
  threadRow(threadId: string): Promise<{
    ownerUserId: string;
    channelId: string;
    agentId: string;
  } | null>;
  /** Append a finished Bot line once; the same id again is a no-op. */
  append(row: {
    id: string;
    ownerUserId: string;
    channelId: string;
    agentId: string;
    threadId: string;
    text: string;
    status?: GroupMessage["status"];
    details: Record<string, unknown>;
  }): Promise<boolean>;
  /**
   * Add a person who has signed in here to a shared group, as the channel's own membership. Their
   * mapping to it is written by the channel store the first time they read it, in their own frame.
   */
  addMember(channelId: string, email: string): Promise<{ userId: string }>;
  /** Everyone who can read this group's transcript. */
  members(channelId: string): Promise<string[]>;
  /** The people in the group, first member (who made it) first. */
  people(
    channelId: string,
  ): Promise<{ userId: string; email: string; name: string | null }[]>;
  /**
   * Take a person out of the group: their membership, and their own mapping when they leave. `unlink`
   * names their own external employees in it, unlinked in the same transaction before the
   * membership goes (0218 lets a member unlink their own `device_acp` only while still a member; the
   * creator may unlink any Bot, 0128).
   */
  removeMember(
    channelId: string,
    userId: string,
    unlink?: readonly string[],
  ): Promise<void>;
};

/** The executor `database.transaction` hands its callback, which reads like the database itself. */
type GroupExecutor =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The stamp a group's own rows carry: `team` when the channel is a shared group (G01-E), so every
 * member reads the transcript and the threads in their own frame; otherwise nothing, and the row
 * takes the writer's frame as it always did (a person's own multi-Bot channel).
 *
 * Read through the writer's row security. A channel they cannot see (they were taken out of the
 * group, its row is gone, or it was never theirs) is GroupNotFoundError, never a fallback: a row
 * with no stamp takes the writer's own, which their own tenant's policy admits, so falling back
 * would file a removed member's queued turn into the group under their name.
 */
async function stampFor(
  database: GroupExecutor,
  channelId: string,
): Promise<{ tenantId?: typeof TEAM_TENANT }> {
  const [row] = await database
    .select({ tenantId: channels.tenantId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!row) throw new GroupNotFoundError();
  return row.tenantId === TEAM_TENANT ? { tenantId: TEAM_TENANT } : {};
}

/** The group's Bots, read under a lock on the channel row so concurrent changes line up one by one. */
async function lockedBots(tx: GroupExecutor, channelId: string) {
  await tx
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.id, channelId))
    .for("update");
  const rows = await tx
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, channelId));
  return rows.map((row) => row.agentId);
}

/** The given Bots in the order `order` ranks them: earliest thread row first, ties by id. */
async function rankedBots(
  tx: GroupExecutor,
  channelId: string,
  bots: readonly string[],
) {
  const rows = await tx
    .select({
      agentId: groupBotThreads.agentId,
      first: min(groupBotThreads.createdAt),
    })
    .from(groupBotThreads)
    .where(eq(groupBotThreads.channelId, channelId))
    .groupBy(groupBotThreads.agentId);
  const at = new Map(rows.map((row) => [row.agentId, row.first?.getTime()]));
  const rank = (id: string) => at.get(id) ?? Number.POSITIVE_INFINITY;
  return [...bots].sort(
    (left, right) =>
      (rank(left) === rank(right) ? 0 : rank(left) < rank(right) ? -1 : 1) ||
      left.localeCompare(right),
  );
}

/**
 * Stamp the caller's own thread rows a millisecond apart in this order, starting from the earliest
 * row anyone in the group has, so the caller's position is each Bot's earliest row. A Bot with no
 * row of the caller's gets one.
 */
async function writeOrder(
  mintThread: () => string,
  tx: GroupExecutor,
  ownerUserId: string,
  channelId: string,
  stamp: { tenantId?: typeof TEAM_TENANT },
  agentIds: readonly string[],
) {
  const [earliest] = await tx
    .select({ at: min(groupBotThreads.createdAt) })
    .from(groupBotThreads)
    .where(eq(groupBotThreads.channelId, channelId));
  const base = earliest?.at?.getTime() ?? Date.now();
  for (const [index, agentId] of agentIds.entries()) {
    const createdAt = new Date(base + index);
    const updated = await tx
      .update(groupBotThreads)
      .set({ createdAt })
      .where(
        and(
          eq(groupBotThreads.channelId, channelId),
          eq(groupBotThreads.ownerUserId, ownerUserId),
          eq(groupBotThreads.agentId, agentId),
        ),
      )
      .returning({ agentId: groupBotThreads.agentId });
    if (updated.length === 0)
      await tx.insert(groupBotThreads).values({
        ownerUserId,
        channelId,
        agentId,
        threadId: mintThread(),
        createdAt,
        ...stamp,
      });
  }
}

/**
 * The detail keys every member of a group may read on a shared row: what `list` shows (the reason a
 * line waits, a relayed answer's Bot, a consent card) and a person message's Bot choice. Everything
 * else a row is given -- a held reply and its continuation, an approval id, a wait's saved
 * conversation, the Bot-to-Bot chain -- is the sender's alone and goes to `group_message_private`
 * (0128), stamped with them.
 */
const SHARED_DETAILS: ReadonlySet<string> = new Set([
  "acpPermission",
  "shareWait",
  "agentIds",
  "answeredBy",
  "compaction",
  "consent",
  "delivery",
  "message",
  "plan",
  "reasoning",
  "stepLimit",
  "turnArtifacts",
  "via",
]);

/**
 * 这一轮开始前，这位员工在发起人那条线程上的上下文自动压缩了（`done`）或没压成（`failed`），记在回复行的
 * `details.compaction` 上（运行流里的 `xiongbao.compaction.*` 事件，见 `threads/compaction.ts`）。读的时候只
 * 交给发起人（压的是他和这位员工的线程），侧栏据此马上刷新、提示一次。
 */
type GroupCompactionNote = { outcome: "done" | "failed" };

function isCompactionNote(value: unknown): value is GroupCompactionNote {
  const outcome = (value as { outcome?: unknown } | null | undefined)?.outcome;
  return outcome === "done" || outcome === "failed";
}

/**
 * 团队机器人弹的授权卡片，`details.consent` 里记的就是这两个 id（见 `postConsents`）。
 *
 * `details` 是 JSON 列，读回来能证明的只有「是个对象」，于是 `list()` 一直把 `consent` 说成 `object`——
 * 调用方明知道里面有 `serverId` 也取不到。这里把写入方写的东西命名出来，读的时候仍按结构判一次，两个字段
 * 缺失或不是字符串就不认（旧行、别处写进来的东西都不算卡片）。
 */
type GroupConsentCard = { botId?: string; serverId?: string };

function isConsentCard(value: unknown): value is GroupConsentCard {
  if (!value || typeof value !== "object") return false;
  const { botId, serverId } = value as { botId?: unknown; serverId?: unknown };
  return (
    (botId === undefined || typeof botId === "string") &&
    (serverId === undefined || typeof serverId === "string")
  );
}

/**
 * 这一轮员工跑满了步数、被收尾（期一）：运行流里 `RUN_FINISHED` 前那条 `step-limit {steps}`
 * （`shared/run-notices.ts`），记在回复行的 `details.stepLimit` 上。只有步数，不带内容，群里每个人读到的一样；
 * 群聊末尾据此给「已用完 N 步 · 继续」（`app/src/components/channels/group-chat.tsx` `groupStepLimit`）。
 */
type GroupStepLimit = { steps: number };

function isStepLimit(value: unknown): value is GroupStepLimit {
  const steps = (value as { steps?: unknown } | null | undefined)?.steps;
  return typeof steps === "number" && Number.isInteger(steps) && steps > 0;
}

function stepLimitOf(name: string, value: unknown): GroupStepLimit | null {
  if (name !== STEP_LIMIT_EVENT || !isStepLimit(value)) return null;
  return { steps: value.steps };
}

const withStepLimit = (limit: GroupStepLimit | null) =>
  limit ? { stepLimit: limit } : {};

/**
 * 这一轮员工在自己电脑上留下的文件（`computer.turn_artifacts`，服务器在每次 run 收尾前插的那条），记在回复行的
 * `details.turnArtifacts` 上：每条连同它所在的 run（下载路由只认「列出这个路径的那条事件所在的 run」）。
 *
 * 读的是 `runTurn` 的 `onCustom`，那是服务器清洗过之后的流：员工自己流里伪造的这类事件在入库前已被丢掉
 * （`threads/run-side-events.ts`）。这里再核一次员工：事件说的不是这位员工，就不记。`seat` 不记：它是
 * 下载路由自己从那个 run 的事件里还原的，群里其他人不需要读到。群聊据此画「本轮产物」
 * （`app/src/components/channels/group-chat.tsx`）。
 */
type GroupTurnArtifacts = {
  runId: string;
  value: {
    botId: string;
    files: TurnArtifact[];
    scanned: number;
    scanTruncated: boolean;
    omitted: number;
  };
};

function turnArtifactsOf(
  name: string,
  value: unknown,
  agentId: string,
  runId: string,
): GroupTurnArtifacts | null {
  if (name !== TURN_ARTIFACTS_EVENT || runId === "") return null;
  const body = value as Record<string, unknown> | null;
  if (!body || body.botId !== agentId || !Array.isArray(body.files))
    return null;
  const files = body.files.flatMap((raw): TurnArtifact[] => {
    const file = raw as Partial<TurnArtifact> | null;
    if (!file || typeof file.path !== "string" || file.path === "") return [];
    return [
      {
        path: file.path,
        bytes: Number.isFinite(file.bytes) ? Number(file.bytes) : 0,
        modifiedMs: Number.isFinite(file.modifiedMs)
          ? Number(file.modifiedMs)
          : 0,
        change: file.change === "modified" ? "modified" : "new",
      },
    ];
  });
  if (files.length === 0) return null;
  const omitted = Number(body.omitted);
  return {
    runId,
    value: {
      botId: agentId,
      files,
      scanned: Number.isFinite(Number(body.scanned)) ? Number(body.scanned) : 0,
      scanTruncated: body.scanTruncated === true,
      omitted: Number.isFinite(omitted) && omitted > 0 ? omitted : 0,
    },
  };
}

/** 回复行上已记的（读回来的 JSON 列，按结构再判一次）。 */
function storedTurnArtifacts(value: unknown): GroupTurnArtifacts[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = entry as { runId?: unknown; value?: { botId?: unknown } };
    if (
      typeof item?.runId !== "string" ||
      typeof item.value?.botId !== "string"
    )
      return [];
    return (
      turnArtifactsOf(
        TURN_ARTIFACTS_EVENT,
        item.value,
        item.value.botId,
        item.runId,
      ) ?? []
    );
  });
}

const withTurnArtifacts = (items: readonly GroupTurnArtifacts[]) =>
  items.length > 0 ? { turnArtifacts: [...items] } : {};

/**
 * 这位员工这一轮最后一份计划（期二）：它最后一次 `update_plan` 调用里能读成计划的参数（`shared/plan.ts`），记在
 * 回复行的 `details.plan` 上。只有清单，群里每个人读到的一样，群聊顶部据此给每位员工钉一张计划卡
 * （`app/src/components/channels/pinned-plans.tsx`）。读不成计划的调用不算，留着上一份。
 */
function planOf(name: string, args: unknown): PlanItem[] | null {
  return name === UPDATE_PLAN_TOOL ? (readPlan(args) ?? null) : null;
}

/**
 * 这位员工这一轮想了什么、想了多久（期三）：各段推理连在一起，记在回复行的 `details.reasoning` 上，最长
 * `REASONING_TEXT_LIMIT` 字，超过截断并注明（`shared/thinking.ts`）。群里每个人读到的一样，群聊在这一行
 * 上方画折起来的「思考」块（`app/src/components/channels/group-chat.tsx`）。外部员工的轮次不记。
 */
const withReasoning = (reasoning: StoredReasoning | null) =>
  reasoning ? { reasoning } : {};

const withPlan = (plan: readonly PlanItem[] | null) =>
  plan ? { plan: [...plan] } : {};

function compactionNoteOf(name: string): GroupCompactionNote | null {
  if (name === COMPACTION_DONE_EVENT) return { outcome: "done" };
  if (name === COMPACTION_FAILED_EVENT) return { outcome: "failed" };
  return null;
}

/**
 * 这一轮里员工走到了三步里的哪一步（交付闭环 Task 9：接下、申请延期、交付、被挡回），在回复行的
 * `details.delivery` 上记一个**不带内容的状态标记**：哪一步、哪张卡、几点、哪位员工，接下和申请延期再带
 * 预计时间。验收标准、交付物、结论、自查、延期理由、挡回原因一概不进群回复：卡片按租户隔离（规格第 6 节
 * 「不做跨租户可见」），完整内容只有派活的人从卡片接口和流水读（`GET /api/tasks/:id`、`/events`）；群里
 * 其他人只读到一行状态。
 *
 * 标记不带内容，所以不受分享检查约束：直接发出、等你放行、放行或不放行、轮次中途等工具审批再恢复，每条
 * 路径都把标记记在这一行上（回复正文照分享检查显示或隐藏）。外部员工的轮次（`detached`）不记。
 */
export type GroupDeliveryMark = {
  kind: "accepted" | "extension_requested" | "delivered" | "bounced";
  taskId: string;
  /** 服务器收到这一步的时刻（ISO）。 */
  at: string;
  agentId: string;
  /** 接下时报的、申请延期要延到的预计时间（ISO）；没有就不带。 */
  dueAt?: string;
  /**
   * 卡片流水里这一步那一行的 id（`delivery.*` 事件带的 `eventId`）：派活人按它把标记对回流水，不按时间、
   * 不按内容猜。只是一个号码，群里别人拿着它也读不到卡片（流水按租户隔离）。老事件没有就不带。
   */
  eventId?: string;
};

const MARK_KINDS: Readonly<Record<string, GroupDeliveryMark["kind"]>> = {
  [DELIVERY_EVENTS.accepted]: "accepted",
  [DELIVERY_EVENTS.extensionRequested]: "extension_requested",
  [DELIVERY_EVENTS.delivered]: "delivered",
  [DELIVERY_EVENTS.bounced]: "bounced",
};

const isTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

/** 流水行的 id：一个 uuid，别的不收。 */
const isEventId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** 一条员工流里的卡片事件，换成只记状态的标记；不是交付卡事件为 null。 */
export function deliveryMarkOf(
  name: string,
  value: unknown,
  agentId: string,
  at: Date,
): GroupDeliveryMark | null {
  const kind = MARK_KINDS[name];
  if (!kind || !value || typeof value !== "object" || Array.isArray(value))
    return null;
  const { taskId, dueAt, eventId } = value as {
    taskId?: unknown;
    dueAt?: unknown;
    eventId?: unknown;
  };
  if (typeof taskId !== "string" || !taskId) return null;
  const timed = kind === "accepted" || kind === "extension_requested";
  return {
    kind,
    taskId,
    at: at.toISOString(),
    agentId,
    ...(timed && isTime(dueAt) ? { dueAt } : {}),
    ...(isEventId(eventId) ? { eventId } : {}),
  };
}

const MARK_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "taskId",
  "at",
  "agentId",
  "dueAt",
  "eventId",
]);

/** 行上记着的标记；只认形状完全对的，多出任何字段的整条不要。 */
function marksOf(details: Record<string, unknown>): GroupDeliveryMark[] {
  const value = details.delivery;
  if (!Array.isArray(value)) return [];
  return value.filter((mark): mark is GroupDeliveryMark => {
    if (!mark || typeof mark !== "object") return false;
    const record = mark as Record<string, unknown>;
    return (
      Object.keys(record).every((key) => MARK_KEYS.has(key)) &&
      Object.values(MARK_KINDS).includes(record.kind as never) &&
      typeof record.taskId === "string" &&
      isTime(record.at) &&
      typeof record.agentId === "string" &&
      (record.dueAt === undefined || isTime(record.dueAt)) &&
      (record.eventId === undefined || isEventId(record.eventId))
    );
  });
}

const withMarks = (marks: readonly GroupDeliveryMark[]) =>
  marks.length > 0 ? { delivery: [...marks] } : {};

/**
 * 外部员工在群里请求许可时，群转录里那一行（外部员工 Task 12）：只说谁在等谁确认、结果如何。命令、路径、
 * 改动的文件、命中的规则、审批 id 一律不放：许可只有招聘人批（spec §6），内容在他自己的审批里，群里其他
 * 人只该知道「在等」。
 */
export type GroupAcpPermission = {
  kind: "acp.permission";
  agentId: string;
  hirerUserId: string;
  hirerName: string;
  status: "waiting" | "approved" | "denied" | "expired";
};

const ACP_PERMISSION_STATUSES = new Set<GroupAcpPermission["status"]>([
  "waiting",
  "approved",
  "denied",
  "expired",
]);

/** 读回来时只认这几个键，别的（万一写进了什么）一律不交出去。 */
export function groupAcpPermissionOf(
  value: unknown,
): GroupAcpPermission | null {
  if (!value || typeof value !== "object") return null;
  const line = value as Record<string, unknown>;
  if (
    line.kind !== "acp.permission" ||
    typeof line.agentId !== "string" ||
    typeof line.hirerUserId !== "string" ||
    typeof line.hirerName !== "string" ||
    !ACP_PERMISSION_STATUSES.has(line.status as GroupAcpPermission["status"])
  )
    return null;
  return {
    kind: "acp.permission",
    agentId: line.agentId,
    hirerUserId: line.hirerUserId,
    hirerName: line.hirerName,
    status: line.status as GroupAcpPermission["status"],
  };
}

/**
 * 那一行的 id：由审批 id 派生、但看不出审批 id（行 id 每个成员都读得到，审批 id 是把一次决定接回那一轮的
 * 钥匙，只属于招聘人）。
 */
export function groupAcpPermissionRowId(approvalId: string): string {
  return `acp-permission:${createHash("sha256")
    .update(approvalId)
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * 「群的转录变了，重读一下」：不带任何内容（没有预览、没有说话人），前端只拿它去重读这个群
 * （`groupTranscript`，app 的 `use-channel-events.ts`）。
 */
export function groupTranscriptEvent(
  channelId: string,
  memberIds: string[],
): ChannelActivityEvent {
  return {
    channelId,
    memberIds,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    groupTranscript: true,
  };
}

function splitDetails(details: Record<string, unknown>) {
  const shared: Record<string, unknown> = {};
  const held: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details))
    (SHARED_DETAILS.has(key) ? shared : held)[key] = value;
  return { shared, held };
}

/** The sender's private part of a reply that waits on them, written or replaced. */
async function holdBack(
  database: GroupExecutor,
  row: {
    messageId: string;
    ownerUserId: string;
    text: string;
    details: Record<string, unknown>;
  },
) {
  await database
    .insert(groupMessagePrivate)
    // Stamped with the sender, never left to the writer's frame: only the sender reads it.
    .values({ ...row, tenantId: row.ownerUserId })
    .onConflictDoUpdate({
      target: groupMessagePrivate.messageId,
      set: { text: row.text, details: row.details, updatedAt: new Date() },
    });
}

export function createGroupStore(
  database: Database,
  mintThread: () => string,
): GroupStore {
  return {
    async list(channelId) {
      const rows = await database
        .select({
          message: groupMessages,
          partial: groupMessagePrivate.text,
          held: groupMessagePrivate.details,
        })
        .from(groupMessages)
        /*
         * A running reply's partial text is its sender's (0128): the reader's own row security
         * returns it for their own Bots' replies and nothing for anybody else's. The same holds for
         * the details held back on a waiting row -- for this reader that is the approval id their
         * own line waits on, and for every other member there is no row here at all.
         */
        .leftJoin(
          groupMessagePrivate,
          and(
            eq(groupMessagePrivate.messageId, groupMessages.id),
            eq(groupMessagePrivate.ownerUserId, groupMessages.ownerUserId),
          ),
        )
        .where(eq(groupMessages.channelId, channelId))
        .orderBy(desc(groupMessages.createdAt), desc(groupMessages.id))
        .limit(200);
      return rows.reverse().map(({ message, partial, held }) => {
        const running = message.status === "running" && partial !== null;
        if (!running && held === null) return message;
        return {
          ...message,
          ...(running && partial !== null ? { text: partial } : {}),
          ...(held === null ? {} : { held: held as Record<string, unknown> }),
        };
      });
    },
    async thread(ownerUserId, channelId, agentId) {
      const scope = and(
        eq(groupBotThreads.ownerUserId, ownerUserId),
        eq(groupBotThreads.channelId, channelId),
        eq(groupBotThreads.agentId, agentId),
      );
      await database
        .insert(groupBotThreads)
        .values({
          ownerUserId,
          channelId,
          agentId,
          threadId: mintThread(),
          ...(await stampFor(database, channelId)),
        })
        .onConflictDoNothing();
      const [row] = await database
        .select()
        .from(groupBotThreads)
        .where(scope)
        .limit(1);
      if (!row)
        throw new Error("The Bot's group conversation could not be created.");
      return row.threadId;
    },
    async submit(turn) {
      if (!PERSON_MESSAGE_ID.test(turn.messageId))
        throw new GroupRefusedError(PERSON_MESSAGE_ID_REFUSED);
      await database.transaction((tx) => submitGroupTurn(tx, turn));
    },
    async start(turn, agentId, threadId) {
      const id = `${turn.messageId}:${agentId}`;
      const [created] = await database
        .insert(groupMessages)
        .values({
          id,
          channelId: turn.channelId,
          ownerUserId: turn.ownerUserId,
          agentId,
          threadId,
          text: "",
          status: "running",
          ...(await stampFor(database, turn.channelId)),
        })
        .onConflictDoNothing()
        .returning({ id: groupMessages.id });
      if (created) return "run";
      const [row] = await database
        .select()
        .from(groupMessages)
        .where(eq(groupMessages.id, id))
        .limit(1);
      /*
       * The id is taken. Only this turn's own row says what happened to it: a row this frame cannot
       * see, or one that is somebody else's, means another person occupied the id (written before
       * PERSON_MESSAGE_ID, or past the service), and nothing about this Bot's answer is known.
       * Never "done": that would drop the reply without a word.
       */
      if (
        !row ||
        row.ownerUserId !== turn.ownerUserId ||
        row.channelId !== turn.channelId ||
        row.agentId !== agentId
      )
        return "taken";
      return row.status === "running" ? "unknown" : "done";
    },
    async finish(id, text, status, details = {}) {
      /*
       * The shared row gets the status and what every member may read. A reply that waits keeps
       * its text and the wait's details in the sender's private row; any other outcome is the
       * reply itself, shown to the group, and the private row (partial text, a held reply) goes.
       */
      const { shared, held } = splitDetails(details);
      const waiting = status === "waiting";
      await database.transaction(async (tx) => {
        const [row] = await tx
          .update(groupMessages)
          .set({ text: waiting ? "" : text, status, details: shared })
          .where(eq(groupMessages.id, id))
          .returning({ ownerUserId: groupMessages.ownerUserId });
        // Our own row, written by this turn: gone or refused means the group is no longer ours.
        if (!row) throw new GroupNotFoundError();
        if (waiting)
          await holdBack(tx, {
            messageId: id,
            ownerUserId: row.ownerUserId,
            text,
            details: held,
          });
        else
          await tx
            .delete(groupMessagePrivate)
            .where(eq(groupMessagePrivate.messageId, id));
      });
    },
    async progress(id, text) {
      // Into the sender's private row, and only while the shared row is still running.
      // Stamped with the sender, as `holdBack` stamps a held reply, whatever frame writes it.
      await database.execute(sql`
        insert into ${groupMessagePrivate} (message_id, owner_user_id, tenant_id, text)
        select ${groupMessages.id}, ${groupMessages.ownerUserId}, ${groupMessages.ownerUserId}, ${text}
          from ${groupMessages}
         where ${groupMessages.id} = ${id} and ${groupMessages.status} = 'running'
        on conflict (message_id) do update set text = excluded.text, updated_at = now()`);
    },
    async seedOrder(ownerUserId, channelId, agentIds) {
      // Explicit timestamps a millisecond apart, so the order survives rows written in one instant.
      const base = Date.now();
      const stamp = await stampFor(database, channelId);
      for (const [index, agentId] of agentIds.entries())
        await database
          .insert(groupBotThreads)
          .values({
            ownerUserId,
            channelId,
            agentId,
            threadId: mintThread(),
            createdAt: new Date(base + index),
            ...stamp,
          })
          .onConflictDoNothing();
    },
    async order(channelId) {
      const rows = await database
        .select({
          agentId: groupBotThreads.agentId,
          first: min(groupBotThreads.createdAt),
        })
        .from(groupBotThreads)
        .where(eq(groupBotThreads.channelId, channelId))
        .groupBy(groupBotThreads.agentId)
        .orderBy(
          asc(min(groupBotThreads.createdAt)),
          asc(groupBotThreads.agentId),
        );
      return rows.map((row) => row.agentId);
    },
    async bots(channelId) {
      const rows = await database
        .select({ agentId: channelAgents.agentId })
        .from(channelAgents)
        .where(eq(channelAgents.channelId, channelId))
        .orderBy(asc(channelAgents.agentId));
      return rows.map((row) => row.agentId);
    },
    async addBots(ownerUserId, channelId, agentIds) {
      await database.transaction(async (tx) => {
        const stamp = await stampFor(tx, channelId);
        const current = await lockedBots(tx, channelId);
        if (current.length + agentIds.length > MAX_GROUP_BOTS)
          throw new GroupRefusedError(CAP_REFUSED);
        await tx
          .insert(channelAgents)
          .values(agentIds.map((agentId) => ({ channelId, agentId, ...stamp })))
          .onConflictDoNothing();
        // The creator's rows are rewritten for the whole roster, not only the new Bots: other
        // members' older rows (which they alone can delete) would otherwise outrank a re-added
        // Bot's new row in `order`, which ranks each Bot by its earliest row.
        const ranked = await rankedBots(tx, channelId, current);
        await writeOrder(mintThread, tx, ownerUserId, channelId, stamp, [
          ...ranked,
          ...agentIds,
        ]);
      });
    },
    async removeBots(ownerUserId, channelId, agentIds) {
      await database.transaction(async (tx) => {
        // Two removals racing would each see enough Bots left and together leave the group short.
        const current = await lockedBots(tx, channelId);
        if (current.length - agentIds.length < MIN_GROUP_BOTS)
          throw new GroupRefusedError(FLOOR_REFUSED);
        const removed = await tx
          .delete(channelAgents)
          .where(
            and(
              eq(channelAgents.channelId, channelId),
              inArray(channelAgents.agentId, [...agentIds]),
            ),
          )
          .returning({ agentId: channelAgents.agentId });
        // Row security lets only the creator unlink a Bot; none removed means it was refused.
        if (removed.length !== agentIds.length) throw new GroupNotFoundError();
        // Only this person's own rows are theirs to delete; other members' stale rows only affect
        // ranking, and the roster is read through `channel_agents`.
        await tx
          .delete(groupBotThreads)
          .where(
            and(
              eq(groupBotThreads.channelId, channelId),
              eq(groupBotThreads.ownerUserId, ownerUserId),
              inArray(groupBotThreads.agentId, [...agentIds]),
            ),
          );
      });
    },
    async reorder(ownerUserId, channelId, agentIds) {
      await database.transaction(async (tx) => {
        const stamp = await stampFor(tx, channelId);
        await writeOrder(
          mintThread,
          tx,
          ownerUserId,
          channelId,
          stamp,
          agentIds,
        );
      });
    },
    async waitingFor(approvalId) {
      const [row] = await database
        .select({ message: groupMessages, held: groupMessagePrivate.details })
        .from(groupMessages)
        // The approval id is in the sender's private row (0128), which only the sender reads.
        .innerJoin(
          groupMessagePrivate,
          and(
            eq(groupMessagePrivate.messageId, groupMessages.id),
            eq(groupMessagePrivate.ownerUserId, groupMessages.ownerUserId),
          ),
        )
        .where(
          and(
            eq(groupMessages.status, "waiting"),
            /*
             * Whatever the turn waits on: an approval, or (期九·三) a sign-in request or a wait at the
             * computer, each named by its own id in the suspension the row was written from.
             */
            sql`(${groupMessagePrivate.details}->>'approvalId' = ${approvalId}
              or ${groupMessagePrivate.details}->>'signInRequestId' = ${approvalId}
              or ${groupMessagePrivate.details}->>'waitId' = ${approvalId})`,
            /*
             * The decider's own row only. In a shared group every member reads every row, and an
             * approval id is the one thing that ties a decision to the turn it resumes: another
             * member's waiting row is theirs to resume, in their frame, never this one's.
             */
            eq(groupMessages.ownerUserId, currentTenant()),
          ),
        )
        .limit(1);
      return row
        ? {
            ...row.message,
            details: { ...row.message.details, ...row.held },
          }
        : null;
    },
    async delegationFreed(input) {
      return readDelegationFreed(database, input);
    },
    async threadRow(threadId) {
      const [row] = await database
        .select({
          ownerUserId: groupBotThreads.ownerUserId,
          channelId: groupBotThreads.channelId,
          agentId: groupBotThreads.agentId,
        })
        .from(groupBotThreads)
        .where(eq(groupBotThreads.threadId, threadId))
        .limit(1);
      return row ?? null;
    },
    async append(row) {
      const stamp = await stampFor(database, row.channelId);
      const { shared, held } = splitDetails(row.details);
      const waiting = row.status === "waiting";
      return database.transaction(async (tx) => {
        const created = await tx
          .insert(groupMessages)
          .values({
            status: "completed",
            ...row,
            // A line that waits shows the group nothing yet; its text is held with the sender.
            text: waiting ? "" : row.text,
            details: shared,
            ...stamp,
          })
          .onConflictDoNothing()
          .returning({ id: groupMessages.id });
        // A waiting line's text and details, or a finished line's private part (a status line's
        // approval id): its sender's alone.
        if (created.length > 0 && (waiting || Object.keys(held).length > 0))
          await holdBack(tx, {
            messageId: row.id,
            ownerUserId: row.ownerUserId,
            text: row.text,
            details: held,
          });
        return created.length > 0;
      });
    },
    async members(channelId) {
      const rows = await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId));
      return rows.map((row) => row.userId);
    },
    async people(channelId) {
      return database
        .select({
          userId: channelMemberships.userId,
          email: users.email,
          name: users.name,
        })
        .from(channelMemberships)
        .innerJoin(users, eq(users.id, channelMemberships.userId))
        .where(eq(channelMemberships.channelId, channelId))
        .orderBy(asc(channelMemberships.createdAt), asc(users.email));
    },
    async removeMember(channelId, userId, unlink = []) {
      await database.transaction(async (tx) => {
        // Their own external employees first, while row security still counts them a member.
        if (unlink.length > 0)
          await tx
            .delete(channelAgents)
            .where(
              and(
                eq(channelAgents.channelId, channelId),
                inArray(channelAgents.agentId, [...unlink]),
              ),
            );
        /*
         * Row security decides who may: the member themselves, or the person who started the group
         * while still in it (0122). A refusal deletes nothing and says so, rather than reporting a
         * removal that did not happen.
         */
        const removed = await tx
          .delete(channelMemberships)
          .where(
            and(
              eq(channelMemberships.channelId, channelId),
              eq(channelMemberships.userId, userId),
            ),
          )
          .returning({ userId: channelMemberships.userId });
        if (removed.length === 0) throw new GroupNotFoundError();
        /*
         * The mapping is the person's own row, stamped with them, so only they can delete it: when
         * they leave. Someone taken out keeps a mapping that leads nowhere (every read joins the
         * membership), and finds it again if they are added back.
         */
        if (userId === currentTenant())
          await tx
            .delete(intelligenceChannelMappings)
            .where(
              and(
                eq(intelligenceChannelMappings.channelId, channelId),
                eq(intelligenceChannelMappings.userId, userId),
              ),
            );
      });
    },
    async addMember(channelId, email) {
      const [person] = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
        .limit(1);
      if (!person)
        throw new GroupRefusedError(
          "Nobody with that email has signed in to this deployment yet.",
        );
      /*
       * Only a shared group takes other people (G01-E). A person's own channel is stamped with them,
       * so a membership written into it for somebody else would be a row that somebody else can
       * never read: they would be "in" a conversation they cannot open.
       */
      if ((await stampFor(database, channelId)).tenantId !== TEAM_TENANT)
        throw new GroupRefusedError(
          "Only a group conversation started here can have other people added to it.",
        );
      // Stamped `team` from the inviter's frame; the inviter is a member, which is what admits it.
      const added = await database
        .insert(channelMemberships)
        .values({ channelId, userId: person.id, tenantId: TEAM_TENANT })
        .onConflictDoNothing()
        .returning({ userId: channelMemberships.userId });
      if (added.length > 0) return { userId: person.id };
      /*
       * Nothing written: the key (channel, person) is taken. Adding someone already in the group is
       * the same fact twice. Anything else -- a row this frame cannot see holding that person's
       * key -- means they are NOT in the group, and saying they were added would be a lie (I9).
       */
      const [member] = await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, person.id),
            eq(channelMemberships.tenantId, TEAM_TENANT),
          ),
        )
        .limit(1);
      if (!member)
        throw new Error(
          "That person could not be added to this group: their place in it is taken by a row it cannot read.",
        );
      return { userId: person.id };
    },
  };
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A person's message to the group, and the turn that answers it, inside the caller's transaction.
 *
 * The same send twice (a retry after a dropped response) is one message. A different send reusing
 * its id is refused rather than merged. Also how a person's answer to a Bot's question reaches the
 * group (`approvals/questions.ts`), in the transaction that closes the question, so a question is
 * never closed without its answer being posted.
 */
export async function submitGroupTurn(tx: Transaction, turn: GroupTurn) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`group:${turn.messageId}`}))`,
  );
  const [existing] = await tx
    .select()
    .from(groupMessages)
    .where(eq(groupMessages.id, turn.messageId))
    .limit(1);
  if (existing) {
    if (
      existing.ownerUserId !== turn.ownerUserId ||
      existing.channelId !== turn.channelId ||
      existing.text !== turn.text ||
      JSON.stringify(existing.details.agentIds) !==
        JSON.stringify(turn.agentIds)
    )
      throw new GroupRefusedError(
        "This group message belongs to a different request.",
      );
    return;
  }
  await tx.insert(groupMessages).values({
    id: turn.messageId,
    ownerUserId: turn.ownerUserId,
    channelId: turn.channelId,
    text: turn.text,
    details: { agentIds: turn.agentIds },
    // A shared group's messages are the team's; anyone else's are the sender's, by the frame (G01).
    ...(await stampFor(tx, turn.channelId)),
  });
  // The turn is the sender's work, stamped with them by the frame: it runs as them.
  await tx
    .insert(workItems)
    .values({ kind: GROUP_TURN_KIND, key: turn.messageId, payload: turn })
    .onConflictDoNothing();
  await tx.execute(
    sql`select pg_notify('xiongbao_work_offered', ${GROUP_TURN_KIND})`,
  );
}

/**
 * Which group a Bot's group thread belongs to, for a run that thread is carrying.
 *
 * The coordination callbacks (`message_bot`, `ask_person`) authorise a run by its source thread, and a
 * group thread is in `group_bot_threads` rather than `intelligence_channel_mappings`. Resolved with the
 * same checks: the run's actor still a member of a live channel, and the thread that Bot's own, unless
 * the run is a signed delegation whose claim proves a different Bot's authority.
 */
export async function groupSourceForRun(
  database: Database,
  run: { threadId?: string; actorId: string; botId: string; handoff?: unknown },
): Promise<{ channelId: string; botId: string } | null> {
  if (!run.threadId) return null;
  const [row] = await database
    .select({
      channelId: groupBotThreads.channelId,
      botId: groupBotThreads.agentId,
    })
    .from(groupBotThreads)
    .innerJoin(channels, eq(channels.id, groupBotThreads.channelId))
    // A Bot taken out of the group keeps its thread row, but no authority over the group.
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, groupBotThreads.channelId),
        eq(channelAgents.agentId, groupBotThreads.agentId),
      ),
    )
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, groupBotThreads.channelId),
        eq(channelMemberships.userId, run.actorId),
      ),
    )
    .where(
      and(
        eq(groupBotThreads.threadId, run.threadId),
        eq(groupBotThreads.ownerUserId, run.actorId),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return row.botId === run.botId || run.handoff ? row : null;
}

/**
 * The user message a Bot's group turn starts from: what it is being asked, then the shared
 * transcript, labelled as quoted data so a peer's words cannot pose as the person or grant anything.
 */
export function groupTurnMessage(
  id: string,
  text: string,
  transcript: ReadonlyArray<
    Pick<GroupMessage, "id" | "agentId" | "text"> &
      Partial<Pick<GroupMessage, "details">>
  >,
  names: ReadonlyMap<string, string> = new Map(),
  exclude: ReadonlySet<string> = new Set(),
): Message {
  const prior = transcript
    .filter((row) => row.id !== id && !exclude.has(row.id) && row.text)
    .slice(-40)
    .map((row) => {
      /*
       * A `message_bot` answer is written in the asking Bot's row, because that is the voice its
       * thread admits, and `details.answeredBy` names the Bot whose words they are (`announceHandoff`).
       * Quoted as the asking Bot's, the answer read to every Bot here as that Bot's own.
       */
      const answeredBy = (row.details as { answeredBy?: unknown } | undefined)
        ?.answeredBy;
      const speakerId =
        typeof answeredBy === "string" ? answeredBy : row.agentId;
      return {
        speaker: speakerId
          ? (names.get(speakerId) ?? speakerId)
          : GROUP_PERSON_SPEAKER,
        text: row.text.slice(0, 6000),
      };
    });
  return {
    id,
    role: "user",
    content: prior.length
      ? `${text}\n\n${GROUP_TRANSCRIPT_HEADER}\n${JSON.stringify(prior)}`
      : text,
  };
}

/**
 * The framing every group turn opens with: who this Bot is among its peers, and how a request
 * reaches one of them.
 *
 * A function rather than a template beside its call, so the wording is testable without a database
 * and a queue, and so the two halves that must stay true together — "answer only your own part"
 * and "here is how you reach a peer" — cannot drift apart in one place and not the other.
 *
 * WHY IT HAS TO SAY HOW. `relay` reads `@name` off a reply and starts that peer's turn; nothing
 * else in a reply reaches anybody. But the same run also holds `message_bot`, which reads like the
 * better tool for the job, and on 2026-11-15 (L4-3) a group turn called it correctly — the right
 * Bot, the right task — and stopped on an approval this conversation never shows anybody. A group
 * turn has nobody's page open, so the approval is never given, the work is never sent, and the Bot
 * still told the person it had dispatched everything. A Bot told only "do not promise" reaches for
 * the tool anyway; a Bot told which one works does not need the warning, so both are here.
 *
 * The example name is a real peer, and the rule is left out when there is none: a room of one has
 * nobody to address, and an invented example is a name the Bot would write into a group that does
 * not have that member.
 *
 * AND WHERE IT IS NOT. The approval the warning describes is the person's, and a person can answer
 * it for the rest of a conversation ("Allow for this conversation"): the gate then hands the call a
 * permit and the work is sent, so on 2026-11-16 (L4-3) a real `message_bot` hop arrived under a
 * sentence promising it never would. `freed` is the peers this conversation has already allowed the
 * tool to reach, read from the same tables the gate reads, and the warning is said only for the
 * peers outside it -- which is per target, so one allowed peer and one not is the ordinary case.
 */
export function groupFraming(
  self: string,
  others: readonly string[],
  options: { handoffTool?: boolean; freed?: ReadonlySet<string> } = {},
): string {
  const peers = others.length ? ` with ${others.join(", ")}` : "";
  const base = `You are ${self}, one of several Bots in this group conversation${peers}. Answer only your own part. The other Bots answer in their own turns, so do not write replies for them.`;
  const [example] = others;
  if (example === undefined) return base;
  const reaching = `To have a peer take something on, name them in your reply as @ plus their whole name (for example @${example}): that is the only way a request reaches them, and telling the person a peer has been asked without naming them that way is not true.`;
  // Nothing to warn off when this deployment offers no handoff tool at all.
  if (!options.handoffTool) return `${base} ${reaching}`;
  const freed = others.filter((name) => options.freed?.has(name));
  const blocked = others.filter((name) => !options.freed?.has(name));
  if (blocked.length === 0)
    return `${base} ${reaching} message_bot reaches them too: this conversation already allows it to take your work, so either way sends it.`;
  const allowed = freed.length
    ? ` message_bot reaches ${freed.join(", ")}: this conversation already allows it to take your work.`
    : "";
  return `${base} ${reaching}${allowed} Do not use message_bot for ${freed.length ? blocked.join(", ") : "a peer here"}: that call waits for an approval this conversation never shows anybody, so the work would never be sent.`;
}

/**
 * How a reply addresses one Bot, as a `RegExp` source: `@` and the whole name, case-insensitive.
 *
 * Not followed by more of a word, so a Bot called "Ops" is not addressed by "@Opsgenie"; not preceded
 * by one either, so "jo@sam.com" does not address "Sam". Shared by the two readers of a reply -- who
 * it names, and which of its paragraphs belong to whom -- so the two cannot drift apart.
 */
function mentionSource(name: string): string {
  const whole = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<![\\p{L}\\p{N}_])@${whole}(?![\\p{L}\\p{N}_])`;
}

/**
 * The part of a reply that addresses one peer, and the rest of it.
 *
 * A reply is written to the group: an answer to the person, then -- often -- a paragraph naming a
 * peer. Handing the whole reply over as that peer's task reads to the peer as material to answer,
 * and its answer came back repeating what the person had already read (2026-11-16, L4-3). So the
 * paragraphs that name the peer are the ask, and the other paragraphs are context.
 *
 * A reply with no blank-line break offers nothing to split: it is all ask, and the peer gets what it
 * always got. A name no paragraph carries (which cannot happen for a peer `mentionedPeers` returned)
 * falls back the same way rather than handing over an empty task.
 */
export function addressedPart(
  reply: string,
  name: string,
): { ask: string; rest: string } {
  // Not global: `test` on a global pattern carries its last match into the next paragraph.
  const paragraph = new RegExp(mentionSource(name), "iu");
  const asked: string[] = [];
  const rest: string[] = [];
  for (const part of reply.split(/\n{2,}/))
    (paragraph.test(part) ? asked : rest).push(part);
  return asked.length
    ? { ask: asked.join("\n\n"), rest: rest.join("\n\n") }
    : { ask: reply, rest: "" };
}

/**
 * The peers a reply addresses, in the order the reply names them.
 *
 * `@Name` with the whole name, case-insensitive, and not followed by more of a word, so a Bot called
 * "Ops" is not addressed by "@Opsgenie". Not preceded by one either, so "jo@sam.com" does not
 * address "Sam". Where two names start at the same `@`, the longer one is meant: "@Ops Lead"
 * addresses "Ops Lead" and not "Ops". Never the speaker itself.
 */
export function mentionedPeers(
  reply: string,
  roster: readonly GroupBot[],
  speakerId: string,
): GroupBot[] {
  // The speaker is matched too, so that its own longer name still hides a shorter peer's.
  const hits = roster.flatMap((bot) => {
    if (!bot.name.trim()) return [];
    const pattern = new RegExp(mentionSource(bot.name), "giu");
    return Array.from(reply.matchAll(pattern), (match) => ({
      bot,
      at: match.index,
      length: match[0].length,
    }));
  });
  const first = new Map<string, { bot: GroupBot; at: number }>();
  for (const hit of hits) {
    if (hit.bot.id === speakerId || first.has(hit.bot.id)) continue;
    const shadowed = hits.some(
      (other) => other.at === hit.at && other.length > hit.length,
    );
    if (!shadowed) first.set(hit.bot.id, hit);
  }
  return [...first.values()]
    .sort((left, right) => left.at - right.at)
    .map(({ bot }) => bot);
}

/**
 * Where a turn sits in a Bot-to-Bot chain, kept on its row while it waits. Without it, a peer turn
 * resumed after an approval would relay from depth zero and the depth cap would never stop the chain.
 */
function chainOf(turn: GroupTurn): Pick<GroupTurn, "depth" | "fromAgentId"> {
  return {
    ...(turn.depth ? { depth: turn.depth } : {}),
    ...(turn.fromAgentId ? { fromAgentId: turn.fromAgentId } : {}),
  };
}
function chainFrom(
  details: Record<string, unknown>,
): Pick<GroupTurn, "depth" | "fromAgentId"> {
  return {
    ...(Number.isInteger(details.depth) && (details.depth as number) > 0
      ? { depth: details.depth as number }
      : {}),
    ...(typeof details.fromAgentId === "string" && details.fromAgentId
      ? { fromAgentId: details.fromAgentId }
      : {}),
  };
}

/** A run id the platform lock accepts, derived from the durable row so a retry reuses it. */
function runIdFor(rowId: string): string {
  const hex = createHash("sha256").update(rowId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createGroupConversations(deps: {
  store: GroupStore;
  queue: WorkQueue;
  owner: string;
  /**
   * The Bots of this group the owner may still use, or null when they are not a member of it or it
   * is not a group. Read per request and per Bot turn.
   */
  roster(ownerUserId: string, channelId: string): Promise<GroupBot[] | null>;
  runTurn: TurnRunner;
  /** The handoff desk's caps and grant, reused for Bots answering each other. */
  caps: HandoffCaps;
  mayAddress(fromBotId: string, toBotId: string): Promise<boolean>;
  auditStore: AuditStore;
  activity?: (
    turn: GroupTurn,
    agentId: string | null,
    text: string,
    sourceId: string,
  ) => Promise<void>;
  busy?: (turn: GroupTurn, busy: boolean) => Promise<void>;
  /** Tell the group's members to read the transcript again (a status line changed). Content-free. */
  announce?: (event: ChannelActivityEvent) => Promise<void>;
  /** Make the channel a group is, as the ordinary channel store does, refusing Bots they cannot see. */
  createChannel?: (
    ownerUserId: string,
    agentIds: string[],
    options: { shared: true },
  ) => Promise<{ id: string }>;
  /**
   * Whether this person may run the Bot, by the same access filter a new group's Bots pass. Needed
   * to add Bots to an existing group.
   */
  canUseBot?: (ownerUserId: string, agentId: string) => Promise<boolean>;
  /**
   * The hirer of an external employee (`device_acp`), null for any other Bot. Only its hirer brings
   * it into a group or takes it out, whoever started the group (spec §6).
   */
  externalHirer?: (agentId: string) => Promise<string | null>;
  /** How often a running reply's partial text is written for the transcript to show. */
  progressEveryMs?: number;
  /**
   * How long a claimed group turn is held before another worker may take it, 15 minutes when not said.
   * A turn that holds its computer works up to 25 minutes, so the lease is renewed while it runs (every
   * third of this). Injectable so a test need not wait for minutes.
   */
  leaseMs?: number;
  /**
   * The owner's permission before a Bot's words reach other people in the group. A Bot run as this
   * person can draw on their private memory and conversations, and nothing can prove a reply did
   * not, so with anyone else in the group the owner is asked once per Bot and group (or always).
   */
  privateShare?: CheckPrivateShare;
  /**
   * Listen for Team Bot consent cards a turn raises (team-bots.ts), so a server-run turn can put the
   * card in the shared transcript for the person it asks.
   */
  listenForConsent?: (
    ownerUserId: string,
    agentId: string,
  ) => () => { botId: string; serverId: string; message: string }[];
  /**
   * The task board's projector, so an ask in a group is visible where a person looks for work.
   *
   * Optional because the group's own suite drives it without a board, and the transcript is the
   * conversation's record either way: a board that cannot be written must not stop a Bot from
   * answering the person who addressed it.
   *
   * One card per Bot per message, because that is what happened — three coworkers answering one
   * question is three pieces of work, and the card's executor is the whole reason to look at it.
   */
  board?: TaskProjector;
  /**
   * The followed cards (`tasks/delivery.ts`, spec 2026-11-15-delivery-loop §2). A person's message to
   * a coworker that holds an open followed card on this person's group thread with it is a round of
   * that work: it hangs on the card rather than opening one. Optional with the board.
   */
  delivery?: Delivery;
  /**
   * What a turn that ends without a hand-in leaves on its card: the workspace files its coworker wrote
   * (`tasks/auto-delivery.ts`). Optional with the board; absent, the card carries nothing, as it always did.
   */
  workspaceFilesOf?: AutoDeliveryReader["workspaceFilesOf"];
  eventsPersisted?: AutoDeliveryReader["eventsPersisted"];
}) {
  /**
   * Whether a Bot's line may be shown to this group now. `allowed`, or held behind the owner's
   * decision (`pending`, with what to store on the waiting row), or refused.
   */
  async function shareGate(input: {
    ownerUserId: string;
    channelId: string;
    agentId: string;
    threadId: string;
    rowId: string;
    runId: string;
    text: string;
    /** The turn listed files of its own, which are shown only with the row. */
    hasFiles?: boolean;
    continuation?: ApprovalContinuation;
  }): Promise<
    | { status: "allowed" }
    | { status: "denied"; message: string }
    | { status: "pending"; details: Record<string, unknown> }
  > {
    if (!deps.privateShare) return { status: "allowed" };
    // Nothing said and nothing listed has nothing of the owner's to hold back; files are held either way.
    if (!input.text && !input.hasFiles) return { status: "allowed" };
    const recipients = await deps.store.members(input.channelId);
    const continuation: ApprovalContinuation = input.continuation ?? {
      runId: input.runId,
      threadId: input.threadId,
      toolCallId: `group-post:${input.rowId}`,
      toolName: "post_to_group",
      args: {},
      messages: [],
      state: {},
      context: [],
      forwardedProps: undefined,
    };
    const verdict = await deps.privateShare({
      ownerUserId: input.ownerUserId,
      botId: input.agentId,
      audience: {
        kind: "group",
        id: input.channelId,
        recipientUserIds: recipients,
        label: "this group conversation",
      },
      content: input.text,
      origin: { kind: "unknown" },
      continuation,
    });
    if (verdict.status === "allowed") return { status: "allowed" };
    if (verdict.status === "denied")
      return { status: "denied", message: verdict.message };
    return {
      status: "pending",
      details: {
        ...verdict.suspension.waiting,
        message: verdict.message,
        // What it waits on, said to every member in their own words (`waitKind`): nothing else of it.
        shareWait: true,
        // What will be shown once the owner allows it. Never listed while it waits.
        privateShare: { text: input.text, continuation },
      },
    };
  }

  /** The owner's usable Bots, in the order the group was made with; any others after, by id. */
  const orderedRoster = async (owner: string, channel: string) => {
    const bots = await deps.roster(owner, channel);
    if (!bots) return null;
    const order = await deps.store.order(channel);
    const rank = (id: string) => {
      const at = order.indexOf(id);
      return at < 0 ? order.length : at;
    };
    return [...bots].sort(
      (left, right) =>
        rank(left.id) - rank(right.id) || left.id.localeCompare(right.id),
    );
  };
  const roster = async (owner: string, channel: string) => {
    const bots = await orderedRoster(owner, channel);
    if (!bots) throw new GroupNotFoundError();
    return bots;
  };

  /** Hand the conversation to the peers a reply names, within the handoff caps and grants. */
  async function relay(
    turn: GroupTurn,
    speaker: GroupBot,
    replyId: string,
    reply: string,
    bots: readonly GroupBot[],
    runId: string,
  ) {
    const depth = turn.depth ?? 0;
    const initiator: AuditInitiator =
      turn.fromAgentId !== undefined
        ? handoffInitiator(turn.fromAgentId, PERSON_INITIATOR)
        : PERSON_INITIATOR;
    const peers = mentionedPeers(reply, bots, speaker.id);
    for (const [index, peer] of peers.entries()) {
      const reason =
        depth >= deps.caps.maxDepth
          ? "depth_cap"
          : index >= deps.caps.maxPerRun
            ? "fan_out_cap"
            : !(await deps.mayAddress(speaker.id, peer.id).catch(() => false))
              ? "not_granted"
              : null;
      if (reason) {
        await recordAuditEvent(deps.auditStore, {
          eventType: "agent.handoff_refused",
          targetType: "agent",
          targetId: speaker.id,
          actorUserId: turn.ownerUserId,
          initiator,
          payload: {
            bot: speaker.id,
            from: speaker.id,
            target: peer.id,
            run: runId,
            depth,
            reason,
            group: turn.channelId,
          },
        });
        continue;
      }
      const { ask, rest } = addressedPart(reply, peer.name);
      const next: GroupTurn = {
        ownerUserId: turn.ownerUserId,
        channelId: turn.channelId,
        messageId: `${replyId}>${peer.id}`,
        agentIds: [peer.id],
        // The peer is handed what the reply says to it, not the answer to the person it was written
        // beside; the rest rides along as context so nothing it was written against is lost.
        text: ask,
        ...(rest ? { context: rest } : {}),
        depth: depth + 1,
        fromAgentId: speaker.id,
      };
      await deps.queue.offer({
        kind: GROUP_TURN_KIND,
        key: next.messageId,
        payload: { ...next },
      });
      await recordAuditEvent(deps.auditStore, {
        eventType: "agent.handoff_offered",
        targetType: "agent",
        targetId: peer.id,
        actorUserId: turn.ownerUserId,
        initiator,
        payload: {
          bot: speaker.id,
          from: speaker.id,
          to: peer.id,
          run: runId,
          depth: depth + 1,
          task: ask.slice(0, 500),
          group: turn.channelId,
        },
      });
    }
  }

  /**
   * The consent cards a Team Bot raised during this turn, as lines in the shared transcript. Only
   * the person whose account it asked for can answer one; the card says so to anyone else.
   */
  async function postConsents(
    turn: GroupTurn,
    agentId: string,
    threadId: string,
    rowId: string,
    consents:
      | (() => { botId: string; serverId: string; message: string }[])
      | undefined,
  ) {
    for (const ask of consents?.() ?? [])
      await deps.store.append({
        id: `${rowId}:consent:${ask.serverId}`,
        ownerUserId: turn.ownerUserId,
        channelId: turn.channelId,
        agentId,
        threadId,
        text: ask.message,
        details: { consent: { botId: ask.botId, serverId: ask.serverId } },
      });
  }

  async function openCard(
    turn: GroupTurn,
    agentId: string,
    runId: string,
  ): Promise<string | null> {
    if (!deps.board) return null;
    try {
      return await deps.board.opened({
        tenantId: turn.ownerUserId,
        title: turn.text,
        executorAgentId: agentId,
        // Whose ask this is decides which lane a person finds it in: their own message is chat, a
        // peer's `@Name` is a hand-off -- the same distinction the audit initiator already carries.
        source: turn.fromAgentId ? "handoff" : "chat",
        channelRef: turn.channelId,
        runRef: runId,
        /*
         * A peer hop hangs under the coworker that addressed it, named by that turn's RUN.
         *
         * The row id already carries the speaker (`<message>:<speaker>><peer>`), so what is left of it
         * before the `>` is the parent's own row id -- the same slice the transcript uses to drop the
         * parent's line out of the hop's history. The hopper never has the parent's card id, which is
         * why the projector resolves it (ticket 020), and a parent that archived in the meantime is a
         * card with no parent rather than a hop that fails.
         */
        ...(turn.fromAgentId
          ? {
              parentRunRef: runIdFor(
                turn.messageId.slice(0, turn.messageId.lastIndexOf(">")),
              ),
            }
          : {}),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "group-board-open-failed",
          channelId: turn.channelId,
          agentId,
          runId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      // The board is a projection. The person asked the coworker, and it answers whether or not a card landed.
      return null;
    }
  }

  /** 告诉群里每个人「转录变了，重读一下」：不带内容，不改会话列表的预览（`groupTranscriptEvent`）。 */
  async function announceTranscript(channelId: string) {
    if (!deps.announce) return;
    await deps.announce(
      groupTranscriptEvent(channelId, await deps.store.members(channelId)),
    );
  }

  /**
   * Close the card this turn opened.
   *
   * Awaited, not fired off: an answer saved and a card still saying "running" is two answers to "is
   * this done", and the board is the one a person reads when they decide whether to go and look.
   *
   * A close for a card that was never opened matches nothing and is not an error -- the projector keys
   * on the run id, and there is no row with it.
   */
  async function closeCard(
    turn: Pick<GroupTurn, "ownerUserId" | "channelId">,
    agentId: string,
    runId: string,
    failed: boolean,
    /**
     * The card this turn is a round of, and what the round said (its reply, or why it failed). A
     * followed card -- one this turn hung on, or the card it opened and followed while it ran -- keeps
     * its status (`finished` skips it) and records the round instead (`tasks/delivery.ts`).
     */
    round?: { taskId: string | null; said?: string },
  ): Promise<void> {
    if (!deps.board) return;
    const logged = (error: unknown) =>
      console.error(
        JSON.stringify({
          type: "group-board-close-failed",
          channelId: turn.channelId,
          agentId,
          runId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    /*
     * Called for a round hung on a followed card too, and before `runEnded`: the board's close is
     * where a question the round left open parks the card (`withQuestionParking`), and the card is
     * found by the round's run id only while `active_run_ref` still names it. A close that fails is
     * logged and the round still ends.
     */
    try {
      // A card nobody follows moves to 等验收 here, carrying the files this turn wrote; a followed one is left.
      const deliverableRef = failed
        ? undefined
        : await autoDeliverable(deps, turn.ownerUserId, runId, (type, detail) =>
            console.error(
              JSON.stringify({
                type,
                channelId: turn.channelId,
                agentId,
                ...detail,
              }),
            ),
          );
      await deps.board.finished({
        tenantId: turn.ownerUserId,
        runRef: runId,
        failed,
        ...(deliverableRef ? { deliverableRef } : {}),
      });
    } catch (error) {
      logged(error);
    }
    if (!round?.taskId || !deps.delivery) return;
    try {
      await deps.delivery.runEnded(turn.ownerUserId, round.taskId, {
        runId,
        failed,
        ...(failed
          ? { error: round.said }
          : { firstSentence: firstSentenceOf(round.said ?? "") }),
      });
    } catch (error) {
      logged(error);
    }
  }

  /**
   * One Bot's part of a turn. Returns why that Bot's answer could not be recorded at all, when its
   * reply row's place is held by a row that is not this turn's: that Bot's failure, kept on the
   * queued item, and not the turn's -- the other Bots of the turn, and the queue, go on.
   */
  async function runBot(
    turn: GroupTurn,
    agentId: string,
  ): Promise<string | undefined> {
    const id = `${turn.messageId}:${agentId}`;
    const bots = await orderedRoster(turn.ownerUserId, turn.channelId);
    const bot = bots?.find((candidate) => candidate.id === agentId);
    const threadId = bot
      ? await deps.store.thread(turn.ownerUserId, turn.channelId, agentId)
      : null;
    const started = await deps.store.start(turn, agentId, threadId);
    if (started === "done") return;
    if (started === "taken") {
      const reason = `${agentId}: This Bot's reply could not be recorded: its place in the conversation is taken by another row.`;
      console.error(
        JSON.stringify({
          type: "group-turn-reply-taken",
          channelId: turn.channelId,
          agentId,
          rowId: id,
          timestamp: new Date().toISOString(),
        }),
      );
      return reason;
    }
    if (started === "unknown") {
      await deps.store.finish(
        id,
        "This Bot's earlier turn stopped before its outcome was saved. It was not repeated.",
        "failed",
      );
      return;
    }
    if (!bots || !bot || !threadId) {
      await deps.store.finish(
        id,
        "This Bot is no longer available in this conversation, so it did not answer.",
        "failed",
      );
      return;
    }
    const names = new Map(
      bots.map((candidate) => [candidate.id, candidate.name]),
    );
    const from = turn.fromAgentId
      ? (names.get(turn.fromAgentId) ?? turn.fromAgentId)
      : null;
    const self = names.get(agentId) ?? agentId;
    const others = bots
      .filter((candidate) => candidate.id !== agentId)
      .map((candidate) => candidate.name);
    // Each Bot speaks for itself: left unsaid, the first to answer writes everybody's part.
    const handoffTool = deps.caps.maxDepth > 0 && deps.caps.maxPerRun > 0;
    /*
     * A handoff the person already allowed for this conversation does arrive, so the warning is
     * owed only for the peers outside that set. Read once per turn: the framing is the same for
     * every Bot of the group, but each Bot's own answers are its own.
     */
    const freed =
      handoffTool && others.length > 0
        ? await deps.store.delegationFreed({
            ownerUserId: turn.ownerUserId,
            threadId,
            botId: agentId,
            peers: others,
          })
        : new Set<string>();
    const role = groupFraming(self, others, { handoffTool, freed });
    // An answer is told as one, with the question it answers, as a one-Bot conversation tells it.
    const said = turn.inResponseTo
      ? `In response to your question: ${turn.inResponseTo}\n\n${turn.text}`
      : turn.text;
    /*
     * A peer's hop carries the paragraph that named it and the rest of the reply as context
     * (`addressedPart`). Both are said plainly, and in that order: the peer is doing a part of what
     * was written, not reviewing the whole answer the person has already read -- which is what it
     * answered with when the whole reply arrived under one heading (2026-11-16, L4-3).
     */
    const instruction = from
      ? [
          role,
          `${from} addressed you in this group conversation: do the part it asks of you, and answer that in your own words. The person has already read its reply, so do not repeat it back.`,
          `What ${from} asks of you:\n${said}`,
          ...(turn.context
            ? [`The rest of ${from}'s reply, for context:\n${turn.context}`]
            : []),
        ].join("\n\n")
      : `${role}\n\n${said}`;
    // A peer turn's prompt is the peer's reply, so that row is left out of the transcript under it.
    const exclude = new Set(
      turn.fromAgentId
        ? [turn.messageId.slice(0, turn.messageId.lastIndexOf(">"))]
        : [],
    );
    const runId = runIdFor(id);
    /*
     * An external employee's card is its hirer's, whoever asked: its turn runs in the hirer's queue
     * and the run that does the work finishes the card it finds there (`adoptRunnerCard`). One card,
     * one charge, in that tenant (spec §1, §6). Every other Bot's card is the asker's.
     */
    const cardTurn = bot.hiredBy ? { ...turn, ownerUserId: bot.hiredBy } : turn;
    /*
     * The board's card for this answer, opened here and not when the message was queued.
     *
     * Everything above is a turn that never reached a Bot: it left the conversation, its earlier turn
     * stopped with an unknown outcome, the group is gone. A card for one of those would say a coworker
     * answered when nothing ran at all -- the same lie ticket 020's handoff cards were written to
     * avoid, where the open sits after the pause gate and the refusal for exactly this reason.
     */
    /*
     * Unless it is a round of work already on the board (一件活一张卡): a person's message to a coworker
     * that holds an open followed card on this person's thread with it hangs on that card, opens none
     * and charges nothing (the runner is told the card is taken, as for any card the caller owns). A
     * peer's hop is the hand-off it is, with a card of its own, as the runner treats a hop. An external
     * employee's card is its hirer's (`cardTurn` above), and so is the followed card it works on: its
     * work was followed the moment it was queued (spec 2026-11-15-delivery-loop §9). Its turn is not
     * hung here -- the group never runs it, and the run that does the work hangs itself on the card
     * when it starts -- so the message only finds the card, and opens and charges nothing.
     */
    /*
     * A lookup or a hang that fails is said, and the round is then an ordinary one with its card
     * (`openCard` below). Not hung is not hung: claiming the followed card without `active_run_ref`
     * naming this run would leave an approval the round raises parking nothing and a `deliver_task`
     * finding no card, silently. A card of its own keeps the round on the board and answerable; the
     * person's message is still answered, which failing the round would not do for a fault of ours.
     */
    const trackedCardFault = (type: string, error: unknown) =>
      console.error(
        JSON.stringify({
          type,
          error: error instanceof Error ? error.message : String(error),
          context: { channelId: turn.channelId, agentId, runId },
          timestamp: new Date().toISOString(),
        }),
      );
    let followed =
      deps.board && deps.delivery && !turn.fromAgentId
        ? await deps.delivery
            .openTrackedCard(
              cardTurn.ownerUserId,
              threadId,
              agentId,
              turn.taskId,
            )
            .catch((error: unknown) => {
              trackedCardFault("group-turn-tracked-card-lookup-failed", error);
              return null;
            })
        : null;
    if (followed && deps.delivery && !bot.hiredBy) {
      const hung = await deps.delivery
        .attachRun(turn.ownerUserId, followed.id, runId)
        .then(
          // False: the card ended between the lookup and the hang -- not hung either.
          (attached) => attached,
          (error: unknown) => {
            trackedCardFault("group-turn-attach-failed", error);
            return false;
          },
        );
      if (!hung) followed = null;
    }
    const cardId = followed
      ? followed.id
      : await openCard(cardTurn, agentId, runId);
    const carded = cardId !== null;
    const round = (said?: string) => ({
      taskId: cardId,
      ...(said ? { said } : {}),
    });
    /*
     * The skill the person picked, when their message starts with its command: under the group's
     * framing above, the message this Bot is sent no longer starts with it, so it is stated for the
     * run. Only a person's own turn; a peer's reply that starts with one picks nothing. Which skill
     * that is, and whether this Bot holds it, the server decides (`picked-skill.ts`).
     */
    const skill = turn.fromAgentId ? undefined : leadingSkillCommand(turn.text);
    const consents = deps.listenForConsent?.(turn.ownerUserId, agentId);
    // Partial text, written at most this often, so the transcript shows the reply as it arrives.
    let latest: string | null = null;
    let writing: Promise<void> | null = null;
    // How far past the save this turn got, so a fault after it finishes what never started without
    // repeating what did: consents are collected once, and a relay that began may have sent hops.
    let saved = false;
    let savedReply = "";
    let consentsPosted = false;
    let relayStarted = false;
    let lastWrite = 0;
    const every = deps.progressEveryMs ?? 400;
    const flush = () => {
      if (writing || latest === null || Date.now() - lastWrite < every) return;
      const text = latest;
      latest = null;
      lastWrite = Date.now();
      writing = deps.store
        .progress(id, text)
        .catch(() => {})
        .finally(() => {
          writing = null;
        });
    };
    let compacted: GroupCompactionNote | null = null;
    let limited: GroupStepLimit | null = null;
    const artifacts: GroupTurnArtifacts[] = [];
    let planned: PlanItem[] | null = null;
    // 外部员工的轮次在它自己那台电脑上跑，计划不记在这一行上。
    const ownPlan = () => (bot.hiredBy ? null : planned);
    const thought: { text: string; ms?: number }[] = [];
    // 思考也一样。
    const ownReasoning = () => (bot.hiredBy ? null : joinReasoning(thought));
    const marks: GroupDeliveryMark[] = [];
    /*
     * 外部员工的轮次（它的招聘人 `hiredBy`，或这一轮回了 `detached`）只回一句「开始了」，它的三步在设备
     * 那一轮里走（`announceHandoff`），群回复上不记标记。挂起、出错这些拿不到 `detached` 的路径按员工认。
     */
    const ownMarks = () => (bot.hiredBy ? [] : marks);
    try {
      // A round hung on a followed card says so, so the runner asks whether that card still waits.
      const hungOn =
        followed && !bot.hiredBy
          ? roundHungByEntry
          : <T>(body: () => T): T => body();
      const result = await hungOn(async () =>
        deps.runTurn({
          ...(turn.depth ? { depth: turn.depth } : {}),
          onText: (text) => {
            latest = text;
            flush();
          },
          onToolCall: ({ name, args }) => {
            planned = planOf(name, args) ?? planned;
          },
          onReasoning: (piece) => {
            thought.push(piece);
          },
          onCustom: ({ name, value }) => {
            compacted = compactionNoteOf(name) ?? compacted;
            limited = stepLimitOf(name, value) ?? limited;
            const made = turnArtifactsOf(name, value, agentId, runId);
            if (made) artifacts.push(made);
            const mark = deliveryMarkOf(name, value, agentId, new Date());
            if (mark) marks.push(mark);
          },
          ownerUserId: turn.ownerUserId,
          routineId: `group:${turn.channelId}`,
          runId,
          // `openCard` above filed this answer under the same run id (or the turn hangs on a followed card),
          // so the runner files nothing — and when neither happened (no board, or the write failed), the
          // runner's card is the only record there is.
          cardOwnedByCaller: carded,
          agentId,
          threadId,
          instruction,
          ...(skill ? { skill } : {}),
          userMessage: groupTurnMessage(
            `group-user:${id}`,
            instruction,
            // Another person's reply in progress has not been through its owner's share check, so this
            // Bot is not handed it, as that person's teammates do not see it either.
            (await deps.store.list(turn.channelId)).filter(
              (message) =>
                !(
                  deps.privateShare &&
                  message.agentId &&
                  message.status === "running" &&
                  message.ownerUserId !== turn.ownerUserId
                ),
            ),
            names,
            exclude,
          ),
          initiator: turn.fromAgentId
            ? handoffInitiator(turn.fromAgentId, PERSON_INITIATOR)
            : PERSON_INITIATOR,
        }),
      );
      await writing;
      /*
       * A detached turn (an external employee's, `createAcpGroupTurn`) answers only this server's own
       * notice that it started: nothing of anyone's to hold back. Its real answer is gated when it is
       * posted (`announceHandoff`), with its hirer.
       */
      const detached = (result as { detached?: boolean }).detached === true;
      const gate = detached
        ? ({ status: "allowed" } as const)
        : await shareGate({
            ownerUserId: turn.ownerUserId,
            channelId: turn.channelId,
            agentId,
            threadId,
            rowId: id,
            runId,
            text: result.replyText,
          });
      const shownMarks = detached ? [] : ownMarks();
      // 外部员工的轮次不走这里的步数（它在自己那台电脑上跑），不记。
      const shownLimit = detached || bot.hiredBy ? null : limited;
      const shownArtifacts = detached || bot.hiredBy ? [] : artifacts;
      const shownPlan = detached ? null : ownPlan();
      const shownReasoning = detached ? null : ownReasoning();
      if (gate.status === "pending") {
        await deps.store.finish(id, "", "waiting", {
          ...gate.details,
          ...chainOf(turn),
          ...withMarks(shownMarks),
          ...withStepLimit(shownLimit),
          // 回复还扣着：文件名和 run 也一起扣着（不在共享的部分），主人放行时再放出来。
          ...(shownArtifacts.length > 0
            ? { heldTurnArtifacts: [...shownArtifacts] }
            : {}),
          ...withPlan(shownPlan),
          ...withReasoning(shownReasoning),
        });
        /*
         * The card stays where the gate left it, and it is not this call's business to move it.
         *
         * A held reply is waiting on the owner's decision, and the row that opened that ask carried
         * this turn's run id, so the approval machinery has already parked the card against it.
         * Writing `awaiting_review` here would pull a card out of the lane the person is being asked
         * to answer in.
         */
        return;
      }
      const compaction: Record<string, unknown> = {
        ...(compacted ? { compaction: compacted } : {}),
        ...withMarks(shownMarks),
        ...withStepLimit(shownLimit),
        ...withPlan(shownPlan),
        ...withReasoning(shownReasoning),
      };
      if (gate.status === "denied") {
        await deps.store.finish(id, gate.message, "failed", compaction);
        await closeCard(cardTurn, agentId, runId, true, round(gate.message));
        return;
      }
      // 回复放行了，这一轮的文件才跟着放出来。
      await deps.store.finish(id, result.replyText, "completed", {
        ...compaction,
        ...withTurnArtifacts(shownArtifacts),
      });
      /*
       * An external employee's turn answers at once that it started and goes on on its owner's
       * computer (agents/acp/agent.ts `createAcpGroupTurn`): its card stays open for the run that
       * does the work, which finishes it and announces its answer here (`announceHandoff`).
       */
      if (!detached)
        await closeCard(
          cardTurn,
          agentId,
          runId,
          false,
          round(result.replyText),
        );
      saved = true;
      savedReply = result.replyText;
      await deps.activity?.(turn, agentId, result.replyText, `group:${id}`);
      consentsPosted = true;
      await postConsents(turn, agentId, threadId, id, consents);
      relayStarted = true;
      await relay(turn, bot, id, result.replyText, bots, runId);
    } catch (error) {
      // The reply is already saved: a fault handing it on is not this Bot's answer failing, and
      // writing it over the row would replace a good reply with an error that no retry repairs.
      if (saved) {
        console.error(
          JSON.stringify({
            type: "group-turn-after-reply-error",
            error: error instanceof Error ? error.message : String(error),
            context: { channelId: turn.channelId, agentId, rowId: id },
            timestamp: new Date().toISOString(),
          }),
        );
        const unfinished = async (step: string, run: () => Promise<void>) => {
          try {
            await run();
          } catch (stepError) {
            console.error(
              JSON.stringify({
                type: "group-turn-after-reply-error",
                step,
                error:
                  stepError instanceof Error
                    ? stepError.message
                    : String(stepError),
                context: { channelId: turn.channelId, agentId, rowId: id },
                timestamp: new Date().toISOString(),
              }),
            );
          }
        };
        if (!consentsPosted)
          await unfinished("consents", () =>
            postConsents(turn, agentId, threadId, id, consents),
          );
        if (!relayStarted)
          await unfinished("relay", () =>
            relay(turn, bot, id, savedReply, bots, runId),
          );
        return;
      }
      await writing;
      await postConsents(turn, agentId, threadId, id, consents);
      if (error instanceof HeadlessToolSuspension) {
        await deps.store.finish(id, "", "waiting", {
          ...error.waiting,
          message: error.message,
          ...chainOf(turn),
          // 等工具审批前已经走过的步骤：恢复后接着记（`continueWaiting`）。
          ...withMarks(ownMarks()),
          ...withPlan(ownPlan()),
          ...withReasoning(ownReasoning()),
        });
        /*
         * Two different waits, and the board tells them apart.
         *
         * An approval raises its request under this turn's run id, which is the id the card is keyed
         * by, so the board already moved the card to 需要操作 and closing it here would answer a
         * question the person has not been asked yet. A durable wait -- a computer still offline, an
         * action handed to the person to do themselves -- has no row a card can be held against, and
         * `needs_action` would be a lane promising a decision that cannot be made. That is the same
         * line `routines/runner.ts` draws for a suspension of its own, and the card goes to the review
         * lane here for the same reason: it is finished as far as this run goes, and what it says is
         * the message above.
         */
        const heldForApproval =
          typeof error.waiting.approvalId === "string" &&
          error.waiting.approvalId.length > 0;
        if (!heldForApproval)
          await closeCard(cardTurn, agentId, runId, false, round());
      } else {
        // An error with no message must still be a text: the share check lets an empty one through.
        const message =
          (error instanceof Error ? error.message : String(error)) ||
          "这一轮没能完成。";
        const failedDetails = {
          ...withMarks(ownMarks()),
          ...withPlan(ownPlan()),
          ...withReasoning(ownReasoning()),
        };
        /*
         * A turn the time limit stopped, or that ran out of rounds or failed, still left its files on
         * the computer, and the group shows a reply's files only from its row. They are shown through
         * the same share check as a finished reply: held with the row when the owner must allow it, and
         * left off when refused. An external employee's turn lists none here.
         */
        const leftFiles = bot.hiredBy ? [] : artifacts;
        const gate: Awaited<ReturnType<typeof shareGate>> =
          leftFiles.length === 0
            ? { status: "allowed" }
            : await shareGate({
                ownerUserId: turn.ownerUserId,
                channelId: turn.channelId,
                agentId,
                threadId,
                rowId: id,
                runId,
                text: message,
                hasFiles: true,
              }).catch(() => ({ status: "denied", message }) as const);
        if (gate.status === "pending") {
          await deps.store.finish(id, "", "waiting", {
            ...gate.details,
            ...chainOf(turn),
            ...failedDetails,
            heldTurnArtifacts: [...leftFiles],
            // Once the owner allows it, the row ends as the failure it is, not as a reply.
            heldFailure: true,
          });
          return;
        }
        await deps.store.finish(
          id,
          gate.status === "denied" ? gate.message : message,
          "failed",
          {
            ...failedDetails,
            ...(gate.status === "allowed" ? withTurnArtifacts(leftFiles) : {}),
          },
        );
        await closeCard(
          cardTurn,
          agentId,
          runId,
          true,
          round(gate.status === "denied" ? gate.message : message),
        );
      }
    }
  }

  /** The group's Bots that are this person's own external employees. */
  const externalOf = async (
    channel: string,
    userId: string,
  ): Promise<string[]> => {
    if (!deps.externalHirer) return [];
    const own: string[] = [];
    for (const id of await deps.store.bots(channel))
      if ((await deps.externalHirer(id)) === userId) own.push(id);
    return own;
  };
  /** Only the person who started the group changes its Bots; the same refusal `removeMember` gives. */
  const creatorOnly = async (owner: string, channel: string) => {
    await roster(owner, channel);
    const creator = (await deps.store.people(channel))[0]?.userId;
    if (owner !== creator)
      throw new GroupRefusedError("只有发起这个群组的人才能调整群里的员工。");
  };
  /**
   * Who may add or remove these Bots: the group's creator for ordinary Bots, and for an external
   * employee its hirer and nobody else, the creator included. A change naming only the caller's own
   * external employees needs them to be in the group, not to have started it.
   */
  const hirerOrCreator = async (
    owner: string,
    channel: string,
    agentIds: readonly string[],
    change: "add" | "remove",
  ) => {
    let others = false;
    for (const id of agentIds) {
      const hirer = (await deps.externalHirer?.(id)) ?? null;
      if (hirer === null) others = true;
      else if (hirer !== owner)
        throw new GroupRefusedError(
          change === "add"
            ? "外部员工只能由招它的人拉进群组。"
            : "外部员工只能由招它的人移出群组，群主也不行。",
        );
    }
    if (others) await creatorOnly(owner, channel);
    else await roster(owner, channel);
  };
  const botList = (input: unknown) => {
    const agentIds = z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_GROUP_BOTS)
      .parse(input);
    if (new Set(agentIds).size !== agentIds.length)
      throw new GroupRefusedError("每位员工只能出现一次。");
    return agentIds;
  };

  /**
   * A `message_bot` answer relayed into a Bot's group thread, shown in the shared transcript in that
   * Bot's voice (the only voice its thread admits) and naming the Bot that answered. Returns false
   * for a thread that is not a group's, so the caller can announce it the ordinary way.
   */
  async function announceHandoff(input: {
    threadId: string;
    actorId: string;
    agentId: string;
    text: string;
    /**
     * `device_acp`: not a relayed answer but an external employee's own, from a turn the group
     * did not wait for (`createAcpGroupTurn`), posted from its own group thread whoever asked in it.
     */
    via?: "device_acp";
  }): Promise<boolean> {
    const thread = await deps.store.threadRow(input.threadId);
    if (
      !thread ||
      (input.via === "device_acp"
        ? thread.agentId !== input.agentId
        : thread.ownerUserId !== input.actorId)
    )
      return false;
    const bots = await orderedRoster(thread.ownerUserId, thread.channelId);
    const speaking = bots?.find((bot) => bot.id === thread.agentId);
    if (!speaking) return true;
    /*
     * Whose words these are. An external employee answers from its hirer's computer and files, so
     * its hirer is asked whether they may reach the group, and its line is the hirer's: written in
     * the hirer's frame, held in the hirer's private row, resumed by the hirer's decision
     * (`continueWaiting` finds only the decider's own rows). Anyone else's relayed answer is the
     * thread owner's, as before.
     */
    const owner =
      input.via === "device_acp" && speaking.hiredBy
        ? speaking.hiredBy
        : thread.ownerUserId;
    return owner === thread.ownerUserId
      ? postAnswer(input, thread, owner)
      : runAsTenant(owner, () => postAnswer(input, thread, owner));
  }

  /** The rest of `announceHandoff`: the share gate and the line, as `owner`'s, in `owner`'s frame. */
  async function postAnswer(
    input: {
      threadId: string;
      agentId: string;
      text: string;
      via?: "device_acp";
    },
    thread: { channelId: string; agentId: string },
    owner: string,
  ): Promise<boolean> {
    const id = `handoff:${createHash("sha256")
      .update(`${input.threadId}\n${input.agentId}\n${input.text}`)
      .digest("hex")
      .slice(0, 32)}`;
    const gate = await shareGate({
      ownerUserId: owner,
      channelId: thread.channelId,
      agentId: thread.agentId,
      threadId: input.threadId,
      rowId: id,
      runId: runIdFor(id),
      text: input.text,
    });
    const relayed = {
      via: input.via ?? "message_bot",
      answeredBy: input.agentId,
    };
    if (gate.status !== "allowed") {
      await deps.store.append({
        id,
        ownerUserId: owner,
        channelId: thread.channelId,
        agentId: thread.agentId,
        threadId: input.threadId,
        ...(gate.status === "pending"
          ? {
              text: "",
              status: "waiting",
              details: { ...relayed, ...gate.details },
            }
          : { text: gate.message, status: "failed", details: relayed }),
      });
      return true;
    }
    const added = await deps.store.append({
      id,
      ownerUserId: owner,
      channelId: thread.channelId,
      agentId: thread.agentId,
      threadId: input.threadId,
      text: input.text,
      details: relayed,
    });
    if (added)
      await deps.activity?.(
        {
          ownerUserId: owner,
          channelId: thread.channelId,
          messageId: id,
          agentIds: [thread.agentId],
          text: input.text,
        },
        thread.agentId,
        input.text,
        `group:${id}`,
      );
    return true;
  }

  return {
    store: deps.store,
    /** Start a group with Bots in the order the person chose them. */
    async create(owner: string, input: unknown) {
      const body = z
        .strictObject({
          agentIds: z
            .array(z.string().min(1))
            .min(MIN_GROUP_BOTS)
            .max(MAX_GROUP_BOTS),
        })
        .parse(input);
      if (new Set(body.agentIds).size !== body.agentIds.length)
        throw new GroupRefusedError("Each Bot can be in a group once.");
      if (!deps.createChannel)
        throw new GroupRefusedError("Groups cannot be created here.");
      // Shared, so the people later added to it read it in their own frames (G01-E).
      const channel = await deps.createChannel(owner, body.agentIds, {
        shared: true,
      });
      await deps.store.seedOrder(owner, channel.id, body.agentIds);
      return channel;
    },
    /**
     * Add Bots to a group the caller started; they answer after the Bots already in it. An external
     * employee is brought in by its hirer alone, who need only be in the group (spec §6).
     */
    async addBots(
      owner: string,
      channel: string,
      input: string[],
    ): Promise<{ added: string[] }> {
      const agentIds = botList(input);
      await hirerOrCreator(owner, channel, agentIds, "add");
      const current = new Set(await deps.store.bots(channel));
      const again = agentIds.find((id) => current.has(id));
      if (again) throw new GroupRefusedError(`员工 ${again} 已经在群里了。`);
      if (current.size + agentIds.length > MAX_GROUP_BOTS)
        throw new GroupRefusedError(CAP_REFUSED);
      for (const id of agentIds)
        if (!(await deps.canUseBot?.(owner, id)))
          throw new GroupRefusedError(
            `你没有权限使用员工 ${id}，无法加进群里。`,
          );
      await deps.store.addBots(owner, channel, agentIds);
      return { added: agentIds };
    },
    /**
     * Take Bots out of a group the caller started, leaving it at least two. An external employee is
     * taken out by its hirer alone, not by whoever started the group (spec §6).
     */
    async removeBots(
      owner: string,
      channel: string,
      input: string[],
    ): Promise<{ removed: string[] }> {
      const agentIds = botList(input);
      await hirerOrCreator(owner, channel, agentIds, "remove");
      const current = await deps.store.bots(channel);
      const missing = agentIds.find((id) => !current.includes(id));
      if (missing)
        throw new GroupRefusedError(`员工 ${missing} 不在这个群里。`);
      if (current.length - agentIds.length < MIN_GROUP_BOTS)
        throw new GroupRefusedError(FLOOR_REFUSED);
      await deps.store.removeBots(owner, channel, agentIds);
      return { removed: agentIds };
    },
    /** Set the order a group's Bots answer in, naming each current Bot exactly once. */
    async reorder(owner: string, channel: string, input: string[]) {
      const agentIds = botList(input);
      await creatorOnly(owner, channel);
      const current = await deps.store.bots(channel);
      if (
        current.length !== agentIds.length ||
        !agentIds.every((id) => current.includes(id))
      )
        throw new GroupRefusedError(
          "新的顺序必须正好包含群里现有的每一位员工。",
        );
      await deps.store.reorder(owner, channel, agentIds);
    },
    /** Add another person to a group this caller is in. They see the whole shared transcript. */
    async addMember(owner: string, channel: string, input: unknown) {
      const body = z
        .strictObject({ email: z.string().trim().email().max(320) })
        .parse(input);
      await roster(owner, channel);
      return deps.store.addMember(channel, body.email);
    },
    /** Leave a group, or (the person who made it) take someone else out of it. */
    async removeMember(owner: string, channel: string, userId: string) {
      await roster(owner, channel);
      const people = await deps.store.people(channel);
      const creator = people[0]?.userId;
      if (userId !== owner && owner !== creator)
        throw new GroupRefusedError(
          "Only the person who started this group can take others out of it.",
        );
      if (userId === creator && people.length > 1)
        throw new GroupRefusedError(
          "The person who started this group cannot leave while others are in it.",
        );
      if (!people.some((person) => person.userId === userId))
        throw new GroupNotFoundError();
      // A person who leaves takes their external employees with them: nobody else may unlink them.
      await deps.store.removeMember(
        channel,
        userId,
        await externalOf(channel, userId),
      );
    },
    /**
     * An approval that paused a group turn was decided: run the continuation, then write what the Bot
     * said into the transcript row that was waiting. Not a group turn's approval: just runs it.
     */
    async continueWaiting(
      approvalId: string,
      run: (hooks?: {
        /** 恢复后这一轮流里的自定义事件：交付卡的标记从这里接着记。 */
        onCustom?: (event: { name: string; value: unknown }) => void;
        /** 恢复后这一轮的工具调用：计划从这里接着记。 */
        onToolCall?: (call: { name: string; args: unknown }) => void;
        /** 恢复后这一轮的思考：接在等待前记下的后面。 */
        onReasoning?: (reasoning: { text: string; ms?: number }) => void;
      }) => Promise<{ replyText: string }>,
    ): Promise<{ replyText: string }> {
      const row = await deps.store.waitingFor(approvalId);
      if (!row?.agentId) return run();
      const agentId = row.agentId;
      // 等待前已经记下的标记；这一行之后每次重写都带上（标记不带内容，放行与否都显示）。
      const earlier = marksOf(row.details);
      const held = row.details.privateShare as
        | { text?: unknown; continuation?: ApprovalContinuation }
        | undefined;
      if (held && typeof held.text === "string") {
        // A reply held for the owner's permission: nothing to re-run, only whether to show it now.
        const gate = await shareGate({
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          agentId,
          threadId: row.threadId ?? "",
          rowId: row.id,
          runId: runIdFor(row.id),
          text: held.text,
          ...(held.continuation ? { continuation: held.continuation } : {}),
        });
        if (gate.status === "pending") return { replyText: "" };
        if (gate.status === "denied") {
          await deps.store.finish(
            row.id,
            gate.message,
            "failed",
            withMarks(earlier),
          );
          await closeCard(
            { ownerUserId: row.ownerUserId, channelId: row.channelId },
            agentId,
            runIdFor(row.id),
            true,
          );
          return { replyText: "" };
        }
        const {
          privateShare: _held,
          heldTurnArtifacts,
          heldFailure,
          ...rest
        } = row.details;
        // 主人放行了回复：扣着的文件清单随它一起放出来。
        const kept = {
          ...rest,
          ...withTurnArtifacts(storedTurnArtifacts(heldTurnArtifacts)),
        };
        if (heldFailure === true) {
          // A failed turn's message and files, held the same way: shown as the failure it was.
          await deps.store.finish(row.id, held.text, "failed", kept);
          await closeCard(
            { ownerUserId: row.ownerUserId, channelId: row.channelId },
            agentId,
            runIdFor(row.id),
            true,
          );
          return { replyText: "" };
        }
        await deps.store.finish(row.id, held.text, "completed", kept);
        await closeCard(
          { ownerUserId: row.ownerUserId, channelId: row.channelId },
          agentId,
          runIdFor(row.id),
          false,
        );
        const shown: GroupTurn = {
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          messageId: row.id,
          agentIds: [agentId],
          text: held.text,
          ...chainFrom(row.details),
        };
        await deps.activity?.(shown, agentId, held.text, `group:${row.id}`);
        // The same reply allowed immediately would have been handed to the Bots it names.
        // Holding it for the owner's permission must not drop that handoff.
        const bots = await orderedRoster(row.ownerUserId, row.channelId);
        const bot = bots?.find((candidate) => candidate.id === agentId);
        if (bots && bot)
          await relay(shown, bot, row.id, held.text, bots, runIdFor(row.id));
        return { replyText: held.text };
      }
      const resumedMarks: GroupDeliveryMark[] = [];
      // 恢复后这一段又跑满了步数：和标记一样记在这一行上。
      let resumedLimit: GroupStepLimit | null = null;
      /*
       * 恢复后的这一段不记产物清单：续跑的 run 用的是它自己新取的 run id（`continuationRunner` 不传），
       * `onCustom` 不告诉我们它是什么，而下载链接要的正是那个 id。
       */
      // 等待前记下的计划；恢复后又更新了就换上新的。
      let resumedPlan: PlanItem[] | null =
        readPlan({ items: row.details.plan }) ?? null;
      // 等待前记下的思考；恢复后又想了的接在后面。
      const earlierThought = readStoredReasoning(row.details.reasoning);
      const resumedThought: { text: string; ms?: number }[] = [];
      const allMarks = () => ({
        ...withMarks([...earlier, ...resumedMarks]),
        ...withStepLimit(resumedLimit),
        ...withPlan(resumedPlan),
        ...withReasoning(
          resumedThought.length > 0
            ? joinReasoning([
                ...(earlierThought ? [earlierThought] : []),
                ...resumedThought,
              ])
            : earlierThought,
        ),
      });
      try {
        const outcome = await run({
          onToolCall: ({ name, args }) => {
            resumedPlan = planOf(name, args) ?? resumedPlan;
          },
          onReasoning: (piece) => {
            resumedThought.push(piece);
          },
          onCustom: ({ name, value }) => {
            resumedLimit = stepLimitOf(name, value) ?? resumedLimit;
            const mark = deliveryMarkOf(name, value, agentId, new Date());
            if (mark) resumedMarks.push(mark);
          },
        });
        /*
         * The resumed reply is a reply like any other: with other people in the group, it waits on
         * the owner's permission before they read it, exactly as `runBot` holds one. Its words come
         * from a run as the owner, which an approval in the middle does not make any less private.
         */
        const gate = await shareGate({
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          agentId,
          threadId: row.threadId ?? "",
          rowId: row.id,
          runId: runIdFor(row.id),
          text: outcome.replyText,
        });
        if (gate.status === "pending") {
          // Held for the owner; the card stays where the share ask parked it (see `runBot`).
          await deps.store.finish(row.id, "", "waiting", {
            ...gate.details,
            ...chainFrom(row.details),
            ...allMarks(),
          });
          return { replyText: "" };
        }
        if (gate.status === "denied") {
          await deps.store.finish(row.id, gate.message, "failed", allMarks());
          await closeCard(
            { ownerUserId: row.ownerUserId, channelId: row.channelId },
            agentId,
            runIdFor(row.id),
            true,
          );
          return { replyText: "" };
        }
        await deps.store.finish(
          row.id,
          outcome.replyText,
          "completed",
          allMarks(),
        );
        await closeCard(
          { ownerUserId: row.ownerUserId, channelId: row.channelId },
          agentId,
          runIdFor(row.id),
          false,
        );
        const turn: GroupTurn = {
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          messageId: row.id.slice(0, row.id.lastIndexOf(":")),
          agentIds: [row.agentId],
          text: outcome.replyText,
          ...chainFrom(row.details),
        };
        /*
         * 以交付收尾、没再说话的续跑（`handedIn`）：行上记着交付标记，没有一句话可预览、可转给别的员工。
         * 但行从等待变成了完成，开着的群页面不轮询等审批的行：告诉群里每个人重读一下，不改会话列表的预览。
         */
        if (!outcome.replyText) {
          // 行已经记成完成；通知没发出去只是页面晚点刷新，不该把这一行改成失败。
          await announceTranscript(row.channelId).catch(() => undefined);
          return outcome;
        }
        await deps.activity?.(
          turn,
          row.agentId,
          outcome.replyText,
          `group:${row.id}`,
        );
        const bots = await orderedRoster(row.ownerUserId, row.channelId);
        const bot = bots?.find((candidate) => candidate.id === row.agentId);
        if (bots && bot)
          await relay(
            turn,
            bot,
            row.id,
            outcome.replyText,
            bots,
            runIdFor(row.id),
          );
        return outcome;
      } catch (error) {
        if (error instanceof HeadlessToolSuspension)
          await deps.store.finish(row.id, "", "waiting", {
            ...error.waiting,
            message: error.message,
            ...chainFrom(row.details),
            ...allMarks(),
          });
        // Suspended again: the new ask parked the card, and it stays there until that is answered.
        else {
          await deps.store.finish(
            row.id,
            error instanceof Error ? error.message : String(error),
            "failed",
            allMarks(),
          );
          await closeCard(
            { ownerUserId: row.ownerUserId, channelId: row.channelId },
            agentId,
            runIdFor(row.id),
            true,
          );
          // 行变成失败了：开着的群页面同样要重读，才看得到这一轮没做完。
          await announceTranscript(row.channelId).catch(() => undefined);
        }
        throw error;
      }
    },
    announceHandoff,
    /**
     * An external employee's own answer, from a turn its group did not wait for
     * (agents/acp/agent.ts `createAcpGroupTurn`), into the group it was asked in: posted in the
     * frame of whoever owns that group thread (who asked, possibly not its hirer), whatever frame
     * the turn ran in.
     */
    async announceExternal(input: {
      threadId: string;
      agentId: string;
      text: string;
    }): Promise<boolean> {
      // The hirer, whose frame the turn ran in, is a member of the group: its thread rows are theirs to read.
      const thread = await deps.store.threadRow(input.threadId);
      if (!thread || thread.agentId !== input.agentId) return false;
      return runAsTenant(thread.ownerUserId, () =>
        announceHandoff({
          ...input,
          actorId: thread.ownerUserId,
          via: "device_acp",
        }),
      );
    },
    /**
     * 外部员工在群里请求许可（外部员工 Task 12）：许可桥给群线程里的一轮开审批时写一行「在等 <招聘人> 确认」，
     * 审批有了结果时改成 approved / denied / expired。只有状态，没有内容，所以和分享检查无关（同交付闭环
     * 第 9 项的做法）；写在招聘人的租户里、记成招聘人的行，和它在群里的回答一样（`announceHandoff`）。
     * 不是群线程、或线程不是这位员工的：什么都不写，答 false。
     */
    async acpPermission(input: {
      threadId: string;
      agentId: string;
      hirerUserId: string;
      approvalId: string;
      status: GroupAcpPermission["status"];
    }): Promise<boolean> {
      const thread = await deps.store.threadRow(input.threadId);
      if (!thread || thread.agentId !== input.agentId) return false;
      const { channelId } = thread;
      return runAsTenant(input.hirerUserId, async () => {
        // 群里别处怎么称呼人，这里就怎么称呼：名字，没有名字时邮箱（group-chat 的 `people`）。
        const hirer = (await deps.store.people(channelId)).find(
          (person) => person.userId === input.hirerUserId,
        );
        const id = groupAcpPermissionRowId(input.approvalId);
        const row = (status: GroupAcpPermission["status"], name: string) => ({
          id,
          ownerUserId: input.hirerUserId,
          channelId,
          agentId: input.agentId,
          threadId: input.threadId,
          text: "",
          status: "completed" as const,
          details: {
            acpPermission: {
              kind: "acp.permission",
              agentId: input.agentId,
              hirerUserId: input.hirerUserId,
              hirerName: name,
              status,
            } satisfies GroupAcpPermission,
          } as Record<string, unknown>,
        });
        let written: boolean;
        if (input.status === "waiting") {
          // 招聘人不在这个群里了：没人能在这里确认，不写。
          if (!hirer) return false;
          const waiting = row("waiting", hirer.name ?? hirer.email);
          written = await deps.store.append({
            ...waiting,
            /*
             * 审批 id 只给招聘人本人：放在这一行的私有部分（`group_message_private`，只有行主人读得到），
             * 「去确认」和他群里的卡靠它落到那一条。成员读到的这一行里没有它。
             */
            details: { ...waiting.details, acpApprovalId: input.approvalId },
          });
        } else {
          // 招聘人后来离开了群：结果照样写，名字沿用这一行原来的。
          const name =
            (hirer ? (hirer.name ?? hirer.email) : null) ??
            groupAcpPermissionOf(
              (await deps.store.list(channelId)).find(
                (message) => message.id === id,
              )?.details.acpPermission,
            )?.hirerName ??
            "招聘人";
          const ended = row(input.status, name);
          try {
            // 结束了：私有部分（审批 id）随之删掉。
            await deps.store.finish(id, "", "completed", ended.details);
            written = true;
          } catch (error) {
            if (!(error instanceof GroupNotFoundError)) throw error;
            /*
             * 「在等」那一行还没写成（结果比开头先到）：直接写结束的这一行。之后迟到的「在等」撞上同一个
             * id，什么都不写。
             */
            written = await deps.store.append(ended);
          }
        }
        // 告诉群里每个人「重读一下」：不带内容，不改会话列表的预览。
        if (written && deps.announce)
          await deps.announce(
            groupTranscriptEvent(
              channelId,
              await deps.store.members(channelId),
            ),
          );
        return written;
      });
    },
    async list(owner: string, channel: string) {
      const bots = await roster(owner, channel);
      const messages = await deps.store.list(channel);
      const people = await deps.store.people(channel);
      return {
        bots,
        people: people.map((person, index) => ({
          ...person,
          // The first member made the group, and is the one who may take others out of it.
          creator: index === 0,
        })),
        messages: messages.map(({ details, held, ...message }) => ({
          ...message,
          // A reply in progress has not been through the owner's share check yet (that runs once the
          // turn ends), so only the person whose Bot it is reads it as it arrives.
          ...(deps.privateShare &&
          message.agentId &&
          message.status === "running" &&
          message.ownerUserId !== owner
            ? { text: "" }
            : {}),
          ...(typeof details.answeredBy === "string"
            ? { answeredBy: details.answeredBy }
            : {}),
          ...(isConsentCard(details.consent)
            ? { consent: details.consent }
            : {}),
          ...withMarks(marksOf(details)),
          ...(isStepLimit(details.stepLimit)
            ? { stepLimit: { steps: details.stepLimit.steps } }
            : {}),
          ...withTurnArtifacts(storedTurnArtifacts(details.turnArtifacts)),
          ...withPlan(readPlan({ items: details.plan }) ?? null),
          ...withReasoning(readStoredReasoning(details.reasoning)),
          // 外部员工在等招聘人确认：每个成员读到的都只有谁在等谁、结果如何。
          ...(groupAcpPermissionOf(details.acpPermission)
            ? {
                acpPermission: groupAcpPermissionOf(details.acpPermission),
                // 还在等时，招聘人本人拿到他那条审批的 id（私有部分，只有行主人读得到）。
                ...(message.ownerUserId === owner &&
                groupAcpPermissionOf(details.acpPermission)?.status ===
                  "waiting" &&
                typeof held?.acpApprovalId === "string"
                  ? { approvalId: held.acpApprovalId }
                  : {}),
              }
            : {}),
          // 压的是发起人和这位员工的线程：只告诉他自己。
          ...(message.ownerUserId === owner &&
          message.agentId &&
          isCompactionNote(details.compaction)
            ? { compaction: details.compaction }
            : {}),
          ...(message.status === "waiting"
            ? {
                // A reply held until its owner says it may reach this group (`shareGate`).
                ...(details.shareWait === true
                  ? { waitKind: "share" as const }
                  : {}),
                reason:
                  typeof details.message === "string"
                    ? details.message
                    : "Waiting for your response.",
                /*
                 * 这一行等的是发起人自己那条审批：把它的 id 一并给他，页面上的「去审批」才有唯一
                 * 落点，而不是落在一张要自己再找一遍的清单上。别人读到的是同一行、同一个原因，
                 * 但没有这个 id——审批 id 是把一次决定接回它那一轮的钥匙，而那一轮是发起人的。
                 * `ownerUserId` 再挡一道：这一列本来就只由行主人的连接读得到（0128 的行级策略），
                 * 越过策略的连接（超级用户、BYPASSRLS）也得靠它才不会漏。
                 */
                ...(message.ownerUserId === owner &&
                typeof held?.approvalId === "string"
                  ? { approvalId: held.approvalId }
                  : {}),
              }
            : {}),
        })),
      };
    },
    async send(
      owner: string,
      channel: string,
      input: unknown,
      /** Server code only: the followed card this message is about (`GroupTurn.taskId`). */
      options?: { taskId?: string },
    ) {
      const body = z
        .strictObject({
          id: z
            .string()
            .min(1)
            .max(160)
            .regex(PERSON_MESSAGE_ID, PERSON_MESSAGE_ID_REFUSED),
          text: z.string().trim().min(1).max(16000),
          agentId: z.string().min(1).nullable().optional(),
        })
        .parse(input);
      const bots = await roster(owner, channel);
      if (!bots.length)
        throw new GroupRefusedError(
          "None of this conversation's Bots are available to you any more.",
        );
      if (body.agentId && !bots.some((bot) => bot.id === body.agentId))
        throw new GroupRefusedError("That Bot is not in this conversation.");
      // A chip addresses one Bot; `@Name`s in the text address those Bots in the order written;
      // otherwise every Bot answers, in the group's order.
      const named = mentionedPeers(body.text, bots, "");
      const turn: GroupTurn = {
        ownerUserId: owner,
        channelId: channel,
        messageId: body.id,
        text: body.text,
        agentIds: body.agentId
          ? [body.agentId]
          : (named.length ? named : bots).map((bot) => bot.id),
        ...(options?.taskId ? { taskId: options.taskId } : {}),
      };
      await deps.store.submit(turn);
      await deps.activity?.(turn, null, turn.text, `group:${turn.messageId}`);
      return { id: turn.messageId, queued: true };
    },
    /** Claim and run one queued turn. Returns whether there was one, so a caller can drain. */
    async sweep(): Promise<boolean> {
      const leaseMs = deps.leaseMs ?? 15 * 60_000;
      const [item] = await deps.queue.claim({
        kind: GROUP_TURN_KIND,
        owner: deps.owner,
        leaseMs,
        limit: 1,
        maxAttempts: 2,
        // A group answers one message after another; different groups may be answered at once.
        oneAtATimeBy: "channelId",
      });
      if (!item) return false;
      const turn = turnSchema.parse(item.payload);
      /*
       * THE TURN OWNER'S TENANT, which is the item's stamp rather than anything on this connection.
       *
       * A group turn writes a thread, a Bot message row, and a final text — all of them read
       * afterwards by the person who sent the message, inside their own tenant. The claim is made as
       * `platform` because "what is queued" is nobody's tenant's question, but a worker on a timer
       * has no tenant of its own, so without this frame every one of those rows is filed under
       * `system`: the Bots answer, and the conversation shows an empty transcript forever. That is
       * what "the group never replies" looks like from the outside, with the queue healthy.
       *
       * The payload's owner names who the turn runs as (the roster, the Bot's owner, the audit
       * actor, the share check, the board), so it may only CONFIRM the stamp (G01): an item stamped
       * with one person that names another, or stamped as nobody's, is ended here and never run,
       * like the approval and delivery workers' items.
       */
      const claimed = await runAsClaimedTenant(
        item,
        turn.ownerUserId,
        async () => {
          try {
            await deps.busy?.(turn, true).catch(() => {});
            // The Bots whose answer could not be recorded at all; the rest still answer.
            const unrecorded: string[] = [];
            const renewLease = () =>
              deps.queue.renew({
                kind: item.kind,
                key: item.key,
                owner: deps.owner,
                leaseMs,
              });
            /*
             * A Bot's turn may run longer than the lease, so the lease is kept while it runs. One that
             * could not be renewed was taken by another worker: this one stops after the Bot it is on,
             * and does not start the next, so the two never answer the same message at once.
             */
            let leaseLost = false;
            const heartbeat = setInterval(
              () => {
                void renewLease().then(
                  (kept) => {
                    if (!kept) leaseLost = true;
                  },
                  () => undefined,
                );
              },
              Math.max(1, Math.floor(leaseMs / 3)),
            );
            try {
              // One Bot after another, so each later Bot reads what the earlier ones said.
              for (const agentId of turn.agentIds) {
                if (leaseLost || !(await renewLease()))
                  throw new Error("The group turn lease was lost.");
                const failed = await runBot(turn, agentId);
                if (failed) unrecorded.push(failed);
              }
            } finally {
              clearInterval(heartbeat);
            }
            /*
             * Ended either way: a place another row holds stays held, so a retry could only fail the
             * same way (and hold up the sweep behind it). The reason is kept on the item.
             */
            await deps.queue.finish({
              kind: item.kind,
              key: item.key,
              owner: deps.owner,
              ...(unrecorded.length ? { reason: unrecorded.join("\n") } : {}),
            });
          } catch (error) {
            /*
             * The sender can no longer see the group (taken out of it, or its row is gone): nothing
             * of this turn may be written, and no retry will change that. Ended, not released.
             */
            if (error instanceof GroupNotFoundError) {
              await deps.queue.finish({
                kind: item.kind,
                key: item.key,
                owner: deps.owner,
              });
              console.error(
                JSON.stringify({
                  type: "group-turn-not-a-member",
                  key: item.key,
                  channelId: turn.channelId,
                }),
              );
              return;
            }
            await deps.queue.release({
              kind: item.kind,
              key: item.key,
              owner: deps.owner,
              delayMs: 10_000,
              reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            await deps.busy?.(turn, false).catch(() => {});
          }
        },
      );
      if (!claimed.ran) {
        await deps.queue.finish({
          kind: item.kind,
          key: item.key,
          owner: deps.owner,
        });
        console.error(
          JSON.stringify({
            type: "group-turn-untrusted-tenant",
            key: item.key,
            reason: claimed.reason,
          }),
        );
      }
      return true;
    },
  };
}
export type GroupConversations = ReturnType<typeof createGroupConversations>;

export function createGroupRoutes(
  service: GroupConversations,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof GroupNotFoundError
        ? 404
        : error instanceof GroupRefusedError || error instanceof z.ZodError
          ? 400
          : 500,
    ),
  );
  routes.post("/", async (context) =>
    context.json(
      {
        channel: await service.create(
          context.var.actor.id,
          await context.req.json(),
        ),
      },
      201,
    ),
  );
  routes.post("/:channelId/members", async (context) =>
    context.json(
      await service.addMember(
        context.var.actor.id,
        context.req.param("channelId"),
        await context.req.json(),
      ),
      201,
    ),
  );
  routes.delete("/:channelId/members/:userId", async (context) => {
    await service.removeMember(
      context.var.actor.id,
      context.req.param("channelId"),
      context.req.param("userId"),
    );
    return context.body(null, 204);
  });
  const botIds = async (context: { req: { json(): Promise<unknown> } }) =>
    z
      .strictObject({ agentIds: z.array(z.string()) })
      .parse(await context.req.json()).agentIds;
  routes.post("/:channelId/bots", async (context) =>
    context.json(
      await service.addBots(
        context.var.actor.id,
        context.req.param("channelId"),
        await botIds(context),
      ),
    ),
  );
  routes.delete("/:channelId/bots", async (context) =>
    context.json(
      await service.removeBots(
        context.var.actor.id,
        context.req.param("channelId"),
        await botIds(context),
      ),
    ),
  );
  routes.put("/:channelId/order", async (context) => {
    await service.reorder(
      context.var.actor.id,
      context.req.param("channelId"),
      await botIds(context),
    );
    return context.body(null, 204);
  });
  routes.get("/:channelId", async (context) =>
    context.json(
      await service.list(context.var.actor.id, context.req.param("channelId")),
    ),
  );
  routes.post("/:channelId", async (context) =>
    context.json(
      await service.send(
        context.var.actor.id,
        context.req.param("channelId"),
        await context.req.json(),
      ),
      202,
    ),
  );
  return routes;
}

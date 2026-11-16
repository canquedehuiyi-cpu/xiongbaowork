/*
 * 微信里用文字拍板（计划 2026-11-16-im-channels-wechat Task 7）：审批回数字，交付闭环回命令。
 *
 * 三类提示，挂在 Task 6 的入站分流上（`createWechatInbound({ prompts: handlers })`，按 `kind` 分派）：
 *  - `approval`（ref = 审批 id）：「【代码熊】想要 删除 ~/build 目录（在「修复构建」里）。回复 1 批准一次，2 拒绝，
 *    3 这次对话里都允许；详情：<链接>」。1 → `allow_once`，2 → `deny`，3 → `allow_conversation`。底线类（只给
 *    「允许一次」的，`offersStandingRule` / 外部员工的 `acpCardOf(...).offerConversation`）不出现 3，回 3 就说
 *    「这条只能批准一次或拒绝」，不放行。交给本人做的（hand_off）：1 = 做完了（`handled`），2 = 不做。
 *    决定只经审批服务（`approvals.decide`，记下渠道 `wechat`）：底线、并发、谁先批谁算数都在那里判。别处已经
 *    处理过的，再回数字答「这条已由 某某 在 <渠道> 处理」（按审批记下的 `decided_via`，旧数据说「网页」），不改状态。
 *  - `handin`（ref = 卡片 id）：交付待验收，回「验收」或「退回 原因」（`tasks/return-task.ts`，和看板同一条路）。
 *  - `overdue`（ref = 卡片 id）：逾期，回「再催」「延期 时间」「换人 员工名」「取消」，走 tasks 路由同一套服务函数
 *    （`NudgeRuns.nudgeNow` / `reassignTask`、`Delivery.decideExtension` / `editTask` / `cancelTask`）。
 *    「延期」的时间按这个人的时区读（`when.ts`），读不出就回示例、什么都不改。
 *
 * 只有一条开着时直接对它生效；不止一条开着时要带编号（`A2 1`、`A2 验收`），所以开提示时开着的不止一条，
 * 文字里就带上编号（`prompts.ts` 负责认）。
 *
 * `open…Prompt` 开提示并返回要发的文字；同一件事（同一条审批、同一张卡的同一类提示）还开着就不再开新的，
 * 返回原来的编号。本任务只提供这些函数：员工在别处请求审批、交付待验收、逾期时往微信发，是发件箱 transport
 * （Task 8）的事。微信里开的那一轮停下来等审批时，入站分流直接用 `openApprovalPrompts` 把请求发回来。
 *
 * 一切都在这个人的帧里（轮询器的帧），不开 platform 帧。
 */
import { type BaseEvent, EventType } from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import { approvalViaName } from "../../../../shared/approval-via";
import { approvalPhrase } from "../../../../shared/tool-name";
import { acpCardOf } from "../../agents/acp/permissions";
import type { AgentProfileStore } from "../../agents/profile-store";
import type { AgentActor } from "../../agents/profile-types";
import {
  type ApprovalDecision,
  ApprovalForbiddenError,
  ApprovalNotFoundError,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalVia,
  afterChinese,
  offersStandingRule,
} from "../../approvals/types";
import { shortName } from "../../brand";
import type { Database } from "../../db/client";
import {
  channels,
  intelligenceChannelMappings,
  tasks,
  users,
} from "../../db/schema";
import type { WechatPrompt, WechatPromptKind } from "../../db/schema/wechat";
import type { CardTurns } from "../../tasks/card-turns";
import type { Delivery } from "../../tasks/delivery";
import { DEFAULT_TIME_ZONE, DELIVERY_EVENTS } from "../../tasks/delivery-tools";
import { clockOf, dueRefusalText } from "../../tasks/due-time";
import type { NudgeRuns } from "../../tasks/nudge-run";
import { returnTaskWithReason } from "../../tasks/return-task";
import type { DeliveryStore } from "../store";
import type { WechatPromptContext, WechatPromptHandler } from "./inbound";
import type { WechatStore } from "./store";
import { readLaterTime } from "./when";

/** 退回原因最多几个字（和看板的退回一样）。 */
const RETURN_REASON_CHARS = 500;

type ApprovalLike = Pick<ApprovalRecord, "id" | "action">;
type CardLike = { id: string; title: string; dueAt: Date | null };
type Code = Pick<WechatPrompt, "code">;

/** 这条审批能不能「这次对话里都允许」：底线类、管理员关了的、交给本人做的都不能。 */
function offersConversation(action: ApprovalRecord["action"]): boolean {
  const acp = acpCardOf(action);
  return acp ? acp.offerConversation === true : offersStandingRule(action);
}

const handedOff = (action: ApprovalRecord["action"]) =>
  action.policy?.behaviour === "hand_off";

/** 「【代码熊】想要 删除 ~/build 目录」：审批说的是哪位员工要做什么。 */
function approvalLine(record: ApprovalLike, botName: string): string {
  const phrase = approvalPhrase(record.action);
  return handedOff(record.action)
    ? `【${botName}】需要你亲自做：${phrase}`
    : `【${botName}】想要 ${phrase}`;
}

/**
 * 发到微信的审批请求。`numbered`（开着的提示不止一条）时开头和每个选项都带编号；底线类只有 1 和 2。
 */
export function approvalText(
  prompt: Code,
  record: ApprovalLike,
  botName: string,
  options: {
    numbered?: boolean;
    conversation?: string | null;
    link?: string | null;
  } = {},
): string {
  const tag = options.numbered ? `${prompt.code} ` : "";
  const where = options.conversation
    ? `（在「${options.conversation}」里）`
    : "";
  const choices = handedOff(record.action)
    ? `做完了回复 ${tag}1，不做回复 ${tag}2`
    : [
        `回复 ${tag}1 批准一次`,
        `${tag}2 拒绝`,
        ...(offersConversation(record.action)
          ? [`${tag}3 这次对话里都允许`]
          : []),
      ].join("，");
  const detail = options.link ? `；详情：${options.link}` : "";
  return `${tag}${approvalLine(record, botName)}${where}。${choices}${detail}`;
}

/** 交付待验收：「【代码熊】交了「核对本周发票」，等你验收。回复 验收，或 退回 原因；详情：<链接>」。 */
export function handinText(
  prompt: Code,
  card: CardLike,
  botName: string,
  options: { numbered?: boolean; link?: string | null } = {},
): string {
  const tag = options.numbered ? `${prompt.code} ` : "";
  const detail = options.link ? `；详情：${options.link}` : "";
  return `${tag}【${botName}】交了「${card.title}」，等你验收。回复 ${tag}验收，或 ${tag}退回 原因${detail}`;
}

/** 逾期：「【代码熊】的「核对本周发票」逾期了（原定 15:00）。回复 再催 / 延期 明早10点 / 换人 / 取消；详情：…」。 */
export function overdueText(
  prompt: Code,
  card: CardLike,
  botName: string,
  options: {
    numbered?: boolean;
    link?: string | null;
    now?: Date;
    timeZone?: string;
  } = {},
): string {
  const tag = options.numbered ? `${prompt.code} ` : "";
  const due = card.dueAt
    ? `（原定 ${clockOf(card.dueAt, options.now ?? new Date(), options.timeZone ?? DEFAULT_TIME_ZONE)}）`
    : "";
  const detail = options.link ? `；详情：${options.link}` : "";
  const commands = ["再催", "延期 明早10点", "换人", "取消"]
    .map((command) => `${tag}${command}`)
    .join(" / ");
  return `${tag}【${botName}】的「${card.title}」逾期了${due}。回复 ${commands}${detail}`;
}

export type WechatDecisionDeps = {
  database: Database;
  wechat: Pick<WechatStore, "openPrompt" | "openPrompts" | "closePrompt">;
  /** 审批服务：读这条审批，按本人决定（底线、谁先批谁算数都在里面判）。 */
  approvals: {
    store: { get(ownerUserId: string, id: string): Promise<ApprovalRecord> };
    decide(
      ownerUserId: string,
      id: string,
      decision: ApprovalDecision,
      via: ApprovalVia,
    ): Promise<unknown>;
  };
  deliveries: Pick<DeliveryStore, "botIdentity">;
  delivery: Pick<
    Delivery,
    | "review"
    | "claimReturn"
    | "releaseReturn"
    | "returnTask"
    | "cancelTask"
    | "decideExtension"
    | "editTask"
  >;
  /** 卡片对话里说话（退回的原因、延期的答复）、停下那一轮。没有时退回不了。 */
  turns?: Pick<CardTurns, "sendAsUser" | "stopRound" | "say">;
  /** 再催、换人。没有时这两样做不了。 */
  rounds?: Pick<NudgeRuns, "nudgeNow" | "reassignTask">;
  /** 换人时按名字找员工。 */
  bots: Pick<AgentProfileStore, "list">;
  actorFor(userId: string): Promise<AgentActor>;
  /** 这位员工的接活工具关了没有（关了就不能接手在跟的活）。 */
  acceptTaskDisabled?: (tenantId: string, agentId: string) => Promise<boolean>;
  /** 这个人的时区（作息设置里的）。没有时用产品默认时区。 */
  timeZone?: (tenantId: string) => string | Promise<string>;
  /** 详情链接的前缀（网页的地址）。没有时文字里不带链接。 */
  appUrl?: string | null;
  /**
   * 这个人作息里的收工时间（"HH:MM"）：「延期 周五」没说几点时按它。没有、读不到时按 18:00。
   */
  endOfDay?: (tenantId: string) => Promise<string | null> | string | null;
  now?: () => Date;
};

/** 审批提示开着超过这么久就不再算数：匹配时跳过并关掉（审批本身不动，网页上照样能批）。 */
export const WECHAT_APPROVAL_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

/** 交付待验收、逾期两类提示还算数时，卡片该在的状态。 */
const HANDIN_OPEN = new Set(["awaiting_review"]);
const OVERDUE_OPEN = new Set(["running", "needs_action"]);

export function createWechatDecisions(deps: WechatDecisionDeps) {
  const now = deps.now ?? (() => new Date());
  const zoneOf = async (tenantId: string) =>
    (await deps.timeZone?.(tenantId)) ?? DEFAULT_TIME_ZONE;
  const base = deps.appUrl?.replace(/\/+$/, "") || null;
  const approvalLink = (id: string) =>
    base ? `${base}/approvals?id=${encodeURIComponent(id)}` : null;
  const cardLink = (id: string) =>
    base ? `${base}/tasks/${encodeURIComponent(id)}` : null;

  async function botName(agentId: string | null): Promise<string> {
    if (!agentId) return "员工";
    return (await deps.deliveries.botIdentity(agentId))?.name || "员工";
  }

  /** 审批所在对话的名字（本人起的标题，或自动的摘要）；没有就不说。 */
  async function conversationOf(
    ownerUserId: string,
    threadId: string,
  ): Promise<string | null> {
    const [row] = await deps.database
      .select({ title: channels.title, summary: channels.summary })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channels,
        eq(channels.id, intelligenceChannelMappings.channelId),
      )
      .where(
        and(
          eq(intelligenceChannelMappings.userId, ownerUserId),
          eq(intelligenceChannelMappings.threadId, threadId),
        ),
      )
      .limit(1);
    return row?.title?.trim() || row?.summary?.trim() || null;
  }

  async function cardOf(tenantId: string, taskId: string) {
    const [row] = await deps.database
      .select({
        id: tasks.id,
        title: tasks.title,
        dueAt: tasks.dueAt,
        agentId: tasks.executorAgentId,
        status: tasks.status,
        tracked: tasks.tracked,
      })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
      .limit(1);
    return row ?? null;
  }

  async function personName(userId: string): Promise<string> {
    const [row] = await deps.database
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.name?.trim() || "你";
  }

  async function getApproval(userId: string, id: string) {
    try {
      return await deps.approvals.store.get(userId, id);
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) return null;
      throw error;
    }
  }

  /**
   * 这条提示背后的事还在不在等这个人（见 `WechatPromptHandler.stale`）：审批不在 pending、卡片不在等验收 /
   * 不在员工手上、或者已经不存在 → `settled`；审批提示开过 24 小时 → `expired`。
   */
  async function staleOf(
    prompt: WechatPrompt,
    at: Date,
  ): Promise<"open" | "settled" | "expired"> {
    if (prompt.kind === "approval") {
      // 开过 24 小时的先算过期（不论审批批没批）：过期的一律静默关掉。
      if (
        prompt.createdAt.getTime() <
        at.getTime() - WECHAT_APPROVAL_PROMPT_TTL_MS
      )
        return "expired";
      const record = await getApproval(prompt.userId, prompt.refId);
      return record?.status === "pending" ? "open" : "settled";
    }
    if (prompt.kind === "handin" || prompt.kind === "overdue") {
      const card = await cardOf(prompt.userId, prompt.refId);
      const live = prompt.kind === "handin" ? HANDIN_OPEN : OVERDUE_OPEN;
      if (!card?.tracked || !live.has(card.status)) return "settled";
      // 逾期卡的预计时间已经改到以后（网页上准许了延期、改了时间）：这条逾期提醒已经处理过了。
      if (
        prompt.kind === "overdue" &&
        card.dueAt &&
        card.dueAt.getTime() > at.getTime()
      )
        return "settled";
      return "open";
    }
    return "open";
  }

  /**
   * 对账：这个人开着的审批 / 交付 / 逾期提示里，在别处处理过的、过期的，静默关掉（不发任何消息）。
   * 开新提示前调，免得已经处理过的那几条让新请求也带上编号。
   */
  async function reconcile(userId: string) {
    const at = now();
    for (const prompt of await deps.wechat.openPrompts(userId))
      if ((await staleOf(prompt, at)) !== "open")
        await deps.wechat.closePrompt(userId, prompt.code);
  }

  /** 开一条提示；同一件事还开着就用原来那条。返回编号和开完之后开着几条。 */
  async function open(userId: string, kind: WechatPromptKind, refId: string) {
    await reconcile(userId);
    const before = await deps.wechat.openPrompts(userId);
    const existing = before.find((p) => p.kind === kind && p.refId === refId);
    const code =
      existing?.code ??
      (await deps.wechat.openPrompt(userId, kind, refId)).code;
    return { code, count: before.length + (existing ? 0 : 1) };
  }

  async function renderApproval(
    userId: string,
    record: ApprovalRecord,
    code: string,
    numbered: boolean,
  ) {
    return approvalText({ code }, record, await botName(record.action.botId), {
      numbered,
      conversation: await conversationOf(userId, record.action.threadId),
      link: approvalLink(record.id),
    });
  }

  /**
   * 给这几条审批开提示，返回要发的文字（一条审批一段）。先都开好再写文字，所以一次开了好几条时每段都带编号。
   * 不在等批的（已处理、不存在）跳过。
   */
  async function openApprovalPrompts(
    userId: string,
    approvalIds: readonly string[],
  ): Promise<string[]> {
    const opened: { record: ApprovalRecord; code: string }[] = [];
    let count = 0;
    for (const id of approvalIds) {
      const record = await getApproval(userId, id);
      if (record?.status !== "pending") continue;
      const prompt = await open(userId, "approval", id);
      count = prompt.count;
      opened.push({ record, code: prompt.code });
    }
    const texts: string[] = [];
    for (const { record, code } of opened)
      texts.push(await renderApproval(userId, record, code, count > 1));
    return texts;
  }

  async function openApprovalPrompt(userId: string, approvalId: string) {
    const record = await getApproval(userId, approvalId);
    if (record?.status !== "pending") return null;
    const { code, count } = await open(userId, "approval", approvalId);
    return {
      code,
      text: await renderApproval(userId, record, code, count > 1),
    };
  }

  async function openHandinPrompt(userId: string, taskId: string) {
    const card = await cardOf(userId, taskId);
    if (!card) return null;
    const { code, count } = await open(userId, "handin", taskId);
    return {
      code,
      text: handinText({ code }, card, await botName(card.agentId), {
        numbered: count > 1,
        link: cardLink(taskId),
      }),
    };
  }

  async function openOverduePrompt(userId: string, taskId: string) {
    const card = await cardOf(userId, taskId);
    if (!card) return null;
    const { code, count } = await open(userId, "overdue", taskId);
    return {
      code,
      text: overdueText({ code }, card, await botName(card.agentId), {
        numbered: count > 1,
        link: cardLink(taskId),
        now: now(),
        timeZone: await zoneOf(userId),
      }),
    };
  }

  /** 回话里提到这条提示时的写法：开着的不止一条就带编号。 */
  const tagOf = (context: WechatPromptContext, prompt: WechatPrompt) =>
    context.open.length > 1 ? `${prompt.code} ` : "";
  const close = (context: WechatPromptContext, prompt: WechatPrompt) =>
    deps.wechat.closePrompt(context.account.userId, prompt.code);

  /**
   * 「这条已由 某某 在 <渠道> 处理」。审批按它记下的 `decided_via` 说真实渠道（网页 / 微信 / Slack / Teams，
   * 中文名在 `shared/approval-via.ts`）；没记渠道的旧审批、交付卡和逾期卡（看板上处理的）说「网页」。
   */
  async function handledText(userId: string, via?: string | null) {
    return `这条已由 ${await personName(userId)} 在 ${approvalViaName(via)} 处理`;
  }

  /** 这条在别处处理过了，而这条回复只可能是在回它：照规格说一声，关掉提示。 */
  async function answerSettled(
    context: WechatPromptContext,
    prompt: WechatPrompt,
  ) {
    await close(context, prompt);
    await context.reply(await handledText(context.account.userId));
  }

  /** 审批的那一版：按这条审批记下的渠道说。 */
  async function answerApprovalSettled(
    context: WechatPromptContext,
    prompt: WechatPrompt,
  ) {
    const record = await getApproval(context.account.userId, prompt.refId);
    await close(context, prompt);
    await context.reply(
      await handledText(context.account.userId, record?.decidedVia),
    );
  }

  const approval: WechatPromptHandler = {
    accepts: (answer) => /^[123]$/.test(answer),
    stale: staleOf,
    settled: answerApprovalSettled,
    /** 带编号回了一条开过 24 小时的：审批还在等就说过期了、请到熊宝里处理；已经处理过的不说话。 */
    async expired(context, prompt) {
      await close(context, prompt);
      const record = await getApproval(context.account.userId, prompt.refId);
      if (record?.status !== "pending") return false;
      await context.reply(`这条已过期，请到${shortName()}里处理`);
      return true;
    },
    async label(prompt) {
      const record = await getApproval(prompt.userId, prompt.refId);
      return record
        ? `审批：${approvalLine(record, await botName(record.action.botId))}`
        : "审批";
    },
    async handle(context, prompt, answer) {
      const userId = context.account.userId;
      const tag = tagOf(context, prompt);
      const record = await getApproval(userId, prompt.refId);
      if (!record) {
        await close(context, prompt);
        await context.reply("这条审批已经不在了。");
        return;
      }
      const handled = async (via?: string | null) => {
        await close(context, prompt);
        await context.reply(await handledText(userId, via));
      };
      if (record.status !== "pending") {
        await handled(record.decidedVia);
        return;
      }
      const handOff = handedOff(record.action);
      if (answer === "3" && (handOff || !offersConversation(record.action))) {
        await context.reply(
          handOff
            ? `这条要你亲自做：做完了回复 ${tag}1，不做回复 ${tag}2。`
            : `这条只能批准一次或拒绝：回复 ${tag}1 批准一次，${tag}2 拒绝。`,
        );
        return;
      }
      const decision: ApprovalDecision =
        answer === "2"
          ? "deny"
          : answer === "3"
            ? "allow_conversation"
            : handOff
              ? "handled"
              : "allow_once";
      try {
        await deps.approvals.decide(userId, record.id, decision, "wechat");
      } catch (error) {
        if (
          !(
            error instanceof ApprovalRefusedError ||
            error instanceof ApprovalForbiddenError ||
            error instanceof ApprovalNotFoundError
          )
        )
          throw error;
        // 同一时刻在别处处理了：照实说。否则是审批服务不让（只说原因，提示还开着）。
        const latest = await getApproval(userId, record.id);
        if (latest?.status !== "pending") {
          await handled(latest?.decidedVia);
          return;
        }
        // 审批服务的原因有的是英文：没有中文时不照搬，给一句中文兜底。
        await context.reply(
          /[\u4e00-\u9fff]/u.test(error.message)
            ? `没有办成：${error.message}`
            : `没有办成，请到${shortName()}里看看`,
        );
        return;
      }
      await close(context, prompt);
      const name = await botName(record.action.botId);
      await context.reply(
        decision === "deny"
          ? `已拒绝。【${name}】不会${afterChinese(approvalPhrase(record.action))}。`
          : decision === "allow_conversation"
            ? `已在这次对话里都允许，【${name}】会继续。`
            : decision === "handled"
              ? `好的，记下你已经做完了，【${name}】会继续。`
              : `已批准这一次，【${name}】会继续。`,
      );
    },
  };

  const RETURN = /^退回[\s:：,，、]*(.*)$/su;

  const handin: WechatPromptHandler = {
    accepts: (answer) => answer === "验收" || RETURN.test(answer),
    stale: staleOf,
    settled: answerSettled,
    async label(prompt) {
      const card = await cardOf(prompt.userId, prompt.refId);
      return card ? `验收：「${card.title}」` : "验收";
    },
    async handle(context, prompt, answer) {
      const tenantId = context.account.userId;
      const tag = tagOf(context, prompt);
      const card = await cardOf(tenantId, prompt.refId);
      if (!card) {
        await close(context, prompt);
        await context.reply("这件活已经不在了。");
        return;
      }
      if (answer === "验收") {
        const ok = await deps.delivery.review(
          tenantId,
          card.id,
          `user:${tenantId}`,
          "review",
        );
        await close(context, prompt);
        await context.reply(
          ok ? `已验收「${card.title}」。` : "这件活已经不在等你验收了。",
        );
        return;
      }
      const reason = RETURN.exec(answer)?.[1]?.trim() ?? "";
      if (!reason) {
        await context.reply(`退回要写原因，例如「${tag}退回 缺 C 家发票」。`);
        return;
      }
      if (Array.from(reason).length > RETURN_REASON_CHARS) {
        await context.reply(`退回原因请在 ${RETURN_REASON_CHARS} 字以内。`);
        return;
      }
      const returned = await returnTaskWithReason(
        { delivery: deps.delivery, turns: deps.turns },
        tenantId,
        card.id,
        { actor: `user:${tenantId}`, reason },
      );
      if (returned.ok) {
        await close(context, prompt);
        await context.reply(
          `已退回给【${await botName(card.agentId)}】：${reason}`,
        );
        return;
      }
      switch (returned.why) {
        case "pending":
          await context.reply("正在退回，稍等一下。");
          return;
        case "not_returnable":
          await close(context, prompt);
          await context.reply("这件活不在等你验收，不能退回。");
          return;
        case "refused":
          await context.reply(returned.message ?? "现在退回不了，稍后再试。");
          return;
        default:
          await context.reply("现在退回不了，稍后再试。");
      }
    },
  };

  const LATER = /^延期(?:[\s:：,，]*)(.*)$/su;
  const SWAP = /^换人[\s:：,，]*(.*)$/su;

  /** 「延期 时间」：有待答复的延期申请就准许它（延到这个时间），没有就直接改预计时间。 */
  async function extend(
    context: WechatPromptContext,
    prompt: WechatPrompt,
    card: NonNullable<Awaited<ReturnType<typeof cardOf>>>,
    said: string,
  ) {
    const tenantId = context.account.userId;
    const tag = tagOf(context, prompt);
    const at = now();
    const timeZone = await zoneOf(tenantId);
    const example = `例如「${tag}延期 明早10点」「${tag}延期 2小时后」「${tag}延期 周五」。`;
    if (!said) {
      await context.reply(`延期到什么时候？${example}`);
      return;
    }
    const reading = readLaterTime(said, at, timeZone, {
      endOfDay: (await deps.endOfDay?.(tenantId)) ?? null,
    });
    if (!reading.at) {
      await context.reply(
        reading.why === "unreadable"
          ? `没认出「${said}」是什么时候，${example}`
          : `${dueRefusalText(reading.why)}，换个时间再说一次。`,
      );
      return;
    }
    const actor = `user:${tenantId}` as const;
    const granted = await deps.delivery.decideExtension(tenantId, card.id, {
      actor,
      decision: "grant",
      dueAt: reading.at.toISOString(),
      now: at,
      timeZone,
    });
    let dueAt: Date | null = null;
    if (granted.ok) {
      dueAt = granted.dueAt;
      // 和看板上答复延期一样：在卡片的对话里说一声，对话里的延期申请卡跟着变。
      if (granted.threadRef && granted.agentId)
        await deps.turns
          ?.say(
            tenantId,
            {
              threadId: granted.threadRef,
              agentId: granted.agentId,
              runId: granted.runId,
            },
            {
              type: EventType.CUSTOM,
              name: DELIVERY_EVENTS.extensionDecided,
              value: {
                taskId: card.id,
                decision: "grant",
                dueAt: granted.dueAt?.toISOString() ?? null,
              },
            } as BaseEvent,
            granted.dueAt
              ? `准许延期到 ${clockOf(granted.dueAt, at, timeZone)}`
              : "准许延期",
          )
          .catch((error) =>
            console.error(
              JSON.stringify({
                type: "wechat-extension-notice-failed",
                taskId: card.id,
                error: error instanceof Error ? error.name : "UnknownError",
              }),
            ),
          );
    } else if (granted.why === "no_request") {
      const edited = await deps.delivery.editTask(tenantId, card.id, {
        actor,
        dueAt: reading.at,
      });
      if (!edited.ok) {
        await close(context, prompt);
        await context.reply(
          edited.why === "not_followed"
            ? "这件活不在跟或已经结束。"
            : "成果已交或这件活已结束，改不了时间。",
        );
        return;
      }
      dueAt = edited.dueAt;
    } else if (granted.why === "not_open") {
      await close(context, prompt);
      await context.reply("这件活不在跟或已经结束。");
      return;
    } else if (granted.why === "handed_in") {
      await close(context, prompt);
      await context.reply("成果已交，退回之后才能改时间。");
      return;
    } else if (granted.why === "stale_request") {
      await context.reply("员工刚又申请了一次延期，请到网页上看看再答复。");
      return;
    } else {
      await context.reply(`${dueRefusalText(granted.why)}，换个时间再说一次。`);
      return;
    }
    await close(context, prompt);
    await context.reply(
      `好的，「${card.title}」延期到 ${clockOf(dueAt ?? reading.at, at, timeZone)}。`,
    );
  }

  async function swap(
    context: WechatPromptContext,
    prompt: WechatPrompt,
    card: NonNullable<Awaited<ReturnType<typeof cardOf>>>,
    said: string,
  ) {
    const tenantId = context.account.userId;
    const tag = tagOf(context, prompt);
    if (!deps.rounds) {
      await context.reply("现在换不了人，稍后再试。");
      return;
    }
    const others = (await deps.bots.list(context.actor)).filter(
      (agent) => agent.id !== card.agentId && agent.name,
    );
    const asked = said.replace(/^[@＠]\s*/u, "").trim();
    if (!asked) {
      await context.reply(
        others.length
          ? `换给谁？回复「${tag}换人 员工名」，可以选：${others.map((agent) => agent.name).join("、")}`
          : "没有别的员工可以换。",
      );
      return;
    }
    const hits = others.filter(
      (agent) => agent.name.toLowerCase() === asked.toLowerCase(),
    );
    const [hit] = hits;
    if (!hit) {
      await context.reply(`没找到叫 ${asked} 的员工`);
      return;
    }
    if (hits.length > 1) {
      await context.reply(
        `有 ${hits.length} 位员工叫 ${asked}，请到网页上换人。`,
      );
      return;
    }
    if (await deps.acceptTaskDisabled?.(tenantId, hit.id)) {
      await context.reply(`【${hit.name}】的接活工具已关闭，不能接手这件活。`);
      return;
    }
    const moved = await deps.rounds.reassignTask(
      tenantId,
      card.id,
      hit.id,
      `user:${tenantId}`,
    );
    if (moved.ok) {
      await close(context, prompt);
      await context.reply(`已换给【${hit.name}】，等它接下。`);
      return;
    }
    switch (moved.why) {
      case "no_coworker":
        await context.reply(`没找到叫 ${asked} 的员工`);
        return;
      case "same_coworker":
        await context.reply("这件活已经是这位员工在做。");
        return;
      case "waiting_on_you":
        await context.reply("这件活在等你处理（审批或提问），处理完再换人。");
        return;
      case "handed_in":
        await close(context, prompt);
        await context.reply("成果已交，验收或退回之后才能换人。");
        return;
      default:
        await close(context, prompt);
        await context.reply("这件活不在跟或已经结束。");
    }
  }

  const overdue: WechatPromptHandler = {
    stale: staleOf,
    settled: answerSettled,
    accepts: (answer) =>
      answer === "再催" ||
      answer === "取消" ||
      LATER.test(answer) ||
      SWAP.test(answer),
    async label(prompt) {
      const card = await cardOf(prompt.userId, prompt.refId);
      return card ? `逾期：「${card.title}」` : "逾期";
    },
    async handle(context, prompt, answer) {
      const tenantId = context.account.userId;
      const card = await cardOf(tenantId, prompt.refId);
      if (!card) {
        await close(context, prompt);
        await context.reply("这件活已经不在了。");
        return;
      }
      if (answer === "取消") {
        const cancelled = await deps.delivery.cancelTask(
          tenantId,
          card.id,
          `user:${tenantId}`,
        );
        await close(context, prompt);
        if (!cancelled) {
          await context.reply("这件活不在跟或已经结束。");
          return;
        }
        if (cancelled.threadRef)
          await deps.turns?.stopRound(tenantId, {
            threadId: cancelled.threadRef,
            agentId: cancelled.agentId,
            runId: cancelled.runId,
          });
        await context.reply(`已取消「${card.title}」。`);
        return;
      }
      if (answer === "再催") {
        if (!deps.rounds) {
          await context.reply("现在催不了，稍后再试。");
          return;
        }
        const nudged = await deps.rounds.nudgeNow(tenantId, card.id, {
          actor: `user:${tenantId}`,
          now: now(),
          timeZone: await zoneOf(tenantId),
        });
        if (nudged.ok) {
          await close(context, prompt);
          await context.reply(`已催【${await botName(card.agentId)}】。`);
          return;
        }
        if (nudged.why === "not_nudgeable") await close(context, prompt);
        await context.reply(
          nudged.why === "running"
            ? "员工正在做这件活的一轮，稍后再催。"
            : nudged.why === "just_nudged"
              ? "刚催过，过一会儿再催。"
              : nudged.why === "refused"
                ? nudged.message
                : "这件活不在员工手上（未在跟、已交成果、在等你处理或已结束），不用催。",
        );
        return;
      }
      const later = LATER.exec(answer);
      if (later) {
        await extend(context, prompt, card, later[1]?.trim() ?? "");
        return;
      }
      await swap(context, prompt, card, SWAP.exec(answer)?.[1]?.trim() ?? "");
    },
  };

  return {
    handlers: { approval, handin, overdue } satisfies Partial<
      Record<WechatPromptKind, WechatPromptHandler>
    >,
    openApprovalPrompts,
    openApprovalPrompt,
    openHandinPrompt,
    openOverduePrompt,
  };
}

export type WechatDecisions = ReturnType<typeof createWechatDecisions>;

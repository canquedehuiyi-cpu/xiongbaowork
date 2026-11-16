/*
 * 微信入站分流（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 6）：一条微信消息交给哪位员工、在哪段
 * 对话里开一轮、回复怎么发回微信。
 *
 * 轮询器在 `runAsTenant(account.tenantId, …)` 里逐条调这里，所以这里的一切都在本人的帧里，不开 platform 帧
 * （`converse` 和 `deliveryStore.bind` 内部各自已有的 platform 读除外）。
 *
 * 顺序：
 *  0. 不是本人发的、群里的：不理。然后持久去重（`claimMessage`），见过的直接返回，不回话、不开提示。
 *  1. 没有文字 → 「目前只认文字……」。
 *  2. 在回一条开着的提示（`prompts.ts` 认，按 `kind` 分派）：`pick_agent` 在这里；审批、交付待验收、逾期在
 *     `decisions.ts`（Task 7），经 `deps.prompts` 挂进来。
 *     选人提示开过 10 分钟就作废；消息一旦交给某位员工（或只写「@名字」换人），开着的选人提示也都关掉。
 *  3. 「@名字」开头 → 在这个人看得到的员工里按显示名找：一位 → 交给它；几位同名 → 开选人提示；没有 → 「没找到」。
 *  4. 否则交给上次的员工；没有 → 开选人提示，列最近 5 位「回复数字选员工」。
 *  5. 交给员工：默认单聊 → `scopeFor` → 确保有一条 `wechat` 绑定 → `converse` 开一轮 → 回复加「【员工名】」切段发回。
 *
 * 去重：`delivery_inbox` 的 (source, realm, external_id) 只能在选出员工、有了对话之后才写得进去（对话列非空、
 * 有外键），所以每条消息先在账号行上记一笔（迁移 0227），覆盖所有分支；开一轮的那条路 `converse` 里还会按
 * `delivery_inbox` 再去重一次，外部 ID 都是这条消息自己的 `message.id`。处理中途抛错时拿掉那一笔，轮询器重试时
 * 照常处理；已经开过的一轮由 `delivery_inbox` 挡住，不会再开。
 *
 * 发送：发回微信失败（时间窗关了等）只记日志（错误类名，不含 token 和 context_token），不让这里抛错——
 * 抛了轮询器会重试整条消息。员工的回复已经在熊宝的对话里。
 */
import type { AgentProfileStore } from "../../agents/profile-store";
import type { AgentActor, AgentProfile } from "../../agents/profile-types";
import { shortName } from "../../brand";
import type { ChannelStore } from "../../channels/routes";
import {
  type CredentialSecretReader,
  CredentialUnusableError,
  decryptCredentialForUse,
} from "../../credentials";
import type {
  WechatAccount,
  WechatPrompt,
  WechatPromptKind,
} from "../../db/schema/wechat";
import type { DeliveryRouter } from "../router";
import type { DeliveryScopeResolver } from "../routes";
import type { DeliveryStore } from "../store";
import { DeliveryRefusedError } from "../types";
import type { IlinkClient, IlinkMessage } from "./ilink";
import { matchPromptReply, type PromptAccepts } from "./prompts";
import type { WechatStore } from "./store";

/** 单条微信文本最多多少字（按码点数）。 */
export const WECHAT_TEXT_LIMIT = 2000;
/** 选人名单最多列几位。 */
const PICK_LIMIT = 5;
/** 选人提示开着多久还算数：过了就不再截走数字回复（当普通消息）。 */
export const WECHAT_PICK_TTL_MS = 10 * 60 * 1000;

/**
 * 把一段文字切成每段不超过 `limit` 个字（码点）的几段，拼起来和原文一样。段内有换行、且换行不太靠前时
 * 在换行之后断开，免得把一行拦腰截断。
 */
export function splitWechatText(
  text: string,
  limit = WECHAT_TEXT_LIMIT,
): string[] {
  const chars = Array.from(text);
  if (chars.length <= limit) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      const newline = chars.lastIndexOf("\n", end - 1);
      if (newline >= start + Math.floor(limit / 2)) end = newline + 1;
    }
    parts.push(chars.slice(start, end).join(""));
    start = end;
  }
  return parts;
}

export type WechatSend = (
  account: WechatAccount,
  input: { text: string; contextToken: string | null },
) => Promise<void>;

/** 发回微信时缺了能发的东西（没有令牌、没有 context_token）。只有类名进日志。 */
export class WechatReplyUnavailableError extends Error {
  override name = "WechatReplyUnavailableError";
}

/**
 * 真的发送器：解封这个人的 `bot_token`，带着 `context_token` 调 iLink `sendmessage`。在本人的帧里调用
 * （轮询器的帧）。令牌只交给 iLink，不进日志和错误。
 */
export function createWechatSender(deps: {
  ilink: Pick<IlinkClient, "sendText">;
  credentials: CredentialSecretReader;
  keyEncryptionKey: string;
}): WechatSend {
  return async (account, input) => {
    if (!account.credentialId || !input.contextToken)
      throw new WechatReplyUnavailableError("wechat reply is not possible");
    let botToken: string;
    try {
      botToken = await decryptCredentialForUse(
        deps.keyEncryptionKey,
        deps.credentials,
        account.credentialId,
      );
    } catch (error) {
      if (error instanceof CredentialUnusableError)
        throw new WechatReplyUnavailableError("wechat reply is not possible");
      throw error;
    }
    await deps.ilink.sendText(
      { baseUrl: account.baseUrl, botToken },
      {
        toUserId: account.ilinkUserId,
        contextToken: input.contextToken,
        text: input.text,
      },
    );
  };
}

type Roster = Pick<AgentProfile, "id" | "name" | "title">[];

/** 处理一条提示回复时能用的东西。 */
export type WechatPromptContext = {
  account: WechatAccount;
  message: IlinkMessage;
  actor: AgentActor;
  /** 这个人此刻开着的提示（含这一条）：不止一条时，回话里提到这条要带编号。 */
  open: WechatPrompt[];
  reply(text: string): Promise<void>;
  /** 交给这位员工开一轮（规则 5）。 */
  turn(agentId: string, text: string): Promise<void>;
};

/** 一类提示：认哪些回答、在「请带编号」的清单里怎么称呼、怎么处理。Task 7 加审批、交付闭环几类。 */
export type WechatPromptHandler = {
  accepts: PromptAccepts;
  label(prompt: WechatPrompt): string | Promise<string>;
  handle(
    context: WechatPromptContext,
    prompt: WechatPrompt,
    answer: string,
  ): Promise<void>;
};

export type WechatInboundDeps = {
  wechat: Pick<
    WechatStore,
    | "account"
    | "claimMessage"
    | "releaseMessage"
    | "setLastAgent"
    | "openPrompt"
    | "openPrompts"
    | "closePrompt"
  >;
  deliveries: Pick<DeliveryStore, "bind">;
  router: Pick<DeliveryRouter, "converse">;
  channels: Pick<ChannelStore, "direct" | "list">;
  bots: Pick<AgentProfileStore, "list" | "get">;
  actorFor(userId: string): Promise<AgentActor>;
  scopeFor: DeliveryScopeResolver;
  send: WechatSend;
  /** 测试用：判断选人提示是否过期的时钟。 */
  now?: () => Date;
  /** 别的提示类型（Task 7）。`pick_agent` 由这里自己处理。 */
  prompts?: Partial<Record<WechatPromptKind, WechatPromptHandler>>;
  /**
   * 微信里开的那一轮停下来等审批时，给这些审批开编号提示，返回要发的文字（Task 7 `decisions.ts`）。
   * 没有时照旧只说「有 N 个审批在等你」。
   */
  approvalPrompts?: (
    userId: string,
    approvalIds: string[],
  ) => Promise<string[]>;
};

/** 选人提示存的东西：候选员工（编号就是下标加一）和被搁置的那条消息（只写了「@名字」时为 null）。 */
type PickRef = { agents: string[]; text: string | null };

function readPick(prompt: WechatPrompt): PickRef | null {
  try {
    const ref = JSON.parse(prompt.refId) as Partial<PickRef>;
    if (!Array.isArray(ref.agents)) return null;
    return {
      agents: ref.agents.filter((id): id is string => typeof id === "string"),
      text: typeof ref.text === "string" ? ref.text : null,
    };
  } catch {
    return null;
  }
}

/**
 * 名字以拉丁字母或数字结尾时，后面必须是空白、标点或结尾：「@Bobby hi」不是「Bob」。中文名不要求
 * （「@代码熊看下」照样认得）。`text` 是 @ 之后的原文。
 */
function endsAtBoundary(name: string, text: string): boolean {
  if (!/[A-Za-z0-9]$/.test(name)) return true;
  const next = Array.from(text.slice(name.length))[0];
  return next === undefined || /[\s\p{P}\p{S}]/u.test(next);
}

/** 名字之后可以跟的分隔：空白和常见标点。 */
const AFTER_NAME = /^[\s,，:：、]+/u;

function logFailure(type: string, error: unknown) {
  console.error(
    JSON.stringify({
      type,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );
}

export function createWechatInbound(deps: WechatInboundDeps) {
  const now = deps.now ?? (() => new Date());
  /** 这个人看得到的员工，最近聊过的在前（侧栏的顺序：置顶、再按最近），其余随后。 */
  async function roster(actor: AgentActor): Promise<Roster> {
    const [profiles, page] = await Promise.all([
      deps.bots.list(actor),
      deps.channels.list(actor, { limit: 50 }),
    ]);
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const ordered: Roster = [];
    const seen = new Set<string>();
    for (const channel of page.channels) {
      const [only] = channel.agentIds;
      if (channel.agentIds.length !== 1 || !only || seen.has(only)) continue;
      const profile = byId.get(only);
      if (!profile) continue;
      seen.add(only);
      ordered.push(profile);
    }
    for (const profile of profiles)
      if (!seen.has(profile.id)) ordered.push(profile);
    return ordered;
  }

  /** 名单里的称呼：重名的带上头衔，免得两行一模一样。 */
  function labels(candidates: Roster): string[] {
    return candidates.map((agent) =>
      candidates.filter((other) => other.name === agent.name).length > 1 &&
      agent.title
        ? `${agent.name}（${agent.title}）`
        : agent.name,
    );
  }

  const pickAgent: WechatPromptHandler = {
    accepts: (answer) => /^\d{1,2}$/.test(answer),
    label: () => "选员工",
    async handle(context, prompt, answer) {
      const ref = readPick(prompt);
      const n = Number(answer);
      if (!ref || !/^\d{1,2}$/.test(answer)) {
        await context.reply("回复数字选员工。");
        return;
      }
      if (n < 1 || n > ref.agents.length) {
        await context.reply(
          `请回复 1 到 ${ref.agents.length} 之间的数字选员工。`,
        );
        return;
      }
      const agentId = ref.agents[n - 1];
      if (!agentId) return;
      const agent = await deps.bots.get(context.actor, agentId);
      if (!agent) {
        await context.reply("这位员工已经不在了，请换一位。");
        return;
      }
      if (ref.text === null) {
        await deps.wechat.setLastAgent(context.account.id, agent.id);
        await deps.wechat.closePrompt(context.account.userId, prompt.code);
        await context.reply(
          `好的，接下来交给【${agent.name}】，直接说事就行。`,
        );
        return;
      }
      // `turn` 在 `converse` 返回后关掉所有选人提示（含这一条）。在那之前出错，提示还开着，轮询器重试这条
      // 「数字」时照样选中；`converse` 记过收件箱的，重试时由 `delivery_inbox` 按这条消息的 ID 挡住。
      // 没走到那一步（员工不在了等）也关掉这一条。
      await context.turn(agent.id, ref.text);
      await deps.wechat.closePrompt(context.account.userId, prompt.code);
    },
  };

  const handlers: Partial<Record<WechatPromptKind, WechatPromptHandler>> = {
    ...deps.prompts,
    pick_agent: pickAgent,
  };
  const accepts = Object.fromEntries(
    Object.entries(handlers).map(([kind, handler]) => [kind, handler.accepts]),
  ) as Partial<Record<WechatPromptKind, PromptAccepts>>;

  async function handle(
    account: WechatAccount,
    message: IlinkMessage,
    signal: AbortSignal,
  ) {
    const reply = async (text: string) => {
      for (const part of splitWechatText(text)) {
        try {
          await deps.send(account, {
            text: part,
            contextToken: message.contextToken ?? account.contextToken,
          });
        } catch (error) {
          logFailure("wechat-reply-failed", error);
          return;
        }
      }
    };
    if (message.text === null || !message.text.trim()) {
      await reply(`目前只认文字，图片和文件请在${shortName()}里发`);
      return;
    }
    const text = message.text.trim();
    const actor = await deps.actorFor(account.userId);
    /** 消息交给了某位员工（或换了人）：这个人还开着的选人提示都作废，免得后面回给员工的数字被截走。 */
    const closePicks = async () => {
      for (const open of await deps.wechat.openPrompts(account.userId))
        if (open.kind === "pick_agent")
          await deps.wechat.closePrompt(account.userId, open.code);
    };

    /** 开选人提示：先关掉这个人还开着的旧选人提示，同一时间只留一条。 */
    const pick = async (
      candidates: Roster,
      held: string | null,
      intro: string,
    ) => {
      await closePicks();
      const ref: PickRef = { agents: candidates.map((a) => a.id), text: held };
      const { code } = await deps.wechat.openPrompt(
        account.userId,
        "pick_agent",
        JSON.stringify(ref),
      );
      const names = labels(candidates);
      // 带上提示编号：别的提示（审批、交付）同时开着时，直接回「A3 1」。
      await reply(
        [
          intro,
          `${code}：回复数字选员工`,
          ...names.map((name, i) => `${i + 1}. ${name}`),
        ].join("\n"),
      );
    };

    const turn = async (agentId: string, body: string) => {
      const agent = await deps.bots.get(actor, agentId);
      if (!agent) {
        await reply("这位员工已经不在了，发「@员工名」换一位。");
        return;
      }
      const channel = await deps.channels.direct(actor, agent.id);
      const scope = await deps.scopeFor(account.userId, channel.id, agent.id);
      if (!scope) {
        await reply(
          `暂时联系不上【${agent.name}】，请到${shortName()}里看看。`,
        );
        return;
      }
      const identity = `${account.ilinkUserId}#${agent.id}`;
      try {
        await deps.deliveries.bind({
          ...scope,
          transport: "wechat",
          realm: account.ilinkBotId,
          identity,
          address: account.ilinkUserId,
        });
      } catch (error) {
        if (!(error instanceof DeliveryRefusedError)) throw error;
        await reply(
          `这个微信和【${agent.name}】的对话连在别的${shortName()}账号上，请到${shortName()}里处理。`,
        );
        return;
      }
      await deps.wechat.setLastAgent(account.id, agent.id);
      // 关停已经开始、这一轮还没开：抛出去，去重记录拿掉、游标不存，重启后这条完整重来。
      signal.throwIfAborted();
      const result = await deps.router.converse({
        transport: "wechat",
        realm: account.ilinkBotId,
        identity,
        externalId: message.id,
        text: body,
        signal,
      });
      // `converse` 返回了（不论结果）才关选人提示：它在记收件箱前抛错时提示还开着，重试这条「数字」
      // 照样按搁置的原文开一轮。之后再重试，「数字」交给刚记下的员工，`delivery_inbox` 按这条消息的 ID 挡住。
      await closePicks();
      const signed = (line: string) => `【${agent.name}】${line}`;
      switch (result.kind) {
        case "duplicate":
          return;
        case "unbound":
          await reply(signed(`暂时联系不上，请到${shortName()}里看看。`));
          return;
        case "failed":
          await reply(
            signed(
              signal.aborted
                ? `服务正在更新，这一轮被打断了，请稍后再发一次，或到${shortName()}里查看。`
                : `这一轮没有完成，请到${shortName()}里看看。`,
            ),
          );
          return;
        default: {
          const parts = [
            result.replyText,
            ...result.extras.questions.map((q) => q.text),
          ].filter((part) => part.trim());
          // 这一轮停下来等的审批：开编号提示，请求随回复之后各发一条，回数字就能批（Task 7）。开不了（出错）
          // 就照旧说「有 N 个审批在等你」：这一轮已经记过收件箱，这里抛错的话重试也不会再回话。
          let asks: string[] = [];
          if (result.extras.approvals.length && deps.approvalPrompts)
            try {
              asks = await deps.approvalPrompts(account.userId, [
                ...result.extras.approvals,
              ]);
            } catch (error) {
              logFailure("wechat-approval-prompt-failed", error);
            }
          if (result.extras.approvals.length && !asks.length)
            parts.push(
              `有 ${result.extras.approvals.length} 个审批在等你，请到${shortName()}里处理。`,
            );
          else if (result.kind === "waiting" && !parts.length && !asks.length)
            parts.push(`在等人处理，请打开${shortName()}继续。`);
          if (parts.length || !asks.length)
            await reply(signed(parts.join("\n\n") || "完成了。"));
          for (const ask of asks) await reply(ask);
        }
      }
    };

    // 2. 在回一条开着的提示。
    const open: WechatPrompt[] = [];
    const expiredBefore = now().getTime() - WECHAT_PICK_TTL_MS;
    for (const prompt of await deps.wechat.openPrompts(account.userId)) {
      // 过期的选人提示顺手关掉，不再截走数字回复。
      if (
        prompt.kind === "pick_agent" &&
        prompt.createdAt.getTime() < expiredBefore
      )
        await deps.wechat.closePrompt(account.userId, prompt.code);
      else open.push(prompt);
    }
    const matched = matchPromptReply(text, open, accepts);
    if (matched?.kind === "ambiguous") {
      // 例子用真的编号和这条回复：认这个回答的最后一条（通常是最新的那条）。
      const answer = text.normalize("NFKC").trim();
      const example =
        matched.open.findLast((p) => accepts[p.kind]?.(answer, p)) ??
        matched.open.at(-1);
      const lines = await Promise.all(
        matched.open.map(async (p) =>
          `${p.code} ${(await handlers[p.kind]?.label(p)) ?? ""}`.trim(),
        ),
      );
      await reply(
        [
          `有几条待处理，请带编号回复，例如 ${example?.code ?? "A2"} ${answer}：`,
          ...lines,
        ].join("\n"),
      );
      return;
    }
    if (matched) {
      const handler = handlers[matched.prompt.kind];
      if (handler) {
        await handler.handle(
          { account, message, actor, open, reply, turn },
          matched.prompt,
          matched.answer,
        );
        return;
      }
    }

    // 3. 「@名字」开头。
    const mention = /^[@＠]\s*(.+)$/su.exec(text);
    if (mention?.[1]) {
      const after = mention[1];
      const all = await roster(actor);
      // 最长的名字先配：「代码熊2」和「代码熊」都在时，「@代码熊2 …」是前者。
      const lowered = after.toLowerCase();
      const fits = all.filter(
        (agent) =>
          agent.name &&
          lowered.startsWith(agent.name.toLowerCase()) &&
          endsAtBoundary(agent.name, after),
      );
      const longest = Math.max(0, ...fits.map((agent) => agent.name.length));
      const hits = fits.filter((agent) => agent.name.length === longest);
      const [hit] = hits;
      if (!hit) {
        const asked = after.split(/[\s,，:：、]/u)[0] || after;
        await reply(`没找到叫 ${asked} 的员工`);
        return;
      }
      const rest = after.slice(hit.name.length).replace(AFTER_NAME, "").trim();
      if (hits.length > 1) {
        await pick(
          hits,
          rest || null,
          `有 ${hits.length} 位员工叫 ${hit.name}。`,
        );
        return;
      }
      if (!rest) {
        await deps.wechat.setLastAgent(account.id, hit.id);
        await closePicks();
        await reply(`好的，接下来交给【${hit.name}】，直接说事就行。`);
        return;
      }
      await turn(hit.id, rest);
      return;
    }

    // 4. 上次的员工；没有就列名单。
    const lastAgentId = account.lastAgentId;
    if (lastAgentId && (await deps.bots.get(actor, lastAgentId))) {
      await turn(lastAgentId, text);
      return;
    }
    const recent = (await roster(actor)).slice(0, PICK_LIMIT);
    if (!recent.length) {
      await reply(`你还没有员工，先到${shortName()}里招一位吧。`);
      return;
    }
    await pick(recent, text, "想找哪位员工？");
  }

  return async function inbound(
    claimed: WechatAccount,
    message: IlinkMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    // 只认本人私聊 ClawBot 的消息：别人的、群里的，交不到这个人的员工手上。
    if (message.groupId || message.fromUserId !== claimed.ilinkUserId) return;
    if (!(await deps.wechat.claimMessage(claimed.id, message.id))) return;
    try {
      // 轮询器给的是认领时的行；同一批前面的消息可能已经换了员工，所以重读。
      const account = (await deps.wechat.account(claimed.userId)) ?? claimed;
      if (account.id !== claimed.id) return;
      await handle(account, message, signal ?? new AbortController().signal);
    } catch (error) {
      // 拿掉去重记录自己也失败时只记日志：抛出去的必须是原来的错误。
      try {
        await deps.wechat.releaseMessage(claimed.id, message.id);
      } catch (releaseError) {
        logFailure("wechat-release-failed", releaseError);
      }
      throw error;
    }
  };
}

export type WechatInboundHandler = ReturnType<typeof createWechatInbound>;

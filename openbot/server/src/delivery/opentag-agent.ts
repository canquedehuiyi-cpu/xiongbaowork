/**
 * The AG-UI agent OpenTag calls. See `opentag.ts` for the pairing contract.
 *
 * Order matters and is the whole security story: the shared secret first, then OpenTag's sender
 * context, then the person's authenticated delivery binding. Only a bound sender reaches a turn, and
 * only their own Bot in their own canonical thread. Everyone else is told how to link, and nothing
 * runs.
 *
 * WHOSE TURN THIS IS (G01). The route itself is nobody's: OpenTag's secret names no person. The
 * binding (or, for `link`, the challenge) is looked up as the platform, and everything after it --
 * the turn, the answer to a question, an approval decision, the private notifications, the new
 * binding -- runs as the tenant the database stamped on that row, which may only agree with its
 * owner. A row stamped as nobody's is treated as no binding at all.
 */
import { randomUUID } from "node:crypto";
import { approvalPhrase } from "@openbot/shared/tool-name";
import type { DrawnComponent } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import {
  type ApprovalDecision,
  type ApprovalPolicyOutcome,
  afterChinese,
  approvalArgsPreview,
  offersStandingRule,
  wantsTo,
} from "../approvals/types";
import { englishName, shortName } from "../brand";
import {
  ingestSlackEvent,
  type SlackTriggerEvent,
} from "../responsibilities/slack";
import {
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import {
  agUiStream,
  approvalFields,
  COMPONENT_CALL_PREFIX,
  chartForOpenTag,
  chartSourcesLine,
  componentCallEvents,
  confirmWriteInterrupt,
  isComponentFollowUp,
  latestUserMessage,
  OPENTAG_CHART_TOOL,
  type OpenTagRunInput,
  type OpenTagTransport,
  parseChannelUser,
  parseOpenTagRunInput,
  resumeFromInput,
  senderFromContext,
  textEvents,
} from "./opentag";
import type { DeliveryRouter } from "./router";
import type { DeliveryStore } from "./store";
import {
  type ChatTransport,
  type DeliveryBinding,
  DeliveryRefusedError,
  type DeliveryScope,
} from "./types";

/** The approvals service, named by what a paired chat surface may do with it. */
export type PairedApprovals = {
  store: {
    get(
      ownerUserId: string,
      id: string,
    ): Promise<{
      status: string;
      action: {
        botId: string;
        toolRef: string;
        effect: string;
        /** Where it acts, and what it is aimed at: the card names the action by both. */
        scope: string;
        target?: unknown;
        threadId: string;
        args: unknown;
        /**
         * Why the gate asked. A check-in task's approval, and one the delete/outbound floors raised
         * (删除类和对外发送底线问的), offers no "Always allow".
         */
        policy?: ApprovalPolicyOutcome;
      };
    }>;
  };
  decide(
    ownerUserId: string,
    id: string,
    decision: ApprovalDecision,
  ): Promise<unknown>;
  answerQuestion(
    ownerUserId: string,
    id: string,
    response: string,
  ): Promise<unknown>;
  inbox(ownerUserId: string): Promise<{
    questions: { id: string; threadId: string; question: string }[];
  }>;
};

export type OpenTagAgentDeps = {
  opentag: OpenTagTransport;
  router: Pick<DeliveryRouter, "converse" | "notify">;
  store: Pick<
    DeliveryStore,
    | "findBinding"
    | "readChallenge"
    | "consumeChallenge"
    | "bind"
    | "botIdentity"
  >;
  scopeFor(
    owner: string,
    channelId: string,
    agentId: string,
  ): Promise<DeliveryScope | null>;
  approvals?: PairedApprovals;
  /** Slack trigger ingest; defaults to the responsibilities lane's `ingestSlackEvent`. */
  ingestSlack?: (event: SlackTriggerEvent) => Promise<unknown>;
  /**
   * OpenBot linked-account codes (Connections) from a Slack sender. Reachability
   * codes are checked first; this is used for any code that is not a live one (an expired or used
   * Reachability code falls through too, matches no account code, and gets the usual expired reply).
   * An account code is redeemed only in a direct message. One posted in a shared conversation is
   * cancelled (`discard`), since anyone there could send it first and bind their own Slack account
   * to its issuer: with a mention the issuer is told to make a new one; without one (an observed
   * post) it is cancelled quietly and redacted before the Slack triggers see the message.
   */
  identity?: {
    redeem(
      code: string,
      sender: { teamId: string; userId: string },
    ): Promise<"linked" | "conflict" | "invalid">;
    /** Cancels a live account code; true when one was cancelled. */
    discard(code: string): Promise<boolean>;
  };
};

const LINK =
  /\blink\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const LINKS = new RegExp(LINK.source, "gi");

/**
 * A channel post the app was not mentioned in: everyone there has seen any link code in it,
 * Reachability or account, so on Slack each one is cancelled, quietly (an observe run never
 * replies; Teams waits on the same rule as `link`). The codes are redacted rather than
 * the message dropped, so the post still fires the owners' message triggers without carrying a
 * code. A failed cancel is logged and never stops the triggers.
 */
async function withoutLinkCodes(
  deps: OpenTagAgentDeps,
  sender: { transport: ChatTransport },
  text: string,
) {
  const codes = [...text.matchAll(LINKS)].map((m) => m[1]?.toLowerCase());
  if (!codes.length) return text;
  for (const code of codes) {
    if (!code) continue;
    // Each cancel is tried on its own: a store that fails to spend a Reachability code must not
    // leave an account code with the same value live, and the other way round.
    if (sender.transport !== "slack") continue;
    await logFailure(() => cancelReachabilityCode(deps, code));
    const identity = deps.identity;
    if (identity) await logFailure(() => identity.discard(code));
  }
  return text.replace(LINKS, "link [code removed]");
}

async function logFailure(cancel: () => Promise<unknown>) {
  try {
    await cancel();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "opentag-link-code-discard-error",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

/**
 * Spends a live Reachability code without binding anyone; true when one was cancelled. Read as the
 * platform and spent as its issuer, as the mentioned path does (G01); an untrusted stamp is left to
 * expire.
 */
async function cancelReachabilityCode(deps: OpenTagAgentDeps, code: string) {
  const challenge = await runAsTenant("platform", () =>
    deps.store.readChallenge(code),
  );
  if (!challenge) return false;
  const issuer = trustedTenant(challenge.tenantId, challenge.ownerUserId);
  if (!issuer) return false;
  return Boolean(
    await runAsTenant(issuer, () =>
      deps.store.consumeChallenge(code, challenge.ownerUserId),
    ),
  );
}

// A function, not a constant: the brand is set after this module loads.
const cancelledInShared = () =>
  `这个关联码发在了别人也看得到的地方，我已经把它作废了。请在${shortName()}里重新生成一个，用私信发给我。`;

const platformName = (transport: ChatTransport) =>
  transport === "teams" ? "Microsoft Teams" : "Slack";

export function linkInstructions(transport: ChatTransport) {
  return `我还不知道你在${shortName()}里是谁，所以什么都没有执行。请在${shortName()}的「触达方式」里选好对话和 ${platformName(transport)}，把页面上给出的 \`link <关联码>\` 消息发给我。`;
}

/** What a person reads when a turn fails for a reason the Bot is not meant to explain. */
export function turnFailureMessage(): string {
  return `${englishName()} could not complete this turn. Try again, or open the conversation in ${englishName()}.`;
}

export async function handleOpenTagRun(
  deps: OpenTagAgentDeps,
  request: Request,
): Promise<Response> {
  if (!deps.opentag.authenticates(request.headers.get("authorization")))
    return Response.json(
      { error: "Invalid OpenTag credentials." },
      { status: 401 },
    );
  let input: OpenTagRunInput;
  try {
    input = parseOpenTagRunInput(await request.json());
  } catch (error) {
    // Where the run failed to parse, never what it said: paths and codes only.
    console.error(
      JSON.stringify({
        type: "opentag-run-invalid",
        issues:
          error instanceof z.ZodError
            ? error.issues.slice(0, 10).map(({ path, code }) => ({
                path: path.join("."),
                code,
              }))
            : [
                {
                  path: "",
                  code: error instanceof Error ? error.name : "unknown",
                },
              ],
      }),
    );
    return Response.json(
      { error: "Supply a valid AG-UI run." },
      { status: 400 },
    );
  }
  const signal = request.signal;
  const stream = agUiStream(async (emit) => {
    const { threadId, runId } = input;
    emit({ type: "RUN_STARTED", threadId, runId });
    const say = (text: string) => {
      for (const event of textEvents(randomUUID(), text)) emit(event);
    };
    try {
      const outcome = await answer(deps, input, signal);
      say(outcome.text);
      // The Bot's charts, drawn natively by the Channel when it offers its chart component.
      if (input.tools.some((tool) => tool.name === OPENTAG_CHART_TOOL))
        for (const component of outcome.components ?? []) {
          const args = chartForOpenTag(component);
          if (!args) continue;
          for (const event of componentCallEvents(
            `${COMPONENT_CALL_PREFIX}${randomUUID()}`,
            OPENTAG_CHART_TOOL,
            args,
          ))
            emit(event);
          say(chartSourcesLine(component.args));
        }
      if (outcome.interrupt)
        emit({
          type: "CUSTOM",
          name: "on_interrupt",
          value: outcome.interrupt,
        });
      emit({ type: "RUN_FINISHED", threadId, runId });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "opentag-run-error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      emit({
        type: "RUN_ERROR",
        message:
          error instanceof DeliveryRefusedError
            ? error.message
            : turnFailureMessage(),
      });
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function answer(
  deps: OpenTagAgentDeps,
  input: OpenTagRunInput,
  signal: AbortSignal,
): Promise<{
  text: string;
  interrupt?: unknown;
  components?: DrawnComponent[];
}> {
  // The Channel drew our chart and runs us again with its result; the turn already answered.
  if (isComponentFollowUp(input)) return { text: "" };
  const resume = resumeFromInput(input);
  if (resume) return decideFromCard(deps, resume);

  const sender = senderFromContext(input);
  if (!sender)
    return {
      text: `OpenTag 没有告诉${shortName()}这条消息是谁发的，所以什么都没有执行。请把 OpenTag 升级到会转发发送者信息的版本。`,
    };
  // Something to watch, not to answer: feed the owner's Slack triggers and stay quiet.
  if (sender.observe) {
    const text =
      sender.observe === "message" ? latestUserMessage(input)?.text : undefined;
    await feedSlackTriggers(deps, sender, {
      type: sender.observe,
      text: text && (await withoutLinkCodes(deps, sender, text)),
    });
    return { text: "" };
  }
  const message = latestUserMessage(input);
  if (!message?.text)
    return { text: "给我发消息，我会转给你的员工。" };

  const code = LINK.exec(message.text)?.[1];
  if (code) return link(deps, sender, code.toLowerCase());

  // One event per Slack message: a mention is `app_mention` only, never also a `message`. Fed
  // whether or not the author linked OpenBot: owners' triggers are decided by their own access.
  await feedSlackTriggers(deps, sender, {
    type: sender.mentioned ? "app_mention" : "message",
    text: message.text,
  });
  const owned = await ownedBinding(deps, sender);
  if (!owned) return { text: linkInstructions(sender.transport) };
  return runAsTenant(owned.tenant, () =>
    answerAsBinding(
      deps,
      input,
      sender,
      { id: message.id, text: message.text },
      owned.binding,
      signal,
    ),
  );
}

/** The bound sender's message, run inside the binding's own tenant. */
async function answerAsBinding(
  deps: OpenTagAgentDeps,
  input: OpenTagRunInput,
  sender: NonNullable<ReturnType<typeof senderFromContext>>,
  message: { id?: string | undefined; text: string },
  bound: DeliveryBinding,
  signal: AbortSignal,
): Promise<{
  text: string;
  interrupt?: unknown;
  components?: DrawnComponent[];
}> {
  const answered = await answerOpenQuestion(deps, bound, message.text);
  if (answered) {
    const bot = await deps.store.botIdentity(bound.agentId);
    return {
      text: `谢谢，你的回答已经转给 ${bot?.name ?? YOUR_BOT}，它会接着做，并在这里回复你。`,
    };
  }

  const result = await deps.router.converse({
    transport: sender.transport,
    realm: sender.realm,
    identity: sender.identity,
    // The platform event id survives an agent retry; the AG-UI message id is the fallback.
    externalId: sender.event
      ? `event:${sender.event}`
      : `${input.threadId}:${message.id ?? input.runId}`,
    text: message.text,
    signal,
  });
  if (result.kind === "unbound")
    return { text: linkInstructions(sender.transport) };
  if (result.kind === "duplicate")
    return { text: "这条消息已经转给你的员工了。" };
  if (result.kind === "failed") return { text: `${result.message}` };

  if (!sender.private) return answerPrivately(deps, result);

  const questions = result.extras.questions.map((q) => q.text);
  const approvalId = result.extras.approvals[0];
  const parts = [result.replyText, ...questions].filter(Boolean);
  if (questions.length) parts.push("直接在这里回复就能回答。");
  if (approvalId) {
    const card = await approvalCard(deps, result.binding, approvalId);
    if (result.extras.approvals.length > 1)
      parts.push(
        `还有 ${result.extras.approvals.length - 1} 个审批在${shortName()}的员工页上等你处理。`,
      );
    if (card) return { text: parts.join("\n\n"), interrupt: card };
    parts.push(`你的员工在等一个审批。请到${shortName()}的员工页上查看。`);
  } else if (result.kind === "waiting" && !parts.length) {
    parts.push(`你的员工在等人处理。请打开${shortName()}继续。`);
  }
  return {
    text: parts.join("\n\n") || "完成了。",
    ...(result.components ? { components: result.components } : {}),
  };
}

/**
 * The conversation may include other people, and the turn's output comes from the owner's private
 * conversation. So none of it is posted in the thread: the reply, questions and approval requests go
 * to the owner through the delivery outbox (their DM with the app, their other linked channels, their
 * phone), where failures are visible, and the thread only says where the answer went.
 */
async function answerPrivately(
  deps: OpenTagAgentDeps,
  result: Extract<
    Awaited<ReturnType<DeliveryRouter["converse"]>>,
    { extras: unknown }
  >,
) {
  const scope = {
    ownerUserId: result.binding.ownerUserId,
    channelId: result.binding.channelId,
    agentId: result.binding.agentId,
    threadId: result.binding.threadId,
  };
  if (result.replyText)
    await deps.router.notify(scope, {
      id: `opentag-reply:${result.inboxId}`,
      text: result.replyText,
      kind: "reply",
    });
  for (const question of result.extras.questions)
    await deps.router.notify(scope, {
      id: question.id,
      text: question.text,
      kind: "question",
      requestId: question.id,
    });
  const bot = await deps.store.botIdentity(result.binding.agentId);
  for (const approvalId of result.extras.approvals)
    await deps.router.notify(scope, {
      id: approvalId,
      text: `${bot?.name ?? YOUR_BOT} 在等你审批。请到${shortName()}的员工页上查看。`,
      kind: "approval",
      requestId: approvalId,
    });
  return {
    text: "这个对话可能有别人能看到，所以我把回答私信发给你了。",
  };
}

/**
 * A message from a bound person who has an open question from this Bot answers that question.
 * Checked before running a fresh turn so the reply resumes the question's own continuation.
 */
export async function answerOpenQuestion(
  deps: OpenTagAgentDeps,
  binding: DeliveryBinding,
  text: string,
) {
  if (!deps.approvals) return null;
  const { questions } = await deps.approvals.inbox(binding.ownerUserId);
  const open = questions.find((q) => q.threadId === binding.threadId);
  if (!open) return null;
  await deps.approvals.answerQuestion(binding.ownerUserId, open.id, text);
  return open;
}

async function link(
  deps: OpenTagAgentDeps,
  sender: {
    transport: ChatTransport;
    realm: string;
    identity: string;
    private: boolean;
  },
  code: string,
) {
  // The code is the only thing that names a person here, so it is read as the platform; the rest
  // runs as the tenant stamped on the challenge, so the binding is filed as that person's (G01).
  const challenge = await runAsTenant("platform", () =>
    deps.store.readChallenge(code),
  );
  // A Reachability code binds whoever sends it to its issuer's Bot: their messages run as the
  // issuer, and the Bot's questions and approval requests go to them. Anyone else in a shared
  // conversation has seen it and could send it first, so it is only redeemed in a direct message
  // and one posted here is spent, the same rule as for an account code below. Slack only for now:
  // a Teams chat is private only by its conversation kind, and until OpenTag is confirmed to send
  // `personal` for a one-to-one chat, this rule could spend every code sent from Teams.
  if (challenge && sender.transport === "slack" && !sender.private) {
    const issuer = trustedTenant(challenge.tenantId, challenge.ownerUserId);
    // Spent as its issuer, whose row it is (G01); an untrusted stamp is left to expire.
    if (issuer)
      await runAsTenant(issuer, () =>
        deps.store.consumeChallenge(code, challenge.ownerUserId),
      );
    return { text: cancelledInShared() };
  }
  if (!challenge && sender.transport === "slack" && deps.identity) {
    // Anyone else in a shared conversation has now seen the code and could send it first, binding
    // their own Slack account to its issuer, so an account code is only redeemed in a direct
    // message and one posted here is cancelled (an unmentioned channel post is cancelled in
    // `withoutLinkCodes`).
    if (!sender.private) {
      if (await deps.identity.discard(code))
        return { text: cancelledInShared() };
      return {
        text: `这个关联码已经过期、用过了，或者是别的应用的。请在${shortName()}里重新生成一个。`,
      };
    }
    const outcome = await deps.identity.redeem(code, {
      teamId: sender.realm,
      userId: sender.identity,
    });
    if (outcome === "linked")
      return {
        text: `你的 Slack 账号已经关联到${shortName()}，可以在「已连接的账号」里看到。`,
      };
    if (outcome === "conflict")
      return {
        text: `这个 Slack 账号已经关联到${shortName()}的另一位用户。`,
      };
  }
  const tenant = challenge
    ? trustedTenant(challenge.tenantId, challenge.ownerUserId)
    : null;
  if (!challenge || !tenant || challenge.transport !== sender.transport)
    return {
      text: `这个关联码已经过期、用过了，或者是别的应用的。请在${shortName()}里重新生成一个。`,
    };
  return runAsTenant(tenant, () => linkAs(deps, sender, code, challenge));
}

async function linkAs(
  deps: OpenTagAgentDeps,
  sender: { transport: ChatTransport; realm: string; identity: string },
  code: string,
  challenge: NonNullable<Awaited<ReturnType<DeliveryStore["readChallenge"]>>>,
) {
  const scope = await deps.scopeFor(
    challenge.ownerUserId,
    challenge.channelId,
    challenge.agentId,
  );
  if (
    !scope ||
    scope.threadId !== challenge.threadId ||
    !(await deps.store.consumeChallenge(code, challenge.ownerUserId))
  )
    return {
      text: `那个对话已经变了。请在${shortName()}里重新生成关联码。`,
    };
  try {
    await deps.store.bind({
      ...scope,
      transport: sender.transport,
      realm: sender.realm,
      identity: sender.identity,
      // Slack delivers a message addressed to a user id into that user's DM with the app.
      address: sender.identity,
    });
  } catch (error) {
    if (error instanceof DeliveryRefusedError) return { text: error.message };
    throw error;
  }
  const bot = await deps.store.botIdentity(scope.agentId);
  return {
    text: `关联好了。你在这里发给我的消息会转到${shortName()}里和 ${bot?.name ?? YOUR_BOT} 的对话，它的提问和审批也会发到这里。`,
  };
}

/** 找不到员工的名字时，卡片和回复里对它的称呼。 */
const YOUR_BOT = "你的员工";

async function approvalCard(
  deps: OpenTagAgentDeps,
  binding: DeliveryBinding,
  approvalId: string,
) {
  if (!deps.approvals) return null;
  let record: Awaited<ReturnType<PairedApprovals["store"]["get"]>>;
  try {
    record = await deps.approvals.store.get(binding.ownerUserId, approvalId);
  } catch {
    return null;
  }
  if (
    record.status !== "pending" ||
    record.action.threadId !== binding.threadId
  )
    return null;
  const bot = await deps.store.botIdentity(record.action.botId);
  return confirmWriteInterrupt({
    approvalId,
    // In the words the approval card in OpenBot uses, never the tool's id ("Your Bot: computer_click").
    action: wantsTo(bot?.name ?? YOUR_BOT, record.action),
    approver: `${binding.transport}:${binding.identity}`,
    effect: record.action.effect,
    // The approvals preview already redacts secrets and private content.
    fields: approvalFields(approvalArgsPreview(record.action)),
    allowAlways: offersStandingRule(record.action),
  });
}

async function decideFromCard(
  deps: OpenTagAgentDeps,
  resume: NonNullable<ReturnType<typeof resumeFromInput>>,
): Promise<{ text: string }> {
  if (resume.invalid)
    return {
      text: "没能读懂这次审批的回答，所以什么都没有决定。",
    };
  if (!deps.approvals)
    return {
      text: `这个部署不能在聊天里审批。请到${shortName()}的员工页上决定。`,
    };
  const person = parseChannelUser(resume.by);
  if (!person)
    return {
      text: `这张审批卡片没有说明是谁回答的，所以什么都没有决定。请升级 OpenTag，或者到${shortName()}的员工页上决定。`,
    };
  // The clicker is mapped exactly like a message sender; OpenTag already refused anyone but the
  // named approver, and OpenBot then decides only as that binding's owner.
  const owned = await ownedBinding(deps, person);
  if (!owned)
    return {
      text: "你没有关联到这个审批的主人，所以什么都没有决定。",
    };
  // Decided as the binding's own tenant, so the approval's resume is stamped as that person (G01).
  return runAsTenant(owned.tenant, () =>
    decideAsBinding(deps, resume, owned.binding),
  );
}

async function decideAsBinding(
  deps: OpenTagAgentDeps,
  resume: Extract<
    NonNullable<ReturnType<typeof resumeFromInput>>,
    { invalid: false }
  >,
  binding: DeliveryBinding,
): Promise<{ text: string }> {
  if (!deps.approvals)
    return {
      text: `这个部署不能在聊天里审批。请到${shortName()}的「审批」里决定。`,
    };
  let record: Awaited<ReturnType<PairedApprovals["store"]["get"]>>;
  try {
    record = await deps.approvals.store.get(
      binding.ownerUserId,
      resume.approvalId,
    );
  } catch {
    return {
      text: "这个审批不是你的，或者已经不存在了，所以什么都没有决定。",
    };
  }
  if (record.action.threadId !== binding.threadId)
    return {
      text: "这个审批属于另一个对话，所以什么都没有决定。",
    };
  if (record.status !== "pending")
    return {
      text: `这个审批已经决定过了。可以在${shortName()}里查看结果。`,
    };
  // An older card may still offer "Always allow" on a check-in task's approval: that is once.
  // 删除类底线问的动作没有「总是允许」：旧卡片上按的 always 只当作这一次。
  const decision: ApprovalDecision = !resume.confirmed
    ? "deny"
    : resume.always && offersStandingRule(record.action)
      ? "allow_always"
      : "allow_once";
  await deps.approvals.decide(binding.ownerUserId, resume.approvalId, decision);
  const bot = await deps.store.botIdentity(record.action.botId);
  const name = bot?.name ?? YOUR_BOT;
  return {
    text:
      decision === "deny"
        ? `已拒绝。${name} 不会${afterChinese(approvalPhrase(record.action))}。`
        : `${decision === "allow_always" ? "已设为总是允许" : "已允许这一次"}。${name} 会继续，并把结果发到这里。`,
  };
}

/**
 * Hand a verified Slack event to the responsibilities lane, for the linked owner's own Bot. Only
 * for a bound sender: an unlinked person names no owner, so their events fire nobody's triggers.
 * Never fails the chat turn; a trigger problem is logged where an operator can find it.
 */
async function feedSlackTriggers(
  deps: OpenTagAgentDeps,
  sender: NonNullable<ReturnType<typeof senderFromContext>>,
  event: { type: SlackTriggerEvent["type"]; text?: string },
) {
  if (
    sender.transport !== "slack" ||
    !sender.event ||
    !sender.conversationId ||
    !/^[A-Z0-9]{2,32}$/.test(sender.realm)
  )
    return;
  // The managed Channel does not expose Slack's own `ts`, so the delivery time stands in for it.
  const now = Math.floor(Date.now() / 1000);
  try {
    await (deps.ingestSlack ?? ingestSlackEvent)({
      teamId: sender.realm,
      eventId: sender.event,
      eventTime: now,
      type: event.type,
      channelId: sender.conversationId,
      userId: sender.identity,
      ts: `${now}.000000`,
      ...(event.text ? { text: event.text.slice(0, 40_000) } : {}),
      ...(event.type === "reaction_added" && sender.reaction
        ? { reaction: sender.reaction }
        : {}),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "opentag-slack-trigger-error",
        errorType: error instanceof Error ? error.name : "UnknownError",
        message:
          error instanceof Error ? error.message.slice(0, 200) : undefined,
      }),
    );
  }
}

/**
 * The person a stored row says it belongs to, or null (G01): the tenant the database stamped on it,
 * which its owner may only agree with. A row stamped as nobody's (`system`, `platform`) answers
 * null, and is treated as if it did not exist.
 */
function trustedTenant(stamped: unknown, owner: string): string | null {
  try {
    return assertPersonTenant(stamped, owner);
  } catch (error) {
    if (error instanceof TenantContextError) return null;
    throw error;
  }
}

/**
 * The sender's enabled binding and the tenant to act as for it, only while its owner still has
 * that conversation and Bot. Which person an identity is bound to is looked up as the platform;
 * the conversation check already runs as the binding's own tenant.
 */
async function ownedBinding(
  deps: OpenTagAgentDeps,
  person: { transport: ChatTransport; realm: string; identity: string },
): Promise<{ binding: DeliveryBinding; tenant: string } | null> {
  const binding = await runAsTenant("platform", () =>
    deps.store.findBinding(person.transport, person.realm, person.identity),
  );
  if (!binding) return null;
  const tenant = trustedTenant(binding.tenantId, binding.ownerUserId);
  if (!tenant) return null;
  const scope = await runAsTenant(tenant, () =>
    deps.scopeFor(binding.ownerUserId, binding.channelId, binding.agentId),
  );
  return scope?.threadId === binding.threadId ? { binding, tenant } : null;
}

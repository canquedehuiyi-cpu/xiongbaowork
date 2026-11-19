import type { DrawnComponent } from "@openbot/toolkit/run-turn";
import {
  resolveUpdateRoute,
  type UpdateRoute,
  type UpdateRouteInput,
} from "../agents/lifecycle";
import { productName } from "../brand";
import type { AttentionPing } from "../proactive/contracts";
import { pingHeadline } from "../proactive/ping";
import {
  assertPersonTenant,
  isTenantFramed,
  requireTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import type { WorkItem, WorkQueue } from "../work/queue";
import type { ExpoPushTransport } from "./push";
import type { DeliveryStore } from "./store";
import {
  type BindingTransport,
  type ChatTransport,
  type DeliveryBinding,
  type DeliveryInbox,
  type DeliveryKind,
  DeliveryProviderError,
  DeliveryRefusedError,
  type DeliveryScope,
  PERSON_DELIVERY_KINDS,
  type PersonDeliveryKind,
  type TextTransport,
  type WechatPromptRefKind,
  wechatPromptRef,
} from "./types";
/** What a paired chat turn produced besides its reply, surfaced in that same turn. */
export type InlineTurnExtras = {
  approvals: string[];
  questions: { id: string; text: string }[];
};
export type ConverseResult =
  | { kind: "unbound" }
  | { kind: "duplicate"; binding: DeliveryBinding }
  | {
      kind: "replied" | "waiting";
      binding: DeliveryBinding;
      inboxId: string;
      replyText: string;
      /** Display components the turn drew, for a chat surface that can draw them natively. */
      components?: DrawnComponent[];
      extras: InlineTurnExtras;
      waiting?: { kind: string; requestId?: string; approvalId?: string };
    }
  | {
      kind: "failed";
      binding: DeliveryBinding;
      inboxId: string;
      message: string;
    };
/** Twilio error 21610: the recipient has opted out, so Twilio refuses the send. */
const TWILIO_UNSUBSCRIBED = "21610";
export type DeliveryWorkKind =
  | "delivery.inbound"
  | "delivery.outbound"
  | "delivery.push-receipt";
export const DELIVERY_WORK_KINDS: DeliveryWorkKind[] = [
  "delivery.inbound",
  "delivery.outbound",
  "delivery.push-receipt",
];
type RouterStore = Pick<
  DeliveryStore,
  | "findBinding"
  | "binding"
  | "bindingsFor"
  | "bindingsByUse"
  | "checkInConversations"
  | "devices"
  | "device"
  | "removeDevice"
  | "offerInbox"
  | "latestInbox"
  | "inbox"
  | "setInbox"
  | "offerOutbox"
  | "outbox"
  | "outboxByKey"
  | "startOutbox"
  | "setOutbox"
  | "offerReceipt"
  | "recordInbox"
  | "setSmsOptOut"
  | "botIdentity"
>;
/** The title of a push that carries no heading of its own. */
export function defaultPushTitle(): string {
  return productName();
}

export function createDeliveryRouter(deps: {
  store: RouterStore;
  queue: Pick<WorkQueue, "claim" | "renew" | "finish" | "release">;
  owner: string;
  authoriseScope(scope: DeliveryScope): Promise<boolean>;
  /**
   * The person's conversation with a Bot, as delivery addresses it, or null when they can no longer
   * reach either. A ping's push is filed under one of these.
   */
  scopeFor(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<DeliveryScope | null>;
  /**
   * The owner's turn. `tenantId` is the tenant of the row the turn answers for (the paired binding,
   * or the queued inbox row), never this worker's own frame: a queued delivery is claimed on a timer
   * that has no tenant, so the turn is told whose it is (see `TurnRunner`).
   */
  runTurn(
    input: DeliveryScope & {
      tenantId: string;
      runId: string;
      text: string;
      signal: AbortSignal;
      /** Where the person wrote: the native app, or a chat or text platform. */
      source: DeliveryInbox["source"];
    },
  ): Promise<{
    replyText: string;
    components?: DrawnComponent[];
    waiting?: boolean;
  }>;
  providers: {
    /** Slack and Teams both reach people through the OpenTag pairing's proactive delivery. */
    slack?: TextTransport;
    teams?: TextTransport;
    sms?: TextTransport;
    /** 微信 ClawBot 的发件箱出口（Task 8）；没有时发往微信的行记为失败。 */
    wechat?: TextTransport;
    push?: ExpoPushTransport;
  };
  /**
   * 微信的主动推送时间窗（wechat/transport.ts `createWechatWindow`）：窗口关着时不写微信那一行，并记一笔
   * 漏发，下次入站时补一句。没有时不看窗口。
   */
  wechatWindow?: {
    open(ownerUserId: string): Promise<boolean>;
    missed(ownerUserId: string): Promise<void>;
  };
  /** The person's routing by kind; defaults to the lifecycle lane's `resolveUpdateRoute`. */
  routeFor?(input: UpdateRouteInput): Promise<UpdateRoute>;
  /** Unused since Slack events feed `ingestSlackEvent` from the pairing route; kept for assembly. */
  notifyEvent?(event: {
    ownerUserId: string;
    source: "slack";
    externalId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
  audit?(event: {
    ownerUserId: string;
    channelId: string;
    id: string;
    kind: string;
    state: string;
  }): Promise<void>;
}) {
  const leaseMs = 60_000;
  /**
   * The person a stored record says it belongs to, or null (G01).
   *
   * `stamped` is the tenant the database wrote on the row from the frame that created it; the
   * record's owner, when given, may only agree. A row stamped as nobody's, one naming another
   * person, or a caller already acting for somebody else answers null, and nothing is run or sent
   * for it.
   */
  function trustedTenant(stamped: unknown, owner?: string): string | null {
    try {
      return assertPersonTenant(stamped, owner);
    } catch (error) {
      if (error instanceof TenantContextError) return null;
      throw error;
    }
  }
  /**
   * Bindings with a paired chat turn open in this process. An approval or question raised during
   * that turn is shown in the turn itself (an OpenTag card, or text), so it is collected here rather
   * than also sent as a second, proactive message to the same person.
   */
  const inline = new Map<string, InlineTurnExtras>();
  /**
   * 微信那一行能不能写：时间窗开着。关着时（只有提醒类才算漏发，回复不算）记一笔漏发，`noted` 保证同一次
   * 通知只记一笔。
   */
  async function wechatOpen(
    ownerUserId: string,
    noted: { done: boolean },
    countsAsMissed = true,
  ): Promise<boolean> {
    if (!deps.wechatWindow) return true;
    if (await deps.wechatWindow.open(ownerUserId)) return true;
    if (countsAsMissed && !noted.done) {
      noted.done = true;
      await deps.wechatWindow.missed(ownerUserId);
    }
    return false;
  }
  /** 本人最近用过、还能进的那个微信绑定（「等你确认」没有对口绑定时回落用），没有就是 null。 */
  async function wechatFallback(
    ownerUserId: string,
  ): Promise<DeliveryBinding | null> {
    for (const binding of await deps.store.bindingsByUse(ownerUserId)) {
      if (binding.transport !== "wechat") continue;
      if (binding.ownerUserId !== ownerUserId) continue;
      if (await deps.authoriseScope(binding)) return binding;
    }
    return null;
  }
  async function notify(
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: Exclude<DeliveryKind, PersonDeliveryKind>;
      requestId?: string | null;
      /**
       * A `reply` that says a turn ended while its person was away (`threads/turn-notice.ts`), the one
       * thing sent to the places they are, whoever started the turn.
       *
       * `push` and `chat` are the person's own switches for the phone and for the chat platforms they
       * bound. A reply from a turn begun in the browser is otherwise never pushed to WeChat (the
       * routing rule below); this one is, because the person is away from the browser, and it follows
       * the same gates as everything else sent there: the person's routing for progress (WeChat only
       * where they opted in), the Bot's notification level and WeChat's time window. `chatText` is the
       * line without the Bot's name, for a platform that posts under that Bot's own name.
       */
      away?: { push: boolean; chat: boolean; chatText: string };
    },
    includeBindings = true,
  ) {
    /*
     * Queued only from inside the owner's own frame (G01). The outbox rows and their work items are
     * stamped with whatever tenant this runs as, and the sweep sends only items stamped as a
     * person: a notification queued unframed (stamped `system`, which every tenant can read) or
     * from somebody else's frame would never be sent, and its text would sit where it does not
     * belong. Such a caller is reported here, by name, and nothing is queued.
     */
    if (
      !trustedTenant(
        isTenantFramed() ? requireTenant() : undefined,
        scope.ownerUserId,
      )
    ) {
      console.error(
        JSON.stringify({
          type: "delivery-notify-untrusted-tenant",
          kind: input.kind,
          id: input.id,
          framed: isTenantFramed(),
        }),
      );
      return;
    }
    if (!(await deps.authoriseScope(scope)))
      throw new DeliveryRefusedError("Conversation access has been revoked.");
    // Progress/decision/question routing and the per-Bot notification preference. Fails open.
    const route = await (deps.routeFor ?? resolveUpdateRoute)({
      ownerUserId: scope.ownerUserId,
      agentId: scope.agentId,
      kind: input.kind,
    });
    const noted = { done: false };
    const away = input.away;
    if (includeBindings && (away?.chat ?? true)) {
      const bindings: DeliveryBinding[] = await deps.store.bindingsFor(scope);
      /*
       * 「等你确认」在这段对话没有对口的微信绑定时（任务卡片那段对话、没在微信里找过的员工），回落到本人最近用过
       * 的那个微信绑定，和逾期、清点一样（`notifyPerson`）。文字由微信出口按审批本身写（员工名、对话名、编号），
       * 所以这一行记在那个绑定的对话下。本人没打开微信、时间窗关着时照常不发。Slack / Teams 不回落。
       */
      if (
        (input.kind === "approval" || away) &&
        deps.providers.wechat &&
        !bindings.some((binding) => binding.transport === "wechat")
      ) {
        const fallback = await wechatFallback(scope.ownerUserId);
        if (fallback) bindings.push(fallback);
      }
      for (const binding of bindings) {
        const open = inline.get(binding.id);
        if (open && input.kind === "approval" && input.requestId) {
          open.approvals.push(input.requestId);
          continue;
        }
        if (open && input.kind === "question") {
          open.questions.push({
            id: input.requestId ?? input.id,
            text: input.text,
          });
          continue;
        }
        // 部署关了微信（`WECHAT_ENABLED`）：之前留下的微信绑定不再写行。
        if (binding.transport === "wechat" && !deps.providers.wechat) continue;
        let roundToClose: string | null = null;
        if (binding.transport === "wechat" && input.kind === "reply" && !away) {
          /*
           * 网页里发起的普通回复不推到微信：回复只发给入站来源为微信、还停在等人处理的那一轮（它在微信里停下等
           * 审批，别处批了，后续的回复回到微信）。这一轮本来就是从微信发起的，回复属于那段对话，所以不看本人在
           * 「消息发到哪里」开没开微信；员工的通知级别（「什么都别通知」）照样算。
           */
          const last = await deps.store.latestInbox(binding.id);
          if (last?.source !== "wechat" || last.state !== "accepted") continue;
          roundToClose = last.id;
          if (!route.notify) {
            await deps.store.setInbox(
              roundToClose,
              "failed",
              "员工设成了不通知，回复没有发到微信。",
            );
            continue;
          }
        } else if (
          // Teams is a chat surface like Slack; routing names chat transports as `slack` until the
          // lifecycle lane lists `teams` separately.
          !route.allows(
            binding.transport === "teams" ? "slack" : binding.transport,
          )
        )
          continue;
        // 微信只在时间窗里发；提醒类没发出去算一笔漏发，回复不算。
        if (
          binding.transport === "wechat" &&
          !(await wechatOpen(scope.ownerUserId, noted, input.kind !== "reply"))
        ) {
          /*
           * 那一轮的回复发不出去也收尾：不置终态的话它一直是「最新一条」，之后网页里发起的回复会被当成它的推到
           * 微信。
           */
          if (roundToClose)
            await deps.store.setInbox(
              roundToClose,
              "failed",
              "微信的时间窗已关，回复没有发到微信。",
            );
          continue;
        }
        const filed =
          binding.channelId === scope.channelId &&
          binding.agentId === scope.agentId &&
          binding.threadId === scope.threadId
            ? scope
            : {
                ownerUserId: binding.ownerUserId,
                channelId: binding.channelId,
                agentId: binding.agentId,
                threadId: binding.threadId,
              };
        await deps.store.offerOutbox({
          ...filed,
          dedupeKey: `${input.kind}:${input.id}:binding:${binding.id}`,
          bindingId: binding.id,
          deviceId: null,
          transport: binding.transport,
          /*
           * A platform that posts as the Bot already names it, so the line without the name is sent
           * there -- unless the row is filed under another Bot's conversation (a WeChat account the
           * person last used with someone else), where the name is what says who it is about.
           */
          text:
            away &&
            binding.transport !== "sms" &&
            binding.agentId === scope.agentId
              ? away.chatText
              : input.text,
          kind: input.kind,
          requestId: input.requestId ?? null,
        });
        /*
         * 这一轮的回复交出去了：把那一轮的入站行置为终态。它停下等审批时被记成 `accepted`，网页聊天不会产生新的
         * 入站行，不置终态的话它会一直是「最新一条」，之后网页里发起的回复也会被当成它的而推到微信。
         */
        if (roundToClose) await deps.store.setInbox(roundToClose, "sent");
      }
    }
    if (route.allows("push") && (away?.push ?? true))
      for (const device of await deps.store.devices(scope.ownerUserId))
        await deps.store.offerOutbox({
          ...scope,
          dedupeKey: `${input.kind}:${input.id}:device:${device.id}`,
          bindingId: null,
          deviceId: device.id,
          transport: "push",
          text: input.text,
          kind: input.kind,
          requestId: input.requestId ?? null,
        });
  }
  /**
   * Offer one ping (proactive/ping.ts): once to each of the person's push devices, and one message
   * on each chat platform they use, into the account they used there last. That conversation's Bot
   * posts it, naming each item's Bot, and a reply there reaches that Bot as any reply does. A person
   * with no chat account connected gets the push, and the app lists the items either way. Their
   * routing for "Something needs you" picks the transports.
   *
   * AS THAT BOT, SO BY THAT BOT'S RULE. Whether an account may carry the message is the route that
   * conversation's Bot gets for its own updates, asked for `attention`: a Bot the person told to
   * notify them of nothing never posts one, and the next account they used on that platform carries
   * it instead. A platform left with none gets nothing; the push and the app still have it.
   *
   * SAFE TO OFFER AGAIN. A replica that stopped between writing a ping and marking it offered leaves
   * it to be offered again (`unoffered`). The keys are per platform and per device, not per account,
   * so a second offer sends nothing new even after the person has used another account since.
   */
  async function notifyAttention(ping: AttentionPing) {
    if (ping.items.length === 0) return;
    const routeFor = deps.routeFor ?? resolveUpdateRoute;
    const chosen = new Map<BindingTransport, DeliveryBinding>();
    const noted = { done: false };
    for (const binding of await deps.store.bindingsByUse(ping.ownerUserId)) {
      if (chosen.has(binding.transport)) continue;
      if (binding.transport === "wechat" && !deps.providers.wechat) continue;
      const carrier = await routeFor({
        ownerUserId: ping.ownerUserId,
        agentId: binding.agentId,
        kind: "attention",
      });
      if (!carrier.allows(binding.transport)) continue;
      // An account whose conversation the person lost is passed over for the next one they used.
      if (!(await deps.authoriseScope(binding))) continue;
      if (
        binding.transport === "wechat" &&
        !(await wechatOpen(ping.ownerUserId, noted))
      )
        continue;
      chosen.set(binding.transport, binding);
    }
    for (const [transport, binding] of chosen)
      await deps.store.offerOutbox({
        ownerUserId: binding.ownerUserId,
        channelId: binding.channelId,
        agentId: binding.agentId,
        threadId: binding.threadId,
        dedupeKey: `attention:${ping.pingId}:${transport}`,
        bindingId: binding.id,
        deviceId: null,
        transport,
        text: ping.text,
        kind: "attention",
        requestId: null,
      });
    const route = await routeFor({
      ownerUserId: ping.ownerUserId,
      kind: "attention",
    });
    if (!route.allows("push")) return;
    const devices = await deps.store.devices(ping.ownerUserId);
    if (devices.length === 0) return;
    const scope = await pingScope(ping);
    if (!scope) return;
    for (const device of devices)
      await deps.store.offerOutbox({
        ...scope,
        dedupeKey: `attention:${ping.pingId}:device:${device.id}`,
        bindingId: null,
        deviceId: device.id,
        transport: "push",
        text: `${pingHeadline(ping.items.length)}\n${ping.pushBody}`,
        kind: "attention",
        requestId: null,
      });
  }
  /**
   * Tell the person something about their followed work (spec 2026-11-15-delivery-loop §10): a start
   * or end briefing, or a reminder about one late card. Offered once to each of their push devices and
   * once on each chat platform they connected (Slack, Teams, SMS), as a ping is. Returns how many
   * places it was newly queued for (`queued`) and how many already held this same message for this
   * same person from an earlier try (`already`): a caller that reached nobody (both 0) keeps it for the
   * workbench. A number that replied STOP, and a platform with no provider here, are passed over and
   * not counted.
   *
   * WHERE. A chat platform's account in one of `scopes` (the card's conversation, best first) is
   * preferred, else the account the person used last on that platform; the push is filed under the
   * first of `scopes` the person can still reach, and is not sent when they can reach none. Whether
   * an account or a device may carry it is the person's routing for "Something needs you"
   * (`attention`), asked as that conversation's Bot, as a ping is.
   *
   * WHEN is the caller's to decide: work hours and the three-a-day cap are kept by the delivery
   * checker and the briefing pass before anything comes here. The rows are keyed by the person, `id`
   * and the place (`delivery_outbox.dedupe_key` is unique across the whole deployment, so a key
   * without the person would let the first person's briefing of the day shut out everybody else's);
   * offering the same message again sends nothing new.
   *
   * Queued only from the person's own frame, as `notify` is; anything else is reported and dropped.
   */
  async function notifyPerson(input: {
    ownerUserId: string;
    kind: Exclude<PersonDeliveryKind, "attention">;
    id: string;
    title: string;
    body: string;
    scopes: DeliveryScope[];
    /** The card a reminder is about, carried to the push so a tap opens it. */
    taskId?: string | null;
    /** 微信那一行末尾多带的一句（开工清点：「回复任意内容，今天的提醒就能继续发到这里」）。 */
    wechatFooter?: string;
    /** 微信那一行换成带编号的提示（传给微信出口的结构化标记，不看标题文字）。 */
    wechatPrompt?: WechatPromptRefKind;
  }): Promise<{ queued: number; already: number }> {
    const reached = { queued: 0, already: 0 };
    if (
      !trustedTenant(
        isTenantFramed() ? requireTenant() : undefined,
        input.ownerUserId,
      )
    ) {
      console.error(
        JSON.stringify({
          type: "delivery-notify-untrusted-tenant",
          kind: input.kind,
          id: input.id,
          framed: isTenantFramed(),
        }),
      );
      return reached;
    }
    const routeFor = deps.routeFor ?? resolveUpdateRoute;
    const text = input.body ? `${input.title}\n${input.body}` : input.title;
    const requestId = input.taskId ?? null;
    const key = (place: string) =>
      `${input.kind}:${input.ownerUserId}:${input.id}:${place}`;
    /*
     * One row: queued, or found there already. A key taken by a row that is not this person's
     * same message (which the person in the key rules out, short of a bug) is reported and counted
     * as nothing -- neither reached nor failed.
     */
    const offer = async (
      row: Parameters<RouterStore["offerOutbox"]>[0],
    ): Promise<void> => {
      if (await deps.store.offerOutbox(row)) {
        reached.queued += 1;
        return;
      }
      const held = await deps.store.outboxByKey(row.dedupeKey);
      if (
        held &&
        held.ownerUserId === input.ownerUserId &&
        held.kind === input.kind &&
        held.transport === row.transport
      ) {
        reached.already += 1;
        return;
      }
      console.error(
        JSON.stringify({
          type: "delivery-notify-key-taken",
          kind: input.kind,
          id: input.id,
          transport: row.transport,
        }),
      );
    };
    const candidates: DeliveryBinding[] = [];
    for (const scope of input.scopes)
      candidates.push(...(await deps.store.bindingsFor(scope)));
    candidates.push(...(await deps.store.bindingsByUse(input.ownerUserId)));
    const chosen = new Map<BindingTransport, DeliveryBinding>();
    const noted = { done: false };
    for (const binding of candidates) {
      if (chosen.has(binding.transport)) continue;
      if (binding.ownerUserId !== input.ownerUserId) continue;
      /*
       * Only a place that can carry it counts as reached: a number that replied STOP is never texted
       * (its row would only be marked opted out), and a platform this deployment has no provider for
       * would only fail. Counted, either one would tell the checker the person was told when nobody
       * was, and the reminder would miss the start briefing.
       */
      if (binding.optedOutAt) continue;
      if (!deps.providers[binding.transport]) continue;
      const carrier = await routeFor({
        ownerUserId: input.ownerUserId,
        agentId: binding.agentId,
        kind: "attention",
      });
      if (!carrier.allows(binding.transport)) continue;
      if (!(await deps.authoriseScope(binding))) continue;
      if (
        binding.transport === "wechat" &&
        !(await wechatOpen(input.ownerUserId, noted))
      )
        continue;
      chosen.set(binding.transport, binding);
    }
    for (const [transport, binding] of chosen)
      await offer({
        ownerUserId: binding.ownerUserId,
        channelId: binding.channelId,
        agentId: binding.agentId,
        threadId: binding.threadId,
        dedupeKey: key(transport),
        bindingId: binding.id,
        deviceId: null,
        transport,
        text:
          transport === "wechat" && input.wechatFooter
            ? `${text}\n${input.wechatFooter}`
            : text,
        kind: input.kind,
        requestId:
          transport === "wechat" && input.wechatPrompt && requestId
            ? wechatPromptRef(input.wechatPrompt, requestId)
            : requestId,
      });
    const route = await routeFor({
      ownerUserId: input.ownerUserId,
      kind: "attention",
    });
    if (!deps.providers.push || !route.allows("push")) return reached;
    const devices = await deps.store.devices(input.ownerUserId);
    if (devices.length === 0) return reached;
    let scope: DeliveryScope | null = null;
    for (const candidate of input.scopes)
      if (
        candidate.ownerUserId === input.ownerUserId &&
        (await deps.authoriseScope(candidate))
      ) {
        scope = candidate;
        break;
      }
    if (!scope) return reached;
    for (const device of devices)
      await offer({
        ...scope,
        dedupeKey: key(`device:${device.id}`),
        bindingId: null,
        deviceId: device.id,
        transport: "push",
        text,
        kind: input.kind,
        requestId,
      });
    return reached;
  }
  /**
   * The conversation a ping's push is filed under: the check-in conversation of its newest item the
   * person can still reach, so the send is refused, as any is, once they can reach none of them.
   */
  async function pingScope(ping: AttentionPing) {
    const tried = new Set<string>();
    for (const { agentId, channelId } of await deps.store.checkInConversations(
      ping.ownerUserId,
      ping.items.map((item) => item.suggestionId),
    )) {
      const key = JSON.stringify([agentId, channelId]);
      if (tried.has(key)) continue;
      tried.add(key);
      const scope = await deps.scopeFor(ping.ownerUserId, channelId, agentId);
      if (scope) return scope;
    }
    return null;
  }
  async function receive(input: {
    source: "sms";
    realm: string;
    identity: string;
    address?: string;
    externalId: string;
    text: string;
    echo?: boolean;
  }) {
    if (input.echo) return { queued: false };
    /*
     * Which person a provider identity is bound to is nobody's question until it is answered, so
     * the lookup asks as the platform. Everything after it runs as the binding's own tenant, so the
     * inbox row and its work item are stamped with the person and run as them (G01).
     */
    const binding = await runAsTenant("platform", () =>
      deps.store.findBinding(
        input.source,
        input.realm,
        input.identity,
        input.address,
      ),
    );
    if (!binding) return { queued: false };
    const tenant = trustedTenant(binding.tenantId, binding.ownerUserId);
    if (!tenant) return { queued: false };
    return runAsTenant(tenant, async () => {
      if (!(await deps.authoriseScope(binding))) return { queued: false };
      // Opted out by STOP: their texts start no turns until they send START.
      if (binding.optedOutAt) return { queued: false };
      const result = await deps.store.offerInbox({
        ownerUserId: binding.ownerUserId,
        channelId: binding.channelId,
        agentId: binding.agentId,
        threadId: binding.threadId,
        bindingId: binding.id,
        source: input.source,
        realm: input.realm,
        externalId: input.externalId,
        text: input.text,
      });
      // The downstream event engine deduplicates independently: a provider retry can recover an
      // interrupted event insertion without re-running the conversational turn.
      return result;
    });
  }
  /**
   * One paired Slack/Teams message, run now and answered in the same AG-UI stream.
   *
   * The same canonical turn as every other delivery (`runTurn`: the owner's selected Bot, in the
   * bound Intelligence thread, with learning, governance, approvals and audit), recorded in the
   * inbox for dedupe and visibility but not queued, since the caller is waiting for the answer.
   */
  async function converse(input: {
    /** Slack/Teams 经 OpenTag 配对；`wechat` 由微信入站分流（delivery/wechat/inbound.ts）调用。 */
    transport: ChatTransport | "wechat";
    realm: string;
    identity: string;
    externalId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<ConverseResult> {
    // Looked up as the platform, then run as the binding's own tenant, as `receive` is.
    const binding = await runAsTenant("platform", () =>
      deps.store.findBinding(input.transport, input.realm, input.identity),
    );
    if (!binding) return { kind: "unbound" };
    const tenant = trustedTenant(binding.tenantId, binding.ownerUserId);
    if (!tenant) return { kind: "unbound" };
    return runAsTenant(tenant, () => converseAs(binding, input));
  }
  async function converseAs(
    binding: NonNullable<Awaited<ReturnType<RouterStore["findBinding"]>>>,
    input: {
      transport: ChatTransport | "wechat";
      realm: string;
      externalId: string;
      text: string;
      signal: AbortSignal;
    },
  ): Promise<ConverseResult> {
    if (!(await deps.authoriseScope(binding))) return { kind: "unbound" };
    const scope = {
      ownerUserId: binding.ownerUserId,
      channelId: binding.channelId,
      agentId: binding.agentId,
      threadId: binding.threadId,
    };
    const row = await deps.store.recordInbox({
      ...scope,
      bindingId: binding.id,
      source: input.transport,
      realm: input.realm,
      externalId: input.externalId,
      text: input.text,
    });
    if (!row) return { kind: "duplicate", binding };
    // Slack responsibilities are fed by the pairing route through `ingestSlackEvent`, once per
    // event, so the turn itself does not also emit one.
    const extras: InlineTurnExtras = { approvals: [], questions: [] };
    inline.set(binding.id, extras);
    try {
      const result = await deps.runTurn({
        ...scope,
        tenantId: binding.tenantId,
        runId: row.id,
        text: input.text,
        signal: input.signal,
        source: input.transport,
      });
      await deps.store.setInbox(row.id, "sent");
      await deps.audit?.({
        ...scope,
        id: row.id,
        kind: "inbound",
        state: "sent",
      });
      return {
        kind: extras.approvals.length || result.waiting ? "waiting" : "replied",
        binding,
        inboxId: row.id,
        replyText: result.replyText,
        ...(result.components?.length ? { components: result.components } : {}),
        extras,
      };
    } catch (error) {
      // The governed turn stopped for a person: a durable approval or hand-off is now pending.
      if (
        error instanceof Error &&
        error.name === "HeadlessToolSuspension" &&
        "waiting" in error &&
        error.waiting &&
        typeof error.waiting === "object"
      ) {
        const waiting = error.waiting as {
          kind: string;
          requestId?: string;
          approvalId?: string;
        };
        const pending = waiting.approvalId ?? waiting.requestId;
        if (
          waiting.kind === "approval" &&
          pending &&
          !extras.approvals.includes(pending)
        )
          extras.approvals.push(pending);
        await deps.store.setInbox(
          row.id,
          "accepted",
          "Waiting for a person's decision.",
        );
        return {
          kind: "waiting",
          binding,
          inboxId: row.id,
          replyText: "",
          extras,
          waiting,
        };
      }
      const message =
        error instanceof DeliveryRefusedError
          ? error.message
          : "The agent turn failed. Inspect the conversation before retrying.";
      await deps.store.setInbox(row.id, "failed", message);
      await deps.audit?.({
        ...scope,
        id: row.id,
        kind: "inbound",
        state: "failed",
      });
      return { kind: "failed", binding, inboxId: row.id, message };
    } finally {
      if (inline.get(binding.id) === extras) inline.delete(binding.id);
    }
  }
  /**
   * One claimed delivery, run inside `tenant`: the tenant stamped on the claimed work item. The
   * inbox or outbox row is read in that frame, so another person's row is not even visible, and a
   * row that is visible but is not that person's own (a `system` row, or one naming somebody else)
   * is left alone rather than run or sent.
   */
  async function deliver(
    item: WorkItem,
    tenant: string,
    signal: AbortSignal,
    owns: () => Promise<boolean>,
  ) {
    if (!(await owns())) return;
    if (item.kind === "delivery.inbound") {
      const row = await deps.store.inbox(item.key);
      if (row && (row.tenantId !== tenant || row.ownerUserId !== tenant)) {
        untrusted(item, "inbox row is not the item tenant's");
        return;
      }
      if (
        !row ||
        row.state === "sent" ||
        row.state === "failed" ||
        row.state === "unknown"
      )
        return;
      if (row.state === "running") {
        await deps.store.setInbox(
          row.id,
          "unknown",
          "Previous agent turn stopped after execution began; inspect conversation before retrying.",
        );
        return;
      }
      if (!(await deps.authoriseScope(row))) {
        await deps.store.setInbox(
          row.id,
          "failed",
          "Conversation access has been revoked.",
        );
        return;
      }
      if (row.bindingId) {
        const binding = await deps.store.binding(row.bindingId);
        if (
          !binding?.enabled ||
          binding.ownerUserId !== row.ownerUserId ||
          binding.channelId !== row.channelId ||
          binding.agentId !== row.agentId ||
          binding.threadId !== row.threadId
        ) {
          await deps.store.setInbox(
            row.id,
            "failed",
            "The source connection changed or was disconnected.",
          );
          return;
        }
      }
      await deps.store.setInbox(row.id, "running");
      try {
        const result = await deps.runTurn({
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          agentId: row.agentId,
          threadId: row.threadId,
          tenantId: row.tenantId,
          runId: row.id,
          text: row.text,
          signal,
          source: row.source,
        });
        if (!(await owns())) return;
        if (result.replyText)
          await notify(row, {
            id: row.id,
            text: result.replyText,
            kind: "reply",
          });
        await deps.store.setInbox(row.id, "sent");
        await deps.audit?.({
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          id: row.id,
          kind: "inbound",
          state: "sent",
        });
      } catch (error) {
        if (!(await owns())) return;
        await deps.store.setInbox(
          row.id,
          "failed",
          error instanceof DeliveryRefusedError
            ? error.message
            : "The agent turn failed. Inspect the conversation before retrying.",
        );
        throw error;
      }
      return;
    }
    const current = await deps.store.outbox(item.key);
    if (!current) return;
    if (current.tenantId !== tenant || current.ownerUserId !== tenant) {
      untrusted(item, "outbox row is not the item tenant's");
      return;
    }
    if (item.kind === "delivery.push-receipt") {
      if (
        current.transport !== "push" ||
        current.state !== "accepted" ||
        !current.providerId ||
        !deps.providers.push
      )
        return;
      const receipt = await deps.providers.push.receipt(current.providerId);
      if (!(await owns())) return;
      if (receipt.status === "pending") {
        await deps.store.setOutbox(
          current.id,
          "failed",
          "Expo did not provide a receipt after the receipt window.",
        );
        return;
      }
      await deps.store.setOutbox(
        current.id,
        receipt.status,
        receipt.error ?? null,
      );
      if (receipt.revokeDevice && current.deviceId)
        await deps.store.removeDevice(current.ownerUserId, current.deviceId);
      return;
    }
    if (current.state === "running") {
      await deps.store.setOutbox(
        current.id,
        "unknown",
        "Previous delivery stopped after sending began; inspect provider history before retrying.",
      );
      return;
    }
    if (current.state !== "queued") return;
    if (!(await deps.authoriseScope(current))) {
      await deps.store.setOutbox(
        current.id,
        "failed",
        "Conversation access has been revoked.",
      );
      return;
    }
    const row = await deps.store.startOutbox(current.id);
    if (!row || !(await owns())) return;
    try {
      let result: {
        id: string;
        status: "queued" | "sent" | "accepted";
        note?: string;
      };
      if (row.transport === "push") {
        const device = row.deviceId
          ? await deps.store.device(row.deviceId)
          : null;
        if (
          !device?.enabled ||
          device.ownerUserId !== row.ownerUserId ||
          !deps.providers.push
        )
          throw new DeliveryRefusedError("Push device unavailable.");
        const [title, body] = (
          PERSON_DELIVERY_KINDS as readonly DeliveryKind[]
        ).includes(row.kind)
          ? headedText(row.text)
          : [defaultPushTitle(), row.text];
        result = await deps.providers.push.send({
          token: device.token,
          title,
          body,
          channelId: row.channelId,
          kind: row.kind,
          requestId: row.requestId,
        });
      } else {
        const binding = row.bindingId
          ? await deps.store.binding(row.bindingId)
          : null;
        if (
          !binding?.enabled ||
          binding.ownerUserId !== row.ownerUserId ||
          binding.channelId !== row.channelId ||
          binding.agentId !== row.agentId ||
          binding.threadId !== row.threadId
        )
          throw new DeliveryRefusedError(
            "Connection unavailable or moved to another conversation.",
          );
        if (row.transport === "sms" && binding.optedOutAt) {
          if (!(await owns())) return;
          await deps.store.setOutbox(
            row.id,
            "opted_out",
            "The recipient replied STOP. Nothing was sent; they can reply START to resume.",
          );
          return;
        }
        const provider = deps.providers[row.transport];
        if (!provider) throw new DeliveryRefusedError("Provider unavailable.");
        const sender =
          row.transport === "sms"
            ? undefined
            : ((await deps.store.botIdentity(row.agentId)) ?? undefined);
        result = await provider.send({
          id: row.id,
          address: binding.address,
          text: row.text,
          transport: row.transport,
          ...(sender ? { sender } : {}),
          ...(row.transport === "wechat"
            ? {
                context: {
                  ownerUserId: row.ownerUserId,
                  kind: row.kind,
                  requestId: row.requestId,
                },
              }
            : {}),
        });
      }
      if (!(await owns())) return;
      await deps.store.setOutbox(
        row.id,
        result.status === "queued" ? "accepted" : result.status,
        result.note ?? null,
        result.id,
      );
      if (row.transport === "push") await deps.store.offerReceipt(row.id);
      await deps.audit?.({
        ownerUserId: row.ownerUserId,
        channelId: row.channelId,
        id: row.id,
        kind: row.transport,
        state: result.status,
      });
    } catch (error) {
      if (!(await owns())) return;
      if (
        error instanceof DeliveryProviderError &&
        error.provider === "Twilio" &&
        error.code === TWILIO_UNSUBSCRIBED
      ) {
        const binding = row.bindingId
          ? await deps.store.binding(row.bindingId)
          : null;
        if (binding) await smsOptOut(binding.realm, binding.identity, true);
        await deps.store.setOutbox(
          row.id,
          "opted_out",
          "Twilio reports this number opted out (21610). Nothing was sent.",
        );
        return;
      }
      await deps.store.setOutbox(
        row.id,
        error instanceof DeliveryProviderError && error.uncertain
          ? "unknown"
          : "failed",
        error instanceof DeliveryRefusedError ||
          error instanceof DeliveryProviderError
          ? error.message
          : "Provider delivery failed.",
      );
      if (
        error instanceof DeliveryProviderError &&
        error.code === "DeviceNotRegistered" &&
        row.deviceId
      )
        await deps.store.removeDevice(row.ownerUserId, row.deviceId);
      await deps.audit?.({
        ownerUserId: row.ownerUserId,
        channelId: row.channelId,
        id: row.id,
        kind: row.transport,
        state: "failed",
      });
    }
  }
  /** Twilio STOP/START for one number: record it on every binding for that number, and audit it. */
  async function smsOptOut(realm: string, identity: string, optedOut: boolean) {
    /*
     * A STOP is the number's, across every person bound to it, so the mark is written as the
     * platform; each binding's audit row is then written as that binding's own tenant, and a
     * binding stamped as nobody's is marked but audits nothing (G01).
     */
    return runAsTenant("platform", async () => {
      const rows = await deps.store.setSmsOptOut(realm, identity, optedOut);
      for (const row of rows) {
        const tenant = trustedTenant(row.tenantId, row.ownerUserId);
        if (!tenant) continue;
        await runAsTenant(tenant, async () =>
          deps.audit?.({
            ownerUserId: row.ownerUserId,
            channelId: row.channelId,
            id: row.id,
            kind: "sms_opt_out",
            state: optedOut ? "opted_out" : "opted_in",
          }),
        );
      }
      return rows.length;
    });
  }
  function untrusted(item: WorkItem, reason: string) {
    console.warn(
      JSON.stringify({
        type: "delivery-untrusted-tenant",
        kind: item.kind,
        id: item.key,
        reason,
      }),
    );
  }
  return {
    receive,
    converse,
    notify,
    notifyAttention,
    notifyPerson,
    smsOptOut,
    async receiveNative(
      scope: DeliveryScope,
      text: string,
      externalId: string,
    ) {
      if (!(await deps.authoriseScope(scope)))
        throw new DeliveryRefusedError("Conversation unavailable.");
      return deps.store.offerInbox({
        ...scope,
        bindingId: null,
        source: "native",
        realm: scope.ownerUserId,
        externalId,
        text,
      });
    },
    async sweep(kind: DeliveryWorkKind) {
      for (const item of await deps.queue.claim({
        kind,
        owner: deps.owner,
        leaseMs,
        limit: 1,
        maxAttempts: 5,
      })) {
        /*
         * WHOSE DELIVERY THIS IS comes from the claimed row (G01): the tenant the database stamped
         * on the work item from the frame that offered it. A row stamped as nobody's is ended here
         * without running a turn or sending anything; every other one runs, start to finish, as
         * that tenant.
         */
        const tenant = trustedTenant(item.tenantId);
        if (!tenant) {
          untrusted(item, "work item names no person");
          await deps.queue.finish({ kind, key: item.key, owner: deps.owner });
          continue;
        }
        const controller = new AbortController();
        let lost = false;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: Promise<void> = Promise.resolve();
        const owns = async () => {
          if (lost) return false;
          const held = await deps.queue.renew({
            kind,
            key: item.key,
            owner: deps.owner,
            leaseMs,
          });
          if (!held) {
            lost = true;
            controller.abort();
          }
          return held;
        };
        const schedule = () => {
          timer = setTimeout(() => {
            heartbeat = (async () => {
              try {
                if ((await owns()) && !stopped) schedule();
              } catch {
                console.error(
                  JSON.stringify({
                    type: "delivery-lease-renewal-failed",
                    kind,
                    id: item.key,
                  }),
                );
                lost = true;
                controller.abort();
              }
            })();
          }, leaseMs / 3);
          timer.unref?.();
        };
        schedule();
        try {
          await runAsTenant(tenant, () =>
            deliver(item, tenant, controller.signal, owns),
          );
          if (!lost)
            await deps.queue.finish({ kind, key: item.key, owner: deps.owner });
        } catch (error) {
          if (!lost)
            await deps.queue.release({
              kind,
              key: item.key,
              owner: deps.owner,
              delayMs: 60_000,
              reason:
                error instanceof DeliveryProviderError
                  ? error.message
                  : "Delivery processing failed.",
            });
          throw error;
        } finally {
          stopped = true;
          if (timer) clearTimeout(timer);
          await heartbeat;
        }
      }
    },
  };
}
/** A ping's push row: its title on the first line, its body after it. */
function headedText(text: string): [title: string, body: string] {
  const end = text.indexOf("\n");
  return end < 0 ? [text, ""] : [text.slice(0, end), text.slice(end + 1)];
}
export type DeliveryRouter = ReturnType<typeof createDeliveryRouter>;

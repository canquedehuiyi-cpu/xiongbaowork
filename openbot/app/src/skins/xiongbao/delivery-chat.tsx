import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { TranscriptNote } from "@/components/channels/chat-transcript";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useScheduleZone } from "@/lib/settings/work-hours";
import {
  canExtend,
  clockText,
  deadlineOf,
  deliveryErrorText,
  denyExtension,
  type EvidenceRow,
  eventsInOrder,
  evidenceOf,
  type FollowedCard,
  followedCardQueryOptions,
  grantExtension,
  pendingExtension,
  type TaskEvent,
  taskEventsQueryOptions,
} from "@/lib/tasks/delivery";
import {
  bounceText,
  type ChatDeliveryEvent,
  type ChatOutcome,
  type DeliveryMark,
  deliveredOutcome,
  eventFromFlow,
  extensionOutcome,
  isLatestOfKind,
  markLine,
  matchByContent,
  matchByMark,
  type PlacedDeliveryEvent,
} from "@/lib/tasks/delivery-chat";
import { cn } from "@/lib/utils";
import {
  type ActionCard,
  CriteriaDialog,
  deliveryButton,
  ExtendDialog,
  ReturnDialog,
  useDeliveryWrites,
  useWbFallback,
} from "./delivery-actions";

/*
 * 对话里的四种交付卡（交付闭环 Task 9，设计稿 3）：接活回执、延期申请、交付卡，和被挡回时的一行灰字。
 * 单聊和群聊都用它；颜色只取 `--wb-*`，别的皮肤里由 `useWbFallback` 接到应用自己的令牌上。
 *
 * 谁看得到什么、谁能点：
 * - 单聊是你自己的线程，卡的内容来自事件本身。
 * - 群聊的回复上只有不带内容的状态标记（`server/src/channels/group.ts`）。派活的人（回复行的发起人）按
 *   标记读卡片接口和流水，画出完整的卡和按钮；其他人只看到一行状态，不读卡、不试探接口。
 *
 * 卡对回流水（`GET /api/tasks/:id/events`）按内容认，不按位置（`matchByContent`、`matchByMark`）。对上、
 * 是流水里最新的同类行、卡片此刻的状态允许，才给按钮；已经验收、退回、答复过的只写结果，转录里的旧卡
 * 不会对已经结束的活发请求。
 */

/** 卡片接口多给的一项：卡属于哪位（派活的人）。 */
type ChatCard = FollowedCard & { tenantId?: string };

/** 卡和流水在对话里不用看板那么勤地重读。 */
const CHAT_REFRESH_MS = 15_000;

const LABEL = "font-semibold text-[12px] tracking-[0.02em]";

function CardFrame({
  label,
  tone,
  ariaLabel,
  children,
  highlighted = false,
}: {
  label: ReactNode;
  tone: "green" | "amber" | "blue";
  ariaLabel: string;
  children: ReactNode;
  highlighted?: boolean;
}) {
  const fallback = useWbFallback();
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn(
        "m-0 flex w-full min-w-0 max-w-[560px] flex-col gap-2 rounded-(--wb-radius) border bg-(--wb-card) px-3.5 py-3 text-(--wb-fg) text-[13px] leading-[1.6]",
        highlighted ? "border-(--wb-blue-line)" : "border-(--wb-line2)",
      )}
      data-delivery-card={ariaLabel}
      style={fallback}
    >
      <span
        className={cn(
          LABEL,
          tone === "green"
            ? "text-(--wb-green-fg)"
            : tone === "amber"
              ? "text-(--wb-amber-fg)"
              : "text-(--wb-blue)",
        )}
      >
        {label}
      </span>
      {children}
    </fieldset>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <span className="text-(--wb-muted) text-[12.5px] [overflow-wrap:anywhere]">
    {children}
  </span>
);

/** 卡上做过的事：「你 10:52 验收了」。 */
function ResultLine({ children }: { children: ReactNode }) {
  return (
    <span
      className="text-(--wb-fg2) text-[12.5px] [overflow-wrap:anywhere]"
      data-delivery-result=""
    >
      {children}
    </span>
  );
}

const Buttons = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-1.5">{children}</div>
);

const Failure = ({ children }: { children: ReactNode }) => (
  <span className="text-(--wb-danger-fg) text-[12.5px]" role="alert">
    {children}
  </span>
);

function outcomeText(
  outcome: ChatOutcome,
  now: Date,
  zone: string | undefined,
): string {
  const at = clockText(outcome.at, now, zone);
  switch (outcome.kind) {
    case "reviewed":
      return `你 ${at} 验收了`;
    case "returned":
      return `你 ${at} 退回了${outcome.reason ? `：${outcome.reason}` : ""}`;
    case "cancelled":
      return `你 ${at} 取消了这件活`;
    case "reassigned":
      return `${at} 换了员工接手`;
    case "granted":
      return outcome.dueAt
        ? `你 ${at} 准许了，延到 ${clockText(outcome.dueAt, now, zone)}`
        : `你 ${at} 准许了延期`;
    case "denied":
      return `你 ${at} 没准，按原时间交`;
    case "superseded":
      return `${at} 员工又申请了一次，这条不用答复了`;
  }
}

/** 卡片此刻的状态和它的流水（按时间正序）；`enabled` 为假时都不读。 */
/** 结束了的卡：不会再变，不用再轮询。 */
const ENDED = new Set(["done", "cancelled", "failed"]);

function useCardState(taskId: string, enabled: boolean) {
  const me = useQuery(currentUserQueryOptions()).data;
  /*
   * 验收了、取消了的活不会再变：不再隔一会儿读一次（长对话、群里十几件活时，就是十几组常驻的请求）。
   * 打开对话、看板改了卡（查询键都以 `tasks` 开头）时照样重读。
   */
  const card = useQuery({
    ...followedCardQueryOptions<ChatCard>(taskId),
    enabled,
    refetchInterval: (query) =>
      ENDED.has(query.state.data?.status ?? "") ? false : CHAT_REFRESH_MS,
  });
  const data = enabled ? card.data : undefined;
  // 按卡片自带的派活人和当前用户判断。
  const mine = data !== undefined && me != null && data.tenantId === me.id;
  const events = useQuery({
    ...taskEventsQueryOptions(taskId),
    enabled: enabled && mine,
    refetchInterval: ENDED.has(data?.status ?? "") ? false : CHAT_REFRESH_MS,
  });
  const history = mine && events.data ? eventsInOrder(events.data) : undefined;
  return { card: data, mine, history };
}

const actionCardOf = (card: ChatCard): ActionCard => ({
  id: card.id,
  title: card.title,
  executorAgentId: card.executorAgentId,
});

/** 一张卡要知道的：卡片此刻的状态、流水、对上的那一行。 */
type CardState = {
  card: ChatCard | undefined;
  mine: boolean;
  history: readonly TaskEvent[] | undefined;
  /** 对上的流水行；对不上或还没读到为 -1。 */
  index: number;
  now: Date;
  /** 作息时区：卡上的时刻按它念，和推送、看板同一个钟。 */
  zone: string | undefined;
};

/** 接活回执：预计几点交、验收标准，「改预计时间」「改验收标准」。 */
function AcceptedCard({
  event,
  state,
}: {
  event: Extract<ChatDeliveryEvent, { kind: "accepted" }>;
  state: CardState;
}) {
  const { card, mine, index, now, zone } = state;
  const [dialog, setDialog] = useState<"due" | "criteria" | null>(null);
  const editable = mine && card !== undefined && index >= 0 && canExtend(card);
  const criteria = card?.criteria ?? event.criteria;
  const currentDue = card?.dueAt ?? null;
  const moved =
    currentDue !== null &&
    event.dueAt !== null &&
    new Date(currentDue).getTime() !== new Date(event.dueAt).getTime();
  const subject = card?.title;
  return (
    <CardFrame ariaLabel="接活回执" label="已接下" tone="green">
      <span className="[overflow-wrap:anywhere]">
        {subject ? `${subject} · ` : null}
        {event.dueAt ? (
          <>
            预计 <b>{clockText(event.dueAt, now, zone)}</b> 交
          </>
        ) : (
          "没报预计时间，按接下后 2 小时核对"
        )}
        {moved && currentDue ? (
          <Muted>（现在预计 {clockText(currentDue, now, zone)} 交）</Muted>
        ) : null}
      </span>
      {criteria ? <Muted>验收标准：{criteria}</Muted> : null}
      {card && mine && card.status === "awaiting_review" ? (
        <ResultLine>成果已经交了，等你验收</ResultLine>
      ) : null}
      {card && mine && card.status === "done" ? (
        <ResultLine>这件活已经验收了</ResultLine>
      ) : null}
      {card && mine && card.status === "cancelled" ? (
        <ResultLine>这件活已经取消了</ResultLine>
      ) : null}
      {editable ? (
        <Buttons>
          <button
            className={deliveryButton()}
            onClick={() => setDialog("due")}
            type="button"
          >
            改预计时间
          </button>
          <button
            className={deliveryButton()}
            onClick={() => setDialog("criteria")}
            type="button"
          >
            改验收标准
          </button>
        </Buttons>
      ) : null}
      {card && dialog === "due" ? (
        <ExtendDialog
          card={actionCardOf(card)}
          mode="edit"
          onClose={() => setDialog(null)}
        />
      ) : null}
      {card && dialog === "criteria" ? (
        <CriteriaDialog
          card={actionCardOf(card)}
          current={card.criteria ?? event.criteria}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </CardFrame>
  );
}

/** 延期申请：延到几点、为什么，「准许」「不准」。 */
function ExtensionCard({
  event,
  state,
}: {
  event: Extract<ChatDeliveryEvent, { kind: "extension_requested" }>;
  state: CardState;
}) {
  const { card, mine, history, index, now, zone } = state;
  const queryClient = useQueryClient();
  // 答复成功以后、流水重读回来之前，按钮就收起来，不让连点。
  const [answered, setAnswered] = useState(false);
  const settled = () =>
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  const grant = useMutation({
    // 显式带上卡上写的时间：准许的就是你在这张卡上看到的时间。
    mutationFn: (id: string) => grantExtension(id, event.dueAt),
    retry: false,
    onSuccess: () => setAnswered(true),
    onSettled: settled,
  });
  const deny = useMutation({
    mutationFn: (id: string) => denyExtension(id, event.dueAt),
    retry: false,
    onSuccess: () => setAnswered(true),
    onSettled: settled,
  });
  const outcome =
    history && index >= 0 ? extensionOutcome(history, index) : null;
  // 对上的是流水里最新的那条申请、此刻还没答复、员工手上还没交（交了要先退回才能答复），才给按钮。
  const open =
    !answered &&
    mine &&
    card !== undefined &&
    history !== undefined &&
    isLatestOfKind(history, index) &&
    outcome === null &&
    pendingExtension([...history]) !== null &&
    canExtend(card);
  const from = open && card ? deadlineOf(card) : null;
  const to = clockText(event.dueAt, now, zone);
  const busy = grant.isPending || deny.isPending;
  return (
    <CardFrame
      ariaLabel="延期申请"
      label={
        from
          ? `申请延期 · ${clockText(from, now, zone)} → ${to}`
          : `申请延期到 ${to}`
      }
      tone="amber"
    >
      {event.reason ? <Muted>原因：{event.reason}</Muted> : null}
      {outcome ? (
        <ResultLine>{outcomeText(outcome, now, zone)}</ResultLine>
      ) : null}
      {!outcome && answered ? <ResultLine>已答复</ResultLine> : null}
      {!outcome && !answered && mine && card?.status === "awaiting_review" ? (
        <ResultLine>成果已经交了，这条申请先不用答复</ResultLine>
      ) : null}
      {!outcome &&
      mine &&
      (card?.status === "done" || card?.status === "cancelled") ? (
        <ResultLine>这件活已经结束，不用再答复</ResultLine>
      ) : null}
      {open && card ? (
        <>
          <Muted>原来的预计时间还算数，你准了才改。</Muted>
          <Buttons>
            <button
              className={deliveryButton(true)}
              disabled={busy}
              onClick={() => grant.mutate(card.id)}
              type="button"
            >
              {grant.isPending ? "正在准许…" : "准许"}
            </button>
            <button
              className={deliveryButton()}
              disabled={busy}
              onClick={() => deny.mutate(card.id)}
              type="button"
            >
              {deny.isPending ? "正在答复…" : "不准"}
            </button>
          </Buttons>
        </>
      ) : null}
      {grant.error ? (
        <Failure>{deliveryErrorText(grant.error, "extend")}</Failure>
      ) : null}
      {deny.error ? (
        <Failure>{deliveryErrorText(deny.error, "deny")}</Failure>
      ) : null}
    </CardFrame>
  );
}

function FileIcon({ kind }: { kind: EvidenceRow["kind"] }) {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-(--wb-fg2)"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="16"
    >
      {kind === "link" ? (
        <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
      ) : kind === "note" ? (
        <path d="M5 5h14M5 10h14M5 15h9" />
      ) : kind === "diff" ? (
        <path d="M12 5v14M5 12h14" />
      ) : (
        <path d="M6 3h8l4 4v14H6z" />
      )}
    </svg>
  );
}

function EvidenceItem({
  row,
  linked,
}: {
  row: Exclude<EvidenceRow, { kind: "check" }>;
  /** 附件只有派活的人打得开（在它和员工的线程里）。 */
  linked: boolean;
}) {
  const link = "text-inherit underline-offset-2 hover:underline";
  const label =
    row.kind === "attachment" && linked ? (
      <a
        className={link}
        href={`/api/attachments/${encodeURIComponent(row.id)}`}
        rel="noreferrer"
        target="_blank"
      >
        {row.label}
      </a>
    ) : row.kind === "link" ? (
      <a className={link} href={row.url} rel="noreferrer" target="_blank">
        {row.label}
      </a>
    ) : row.kind === "diff" ? (
      `${row.label} · ${row.detail}`
    ) : (
      row.label
    );
  return (
    <span className="flex items-start gap-2">
      <span className="pt-[3px]">
        <FileIcon kind={row.kind} />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </span>
  );
}

/** 交付卡：交付物、自查，「验收」「退回」。 */
function DeliveredCard({
  event,
  state,
}: {
  event: Extract<ChatDeliveryEvent, { kind: "delivered" }>;
  state: CardState;
}) {
  const { card, mine, history, index, now, zone } = state;
  const writes = useDeliveryWrites();
  const [returning, setReturning] = useState(false);
  const rows = evidenceOf(event.deliverable);
  const items = rows.filter(
    (row): row is Exclude<EvidenceRow, { kind: "check" }> =>
      row.kind !== "check",
  );
  const checks = rows.filter((row) => row.kind === "check");
  const outcome =
    history && index >= 0 ? deliveredOutcome(history, index) : null;
  // 对上的是流水里最新的那次交付、卡此刻还在等你验收，才给按钮。
  const open =
    mine &&
    card !== undefined &&
    history !== undefined &&
    isLatestOfKind(history, index) &&
    outcome === null &&
    card.status === "awaiting_review";
  const busy = card ? writes.busy.has(card.id) : false;
  return (
    <CardFrame
      ariaLabel="交付卡"
      highlighted={open}
      label={open ? "已交成果 · 等你验收" : "已交成果"}
      tone="blue"
    >
      {card?.title ? (
        <span className="font-medium [overflow-wrap:anywhere]">
          {card.title}
        </span>
      ) : null}
      {items.map((row) => (
        <EvidenceItem
          key={`${row.kind}:${row.label}`}
          linked={mine}
          row={row}
        />
      ))}
      {checks.length > 0 ? (
        <span className="text-(--wb-fg2) text-[12.5px] [overflow-wrap:anywhere]">
          自查：{checks.map((row) => row.label).join("；")}
        </span>
      ) : null}
      {outcome ? (
        <ResultLine>{outcomeText(outcome, now, zone)}</ResultLine>
      ) : null}
      {open && card ? (
        <Buttons>
          <button
            className={deliveryButton(true)}
            disabled={busy}
            onClick={() => writes.run(actionCardOf(card), "review")}
            type="button"
          >
            {busy ? "正在验收…" : "验收"}
          </button>
          <button
            className={deliveryButton()}
            disabled={busy}
            onClick={() => setReturning(true)}
            type="button"
          >
            退回
          </button>
        </Buttons>
      ) : null}
      {writes.failure ? <Failure>{writes.failure.message}</Failure> : null}
      {card && returning ? (
        <ReturnDialog
          card={actionCardOf(card)}
          onClose={() => setReturning(false)}
        />
      ) : null}
    </CardFrame>
  );
}

/** 居中一行灰字：被挡回，或群里别人看到的状态。 */
function SystemLine({ children, kind }: { children: ReactNode; kind: string }) {
  const fallback = useWbFallback();
  return (
    <p
      className="m-0 self-center rounded-(--wb-radius-pill) bg-(--wb-card2) px-3 py-1 text-center text-(--wb-muted) text-[12px] leading-[1.6] [overflow-wrap:anywhere]"
      data-delivery-card={kind}
      role="note"
      style={fallback}
    >
      {children}
    </p>
  );
}

/** 一张卡的内容和状态都有了，画出来。 */
function CardBody({
  event,
  agentName,
  state,
}: {
  event: ChatDeliveryEvent;
  agentName: string;
  state: CardState;
}) {
  switch (event.kind) {
    case "accepted":
      return <AcceptedCard event={event} state={state} />;
    case "extension_requested":
      return <ExtensionCard event={event} state={state} />;
    case "delivered":
      return <DeliveredCard event={event} state={state} />;
    case "bounced":
      // 不打扰你，员工自己补齐。
      return (
        <SystemLine kind="被挡回">
          {agentName}想交付 · 被挡回：{bounceText(event.reason)}，已让它补齐
        </SystemLine>
      );
  }
}

/** 单聊里的一张交付卡：内容来自事件本身，按内容对回流水。 */
export function DeliveryChatCard({
  event,
  agentName,
  now = new Date(),
}: {
  event: ChatDeliveryEvent;
  agentName: string;
  now?: Date;
}) {
  const { card, mine, history } = useCardState(
    event.taskId,
    event.kind !== "bounced",
  );
  const index = history ? matchByContent(history, event) : -1;
  const zone = useScheduleZone();
  return (
    <CardBody
      agentName={agentName}
      event={event}
      state={{ card, mine, history, index, now, zone }}
    />
  );
}

/**
 * 群聊回复上的一个状态标记。派活的人（`ownerId` 是你）按标记读卡片和流水，画出完整的卡；其他人只看到一行
 * 状态，不读卡。派活的人那边对不上流水（还没读到、读不到）时也只画状态。
 */
export function GroupDeliveryMark({
  mark,
  agentName,
  ownerId,
  ownerName,
  now = new Date(),
}: {
  mark: DeliveryMark;
  agentName: string;
  ownerId: string;
  ownerName: string;
  now?: Date;
}) {
  const me = useQuery(currentUserQueryOptions()).data;
  const owner = me != null && me.id === ownerId;
  const { card, mine, history } = useCardState(mark.taskId, owner);
  const index = history ? matchByMark(history, mark) : -1;
  const zone = useScheduleZone();
  const line = index >= 0 && history ? history[index] : undefined;
  const event = line ? eventFromFlow(line, mark.taskId) : null;
  if (!owner || !event)
    return (
      <SystemLine kind="状态">
        {markLine(mark, agentName, owner ? "你" : ownerName, (at) =>
          clockText(at, now, zone),
        )}
      </SystemLine>
    );
  return (
    <CardBody
      agentName={agentName}
      event={event}
      state={{ card, mine, history, index, now, zone }}
    />
  );
}

/** 单聊里的交付卡，交给转录画在各自那条消息下面。 */
export function deliveryNotes(
  placed: readonly PlacedDeliveryEvent[],
  agentName: string,
): TranscriptNote[] {
  return placed.map((entry) => ({
    key: entry.key,
    anchor: entry.anchor,
    node: <DeliveryChatCard agentName={agentName} event={entry.event} />,
  }));
}

/** 群聊里一行回复带的交付卡，竖着排在回复下面。 */
export function DeliveryChatCards({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-2.5 flex w-full flex-col items-start gap-2.5"
      data-delivery-cards=""
    >
      {children}
    </div>
  );
}

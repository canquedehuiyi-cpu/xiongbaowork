import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  ApprovalActions,
  type OnBoardAnswer,
} from "@/components/tasks/approval-actions";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type Briefing,
  briefingPieces,
  briefingQueryOptions,
  canExtend,
  canNudge,
  clockText,
  DELIVERY_LANES,
  type DeliveryLaneKey,
  deadlineOf,
  deliverableLine,
  deliveryLaneOf,
  type FollowedCard,
  isToday,
  overdueChip,
  overdueMinutes,
} from "@/lib/tasks/delivery";
import { cn } from "@/lib/utils";
import { useBriefingKind } from "./briefing-page";
import {
  DeliveryDialogs,
  deliveryButton,
  LastError,
  type OpenDialog,
  useDeliveryWrites,
  WriteFailure,
} from "./delivery-actions";

/*
 * 看板上的「三步收货」（交付闭环 Task 8，设计稿 1）：在跟的卡分四列——派出 · 待接下 / 已接下 · 在做 /
 * 已交成果 · 等你验收 / 已验收，取消的折叠在已验收下方；逾期卡红框，写明逾期多久、催过几次，带「催一下」
 * 「准许延期」；顶上一行今天的数、「按员工」「只看逾期」，和一条开工 / 收工清点。不在跟的卡不在这里，照
 * 原来的列显示（`routes/_authed/_app/tasks.tsx`）。
 *
 * 只画在默认皮肤里，颜色只从 `--wb-*` 令牌取（`skin.css`），暗色跟着 `<html class="dark">`。
 */

const CARD =
  "flex min-w-0 flex-col gap-2 rounded-(--wb-radius) border border-(--wb-line) bg-(--wb-card) px-[14px] py-3";
const CHIP =
  "inline-flex max-w-full items-center gap-[5px] self-start rounded-(--wb-radius-pill) bg-(--wb-card2) px-2 py-[3px] text-(--wb-fg2) text-[12px] leading-[1.4]";

function ClockIcon({
  size = 12,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeWidth={size > 14 ? 1.8 : 2}
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const NOTHING: ReadonlySet<string> = new Set();

type Coworker = { id: string; name: string; avatarSeed?: string | null };

/**
 * 卡上的「谁 · 什么时候」：员工头像和名字，后面一句。员工不在名单里（已删、外部员工、名单没读到）时
 * 叫「员工」，不露内部 id。
 */
function Who({
  coworker,
  children,
}: {
  coworker: Coworker | undefined;
  children: ReactNode;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-(--wb-muted) text-[12px]">
      {coworker ? (
        <AbstractAvatar
          name={coworker.name}
          portrait={{ kind: "coworker", id: coworker.id }}
          seed={coworker.avatarSeed ?? coworker.id}
          size={18}
        />
      ) : null}
      <span className="min-w-0">
        {coworker?.name ?? "员工"} · {children}
      </span>
    </span>
  );
}

function CardTitle({ card }: { card: FollowedCard }) {
  return (
    <h3 className="m-0 font-semibold text-(--wb-fg) text-[14px] leading-[1.45] [overflow-wrap:anywhere]">
      <Link
        className="text-inherit no-underline outline-none hover:underline focus-visible:underline"
        from="/tasks"
        params={{ taskId: card.id }}
        search={(previous) => previous}
        to="/tasks/$taskId"
      >
        {card.title}
      </Link>
    </h3>
  );
}

function DeliveryCard({
  card,
  coworker,
  now,
  busy,
  onAct,
  onOpen,
  onDecide,
  decidingIds,
}: {
  card: FollowedCard;
  coworker: Coworker | undefined;
  now: Date;
  busy: boolean;
  onAct: (card: FollowedCard, verb: "review" | "nudge") => void;
  onOpen: (open: OpenDialog) => void;
  /** 等你审批或回答的卡，在卡上直接批准 / 拒绝 / 回答（和「待关注」里同一套）。 */
  onDecide?: OnBoardAnswer;
  decidingIds?: ReadonlySet<string>;
}) {
  const place = deliveryLaneOf(card);
  const late = overdueMinutes(card, now);
  const waitingOnYou = card.status === "needs_action";
  const error = card.lastError ? (
    <LastError className="text-[12px]" raw={card.lastError} />
  ) : null;
  const waitingChip = waitingOnYou ? (
    <>
      <span className={cn(CHIP, "bg-(--wb-amber-soft) text-(--wb-amber-fg)")}>
        等你操作
      </span>
      {onDecide ? (
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <ApprovalActions
            onDecide={onDecide}
            pending={decidingIds ?? NOTHING}
            task={card}
          />
        </div>
      ) : null}
    </>
  ) : null;

  if (place?.lane === "pending_accept")
    return (
      <article className={CARD} data-stage="pending_accept">
        <CardTitle card={card} />
        <Who coworker={coworker}>
          {card.createdAt ? `${clockText(card.createdAt, now)} 派出` : "派出"}
        </Who>
        {waitingChip ?? (
          <span className={CHIP}>
            {(card.nudges ?? 0) > 0
              ? `还没接下 · 已催 ${card.nudges} 次`
              : "还没接下 · 5 分钟内没回应会再叫一次"}
          </span>
        )}
        {error}
      </article>
    );

  if (place?.lane === "accepted") {
    const deadline = deadlineOf(card);
    if (late !== null)
      return (
        <article
          className={cn(CARD, "border-(--wb-danger-line)")}
          data-overdue="true"
          data-stage="accepted"
        >
          <CardTitle card={card} />
          <Who coworker={coworker}>
            {deadline ? `预计 ${clockText(deadline, now)} 交` : "已接下"}
          </Who>
          <span
            className={cn(CHIP, "bg-(--wb-danger-soft) text-(--wb-danger-fg)")}
          >
            {overdueChip(late, card.nudges ?? 0)}
          </span>
          {waitingChip}
          {error}
          <div className="flex flex-wrap gap-1.5 empty:hidden">
            {canNudge(card) ? (
              <button
                className={deliveryButton()}
                disabled={busy}
                onClick={() => onAct(card, "nudge")}
                type="button"
              >
                催一下
              </button>
            ) : null}
            {canExtend(card) ? (
              <button
                className={deliveryButton()}
                disabled={busy}
                onClick={() => onOpen({ kind: "extend", card })}
                type="button"
              >
                准许延期
              </button>
            ) : null}
          </div>
        </article>
      );
    return (
      <article className={CARD} data-stage="accepted">
        <CardTitle card={card} />
        <Who coworker={coworker}>
          {card.acceptedAt
            ? `${clockText(card.acceptedAt, now)} 接下`
            : "已接下"}
        </Who>
        <span className={CHIP}>
          <ClockIcon />
          {card.dueAt
            ? `已接下 · 预计 ${clockText(card.dueAt, now)} 交`
            : deadline
              ? `已接下 · 没报预计时间，按 ${clockText(deadline, now)} 核对`
              : "已接下"}
        </span>
        {waitingChip}
        {error}
      </article>
    );
  }

  if (place?.lane === "delivered") {
    const line = deliverableLine(card.deliverableRef);
    return (
      <article
        className={cn(CARD, "border-(--wb-blue-line)")}
        data-stage="delivered"
      >
        <CardTitle card={card} />
        <Who coworker={coworker}>{clockText(card.updatedAt, now)} 交付</Who>
        {line ? (
          <span className="text-(--wb-fg2) text-[12.5px] leading-[1.5] [overflow-wrap:anywhere]">
            {line}
          </span>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <button
            className={deliveryButton(true)}
            disabled={busy}
            onClick={() => onAct(card, "review")}
            type="button"
          >
            {busy ? "验收中…" : "验收"}
          </button>
          <button
            className={deliveryButton()}
            disabled={busy}
            onClick={() => onOpen({ kind: "return", card })}
            type="button"
          >
            退回
          </button>
        </div>
      </article>
    );
  }

  // 已验收；取消的也是这个样子，只是折叠着。
  const returns = card.returns ?? 0;
  return (
    <article className={cn(CARD, "opacity-80")} data-stage={card.status}>
      <CardTitle card={card} />
      <Who coworker={coworker}>
        {card.status === "cancelled"
          ? `${clockText(card.updatedAt, now)} 取消`
          : returns > 0
            ? `退回 ${returns} 次后验收`
            : `你 ${clockText(card.updatedAt, now)} 验收`}
      </Who>
    </article>
  );
}

/**
 * 开工 / 收工清点那一条（设计稿 1）。没有在跟的活时服务器不给清点，这一条就不画。「逐件看」打开清点页
 * （`/briefing`，设计稿 4），一件件列出来。
 */
function BriefingStrip({
  briefing,
  kind,
  now,
  agentOfTask,
}: {
  briefing: Briefing;
  kind: "start" | "end";
  now: Date;
  agentOfTask: (taskId: string) => string | null;
}) {
  const navigate = useNavigate();
  const label = kind === "start" ? "开工清点" : "收工清点";
  const anything =
    briefing.overdue.length +
      briefing.awaitingReview.length +
      briefing.inProgress.length >
    0;
  return (
    <section
      aria-label={`${label}提示`}
      className="flex flex-wrap items-center gap-3 rounded-(--wb-radius) border border-(--wb-line) bg-(--wb-list) px-4 py-3"
    >
      <ClockIcon className="shrink-0 text-(--wb-amber)" size={18} />
      <span className="min-w-0 flex-1 basis-[240px] text-(--wb-fg) text-[13.5px] leading-[1.6]">
        {label}：
        {briefingPieces(briefing, now, agentOfTask).map((piece, index) =>
          piece.strong ? (
            <b
              className={cn(
                "font-semibold",
                piece.danger ? "text-(--wb-danger-fg)" : null,
              )}
              // biome-ignore lint/suspicious/noArrayIndexKey: 一句话拆成的几段，先后不会变。
              key={index}
            >
              {piece.text}
            </b>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上。
            <span key={index}>{piece.text}</span>
          ),
        )}
      </span>
      {anything ? (
        <button
          className={cn(deliveryButton(), "ml-auto")}
          onClick={() => void navigate({ to: "/briefing" })}
          type="button"
        >
          逐件看
        </button>
      ) : null}
    </section>
  );
}

export function DeliveryBoard({
  cards,
  now: fixedNow,
  onlyOverdue,
  onOnlyOverdueChange,
  onDecide,
  decidingIds,
}: {
  /** 看板这一次读到的在跟卡（不在跟的不传进来）。 */
  cards: FollowedCard[];
  now?: Date;
  /** 「只看逾期」，在地址里（`overdue=1`），由看板页传进来。 */
  onlyOverdue: boolean;
  onOnlyOverdueChange: (next: boolean) => void;
  /** 看板的审批 / 回答写入（`useApprovalDecision`），和「待关注」共用一个。 */
  onDecide?: OnBoardAnswer;
  decidingIds?: ReadonlySet<string>;
}) {
  const now = fixedNow ?? new Date();
  const coworkers = useQuery(agentListQueryOptions());
  const coworkerOf = (id: string | null) =>
    id ? coworkers.data?.find((coworker) => coworker.id === id) : undefined;
  // 开工还是收工清点：按你作息的时区（读不到作息时按浏览器的钟），和清点页同一个判断。
  const { kind } = useBriefingKind(now);
  const briefing = useQuery({
    ...briefingQueryOptions(kind ?? "start"),
    enabled: kind !== undefined,
  });
  const writes = useDeliveryWrites();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [byCoworker, setByCoworker] = useState(false);

  const placed = cards.flatMap((card) => {
    const place = deliveryLaneOf(card);
    return place ? [{ card, ...place }] : [];
  });
  const lateCount = placed.filter(
    ({ card }) => overdueMinutes(card, now) !== null,
  ).length;
  const count = (lane: DeliveryLaneKey) =>
    placed.filter((entry) => entry.lane === lane && !entry.folded).length;
  const shown = placed.filter(
    ({ card }) => !onlyOverdue || overdueMinutes(card, now) !== null,
  );
  const nameOf = (card: FollowedCard) =>
    coworkerOf(card.executorAgentId)?.name ?? "员工";
  const ordered = byCoworker
    ? [...shown].sort((a, b) =>
        nameOf(a.card).localeCompare(nameOf(b.card), "zh-CN"),
      )
    : shown;
  const agentOfTask = (taskId: string) => {
    const card = cards.find((entry) => entry.id === taskId);
    return card ? (coworkerOf(card.executorAgentId)?.name ?? null) : null;
  };
  const toggle = (pressed: boolean) =>
    cn(deliveryButton(), pressed ? "border-(--wb-fg2) bg-(--wb-hover)" : null);

  return (
    <section
      aria-label="三步收货"
      className="mt-[6px] mb-[22px] flex flex-col gap-4 text-(--wb-fg)"
      data-delivery-board
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="m-0 font-bold text-[17px] leading-[24px] tracking-[-0.02em]">
          三步收货
        </h2>
        <span className="text-(--wb-muted) text-[13px]">
          今天派出 {cards.filter((card) => isToday(card.createdAt, now)).length}{" "}
          件 · {count("accepted")} 件在做 · {count("delivered")} 件等你验收 ·{" "}
          {lateCount} 件逾期
        </span>
        <div className="ml-auto flex gap-2">
          <button
            aria-pressed={byCoworker}
            className={toggle(byCoworker)}
            onClick={() => setByCoworker((value) => !value)}
            type="button"
          >
            按员工
          </button>
          <button
            aria-pressed={onlyOverdue}
            className={toggle(onlyOverdue)}
            onClick={() => onOnlyOverdueChange(!onlyOverdue)}
            type="button"
          >
            只看逾期
          </button>
        </div>
      </header>

      {briefing.data && kind ? (
        <BriefingStrip
          agentOfTask={agentOfTask}
          briefing={briefing.data}
          kind={kind}
          now={now}
        />
      ) : null}

      <WriteFailure failure={writes.failure} onDismiss={writes.clearFailure} />

      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {DELIVERY_LANES.map((lane) => {
          const inLane = ordered.filter(
            (entry) => entry.lane === lane.key && !entry.folded,
          );
          const folded = ordered.filter(
            (entry) => entry.lane === lane.key && entry.folded,
          );
          const draw = (card: FollowedCard) => (
            <DeliveryCard
              busy={writes.busy.has(card.id)}
              card={card}
              coworker={coworkerOf(card.executorAgentId)}
              key={card.id}
              now={now}
              decidingIds={decidingIds}
              onAct={(target, verb) => writes.run(target, verb)}
              onDecide={onDecide}
              onOpen={setDialog}
            />
          );
          return (
            <section
              aria-label={lane.label}
              className="flex min-w-0 flex-col gap-2.5"
              key={lane.key}
            >
              <div className="flex items-center gap-2 px-0.5 font-semibold text-(--wb-fg) text-[13px]">
                {lane.label}
                <small className="font-normal text-(--wb-muted) text-[13px] tabular-nums">
                  {inLane.length}
                </small>
              </div>
              {inLane.map(({ card }) => draw(card))}
              {inLane.length === 0 && folded.length === 0 ? (
                <p className="m-0 rounded-(--wb-radius) border border-(--wb-line) border-dashed px-3 py-4 text-center text-(--wb-muted) text-[12px]">
                  {onlyOverdue ? "这一列没有逾期的活" : "这一列暂时是空的"}
                </p>
              ) : null}
              {folded.length > 0 ? (
                <details className="group flex flex-col gap-2.5">
                  <summary className="cursor-pointer list-none px-0.5 text-(--wb-muted) text-[12px] outline-none hover:text-(--wb-fg2) focus-visible:text-(--wb-fg) [&::-webkit-details-marker]:hidden">
                    已取消 {folded.length} 件
                  </summary>
                  <div className="mt-2.5 flex flex-col gap-2.5">
                    {folded.map(({ card }) => draw(card))}
                  </div>
                </details>
              ) : null}
            </section>
          );
        })}
      </div>
      <DeliveryDialogs onClose={() => setDialog(null)} open={dialog} />
    </section>
  );
}

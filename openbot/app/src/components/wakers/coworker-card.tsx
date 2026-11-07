import { IconDeviceDesktop, IconId } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { Button, buttonVariants } from "@/components/ui/button";
import { type AgentProfile, isSharedWithYou } from "@/lib/agents/queries";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { TaskStats, WakerGroup } from "@/lib/waker-groups/queries";
import {
  CARD_SURFACE,
  CardFooter,
  CREATE_CARD,
  CreateCardFace,
} from "./card-chrome";
import type { WakersSearch, WakerStatus } from "./wakers-search";

/**
 * Spec D1's three words, on the card itself and on the filter that sorts by them (D4) — one
 * vocabulary for both, the one CONTEXT.md fixes: 在线 / 休息 / 暂停. The fourth is the screen saying
 * it could not read the board or the pause, and it looks nothing like 休息 on purpose: a failed read
 * is not rest.
 */
export const STATUS_WORD: Record<WakerStatus, string> = {
  working: "在线",
  resting: "休息",
  paused: "暂停",
  unknown: "状态未知",
};

/** The dot before the word, as the reference draws 「● 在线」. Unknown is hollow and dashed. */
const STATUS_DOT: Record<WakerStatus, string> = {
  working: "bg-emerald-400",
  resting: "bg-muted-foreground/60",
  paused: "bg-amber-400",
  unknown: "border border-dashed border-muted-foreground",
};

const STATUS_TEXT: Record<WakerStatus, string> = {
  working: "text-muted-foreground",
  resting: "text-muted-foreground",
  paused: "text-amber-600 dark:text-amber-400",
  unknown: "text-muted-foreground",
};

/** The sentence that says why the status reads what it reads; in the card's revealed row. */
function statusSentence(
  status: WakerStatus,
  pauseKnown: boolean,
  pauseUnreadable: boolean,
) {
  switch (status) {
    case "working":
      return "正在处理一个任务。";
    case "paused":
      return "你已暂停它，恢复之前它不会再替你开工。";
    case "resting":
      return "当前没有运行中的任务。";
    case "unknown":
      if (pauseUnreadable) return "读不到它是否被暂停，现在的状态不确定。";
      if (!pauseKnown) return "正在确认它是否被暂停。";
      return "看板读不到，现在有没有在跑不确定。";
  }
}

/** One line on a coworker's card about the machine its work runs on (spec F4). */
export type DeviceLine = {
  /** `task`: a running task's own machine. `owner`: no binding, so the owner's machines. */
  kind: "task" | "owner";
  online: boolean | null;
  text: string;
};

/**
 * What the card can say about the coworker's month on the board. `null` while the read has no answer
 * (loading, or failed with nothing cached): the card then shows "—" rather than a zero it never saw.
 */
export type CardStats = { stats: TaskStats; truncated: boolean } | null;

const TAG =
  "inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[11px] font-normal";

/**
 * One employee on the 员工管理 wall, drawn the way the reference draws its card
 * (docs/acceptance/qoderwake-reference/wakers.png): a 330 × 212 cell with the avatar centred on top,
 * 「● 在线」 and the environment tag at the top right, the name with a small role tag, one grey line
 * of description, and a footer of 任务数 | 最近运行 under a hairline.
 *
 * Everything else the card used to spell out — what the employee needs from the person (the archived
 * Bot 会话 list), why the status reads what it reads, its groups, its machine, and the 暂停/恢复 ·
 * 进对话 · 装配 · 编辑 actions — is one row that slides over the lower half when the card is hovered
 * or anything inside it has keyboard focus. On a touch screen, where there is no hover, the row is
 * simply part of the card. A refused pause keeps the row open so its sentence is never hidden.
 *
 * The tags the archived 员工列表 told employees apart by (已置顶 / 共享给你 / 已隐藏) and the 分身's
 * 待配置 sit at the top left, so the face stays the reference's shape when none applies.
 *
 * The whole card opens the detail page: the name is the link, and its `::after` stretches over the
 * card, so the card is one tab stop with a visible focus ring, and the actions sit above it on their
 * own layer instead of being nested inside a link.
 */
export function CoworkerCard({
  agent,
  attention,
  busy,
  crews,
  device,
  editSearch,
  isAvatar = false,
  onTogglePause,
  pauseKnown,
  pauseUnreadable,
  problem,
  stats,
  status,
  unconfigured,
}: {
  agent: AgentProfile;
  /** This employee's row of `GET /api/bots/attention`, when the read answered and names it. */
  attention?: BotAttention;
  /** A pause or resume for this card is in flight. */
  busy: boolean;
  crews: WakerGroup[];
  device: DeviceLine | null;
  /** The wall's address plus `agent`: 编辑 opens the edit dialog over the same narrowed wall. */
  editSearch: WakersSearch;
  /** This is the person's own 分身 (`GET /api/me/avatar/sources` names it): tagged 个人分身. */
  isAvatar?: boolean;
  onTogglePause: () => void;
  /** The pause read answered, so the card can offer the one action that is actually its next. */
  pauseKnown: boolean;
  /** The pause read failed, which is a different blindness from the board's. */
  pauseUnreadable: boolean;
  /** The server's refusal of this card's last pause or resume, said on the card. */
  problem?: string | null;
  stats: CardStats;
  status: WakerStatus;
  /** This is the 分身 and it has no information source saved yet. */
  unconfigured: boolean;
}) {
  const paused = status === "paused";
  const count = stats
    ? `${stats.truncated ? "≥" : ""}${stats.stats.count}`
    : "—";
  const lastRun = stats?.stats.lastRunAt
    ? relativeTime(stats.stats.lastRunAt)
    : "—";
  const waiting = attention ? attentionSummary(attention) : "";
  const asks = attention ? needsInput(attention) : 0;
  const role = isAvatar ? "个人分身" : agent.title.trim();
  const description =
    agent.roleDescription.trim() ||
    (role !== agent.title.trim() ? agent.title.trim() : "") ||
    "还没写职责。";
  return (
    <div
      className={cn(
        CARD_SURFACE,
        "h-[212px] items-center px-[16px] pt-[19px] hover:border-foreground/20 pointer-coarse:h-auto",
      )}
      data-testid="waker-card"
    >
      <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={48} />
      {/*
        The title row. The two corner clusters live inside it so a screen reader hears the status and
        the tags with the name, but they are positioned against the card (nothing between is
        positioned), where the reference puts them.
      */}
      <div
        className="mt-[16px] flex max-w-full items-center justify-center gap-2"
        data-slot="item-title"
      >
        {/*
          Spec D5: the coworker's own detail page — its duties, running tasks, skill grants and
          recent audit trail.
        */}
        <Link
          className="truncate rounded-sm font-semibold text-[16px] leading-[24px] outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
          data-card-name=""
          params={{ agentId: agent.id }}
          to="/wakers/$agentId"
        >
          {agent.name}
        </Link>
        {role ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground"
            data-role-tag=""
          >
            <IconId aria-hidden="true" className="size-[13px]" />
            {role}
          </span>
        ) : null}
        <span className="absolute top-3 right-3 z-[1] flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[12px]",
              STATUS_TEXT[status],
            )}
            data-status={status}
          >
            <span
              aria-hidden="true"
              className={cn("size-[6px] rounded-full", STATUS_DOT[status])}
            />
            {STATUS_WORD[status]}
          </span>
          {device ? (
            <span
              className={cn(
                TAG,
                "gap-1",
                device.online === false
                  ? "bg-red-500/15 text-red-600 dark:text-red-400"
                  : "bg-blue-500/15 text-blue-600 dark:text-blue-400",
              )}
              data-env-tag="device"
              title={device.text}
            >
              <IconDeviceDesktop aria-hidden="true" className="size-[12px]" />
              本地
            </span>
          ) : (
            <span
              className={cn(TAG, "bg-foreground/5 text-muted-foreground")}
              data-env-tag="unbound"
              title="没有进行中的任务绑定到你的设备，它也不是在你的设备上干活的员工。"
            >
              未绑定
            </span>
          )}
        </span>
        <span className="absolute top-3 left-3 z-[1] flex max-w-[45%] flex-wrap items-center gap-1">
          {asks > 0 ? (
            <span
              aria-hidden="true"
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 font-medium text-[11px] text-primary-foreground tabular-nums"
              data-attention-dot=""
              title={`需要你：${waiting}`}
            >
              {asks}
            </span>
          ) : null}
          {agent.hidden ? (
            <span
              className={cn(TAG, "border text-muted-foreground")}
              data-hidden="true"
            >
              已隐藏
            </span>
          ) : null}
          {agent.pinned ? (
            <span
              className={cn(TAG, "border text-muted-foreground")}
              data-pinned="true"
            >
              已置顶
            </span>
          ) : null}
          {isSharedWithYou(agent) ? (
            <span
              className={cn(TAG, "border text-muted-foreground")}
              data-shared="true"
              title="别人创建并公开的员工，你可以使用。"
            >
              共享给你
            </span>
          ) : null}
          {unconfigured ? (
            <span
              className={cn(
                TAG,
                "border border-amber-500/60 border-dashed text-amber-600 dark:text-amber-400",
              )}
              data-unconfigured="true"
              title="还没有登记信息来源，可以在详情页配置。"
            >
              待配置
            </span>
          ) : null}
        </span>
      </div>
      <p className="mt-1 w-full truncate text-[12px] text-muted-foreground leading-[18px]">
        {description}
      </p>

      <CardFooter
        className="mx-0 w-full"
        left={
          <span
            data-task-count=""
            title={
              stats?.truncated
                ? "近 30 天的任务超过一页，这是至少的数目。"
                : "近 30 天由它执行的任务卡。"
            }
          >
            任务数 {count}
          </span>
        }
        right={
          <span className="truncate" data-last-run="">
            最近运行 {lastRun}
          </span>
        }
      />

      {/*
        The revealed row. Hidden (and not clickable) until the card is hovered or something in it has
        focus; Tab from the card's link lands on its first button, which reveals it. A refused
        pause holds it open.
      */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1.5 border-border border-t bg-card px-4 pt-3 pb-2.5 text-left text-xs",
          "pointer-events-none opacity-0 transition-opacity group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100",
          "data-[open]:pointer-events-auto data-[open]:opacity-100",
          "pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:-mx-[16px] pointer-coarse:mt-2 pointer-coarse:w-[calc(100%+32px)] pointer-coarse:opacity-100",
        )}
        data-card-actions=""
        data-open={problem ? "" : undefined}
      >
        {waiting ? (
          /*
           * What the archived Bot 会话 list said per employee: questions, approvals and stalled
           * hand-offs only the person can move, plus unread messages. Absent on a quiet card.
           */
          <p
            className="flex items-center gap-1.5 text-foreground"
            data-attention={String(asks)}
          >
            {asks > 0 ? (
              <span
                aria-hidden="true"
                className="rounded-full bg-primary px-1.5 font-medium text-[11px] text-primary-foreground tabular-nums"
              >
                {asks}
              </span>
            ) : null}
            需要你：{waiting}
          </p>
        ) : null}
        <p className="line-clamp-2 text-muted-foreground">
          {statusSentence(status, pauseKnown, pauseUnreadable)}
          {crews.length > 0
            ? ` · ${crews.map((crew) => crew.name).join(", ")}`
            : ""}
        </p>
        {device ? (
          <p
            className={cn(
              "truncate",
              device.online === false
                ? "text-red-500"
                : "text-muted-foreground",
            )}
            data-device-line={device.kind}
            data-device-online={
              device.online === null ? "unknown" : String(device.online)
            }
            data-environment="device"
            title={device.text}
          >
            {device.text}
          </p>
        ) : (
          <p className="text-muted-foreground" data-environment="unbound">
            未绑定设备
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-1">
          {/*
            Pause and resume are offered only once the pause read answered: without it the screen
            does not know which of the two is the next step, and guessing would send a resume to a
            coworker that was never paused.
          */}
          {pauseKnown ? (
            <Button
              aria-label={`${paused ? "恢复" : "暂停"} ${agent.name}`}
              disabled={busy}
              onClick={onTogglePause}
              size="xs"
              variant="ghost"
            >
              {paused ? "恢复" : "暂停"}
            </Button>
          ) : null}
          {/*
            Real links, not buttons drawn as anchors: each goes to another screen, so it should open
            in a new tab like any other address.
          */}
          <Link
            className={buttonVariants({ size: "xs", variant: "ghost" })}
            search={{ agent: agent.id }}
            to="/channel/new"
          >
            进对话
          </Link>
          {/* Spec D7: the coworker's own assembly screen, one tap from its card. */}
          <Link
            className={buttonVariants({ size: "xs", variant: "ghost" })}
            params={{ agentId: agent.id }}
            to="/assemble/$agentId"
          >
            装配
          </Link>
          {/* The edit dialog the archived 员工列表 opened, now over this wall. */}
          <Link
            aria-label={`编辑 ${agent.name}`}
            className={buttonVariants({ size: "xs", variant: "ghost" })}
            search={editSearch}
            to="/wakers"
          >
            编辑
          </Link>
        </div>
        {problem ? (
          <p className="text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The wall's FIRST cell, as in the reference: a dashed card that opens the create dialog (spec D2)
 * over this wall, the same deep link as the header's 新建员工.
 */
export function CreateCoworkerCard({ search }: { search: WakersSearch }) {
  return (
    <Link
      className={CREATE_CARD}
      data-testid="waker-create-card"
      search={search}
      to="/wakers"
    >
      <CreateCardFace label="新建员工" />
    </Link>
  );
}

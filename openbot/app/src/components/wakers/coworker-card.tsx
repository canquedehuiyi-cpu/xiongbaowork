import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { type AgentProfile, isSharedWithYou } from "@/lib/agents/queries";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import type { TaskStats, WakerGroup } from "@/lib/waker-groups/queries";
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

const STATUS_BADGE_STYLE: Record<WakerStatus, string> = {
  working: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  resting: "bg-foreground/5 text-muted-foreground",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  unknown:
    "border border-dashed border-muted-foreground/40 text-muted-foreground",
};

/** The sentence under a card's name, which says why the badge says what it says. */
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

/**
 * One employee on the 员工管理 wall (parity plan F2): status, environment, avatar, name, role, task
 * count and last run, with 进对话 / 装配 / 暂停·恢复 one tap away.
 *
 * It also carries what the two archived pages said about the same employee: the old 员工列表
 * (`/agents`) told pinned and shared-with-you employees apart and opened each one's edit dialog, so
 * the card wears 已置顶 / 共享给你 and offers 编辑 (`/wakers?agent=<id>`); the old Bot 会话 (`/bots`)
 * said what each one needs from the person, so the card says that too and links to its
 * `/bots/$agentId` profile (动态), which holds the activity feed and the notification settings the
 * detail page does not.
 *
 * The whole card opens the detail page: the name is the link, and its `::after` stretches over the
 * card, so the card is one tab stop with a visible focus ring and the actions sit above it on their
 * own layer instead of being nested inside a link (which would be invalid and unreachable by
 * keyboard).
 */
export function CoworkerCard({
  agent,
  attention,
  busy,
  crews,
  device,
  editSearch,
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
  return (
    <Item
      className="relative flex-col items-stretch gap-3 bg-card p-4 hover:border-foreground/20"
      data-testid="waker-card"
      variant="outline"
    >
      <div className="flex items-start gap-3">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={40} />
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="max-w-full flex-wrap">
            {/*
              Spec D5: the coworker's own detail page — its duties, running tasks, skill grants and
              recent audit trail. That page only reads; changing what it holds stays on the
              assembly screen linked below, so neither forks where a setting is made.
            */}
            <Link
              className="truncate rounded-sm outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
              data-card-name=""
              params={{ agentId: agent.id }}
              to="/wakers/$agentId"
            >
              {agent.name}
            </Link>
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-normal ${STATUS_BADGE_STYLE[status]}`}
              data-status={status}
            >
              {STATUS_WORD[status]}
            </span>
            {agent.hidden ? (
              <span
                className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                data-hidden="true"
              >
                已隐藏
              </span>
            ) : null}
            {agent.pinned ? (
              <span
                className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                data-pinned="true"
              >
                已置顶
              </span>
            ) : null}
            {isSharedWithYou(agent) ? (
              <span
                className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                data-shared="true"
                title="别人创建并公开的员工，你可以使用。"
              >
                共享给你
              </span>
            ) : null}
            {unconfigured ? (
              <span
                className="rounded border border-dashed border-amber-500/60 px-1.5 py-0.5 text-xs font-normal text-amber-600 dark:text-amber-400"
                data-unconfigured="true"
                title="还没有登记信息来源，可以在详情页配置。"
              >
                待配置
              </span>
            ) : null}
          </ItemTitle>
          <ItemDescription className="line-clamp-1 text-[13px]">
            {agent.title || agent.roleDescription || "还没写职责。"}
          </ItemDescription>
        </ItemContent>
      </div>

      <div className="flex flex-col gap-1">
        {waiting ? (
          /*
           * What the archived Bot 会话 list said per employee: questions, approvals and stalled
           * hand-offs only the person can move, plus unread messages. Absent on a quiet card.
           */
          <p
            className="flex items-center gap-1.5 text-foreground text-xs"
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
        <p className="text-muted-foreground text-xs">
          {statusSentence(status, pauseKnown, pauseUnreadable)}
          {crews.length > 0
            ? ` · ${crews.map((crew) => crew.name).join(", ")}`
            : ""}
        </p>
        {device ? (
          <p
            className={`text-xs ${
              device.online === false ? "text-red-500" : "text-muted-foreground"
            }`}
            data-device-line={device.kind}
            data-device-online={
              device.online === null ? "unknown" : String(device.online)
            }
            data-environment="device"
          >
            {device.text}
          </p>
        ) : (
          <p
            className="text-muted-foreground text-xs"
            data-environment="unbound"
            title="没有进行中的任务绑定到你的设备，它也不是在你的设备上干活的员工。"
          >
            未绑定设备
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t pt-3">
        <div className="flex min-w-0 gap-3 whitespace-nowrap text-muted-foreground text-xs tabular-nums">
          <span
            data-task-count=""
            title={
              stats?.truncated
                ? "近 30 天的任务超过一页，这是至少的数目。"
                : "近 30 天由它执行的任务卡。"
            }
          >
            任务 {count}
          </span>
          <span data-last-run="">最近运行 {lastRun}</span>
        </div>
        <ItemActions className="relative z-10 ml-auto shrink-0 gap-1">
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
          {/* The employee's own Bot profile: its activity, notifications and reset. */}
          <Link
            aria-label={`${agent.name} 的动态`}
            className={buttonVariants({ size: "xs", variant: "ghost" })}
            params={{ agentId: agent.id }}
            to="/bots/$agentId"
          >
            动态
          </Link>
        </ItemActions>
      </div>
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </Item>
  );
}

/**
 * The wall's last cell: a dashed card that opens the create dialog (spec D2) over this wall, the
 * same deep link as the header's 新建员工.
 */
export function CreateCoworkerCard({ search }: { search: WakersSearch }) {
  return (
    <Link
      className="flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground text-sm outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      data-testid="waker-create-card"
      search={search}
      to="/wakers"
    >
      <IconPlus aria-hidden="true" className="size-5" />
      创建员工
    </Link>
  );
}

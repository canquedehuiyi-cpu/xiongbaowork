import {
  IconDeviceDesktop,
  IconDeviceDesktopOff,
  IconPlayerPause,
} from "@tabler/icons-react";
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
  CARD_TAG,
  CardFooter,
  CardIndex,
  CREATE_CARD,
  CreateCardFace,
  Fact,
  PERSONAL_SURFACE,
} from "./card-chrome";
import type { WakersSearch, WakerStatus } from "./wakers-search";

/** The hairline and top highlight around a profile's face, over the face's own rounded clip. */
const FACE_RING =
  "inline-flex shrink-0 rounded-[13px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_13%,transparent)] [&_svg]:scale-[1.42]";

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

/*
 * The status badge (theme.css `.badge` / `.badge.status`): a quiet grey pill for 休息, a brighter one
 * with the signal-red dot for 在线, a pause glyph for 暂停 and a dashed outline for 状态未知 — each
 * also says its word, so no state is told by colour alone.
 */
const STATUS_BADGE: Record<WakerStatus, string> = {
  working: "bg-foreground/[0.085] text-foreground",
  resting: "bg-foreground/[0.05] text-muted-foreground",
  paused: "bg-foreground/[0.05] text-muted-foreground",
  unknown:
    "border border-dashed border-muted-foreground/60 text-muted-foreground",
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

/**
 * One employee on the 员工管理 wall, drawn as docs/design/ios-studio/04-员工管理.png draws its
 * 「角色档案」: a mono `PROFILE / 01` index at the top left and a status badge at the top right
 * (「● 在线 · 本地」, 「休息 · 未绑定」 …), a 44px rounded-square face beside the 16px name and one
 * line of role, one line of duties, and a 任务数 · 最近运行 footer under a hairline. The person's
 * own 分身 wears the page's one local red: a dark-red light in its corner and a faint red edge.
 *
 * Everything else the card used to spell out — what the employee needs from the person (the archived
 * Bot 会话 list), why the status reads what it reads, its groups, its machine, and the 暂停/恢复 ·
 * 进对话 · 装配 · 编辑 actions — is one row that slides over the lower half when the card is hovered
 * or anything inside it has keyboard focus. On a touch screen, where there is no hover, the row is
 * simply part of the card. A refused pause keeps the row open so its sentence is never hidden.
 *
 * The tags the archived 员工列表 told employees apart by (已置顶 / 共享给你 / 已隐藏), the 分身's
 * 待配置 and the count of things waiting on the person sit beside the index, so the face keeps the
 * reference's shape when none applies.
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
  index,
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
  /** The card's place on the wall as drawn, for its `PROFILE / 01` index. */
  index: string;
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
        "hover:border-foreground/20",
        isAvatar && cn(PERSONAL_SURFACE, "hover:border-signal/40"),
      )}
      data-personal={isAvatar ? "" : undefined}
      data-testid="waker-card"
    >
      {/*
        The title block: the top row and the identity. The status and the tags live inside it so a
        screen reader hears them with the name.
      */}
      <div className="flex min-w-0 flex-col" data-slot="item-title">
        <div className="flex min-h-[21px] items-start justify-between gap-[5px]">
          <span className="relative z-[1] flex min-w-0 flex-wrap items-center gap-[4px]">
            <CardIndex index={index} kind="Profile" />
            {asks > 0 ? (
              <span
                aria-hidden="true"
                className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-signal-soft px-[5px] font-semibold text-[10px] text-signal-ink tabular-nums"
                data-attention-dot=""
                title={`需要你：${waiting}`}
              >
                {asks}
              </span>
            ) : null}
            {agent.hidden ? (
              <span className={CARD_TAG} data-hidden="true">
                已隐藏
              </span>
            ) : null}
            {agent.pinned ? (
              <span className={CARD_TAG} data-pinned="true">
                已置顶
              </span>
            ) : null}
            {isSharedWithYou(agent) ? (
              <span
                className={CARD_TAG}
                data-shared="true"
                title="别人创建并公开的员工，你可以使用。"
              >
                共享给你
              </span>
            ) : null}
            {unconfigured ? (
              <span
                className={cn(
                  CARD_TAG,
                  "border-signal/45 border-dashed text-signal-ink",
                )}
                data-unconfigured="true"
                title="还没有登记信息来源，可以在详情页配置。"
              >
                待配置
              </span>
            ) : null}
          </span>
          {/* theme.css `.badge`: the state, then where its work runs. */}
          <span
            className={cn(
              "relative z-[1] inline-flex h-[21px] shrink-0 items-center gap-[5px] rounded-full px-[8px] font-semibold text-[11px] whitespace-nowrap",
              STATUS_BADGE[status],
            )}
          >
            <span
              className="inline-flex items-center gap-[5px]"
              data-status={status}
            >
              {status === "working" ? (
                <span
                  aria-hidden="true"
                  className="size-[5px] rounded-full bg-signal"
                />
              ) : null}
              {status === "paused" ? (
                <IconPlayerPause aria-hidden="true" className="size-[11px]" />
              ) : null}
              {STATUS_WORD[status]}
            </span>
            <span aria-hidden="true" className="opacity-60">
              ·
            </span>
            {device ? (
              <span
                className={cn(
                  "inline-flex items-center gap-[3px]",
                  device.online === false && "text-signal-ink",
                )}
                data-env-tag="device"
                title={device.text}
              >
                {device.online === false ? (
                  <IconDeviceDesktopOff
                    aria-label="设备离线"
                    className="size-[11px]"
                  />
                ) : null}
                本地
              </span>
            ) : (
              <span
                className="font-medium opacity-80"
                data-env-tag="unbound"
                title="没有进行中的任务绑定到你的设备，它也不是在你的设备上干活的员工。"
              >
                未绑定
              </span>
            )}
          </span>
        </div>

        <div className="mt-[12px] flex min-w-0 items-center gap-[10px]">
          {/*
            theme.css `.staff-card .avatar`: a 44px rounded square on a hairline. The seed's round
            drawing is scaled to fill the square (the face's own rounded clip trims it); a chosen
            portrait already fills it.
          */}
          <span className={FACE_RING}>
            <AbstractAvatar
              name={agent.name}
              portrait={{ kind: "coworker", id: agent.id }}
              seed={agent.avatarSeed}
              size={44}
            />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-bold text-[16px] leading-[22px] tracking-[-0.01em]">
              {/*
                Spec D5: the coworker's own detail page — its duties, running tasks, skill grants and
                recent audit trail.
              */}
              <Link
                className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-[16px] focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
                data-card-name=""
                params={{ agentId: agent.id }}
                to="/wakers/$agentId"
              >
                {agent.name}
              </Link>
            </h3>
            {role ? (
              <span
                className="mt-px block truncate text-[12px] text-muted-foreground leading-[17px]"
                data-role-tag=""
              >
                {role}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p
        className="mt-[10px] mb-[10px] truncate text-[12px] text-muted-foreground leading-[18px]"
        title={description}
      >
        {description}
      </p>

      <CardFooter
        left={
          <span
            data-task-count=""
            title={
              stats?.truncated
                ? "近 30 天的任务超过一页，这是至少的数目。"
                : "近 30 天由它执行的任务卡。"
            }
          >
            <Fact label="任务数" value={count} />
          </span>
        }
        right={
          <span className="truncate" data-last-run="">
            <Fact label="最近运行" value={lastRun} />
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
          "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1.5 border-border border-t bg-card px-[14px] pt-3 pb-2.5 text-left text-xs",
          "pointer-events-none opacity-0 transition-opacity motion-reduce:transition-none group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100",
          "data-[open]:pointer-events-auto data-[open]:opacity-100",
          "pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:-mx-[14px] pointer-coarse:mt-[10px] pointer-coarse:-mb-[12px] pointer-coarse:w-[calc(100%+28px)] pointer-coarse:opacity-100",
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
                className="rounded-full bg-signal-soft px-1.5 font-semibold text-[11px] text-signal-ink tabular-nums"
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
              "flex min-w-0 items-center gap-1",
              device.online === false
                ? "text-signal-ink"
                : "text-muted-foreground",
            )}
            data-device-line={device.kind}
            data-device-online={
              device.online === null ? "unknown" : String(device.online)
            }
            data-environment="device"
            title={device.text}
          >
            {device.online === false ? (
              <IconDeviceDesktopOff
                aria-hidden="true"
                className="size-[12px] shrink-0"
              />
            ) : (
              <IconDeviceDesktop
                aria-hidden="true"
                className="size-[12px] shrink-0"
              />
            )}
            <span className="truncate">{device.text}</span>
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
 * The wall's create cell, after the last profile: a dashed card laid out like one more profile
 * (`PROFILE / NEW`), which opens the create dialog (spec D2) over this wall — the same deep link as
 * the header's 新建员工.
 */
export function CreateCoworkerCard({ search }: { search: WakersSearch }) {
  return (
    <Link
      className={CREATE_CARD}
      data-testid="waker-create-card"
      search={search}
      to="/wakers"
    >
      <CreateCardFace
        hint="为团队新建一位员工"
        kind="Profile"
        label="新建员工"
      />
    </Link>
  );
}

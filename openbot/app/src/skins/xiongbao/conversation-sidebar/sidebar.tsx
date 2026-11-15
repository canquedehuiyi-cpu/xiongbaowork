import {
  IconChevronDown,
  IconChevronRight,
  IconChevronsLeft,
  IconLayoutSidebarRight,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useDetailPanelWidth } from "@/components/layout/detail-panel";
import {
  type SidebarSource,
  useConversationSidebar,
} from "@/lib/threads/sidebar";
import { cn } from "@/lib/utils";
import type { ConversationSidebar as SidebarData } from "../../../../../shared/conversation-sidebar";
import { type SidebarSection, useSidebarCollapse } from "./collapse";
import {
  ContextBody,
  ContextMeter,
  contextMeterLabel,
  contextSummary,
} from "./context";
import {
  EnvironmentBody,
  EnvironmentIcon,
  environmentSummary,
} from "./environment";
import { GoalBody, GoalIcon, goalSummary, type PendingApproval } from "./goal";
import { OutputsBody, OutputsIcon, outputsSummary } from "./outputs";

/**
 * 对话侧栏（默认皮肤）：环境 · 目标 · 上下文 · 输出内容，与 Claude Code 桌面端同样的四块。
 *
 * - `panel`：桌面对话右边的一栏，宽 300px；整栏能收成 56px 图标条（目标有待确认时带橙点，上下文是
 *   百分比小条，输出内容带数量）。每块单独收起时标题右边留一句摘要。收起状态按对话记住（`collapse.ts`）。
 * - `page`：手机上的全屏页，四块同样排列，没有图标条。
 *
 * 画成什么样还看对话区留得出多宽（`DetailPanel` 用 ResizeObserver 量的宽度，{@link sidebarRoom}）：
 * 展开后对话区不足 640px 时只画图标条（记住的「展开」不改，窗口放宽了就回来）；连图标条加 400px 对话区
 * 都放不下时整栏不画，顶栏的收起按钮也不画。
 *
 * 颜色只取 `--wb-*` 令牌（`skin.css`）。
 */

const SECTION_NAMES: Record<SidebarSection, string> = {
  environment: "环境",
  goal: "目标",
  context: "上下文",
  outputs: "输出内容",
};

const PANEL_WIDTH = 300;
const STRIP_WIDTH = 56;
/** 侧栏展开时，对话区至少要留这么宽，否则只画图标条。 */
const MIN_CONVERSATION_BESIDE_PANEL = 640;
/** 图标条旁边的对话区至少这么宽（同 `DetailPanel` 的主区下限），否则侧栏不画。 */
const MIN_CONVERSATION_BESIDE_STRIP = 400;
const TOO_NARROW = "窗口再宽一些才能展开侧栏";

/**
 * 按对话区和侧栏合起来的宽度（`DetailPanel` 量的；不在 `DetailPanel` 里时为 null，不受限）决定侧栏能画
 * 成什么：`panel` 可以展开，`strip` 只能是图标条，`none` 不画。
 */
export function sidebarRoom(width: number | null): "panel" | "strip" | "none" {
  if (width === null) return "panel";
  if (width >= PANEL_WIDTH + MIN_CONVERSATION_BESIDE_PANEL) return "panel";
  if (width >= STRIP_WIDTH + MIN_CONVERSATION_BESIDE_STRIP) return "strip";
  return "none";
}

/** 收起键：单聊是线程 id，群组是频道 id。 */
export function collapseKeyOf(source: SidebarSource): string {
  return "threadId" in source ? source.threadId : source.channelId;
}

export function ConversationSidebar({
  source,
  variant,
  agentId,
}: {
  source: SidebarSource;
  variant: "panel" | "page";
  /** 单聊的员工：环境里的齿轮（去员工配置页）和项目选择器要用。 */
  agentId?: string;
}) {
  const collapse = useSidebarCollapse(collapseKeyOf(source));
  const room = sidebarRoom(useDetailPanelWidth());
  const { sidebar, pending: inboxPending } = useConversationSidebar(source);
  const data = sidebar.data;
  /*
   * 「去确认」指向哪一条：审批收件箱里这个对话最新的那条为准（对话里那张卡就是按它画的，点了一定滚得到
   * 或就地画得出）；收件箱里没有时才用服务器从任务卡读到的那条。
   */
  const pending: PendingApproval =
    inboxPending ??
    (data?.goal?.pendingApprovalId
      ? { id: data.goal.pendingApprovalId }
      : null);
  // 只能画图标条：不改记住的「展开」，图标条上的按钮也点不开。
  const forced = variant === "panel" && room === "strip";
  const collapsed = variant === "panel" && (collapse.whole.collapsed || forced);

  if (variant === "panel" && room === "none") return null;

  if (collapsed) {
    const reveal = (name: SidebarSection) =>
      forced ? undefined : () => collapse.reveal(name);
    return (
      <aside
        aria-label="对话侧栏"
        className="flex h-full shrink-0 flex-col items-center gap-2 overflow-y-auto border-(--wb-line) border-l bg-(--wb-list) px-2 py-3.5 text-(--wb-fg2)"
        data-collapsed="true"
        data-forced={forced ? "true" : undefined}
        data-conversation-sidebar=""
        data-loaded={data ? "true" : "false"}
        style={{ width: STRIP_WIDTH }}
      >
        <button
          aria-label="展开侧栏"
          className={cn(
            STRIP_BUTTON,
            "border border-(--wb-line2) bg-(--wb-card2) text-(--wb-fg) disabled:opacity-50 disabled:hover:bg-(--wb-card2)",
          )}
          disabled={forced}
          onClick={collapse.whole.toggle}
          title={forced ? TOO_NARROW : undefined}
          type="button"
        >
          <IconChevronsLeft aria-hidden="true" className="size-4 stroke-[2]" />
        </button>
        <button
          aria-label={
            data ? `环境：${environmentSummary(data.environment)}` : "环境"
          }
          className={STRIP_BUTTON}
          disabled={forced}
          onClick={reveal("environment")}
          title={forced ? TOO_NARROW : undefined}
          type="button"
        >
          <EnvironmentIcon environment={data?.environment} />
        </button>
        <button
          aria-label={pending ? "目标：等你确认" : "目标"}
          className={STRIP_BUTTON}
          disabled={forced}
          onClick={reveal("goal")}
          title={forced ? TOO_NARROW : undefined}
          type="button"
        >
          <GoalIcon />
          {pending ? (
            <span
              aria-hidden="true"
              className="absolute top-[7px] right-[7px] size-2 rounded-full bg-(--wb-amber)"
              data-pending-dot=""
            />
          ) : null}
        </button>
        <button
          aria-label={contextMeterLabel(data?.context)}
          className={cn(STRIP_BUTTON, "flex-col gap-[3px] text-[10px]")}
          disabled={forced}
          onClick={reveal("context")}
          title={forced ? TOO_NARROW : undefined}
          type="button"
        >
          <ContextMeter context={data?.context} />
        </button>
        <button
          aria-label={
            data ? `输出内容：${outputsSummary(data.outputs)}` : "输出内容"
          }
          className={STRIP_BUTTON}
          disabled={forced}
          onClick={reveal("outputs")}
          title={forced ? TOO_NARROW : undefined}
          type="button"
        >
          <OutputsIcon count={data?.outputs.total} />
        </button>
      </aside>
    );
  }

  const section = (
    name: SidebarSection,
    summary: string | null,
    body: ReactNode,
  ) => {
    const { open, toggle } = collapse.section(name);
    return (
      <section
        aria-label={SECTION_NAMES[name]}
        className={cn("flex flex-col", open ? "gap-1.5" : "gap-0")}
        key={name}
      >
        <h3 className="m-0">
          <button
            aria-expanded={open}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-(--wb-radius-sm) border-0 bg-transparent py-1 text-left font-semibold text-(--wb-fg) text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
            onClick={toggle}
            type="button"
          >
            {open ? (
              <IconChevronDown
                aria-hidden="true"
                className="size-3 shrink-0 stroke-[2.5] text-(--wb-muted)"
              />
            ) : (
              <IconChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 stroke-[2.5] text-(--wb-muted)"
              />
            )}
            {SECTION_NAMES[name]}
            {!open && summary ? (
              <small
                className="ml-auto min-w-0 truncate pl-2 font-normal text-(--wb-muted) text-[12px]"
                data-summary=""
              >
                {summary}
              </small>
            ) : null}
          </button>
        </h3>
        {open ? (
          <div
            className={cn(
              "flex flex-col",
              name === "context"
                ? "gap-2"
                : name === "outputs"
                  ? "gap-1"
                  : "gap-1.5",
            )}
            data-section-body=""
          >
            {body}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <aside
      aria-label="对话侧栏"
      className={cn(
        "flex shrink-0 flex-col gap-[22px] overflow-y-auto bg-(--wb-list) px-[18px] py-5 text-(--wb-fg)",
        variant === "panel" ? "h-full border-(--wb-line) border-l" : "w-full",
      )}
      data-collapsed="false"
      data-conversation-sidebar=""
      data-loaded={data ? "true" : "false"}
      style={variant === "panel" ? { width: PANEL_WIDTH } : undefined}
    >
      {sidebar.isError && !data ? (
        <p className="m-0 text-(--wb-muted) text-[12.5px]" role="status">
          侧栏暂时读不到，稍后会再试。
        </p>
      ) : null}
      {data ? (
        <Sections
          data={data}
          section={section}
          pending={pending}
          agentId={agentId}
        />
      ) : null}
    </aside>
  );
}

const STRIP_BUTTON =
  "relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent text-(--wb-fg2) outline-none hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-accent) disabled:cursor-default disabled:hover:bg-transparent";

function Sections({
  data,
  section,
  pending,
  agentId,
}: {
  data: SidebarData;
  section: (
    name: SidebarSection,
    summary: string | null,
    body: ReactNode,
  ) => ReactNode;
  pending: PendingApproval;
  agentId?: string;
}) {
  return (
    <>
      {section(
        "environment",
        environmentSummary(data.environment),
        <EnvironmentBody agentId={agentId} environment={data.environment} />,
      )}
      {section(
        "goal",
        goalSummary(data.goal, pending),
        <GoalBody goal={data.goal} pending={pending} />,
      )}
      {section(
        "context",
        contextSummary(data.context),
        <ContextBody context={data.context} />,
      )}
      {section(
        "outputs",
        outputsSummary(data.outputs),
        <OutputsBody outputs={data.outputs} />,
      )}
    </>
  );
}

/**
 * 对话顶栏右边的「收起侧栏 / 展开侧栏」（设计稿顶栏的那个按钮），和侧栏读同一份收起状态。
 */
export function SidebarCollapseButton({
  collapseKey,
}: {
  collapseKey: string;
}) {
  const { whole } = useSidebarCollapse(collapseKey);
  const room = sidebarRoom(useDetailPanelWidth());
  // 只能画图标条或根本不画侧栏时，这个按钮点了没有用，不画。
  if (room !== "panel") return null;
  return (
    <button
      aria-label={whole.collapsed ? "展开侧栏" : "收起侧栏"}
      aria-pressed={!whole.collapsed}
      className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-(--wb-radius-sm) border border-(--wb-line2) bg-(--wb-card2) text-(--wb-fg) outline-none transition-colors hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
      data-sidebar-toggle=""
      onClick={whole.toggle}
      type="button"
    >
      <IconLayoutSidebarRight
        aria-hidden="true"
        className="size-[18px] stroke-[1.8]"
      />
    </button>
  );
}

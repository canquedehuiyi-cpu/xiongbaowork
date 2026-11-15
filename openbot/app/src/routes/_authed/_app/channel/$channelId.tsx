import { IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { ConversationApprovals } from "@/components/approvals/inline-approval";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { useProfileStatus } from "@/components/bot-profile/waker-detail-sections";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationActions } from "@/components/channels/conversation-actions";
import {
  CONVERSATION_HEADER_CLASS,
  ConversationHeaderCard,
} from "@/components/channels/conversation-header-card";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { useAutoWatchScreen } from "@/components/computer/use-auto-watch-screen";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { BearMascot } from "@/components/layout/workbench-empty";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePresence } from "@/lib/agents/presence";
import {
  type AgentProfile as AgentProfileData,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { useOpenComputerOnRequest } from "@/lib/computers/panel-view";
import { useSkinId } from "@/skins/store";
import {
  ConversationSidebar,
  SidebarCollapseButton,
  SidebarPage,
  SidebarPageButton,
  usePhoneSidebarPage,
} from "@/skins/xiongbao/conversation-sidebar/sidebar";
import { CompactionDivider } from "@/skins/xiongbao/conversation-sidebar/summary-view";
import { useEmployeeCard } from "@/skins/xiongbao/employee-card";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
  /** 默认皮肤的手机上：全屏的对话侧栏（`usePhoneSidebarPage`）。 */
  sidebar: z.literal(1).optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/**
 * Shared detail pane width for the live screen view. A glimpse, not a place to read the page: it shows that the Bot is
 * browsing and roughly what, and the full-size view (one click on the picture) is where the page is read.
 */
const SCREEN_PANEL_WIDTH = 360;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const workbench = useSkinId() === "xiongbao";
  // 默认皮肤没有员工资料抽屉了：旧链接、浏览器历史里残留的 `?settings` 不读，不再压住自动看屏幕。
  const isSettingsOpen = settings === true && !workbench;
  const prefersReducedMotion = useReducedMotion();
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  // The compact employee card, for a 1:1 conversation whose profile is loaded; else the plain name.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const card =
    channel.data?.agentIds.length === 1
      ? agentProfiles?.find((profile) => profile.id === agentId)
      : undefined;
  /*
   * An external employee (外部员工 Task 11) works in its own agent on its hirer's computer, not on a
   * computer of ours. The live screen viewer asks for a computer by the Bot's id, and on a cloud
   * deployment that means locating (and so starting) a cloud computer for it: a cost for nothing to
   * see. So it has no screen to open until the device can relay one: no button, and neither a stale
   * `?watch`, a command clicked in the chat nor browser activity opens the pane for it.
   */
  const external = Boolean(card?.external);
  // Nor before the profile says whether it is one.
  const isWatching = watch === true && agentProfiles !== undefined && !external;
  /*
   * 默认皮肤（聊天工作台）：员工资料那一块换成对话侧栏（环境 · 目标 · 上下文 · 输出内容），常驻在对话右边，
   * 顶栏的齿轮换成「收起侧栏 / 展开侧栏」。手机上顶栏换成一个按钮，打开全屏的侧栏（`usePhoneSidebarPage`）。
   * 别的皮肤照旧是齿轮打开员工资料。
   */
  const phone = useIsMobile();
  const sidebarThread =
    workbench && channel.data?.agentIds.length === 1
      ? channel.data.threadId
      : undefined;
  const sidebarTitle = card?.name ?? channel.data?.name;
  const phonePage = usePhoneSidebarPage();

  useMarkOpenChannelRead(channelId);

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const autoWatch = useAutoWatchScreen({
    botId: external ? undefined : agentId,
    watching: isWatching,
    busy: isSettingsOpen,
    open: () =>
      navigate({
        search: (previous) => ({
          ...previous,
          settings: undefined,
          watch: true,
        }),
      }),
    close: () =>
      navigate({ search: (previous) => ({ ...previous, watch: undefined }) }),
  });

  // A command in the chat clicked opens the Computer on its terminal.
  useOpenComputerOnRequest(external ? undefined : agentId, () => show("watch"));

  // Settings and watch share one pane; opening either clears the other URL flag.
  const show = (next: "settings" | "watch" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching) autoWatch.dismiss();
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: next === "settings" ? true : undefined,
        watch: next === "watch" ? true : undefined,
      }),
    });
  };

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isWatching || isSettingsOpen) && agentId !== undefined}
      aside={
        sidebarThread ? (
          <ConversationSidebar
            agentId={agentId}
            source={{ threadId: sidebarThread }}
            title={sidebarTitle}
            variant="panel"
          />
        ) : undefined
      }
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      title={isWatching ? "电脑" : undefined}
      waiting={
        channel.data ? (
          <ConversationApprovals threadId={channel.data.threadId} />
        ) : null
      }
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={channel?.data?.name} />
        ) : (
          <AgentProfile
            agentId={agentId}
            footer={
              channel.data ? (
                <ConversationActions
                  channelId={channelId}
                  leave={() => navigate({ to: "/" })}
                  name={channel.data.name}
                />
              ) : null
            }
          />
        )
      }
    >
      {/* A direct child of the pane's column, so `sticky` has the whole chat to stay pinned across. */}
      <div
        className={CONVERSATION_HEADER_CLASS}
        data-slot="conversation-header"
      >
        {card ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <SidebarToggle />
            <HeaderCard agent={card} />
          </div>
        ) : (
          <>
            {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
            <div className="flex min-w-0 items-center gap-1.5">
              <SidebarToggle />
              <motion.div
                animate={{ opacity: 1 }}
                className="shrink-0"
                initial={{ opacity: 0 }}
                key={`avatar:${channel.data?.name ?? channelId}`}
                transition={{
                  duration: HEADING_ENTRANCE_SECONDS,
                  ease: EASE_OUT,
                }}
              >
                {agentId ? (
                  <HeaderFace
                    agentId={agentId}
                    participantIds={channel.data?.agentIds ?? []}
                  />
                ) : (
                  <ChannelAvatar participantIds={[]} size={24} />
                )}
              </motion.div>
              <motion.span
                animate={
                  prefersReducedMotion
                    ? { opacity: 1 }
                    : { opacity: 1, transform: "translateY(0px)" }
                }
                className="min-w-0 truncate font-medium text-[14px] tracking-tight"
                initial={
                  prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
                }
                key={`name:${channel.data?.name ?? channelId}`}
                transition={{
                  duration: HEADING_ENTRANCE_SECONDS,
                  ease: EASE_OUT,
                }}
              >
                {channel.data?.name ?? "会话"}
              </motion.span>
            </div>
          </>
        )}
        <div className="flex flex-row gap-1.5">
          {/* Only once it is known not to be an external employee: these poll its computer. */}
          {external || agentProfiles === undefined ? null : (
            <ComputerChatControls
              computerId={agentId}
              open={isWatching}
              onOpenChange={(open) => show(open ? "watch" : null)}
            />
          )}
          {card ? <EmployeeCardButton agentId={card.id} /> : null}
          {workbench ? (
            sidebarThread ? (
              phone ? (
                <SidebarPageButton onOpen={phonePage.open} />
              ) : (
                <SidebarCollapseButton collapseKey={sidebarThread} />
              )
            ) : null
          ) : (
            <Button
              aria-label="会话里的员工"
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          )}
        </div>
      </div>
      {agentId && channel.data?.agentIds.length === 1 ? (
        <BotPausedBanner agentId={agentId} />
      ) : null}
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
        workbench={workbench}
      />
      {phone && sidebarThread && phonePage.isOpen ? (
        <SidebarPage
          agentId={agentId}
          onBack={phonePage.close}
          source={{ threadId: sidebarThread }}
          title={sidebarTitle}
        />
      ) : null}
    </DetailPanel>
  );
}

/**
 * A channel with exactly one coworker is its CopilotKit chat. One with several is a group, which
 * redirects to its shared transcript at `/group/$channelId`.
 */
function ChannelBody({
  channel,
  isPending,
  hasError,
  workbench,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
  /** 默认皮肤：对话里画压缩会话的分隔线。 */
  workbench: boolean;
}) {
  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (isPending) return null;
  if (hasError || !channel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <BearMascot mood="naughty" size={45} />
        <p className="font-medium text-[14px] text-signal-ink" role="alert">
          读不到这段会话。
        </p>
        <p className="text-[12px] text-muted-foreground">
          刷新页面再试一次；如果仍然打不开，它可能已被删除。
        </p>
      </div>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  // Two or more Bots is a group conversation, with its own shared transcript. Every link to a
  // channel lands here, so this is the one redirect they all need.
  if (!runtimeAgentId) {
    return (
      <Navigate
        params={{ channelId: channel.id }}
        replace
        to="/group/$channelId"
      />
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      compactionDivider={
        workbench
          ? (compaction) => (
              <CompactionDivider
                compaction={compaction}
                source={{ threadId: channel.threadId }}
              />
            )
          : undefined
      }
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}

/**
 * The pinned employee card atop a 单聊. In the workbench skin it also says where the employee is now
 * (status dot, 「忙碌 · 任务标题」) from the batch presence read (聊天工作台 Task 8), and its face moves
 * by that same read, so the face and the words never disagree; the other skins draw the card as they
 * always have, its face animated by the same status read as {@link HeaderFace}.
 */
function HeaderCard({ agent }: { agent: AgentProfileData }) {
  return useSkinId() === "xiongbao" ? (
    <PresenceHeaderCard agent={agent} />
  ) : (
    <StatusHeaderCard agent={agent} />
  );
}

/** The workbench skin's card: dot, words and face all from one presence read. */
function PresenceHeaderCard({ agent }: { agent: AgentProfileData }) {
  const presence = usePresence([agent.id]).get(agent.id);
  return (
    <ConversationHeaderCard
      agent={agent}
      motion={presence?.status === "working" ? "working" : "idle"}
      presence={presence}
    />
  );
}

/** Every other skin's card: no presence, the face by the 员工 detail page's status read. */
function StatusHeaderCard({ agent }: { agent: AgentProfileData }) {
  const status = useProfileStatus(agent.id);
  return (
    <ConversationHeaderCard
      agent={agent}
      motion={status === "working" ? "working" : "idle"}
    />
  );
}

/**
 * 「名片」 in the header's tools, as the mock draws it (聊天工作台 Task 9): opens this employee's card
 * (Task 7) on the workbench frame. Only the workbench frame carries the card, so in every other skin
 * there is nothing to open and no button.
 */
function EmployeeCardButton({ agentId }: { agentId: string }) {
  const cards = useEmployeeCard();
  if (!cards) return null;
  return (
    <button
      aria-haspopup="dialog"
      className="h-8 shrink-0 cursor-pointer rounded-(--wb-radius-sm) border border-(--wb-line2) bg-(--wb-card) px-2.5 text-(--wb-fg2) text-[12px] outline-none transition-colors hover:bg-(--wb-hover) focus-visible:outline-2 focus-visible:outline-(--wb-accent)"
      data-employee-card-button=""
      onClick={() => cards.openEmployeeCard(agentId)}
      type="button"
    >
      名片
    </button>
  );
}

/**
 * The conversation title's face, playing its animation in the state the employee is in: the same
 * read the 员工 detail page's face follows (working while it has running work, idling otherwise).
 */
function HeaderFace({
  agentId,
  participantIds,
}: {
  agentId: string;
  participantIds: string[];
}) {
  const status = useProfileStatus(agentId);
  return (
    <ChannelAvatar
      motion={status === "working" ? "working" : "idle"}
      participantIds={participantIds}
      size={24}
    />
  );
}

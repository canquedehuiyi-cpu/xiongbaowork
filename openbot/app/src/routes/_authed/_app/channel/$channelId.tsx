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
import {
  type AgentProfile as AgentProfileData,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { useOpenComputerOnRequest } from "@/lib/computers/panel-view";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
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
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  // The compact employee card, for a 1:1 conversation whose profile is loaded; else the plain name.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const card =
    channel.data?.agentIds.length === 1
      ? agentProfiles?.find((profile) => profile.id === agentId)
      : undefined;

  useMarkOpenChannelRead(channelId);

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const autoWatch = useAutoWatchScreen({
    botId: agentId,
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
  useOpenComputerOnRequest(agentId, () => show("watch"));

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
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
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
          <ComputerChatControls
            computerId={agentId}
            open={isWatching}
            onOpenChange={(open) => show(open ? "watch" : null)}
          />
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
        </div>
      </div>
      {agentId && channel.data?.agentIds.length === 1 ? (
        <BotPausedBanner agentId={agentId} />
      ) : null}
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
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
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
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
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}

/**
 * The conversation title's face, playing its animation in the state the employee is in: the same
 * read the 员工 detail page's face follows (working while it has running work, idling otherwise).
 */
function HeaderCard({ agent }: { agent: AgentProfileData }) {
  const status = useProfileStatus(agent.id);
  return (
    <ConversationHeaderCard
      agent={agent}
      motion={status === "working" ? "working" : "idle"}
    />
  );
}

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

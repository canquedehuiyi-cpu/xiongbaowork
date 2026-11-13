import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { groupQueryOptions } from "@/lib/groups";

/** A conversation with several employees. The channel is an ordinary channel with more than one. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  component: RouteComponent,
  // `?settings=1` opens the group's settings; the card's 「设置」 links here. Nothing else is kept.
  validateSearch: (search: Record<string, unknown>): { settings?: 1 } =>
    search.settings === 1 || search.settings === "1" ? { settings: 1 } : {},
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const channel = useQuery(channelQueryOptions(channelId));
  const group = useQuery(groupQueryOptions(channelId));
  // Only whoever is speaking moves; the rest of the group stays a still picture.
  const speaking = (group.data?.messages ?? [])
    .filter(
      (message) =>
        message.agentId &&
        (message.status === "running" || message.status === "queued"),
    )
    .map((message) => message.agentId as string);
  useMarkOpenChannelRead(channelId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="sticky top-0 flex min-h-12 flex-row items-center gap-1.5 border-b border-border px-3 py-2"
        data-slot="conversation-header"
      >
        <SidebarToggle />
        <ChannelAvatar
          motion="working"
          motionIds={speaking}
          participantIds={channel.data?.agentIds ?? []}
          size={24}
        />
        <span className="min-w-0 truncate font-medium text-[14px] tracking-tight">
          {channel.data?.name ?? "群聊"}
        </span>
        <GroupPeopleButton channelId={channelId} />
      </div>
      {(channel.data?.agentIds ?? []).map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat channelId={channelId} key={channelId} />
    </div>
  );
}

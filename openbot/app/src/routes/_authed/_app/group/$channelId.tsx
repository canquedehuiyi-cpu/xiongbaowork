import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { GroupSettingsButton } from "@/components/channels/group-settings";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { groupQueryOptions } from "@/lib/groups";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";

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
  const { settings } = Route.useSearch();
  const navigate = Route.useNavigate();
  // The group this chat is, when it is one the person made: its portrait stands in for the faces.
  const groupId = useQuery(wakerGroupsQueryOptions()).data?.find(
    (crew) => crew.channelId === channelId,
  )?.id;
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
          groupId={groupId}
          participantIds={channel.data?.agentIds ?? []}
          size={24}
        />
        <span className="min-w-0 truncate font-medium text-[14px] tracking-tight">
          {channel.data?.name ?? "群组"}
        </span>
        <GroupPeopleButton channelId={channelId} />
        <GroupSettingsButton
          channelId={channelId}
          // The drawer and the address are one thing, so the card's 「设置」 link and a reload both land here.
          onOpenChange={(open) =>
            void navigate({
              search: open ? { settings: 1 } : {},
              replace: true,
            })
          }
          open={settings === 1}
        />
      </div>
      {(channel.data?.agentIds ?? []).map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat channelId={channelId} key={channelId} />
    </div>
  );
}

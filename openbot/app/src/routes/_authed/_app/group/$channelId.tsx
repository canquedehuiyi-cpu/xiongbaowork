import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef } from "react";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { GroupSettingsButton } from "@/components/channels/group-settings";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { groupQueryOptions } from "@/lib/groups";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import { useSkinId } from "@/skins/store";
import {
  ConversationSidebar,
  SidebarCollapseButton,
  SidebarPage,
  SidebarPageButton,
} from "@/skins/xiongbao/conversation-sidebar/sidebar";

/** A conversation with several employees. The channel is an ordinary channel with more than one. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  component: RouteComponent,
  /*
   * `?settings=1` opens the group's settings; the card's 「设置」 links here. `?sidebar=1` is the default
   * skin's full-screen conversation sidebar on a phone. Nothing else is kept.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { settings?: 1; sidebar?: 1 } => ({
    ...(search.settings === 1 || search.settings === "1"
      ? { settings: 1 as const }
      : {}),
    ...(search.sidebar === 1 || search.sidebar === "1"
      ? { sidebar: 1 as const }
      : {}),
  }),
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const channel = useQuery(channelQueryOptions(channelId));
  const group = useQuery(groupQueryOptions(channelId));
  const { settings, sidebar: sidebarPage } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  /*
   * 默认皮肤（聊天工作台）：右边常驻对话侧栏，按群组频道取（成员、每位员工的上下文；目标和输出内容是查看者
   * 自己名下的）。电脑上顶栏一个「收起侧栏 / 展开侧栏」，手机上一个按钮打开全屏侧栏（`?sidebar=1`，历史里
   * 的一页：在这里打开的，「返回对话」后退一步；直达的就地去掉参数）。
   */
  const workbench = useSkinId() === "xiongbao";
  const phone = useIsMobile();

  const peopleCount = group.data?.people.length;
  const openedHere = useRef(false);
  const openSidebarPage = () => {
    openedHere.current = true;
    void navigate({ search: (previous) => ({ ...previous, sidebar: 1 }) });
  };
  const closeSidebarPage = () => {
    if (openedHere.current) {
      openedHere.current = false;
      router.history.back();
      return;
    }
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, sidebar: undefined }),
    });
  };
  // The group this chat is, when it is one the person made: its portrait stands in for the faces.
  const crew = useQuery(wakerGroupsQueryOptions()).data?.find(
    (candidate) => candidate.channelId === channelId,
  );
  const groupId = crew?.id;
  // 侧栏里的群名：人建的群用它自己的名字（改过名的以那里为准），否则是频道名。
  const groupName = crew?.name ?? channel.data?.name ?? "群组";
  // Only whoever is speaking moves; the rest of the group stays a still picture.
  const speaking = (group.data?.messages ?? [])
    .filter(
      (message) =>
        message.agentId &&
        (message.status === "running" || message.status === "queued"),
    )
    .map((message) => message.agentId as string);
  useMarkOpenChannelRead(channelId);
  const conversation = (
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
        {workbench ? (
          <span className="ml-auto flex shrink-0">
            {phone ? (
              <SidebarPageButton onOpen={openSidebarPage} />
            ) : (
              <SidebarCollapseButton collapseKey={channelId} />
            )}
          </span>
        ) : null}
      </div>
      {(channel.data?.agentIds ?? []).map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat channelId={channelId} key={channelId} />
    </div>
  );
  if (!workbench) return conversation;
  return (
    <DetailPanel
      aside={
        <ConversationSidebar
          peopleCount={peopleCount}
          source={{ channelId }}
          title={groupName}
          variant="panel"
        />
      }
      onClose={() => undefined}
      open={false}
    >
      {conversation}
      {phone && sidebarPage === 1 ? (
        <SidebarPage
          onBack={closeSidebarPage}
          peopleCount={peopleCount}
          source={{ channelId }}
          title={groupName}
        />
      ) : null}
    </DetailPanel>
  );
}

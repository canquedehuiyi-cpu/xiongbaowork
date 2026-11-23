import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ArtifactPreview } from "@/components/channels/artifact-preview";
import { ChannelAvatar } from "@/components/channels/avatar";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { GroupSettingsButton } from "@/components/channels/group-settings";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useIsMobile } from "@/hooks/use-mobile";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import {
  PREVIEW_PANEL_WIDTH,
  PreviewTargetContext,
  useRoutePreviewTarget,
} from "@/lib/computers/preview";
import { groupQueryOptions } from "@/lib/groups";
import { useGroupCompactionOutcomes } from "@/lib/threads/sidebar";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import { useSkinId } from "@/skins/store";
import {
  ConversationSidebar,
  SidebarCollapseButton,
  SidebarPage,
  SidebarPageButton,
  usePhoneSidebarPage,
} from "@/skins/xiongbao/conversation-sidebar/sidebar";

/** A conversation with several employees. The channel is an ordinary channel with more than one. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  component: RouteComponent,
  /*
   * `?settings=1` opens the group's settings; the card's 「设置」 links here. `?sidebar=1` is the default
   * skin's full-screen conversation sidebar on a phone. `?preview=` is the file preview in the detail pane
   * (a bad value reads as none). Nothing else is kept.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { settings?: 1; sidebar?: 1; preview?: string } => ({
    ...(typeof search.preview === "string" && search.preview !== ""
      ? { preview: search.preview }
      : {}),
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
  const { settings } = Route.useSearch();
  const navigate = Route.useNavigate();
  // 群聊的详情栏只放文件预览这一种内容。
  const preview = useRoutePreviewTarget();
  /*
   * 默认皮肤（聊天工作台）：右边常驻对话侧栏，按群组频道取（成员、每位员工的上下文；目标和输出内容是查看者
   * 自己名下的）。电脑上顶栏一个「收起侧栏 / 展开侧栏」，手机上一个按钮打开全屏侧栏（`usePhoneSidebarPage`）。
   * 群组的一轮在服务器上跑，自动压缩的结果记在回复上（`useGroupCompactionOutcomes`）。
   */
  const workbench = useSkinId() === "xiongbao";
  const phone = useIsMobile();

  const peopleCount = group.data?.people.length;
  const phonePage = usePhoneSidebarPage();
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
  const viewerId = useQuery(currentUserQueryOptions()).data?.id;
  useGroupCompactionOutcomes(
    channelId,
    workbench ? group.data?.messages : undefined,
    viewerId,
  );
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
              search: (previous) => ({
                ...previous,
                settings: open ? (1 as const) : undefined,
              }),
              replace: true,
            })
          }
          open={settings === 1}
        />
        {workbench ? (
          <span className="ml-auto flex shrink-0">
            {phone ? (
              <SidebarPageButton onOpen={phonePage.open} />
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
    <PreviewTargetContext.Provider value={preview}>
      <DetailPanel
        aside={
          <ConversationSidebar
            peopleCount={peopleCount}
            source={{ channelId }}
            title={groupName}
            variant="panel"
          />
        }
        detail={
          preview.target ? <ArtifactPreview target={preview.target} /> : null
        }
        detailWidth={PREVIEW_PANEL_WIDTH}
        onClose={preview.close}
        open={preview.target !== undefined}
        title="预览"
      >
        {conversation}
        {phone && phonePage.isOpen ? (
          <SidebarPage
            onBack={phonePage.close}
            peopleCount={peopleCount}
            source={{ channelId }}
            title={groupName}
          />
        ) : null}
      </DetailPanel>
    </PreviewTargetContext.Provider>
  );
}

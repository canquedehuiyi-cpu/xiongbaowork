import { IconLink, IconList, IconPlus, IconRobot } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ComponentType, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { QueryError } from "@/components/layout/query-error";
import { ChatStage } from "@/components/reachability/chat-stage";
import {
  chatRows,
  filterRows,
  type ReachabilitySearch,
  reachabilitySearch,
} from "@/components/reachability/chats";
import { ConnectedChats } from "@/components/reachability/connected-chats";
import {
  BotsAccountsDialog,
  UnavailableEntryDialog,
} from "@/components/reachability/entry-dialogs";
import {
  LinkConversationDialog,
  useLinkFlow,
} from "@/components/reachability/link-conversation-dialog";
import { RecentDeliveries } from "@/components/reachability/recent-deliveries";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  deliveryKey,
  deliveryQueryOptions,
  removeDeliveryBinding,
  removePushDevice,
} from "@/lib/delivery";
import { modelLibraryQueryOptions } from "@/lib/models/queries";

/**
 * @Waker (the reference's `/at-waker`): where a conversation is carried on outside this app.
 *
 * The path stays `/reachability`, which existing links and bookmarks use. `?view=cards`, `?q=`,
 * `?type=`, `?model=` and `?status=` narrow the connected chats and are omitted at their defaults.
 */
export const Route = createFileRoute("/_authed/_app/reachability")({
  component: ReachabilityPage,
  validateSearch: (search: Record<string, unknown>): ReachabilitySearch =>
    reachabilitySearch(search),
});

type Entry = "im" | "accounts" | "auto" | "requests";

/**
 * The heading, two lines of large type, and the page's one h1 (docs/design/ios-studio/02-Waker.png).
 *
 * The design's slogan is 「在聊天里，让数字员工接手工作」; the page keeps its own business wording —
 * what the page does, in the words it has always used — set as the design sets its headline, and
 * the slogan's idea goes in the sentence under it.
 */
const HEADLINE = "将员工接入群聊或私聊，\n在 IM 中持续承接团队工作";

/*
 * The open heading as docs/design/ios-studio/theme.css draws `.hero.waker`: 270px tall, the text
 * block centred against the chat illustration, the headline a little smaller than the other pages'
 * (clamp 32–51px) and the four entries in a row under the sentence (`.hero-actions.below`, 18px
 * down) rather than at the bottom right. The selectors reach into PageShell's header because that
 * shared component takes no props for this.
 */
const HERO_FRAME = [
  "[&>header]:flex-col [&>header]:items-start [&>header]:justify-center [&>header]:gap-y-[18px]",
  "md:[&>header]:min-h-[270px]",
  "[&>header_h1]:whitespace-pre-line",
  // A phone keeps each line whole: 28px fits 在 IM 中持续承接团队工作 in 364px. Under 1150px the
  // headline gives the chat card a little more room.
  "[&>header_h1]:text-[28px] sm:[&>header_h1]:text-[clamp(32px,3.7vw,51px)] min-[1150px]:[&>header_h1]:text-[clamp(32px,4.1vw,51px)]",
  // The text keeps clear of the chat card where the two would meet (theme.css: 66% under 1150px).
  "md:[&>header>div:not([data-slot])]:max-w-[66%] min-[1150px]:[&>header>div:not([data-slot])]:max-w-[60%]",
].join(" ");

function EntryButton({
  icon: Icon,
  label,
  badge,
  primary,
  title,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  badge?: string;
  primary?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="h-[34px] gap-[7px] px-[11px] text-[12px]"
      onClick={onClick}
      title={title}
      variant={primary ? "default" : "outline"}
    >
      <Icon className="size-[15px]" />
      {label}
      {badge && (
        <span className="rounded-[5px] bg-primary-foreground/10 px-1.5 font-medium text-[11px] leading-[18px]">
          {badge}
        </span>
      )}
    </Button>
  );
}

function ReachabilityPage() {
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const reach = useQuery(deliveryQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const library = useQuery(modelLibraryQueryOptions());
  const flow = useLinkFlow();
  const [entry, setEntry] = useState<Entry | null>(null);
  // People read Bots by name; the id is what the list used to show.
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? id;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: deliveryKey });
  const remove = useMutation({
    mutationFn: removeDeliveryBinding,
    onSuccess: refresh,
  });
  const deviceRemove = useMutation({
    mutationFn: removePushDevice,
    onSuccess: refresh,
  });

  const rows = reach.data
    ? chatRows({
        reach: reach.data,
        channels: channels.data,
        agents: bots.data,
        library: library.data,
      })
    : [];
  const visible = filterRows(rows, search);
  const onSearch = (next: Partial<ReachabilitySearch>) =>
    navigate({
      search: (prev) => reachabilitySearch({ ...prev, ...next }),
      replace: true,
    });
  const writeError = remove.error ?? deviceRemove.error;
  const close = (open: boolean) => {
    if (!open) setEntry(null);
  };

  return (
    <PageShell
      action={
        <>
          <EntryButton
            badge={flow.challengeId ? "待输入验证码" : undefined}
            icon={IconPlus}
            label="接入 IM 聊天"
            onClick={() => setEntry("im")}
            primary
          />
          <EntryButton
            icon={IconRobot}
            label="机器人与账号"
            onClick={() => setEntry("accounts")}
          />
          <EntryButton
            icon={IconLink}
            label="自动接入"
            onClick={() => setEntry("auto")}
            title="未开放：点击查看原因"
          />
          <EntryButton
            icon={IconList}
            label="接入申请"
            onClick={() => setEntry("requests")}
            title="未开放：点击查看原因"
          />
        </>
      }
      art={<ChatStage />}
      className={HERO_FRAME}
      description="在聊天里 @员工，让数字员工接手工作。"
      eyebrow="02 @WAKER / IM WORKSPACE"
      crumb="@Waker"
      title={HEADLINE}
      width="workbench"
    >
      <div className="mt-[5px] grid grid-cols-[minmax(0,1fr)] gap-[22px]">
        {(reach.error || (channels.error && !channels.data) || writeError) && (
          <div className="grid gap-3">
            {reach.error && (
              <QueryError
                error={reach.error}
                label={
                  reach.data
                    ? "刷新失败，下面是上次读取的结果"
                    : "无法读取接入状态"
                }
                onRetry={() => reach.refetch()}
                retrying={reach.isFetching}
              />
            )}
            {channels.error && !channels.data && (
              <QueryError
                error={channels.error}
                label="无法读取会话名称"
                onRetry={() => channels.refetch()}
                retrying={channels.isFetching}
              />
            )}
            {writeError && (
              <p role="alert" className="text-[13px] text-destructive">
                {writeError.message}
              </p>
            )}
          </div>
        )}

        {(reach.data || reach.isPending) && (
          <ConnectedChats
            actions={{
              onRemove: (row) =>
                row.kind === "device"
                  ? deviceRemove.mutate(row.id)
                  : remove.mutate(row.id),
              removing: remove.isPending || deviceRemove.isPending,
            }}
            loading={reach.isPending}
            onConnect={() => setEntry("im")}
            onSearch={onSearch}
            rows={rows}
            search={search}
            visible={visible}
          />
        )}

        <RecentDeliveries deliveries={reach.data?.deliveries} />

        <LinkConversationDialog
          botName={botName}
          flow={flow}
          onOpenChange={close}
          open={entry === "im"}
          reach={reach.data}
        />
        <BotsAccountsDialog
          onOpenChange={close}
          open={entry === "accounts"}
          reach={reach.data}
        />
        <UnavailableEntryDialog
          action="开启自动接入"
          description="让新的 IM 会话不必逐个关联，就自动接到你的员工。"
          onOpenChange={close}
          open={entry === "auto"}
          reason="这个部署还没有自动接入的接口。目前每一条接入都由对话主人逐段发起：Slack、Teams 发一次性关联码，手机号收验证码。"
          title="自动接入"
        />
        <UnavailableEntryDialog
          action="查看接入申请"
          description="IM 里的其他人申请与你的员工对话，由你逐条批准或拒绝。"
          onOpenChange={close}
          open={entry === "requests"}
          reason="这个部署还没有接入申请的记录或审批接口。接入只能由对话主人本人发起，别人无法申请。"
          title="接入申请"
        />
      </div>
    </PageShell>
  );
}

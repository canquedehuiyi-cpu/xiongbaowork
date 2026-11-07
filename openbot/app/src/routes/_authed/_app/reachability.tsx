import {
  IconListCheck,
  IconPlugConnected,
  IconPlus,
  IconRobot,
} from "@tabler/icons-react";
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
import { WakerScene } from "@/components/reachability/waker-scene";
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
 * The hero's headline, three lines, and the page's one h1.
 *
 * The reference has no page title above its hero: the headline IS the heading. `PageShell` always
 * draws its title as the h1, so the headline is passed as that title and {@link HERO_FRAME}
 * restyles it in place — rather than hiding PageShell's h1 and drawing a second one.
 */
const HEADLINE = "@员工\n将员工接入群聊或私聊\n在 IM 中持续承接团队工作";

/*
 * The hero, measured against docs/acceptance/qoderwake-reference/reachability.png (1696×850, CSS
 * px): the scene's card spans y 40–320 with its right edge on the column's; the headline is 32px
 * bold on a 36px line, its first line green; the entry buttons sit 42px under it; the text block is
 * centred against the scene. PageShell lays its header out first, the scene second, the rest after,
 * so from 1100px wide the frame becomes a two-column grid with the rest spanning both columns.
 * The selectors reach into PageShell's header (header > div > h1, its title row) because that
 * component is shared and takes no props for this.
 */
const HERO_FRAME = [
  "pt-[40px]",
  "min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,624px)] min-[1100px]:gap-x-[40px]",
  "[&>header]:self-center",
  "[&>header>div]:flex-col [&>header>div]:items-start [&>header>div]:justify-start [&>header>div]:gap-[42px]",
  "[&>header_h1]:whitespace-pre-line [&>header_h1]:font-bold [&>header_h1]:tracking-normal",
  // A phone keeps each line whole: 26px fits 将员工接入群聊或私聊 in 310px.
  "[&>header_h1]:text-[26px] [&>header_h1]:leading-[32px] sm:[&>header_h1]:text-[32px] sm:[&>header_h1]:leading-[36px]",
  "[&>header_h1::first-line]:text-primary",
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
      className="h-[32px] gap-1.5 rounded-md px-3 font-medium text-[13px]"
      onClick={onClick}
      title={title}
      variant={primary ? "default" : "outline"}
    >
      <Icon className="size-4" />
      {label}
      {badge && (
        <span className="rounded bg-primary-foreground/15 px-1.5 font-normal text-[11px] leading-[18px]">
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
        <div className="flex flex-wrap items-center gap-[9px]">
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
            icon={IconPlugConnected}
            label="自动接入"
            onClick={() => setEntry("auto")}
            title="未开放：点击查看原因"
          />
          <EntryButton
            icon={IconListCheck}
            label="接入申请"
            onClick={() => setEntry("requests")}
            title="未开放：点击查看原因"
          />
        </div>
      }
      className={HERO_FRAME}
      title={HEADLINE}
      width="workbench"
    >
      <WakerScene className="mt-8 justify-self-end min-[1100px]:mt-0 min-[1100px]:-mr-[12px]" />

      <div className="mt-[23px] grid grid-cols-[minmax(0,1fr)] gap-10 min-[1100px]:col-span-2">
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

import {
  IconBolt,
  IconMessagePlus,
  IconRobot,
  IconUserCheck,
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
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  deliveryKey,
  deliveryQueryOptions,
  removeDeliveryBinding,
  removePushDevice,
} from "@/lib/delivery";
import { modelLibraryQueryOptions } from "@/lib/models/queries";
import { cn } from "@/lib/utils";

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

function EntryTile({
  icon: Icon,
  title,
  hint,
  badge,
  muted,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  badge?: string;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex min-h-[64px] items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-left outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          "mt-0.5 flex size-[32px] shrink-0 items-center justify-center rounded-md",
          muted
            ? "bg-foreground/[0.06] text-muted-foreground"
            : "bg-primary/15 text-primary",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          {title}
          {badge && (
            <span
              className={cn(
                "rounded px-1.5 text-[11px] font-normal leading-[18px]",
                muted
                  ? "bg-foreground/[0.06] text-muted-foreground"
                  : "bg-primary/15 text-primary",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="text-[12px] text-muted-foreground">{hint}</span>
      </span>
    </button>
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
    <PageShell width="workbench" title="@Waker">
      <div className="mt-[20px] grid gap-8">
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <div className="grid gap-4">
            <p className="text-pretty text-[13px] text-muted-foreground">
              让员工走出这个应用：在 Slack、Microsoft
              Teams、短信或你的手机上把一段对话接下去。
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <EntryTile
                badge={flow.challengeId ? "待输入验证码" : undefined}
                hint="关联 Slack、Teams 或手机号"
                icon={IconMessagePlus}
                onClick={() => setEntry("im")}
                title="接入 IM 聊天"
              />
              <EntryTile
                hint="可用的聊天机器人、号码与设备"
                icon={IconRobot}
                onClick={() => setEntry("accounts")}
                title="机器人与账号"
              />
              <EntryTile
                badge="未开放"
                hint="新会话无需逐个关联"
                icon={IconBolt}
                muted
                onClick={() => setEntry("auto")}
                title="自动接入"
              />
              <EntryTile
                badge="未开放"
                hint="他人申请与你的员工对话"
                icon={IconUserCheck}
                muted
                onClick={() => setEntry("requests")}
                title="接入申请"
              />
            </div>
          </div>
          <WakerScene className="mx-auto max-w-[380px]" />
        </div>

        {reach.error && (
          <QueryError
            error={reach.error}
            label={
              reach.data ? "刷新失败，下面是上次读取的结果" : "无法读取接入状态"
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
      </div>

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
    </PageShell>
  );
}

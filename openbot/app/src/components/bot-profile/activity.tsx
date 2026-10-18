import {
  IconArrowsExchange,
  type IconBell,
  IconCalendarRepeat,
  IconChecks,
  IconClockPlay,
  IconHelpCircle,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

const ICONS: Record<ActivityKind, typeof IconBell> = {
  routine: IconCalendarRepeat,
  responsibility: IconTargetArrow,
  handoff: IconArrowsExchange,
  approval: IconChecks,
  question: IconHelpCircle,
  follow_up: IconClockPlay,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  routine: "定时任务",
  responsibility: "长期职责",
  handoff: "交接的任务",
  approval: "审批",
  question: "提问",
  follow_up: "跟进",
};

/**
 * The ledgers' own status words, said in the screen's language. The vocabulary is the server's
 * (`server/src/activity/activity.ts`), so a value this map has not met yet falls through to itself
 * rather than to a blank -- a row that says nothing about its state is worse than one English word.
 */
const STATUS_LABEL: Record<string, string> = {
  scheduled: "已排期",
  running: "进行中",
  active: "进行中",
  queued: "排队中",
  waiting: "等待中",
  "waiting for you": "等你处理",
  succeeded: "已完成",
  done: "已完成",
  delivered: "已交付",
  failed: "失败",
  skipped: "已跳过",
  stopped: "已停止",
  cancelled: "已取消",
};

/** Where an item opens: its conversation when it has one, otherwise the screen that owns its kind. */
function linkFor(item: ActivityItem) {
  if (item.channelId)
    return (
      <Link to="/channel/$channelId" params={{ channelId: item.channelId }} />
    );
  switch (item.kind) {
    case "approval":
    case "question":
      return <Link to="/approvals" />;
    case "responsibility":
      return <Link to="/responsibilities" />;
    case "routine":
      return <Link to="/routines" />;
    default:
      return null;
  }
}

function ActivityRow({
  agentId,
  item,
}: {
  agentId: string;
  item: ActivityItem;
}) {
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const Icon = ICONS[item.kind];
  const link = linkFor(item);
  const when = relativeTime(item.at);
  const control = item.stoppable ? (
    <Button
      disabled={stop.isPending}
      onClick={() => stop.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {stop.isPending ? "正在停止…" : "停止"}
    </Button>
  ) : item.cancellable ? (
    <Button
      disabled={cancel.isPending}
      onClick={() => cancel.mutate({ agentId, id: item.id })}
      size="sm"
      variant="outline"
    >
      {cancel.isPending ? "正在取消…" : "取消"}
    </Button>
  ) : null;
  const content = (
    <>
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription>
          {KIND_LABEL[item.kind]} ·{" "}
          {item.needsYou
            ? "等你处理"
            : (STATUS_LABEL[item.status] ?? item.status)}
          {when ? ` · ${when}` : ""}
          {item.detail ? ` · ${item.detail}` : ""}
        </ItemDescription>
      </ItemContent>
    </>
  );
  /*
   * A row with a Stop or Cancel keeps the row itself unlinked, so the button is not nested inside a
   * link; the conversation is still one click away through the title's own link.
   */
  if (control)
    return (
      <Item size="sm">
        {content}
        <ItemActions>
          {link ? (
            <Button render={link} size="sm" variant="ghost">
              打开
            </Button>
          ) : null}
          {control}
        </ItemActions>
      </Item>
    );
  return link ? (
    <Item render={link} size="sm">
      {content}
    </Item>
  ) : (
    <Item size="sm">{content}</Item>
  );
}

function ActivitySection({
  agentId,
  empty,
  items,
  title,
}: {
  agentId: string;
  empty: string;
  items: ActivityItem[];
  title: string;
}) {
  return (
    <PageSection title={title}>
      {items.length === 0 ? (
        <PageEmpty>{empty}</PageEmpty>
      ) : (
        <PageRows>
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 ? <Separator /> : null}
              <ActivityRow agentId={agentId} item={item} />
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** In progress, Scheduled and Completed, read from the ledgers the work already lives in. */
export function BotActivitySections({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (activity.isPending) return null;
  if (activity.error)
    return (
      <PageSection title="动态">
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到这位员工的动态。
        </p>
      </PageSection>
    );
  return (
    <>
      <ActivitySection
        agentId={agentId}
        empty="没有在进行或等你处理的事。"
        items={activity.data.inProgress}
        title="进行中"
      />
      <ActivitySection
        agentId={agentId}
        empty="没有排期的事。"
        items={activity.data.scheduled}
        title="已排期"
      />
      <ActivitySection
        agentId={agentId}
        empty="还没有做完的事。"
        items={activity.data.completed}
        title="已完成"
      />
    </>
  );
}

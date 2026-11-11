import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { QueryError } from "@/components/layout/query-error";
import { Button } from "@/components/ui/button";
import {
  ProfileEmpty,
  ProfilePanel,
} from "@/components/bot-profile/profile-kit";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type AgentAuditEvent,
  agentAuditQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { RequestError } from "@/lib/client";
import { relativeTime } from "@/lib/relative-time";

/**
 * What each row of a coworker's trail says, in the product's language.
 *
 * Only the events the server writes against a coworker (`target_type = 'agent'`) are named here. An
 * event this list does not know yet is shown by its own type rather than dropped or guessed at: a
 * trail that silently skips a row is a trail nobody can rely on.
 */
export const AGENT_AUDIT_LABEL: Record<string, string> = {
  "bot.created": "创建了这位员工",
  "bot.updated": "修改了这位员工的设置",
  "bot.duplicated": "复制了这位员工",
  "bot.deleted": "删除了这位员工",
  "bot.hidden": "隐藏了这位员工",
  "bot.unhidden": "取消隐藏",
  "bot.pinned": "置顶了这位员工",
  "bot.unpinned": "取消置顶",
  "bot.paused": "暂停了这位员工",
  "bot.resumed": "恢复了这位员工",
  "bot.reset": "重置了这位员工",
  "bot.notifications_changed": "调整了通知方式",
  "bot.follow_up_scheduled": "安排了一次跟进",
  "bot.follow_up_cancelled": "取消了一次跟进",
  "bot.handoff_stopped": "停止了一项交接任务",
  "bot.callback_token_issued": "签发了回调凭证",
  "bot.callback_token_revoked": "吊销了回调凭证",
  "bot.declined": "这位员工拒绝了一次请求",
  "agent.handoff_offered": "发起了一次交接",
  "agent.handoff_refused": "一次交接被拦截",
  "agent.handoff_delivered": "交接已送达",
  "agent.handoff_failed": "一次交接没有完成",
  "agent.handoff_retried": "重试了一次交接",
  "agent.escalated": "向人提了一个问题",
  "agent.escalation_failed": "一个问题没能送到人手里",
  "agent.stream_stalled": "一次回复中途卡住",
  "agent.dial_refused": "一个外部地址被拒绝连接",
  "channel.routed": "一条消息被路由给它",
  "model.refused": "模型调用被拦截",
  "mcp.callback_refused": "一次工具回调被拒绝",
};

/** Who or what started the row, when no person is named on it. */
const INITIATOR_LABEL: Record<string, string> = {
  person: "成员",
  deployment: "系统",
  routine: "定时任务",
  responsibility: "长期职责",
  memory: "记忆整理",
  handoff: "交接",
};

export function auditEventLabel(eventType: string): string {
  return AGENT_AUDIT_LABEL[eventType] ?? eventType;
}

/**
 * The name on a row: "你" for the signed-in person's own rows, the initiator otherwise.
 *
 * Other people are never named by id on this page. The server already keeps one person's private
 * rows (pausing, muting, resetting) away from everybody else; an opaque user id would add nothing a
 * reader could act on.
 */
function whoOf(event: AgentAuditEvent, me: string | undefined): string {
  if (me && event.actorUserId === me) return "你";
  if (event.initiatorKind !== "person") {
    return INITIATOR_LABEL[event.initiatorKind] ?? event.initiatorKind;
  }
  return event.actorUserId ? "其他成员" : "系统";
}

/**
 * A coworker's recent audit trail (story D5), read from `GET /api/bots/:agentId/audit`.
 *
 * Owns its own loading, error and empty states so a failure here never blanks the rest of the
 * detail page, and pages on the server's cursor with an explicit 加载更多 rather than an offset.
 */
export function AgentAuditTrail({ agentId }: { agentId: string }) {
  const trail = useInfiniteQuery(agentAuditQueryOptions(agentId));
  const me = useQuery(currentUserQueryOptions());
  const myId = me.data?.id;

  if (trail.isPending) {
    return (
      <div
        aria-label="正在读取审计记录"
        className="mt-[10px] grid gap-[6px]"
        role="status"
      >
        <Skeleton className="h-[48px] rounded-[14px]" />
        <Skeleton className="h-[48px] rounded-[14px]" />
      </div>
    );
  }
  /*
   * No data and not pending is a first read that failed. A later failure (a refetch, or the next
   * page) keeps the rows already shown and is said beside them instead of blanking the list.
   */
  if (!trail.data) {
    // 503 is the deployment saying it keeps no trail at all, which is not something to retry.
    if (trail.error instanceof RequestError && trail.error.status === 503) {
      return (
        <ProfileEmpty>
          <span role="alert">
            这个部署没有开启审计记录，所以这里没有流水可看。
          </span>
        </ProfileEmpty>
      );
    }
    return (
      <div className="mt-[10px]">
        <QueryError
          error={trail.error}
          label="读不到审计记录"
          onRetry={() => void trail.refetch()}
          retrying={trail.isFetching}
        />
      </div>
    );
  }

  const pages = trail.data.pages;
  const events = pages.flatMap((page) => page.events);
  const ownOnly = pages[0]?.scope === "own";

  return (
    <div className="mt-[10px]">
      {ownOnly ? (
        <p
          className="mb-[8px] text-[13px] text-muted-foreground"
          data-scope="own"
        >
          你不是这位员工的主人，所以这里只列出你自己对它做过的操作。
        </p>
      ) : null}
      {events.length === 0 ? (
        <ProfileEmpty className="mt-0">
          <span className="block font-medium text-foreground/80">
            还没有审计记录
          </span>
          <span className="mt-[2px] block">
            有人修改、暂停它，或它交接、提问时，这里会留下一条记录。
          </span>
        </ProfileEmpty>
      ) : (
        <ProfilePanel className="mt-0">
          {events.map((event) => (
            <Item data-event-type={event.eventType} key={event.id} size="sm">
              <ItemContent className="flex-row flex-wrap items-baseline justify-between gap-x-[12px]">
                <ItemTitle>
                  {whoOf(event, myId)} · {auditEventLabel(event.eventType)}
                </ItemTitle>
                <ItemDescription className="font-mono text-[11.5px] tabular-nums">
                  <time dateTime={event.createdAt}>
                    {relativeTime(event.createdAt)}
                  </time>
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ProfilePanel>
      )}
      {trail.isRefetchError ? (
        <p className="mt-[8px] text-[13px] text-destructive" role="alert">
          刷新审计记录失败，上面是上一次读到的：
          {trail.error?.message ?? "请稍后再试。"}
        </p>
      ) : null}
      {trail.isFetchNextPageError ? (
        <p className="mt-[8px] text-[13px] text-destructive" role="alert">
          更早的记录没读到：{trail.error?.message ?? "请稍后再试。"}
        </p>
      ) : null}
      {trail.hasNextPage ? (
        <Button
          className="mt-[10px]"
          disabled={trail.isFetchingNextPage}
          onClick={() => void trail.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {trail.isFetchingNextPage ? "正在加载…" : "加载更早的记录"}
        </Button>
      ) : null}
    </div>
  );
}

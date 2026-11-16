import { createFileRoute } from "@tanstack/react-router";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import {
  RecentAuditSection,
  RunningTasksSection,
} from "@/components/bot-profile/waker-detail-sections";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/activity")({
  component: ActivityPage,
});

/**
 * The tasks, routines and goals this Bot is doing, has lined up and has finished, on a page of its
 * own, and a row to every action it took. On the Bot's own page the three lists ran on for screens
 * and pushed its settings out of reach; there, one row counts them and opens this.
 *
 * 熊宝在上游之后加了两段（原 `/wakers/$agentId` 上的）：看板上由它执行的进行中任务和最近审计。这周标完成的
 * 任务跟上游一样留在员工自己的页面上（这一页的「已完成」是它做完的事，两段同名会分不清）。
 */
function ActivityPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="查看这位员工正在做、已安排和已完成的任务、定时任务与长期职责。"
      title="动态"
    >
      {(agent) => (
        <>
          <BotActivitySections agentId={agent.id} />
          <RunningTasksSection agentId={agent.id} />
          <RecentAuditSection agentId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}

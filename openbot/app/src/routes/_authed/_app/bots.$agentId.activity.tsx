import { createFileRoute } from "@tanstack/react-router";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/activity")({
  component: ActivityPage,
});

/**
 * The tasks, routines and goals this Bot is doing, has lined up and has finished, on a page of its
 * own, and a row to every action it took. On the Bot's own page the three lists ran on for screens
 * and pushed its settings out of reach; there, one row counts them and opens this.
 */
function ActivityPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="查看这位员工正在做、已安排和已完成的任务、定时任务与长期职责。"
      title="动态"
    >
      {(agent) => <BotActivitySections agentId={agent.id} />}
    </BotSubpage>
  );
}

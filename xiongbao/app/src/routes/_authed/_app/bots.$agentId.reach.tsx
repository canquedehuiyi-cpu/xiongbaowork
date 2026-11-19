import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ReachingYou } from "@/components/delivery/reaching-you";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/reach")({
  component: ReachPage,
});

function ReachPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="在 Slack、Microsoft Teams 或短信里接着和这位员工对话。"
      title="触达方式"
    >
      {(agent) => <ReachingYou agentId={agent.id} />}
    </BotSubpage>
  );
}

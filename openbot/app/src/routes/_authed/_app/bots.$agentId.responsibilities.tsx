import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";

export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/responsibilities",
)({
  component: ResponsibilitiesPage,
});

function ResponsibilitiesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="查看这位员工的长期职责、每次运行是什么触发的，以及结果。"
      title="长期职责"
    >
      {(agent) => <BotResponsibilities agentId={agent.id} />}
    </BotSubpage>
  );
}

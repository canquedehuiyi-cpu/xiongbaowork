import { createFileRoute } from "@tanstack/react-router";
import { ExternalUnattendedNote } from "@/components/agents/external/external-marks";
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
      {(agent) =>
        // 外部员工这一步不接长期职责（外部员工规格「不做」）。
        agent.external ? (
          <ExternalUnattendedNote />
        ) : (
          <BotResponsibilities agentId={agent.id} />
        )
      }
    </BotSubpage>
  );
}

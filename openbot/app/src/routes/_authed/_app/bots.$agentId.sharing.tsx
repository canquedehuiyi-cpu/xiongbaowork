import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SharingSections } from "@/components/bot-profile/sharing";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/sharing")({
  component: SharingPage,
});

function SharingPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="选择谁能用这位员工。每个人和它的对话都只有自己能看到。"
      title="共享"
    >
      {(agent) => <SharingSections agent={agent} />}
    </BotSubpage>
  );
}

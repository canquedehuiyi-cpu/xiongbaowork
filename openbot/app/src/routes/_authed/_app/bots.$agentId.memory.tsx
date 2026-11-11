import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { MemorySources } from "@/components/memory/sources";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/memory")({
  /*
   * The personal edition has no memory (see `offersMemory`). This employee's check-ins, the other
   * half of this page, are on 它能做什么 there, so an old link to this page opens that.
   */
  beforeLoad: async ({ context, params }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({
        to: "/bots/$agentId/access",
        params: { agentId: params.agentId },
        replace: true,
      });
    }
  },
  component: MemoryPage,
});

function MemoryPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="选择这位员工从哪些应用里学习，并管理它的主动巡检。"
      title="记忆"
    >
      {(agent) => (
        <>
          <p className="mt-6 text-muted-foreground text-sm">
            你直接告诉所有员工的事在
            <Link
              className="text-foreground underline underline-offset-4"
              to="/capabilities/memory"
            >
              能力 › 记忆与信息源
            </Link>
            里。
          </p>
          <MemorySources agentId={agent.id} />
          <ProactiveResearchSettings agentId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}

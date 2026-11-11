import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { AccessSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/access")({
  component: AccessPage,
});

/**
 * 技能与应用。个人版里叫「它能做什么」，一页顶团队版的五页（"What it can do" upstream):
 * what it can use, what it asks you before doing, the goals it works on, and its check-ins, which
 * are separate pages in the team edition. Check-ins sit on the Bot's Memory page there, and the
 * personal edition has no memory (see `offersMemory`), so they are here.
 */
function AccessPage() {
  const { agentId } = Route.useParams();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <BotSubpage
      agentId={agentId}
      description={
        personal
          ? "管理这位员工能用什么、动手前要问你什么、它在做的长期职责和主动巡检。"
          : "管理这位员工能用的技能、应用，以及它能找哪些员工帮忙。"
      }
      title={personal ? "它能做什么" : "技能与应用"}
    >
      {(agent) => (
        <>
          <AccessSections agent={agent} />
          {personal ? (
            <>
              <BotApprovalRules agentId={agent.id} />
              <BotResponsibilities agentId={agent.id} />
              <ProactiveResearchSettings agentId={agent.id} />
            </>
          ) : null}
        </>
      )}
    </BotSubpage>
  );
}

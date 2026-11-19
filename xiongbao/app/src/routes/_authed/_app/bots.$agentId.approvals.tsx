import { createFileRoute } from "@tanstack/react-router";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotPermissions } from "@/components/bot-profile/permissions";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/approvals")({
  component: ApprovalRulesPage,
});

/**
 * 审批与权限：上游的审批规则（哪些动作不用问你），加上熊宝每个工具的权限（直接 / 询问 / 禁用，原
 * `/wakers/$agentId` 上的「权限」）。审批底线由服务端判定，这里放不宽。
 */
function ApprovalRulesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="选择这位员工哪些动作不用等你批准，以及它的每个工具是直接用、先问你还是禁用。"
      title="审批与权限"
    >
      {(agent) => (
        <>
          <BotApprovalRules agentId={agent.id} />
          <BotPermissions agentId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { AssembleSections } from "@/components/bot-profile/assemble";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SetupSections } from "@/components/bot-profile/setup";
import { ProjectSection } from "@/components/bot-profile/waker-detail-sections";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/setup")({
  component: SetupPage,
});

/**
 * 员工的「设置」：上游的身份、可见性、独立运行和运行方式（`SetupSections`），熊宝的当前项目，再加上原来的装配页
 * （`/assemble/$agentId` 重定向到这里）：模型、人设、技能、可自助安装的工具、连接器和知识库。
 */
function SetupPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="修改这位员工的身份、可见性和运行方式，以及它用的模型、人设和能碰到的东西，从下一轮开始生效。"
      title="设置"
    >
      {(agent) => (
        <>
          <SetupSections agent={agent} />
          <ProjectSection profile={agent} />
          <AssembleSections profile={agent} />
        </>
      )}
    </BotSubpage>
  );
}

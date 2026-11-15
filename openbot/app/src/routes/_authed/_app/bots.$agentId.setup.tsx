import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HireSettings } from "@/components/agents/external/hire-settings";
import { AssembleSections } from "@/components/bot-profile/assemble";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SetupSections } from "@/components/bot-profile/setup";
import { ProjectSection } from "@/components/bot-profile/waker-detail-sections";
import { hiredRun } from "@/lib/agents/external";

const setupSearchSchema = z.object({
  /** 外部员工：打开招聘设置的编辑态（电脑、工作文件夹、五项规则）。别的员工不认它。 */
  edit: z.literal("run").optional(),
});

export const Route = createFileRoute("/_authed/_app/bots/$agentId/setup")({
  validateSearch: setupSearchSchema,
  component: SetupPage,
});

/**
 * 员工的「设置」：上游的身份、可见性、独立运行和运行方式（`SetupSections`），熊宝的当前项目，再加上原来的装配页
 * （`/assemble/$agentId` 重定向到这里）：模型、人设、技能、可自助安装的工具、连接器和知识库。
 *
 * 外部员工（外部员工 Task 11）在自己的工作文件夹里干活，没有「当前项目」；「运行方式」写它在哪台电脑上、用的是
 * 哪个智能体。`?edit=run` 是招聘设置的编辑态（名片和「运行方式」里的「配置」都到这里），存好或取消回到这一页。
 */
function SetupPage() {
  const { agentId } = Route.useParams();
  const { edit } = Route.useSearch();
  const navigate = Route.useNavigate();
  const leaveEdit = () =>
    void navigate({ search: (previous) => ({ ...previous, edit: undefined }) });
  return (
    <BotSubpage
      agentId={agentId}
      description="修改这位员工的身份、可见性和运行方式，以及它用的模型、人设和能碰到的东西，从下一轮开始生效。"
      title="设置"
    >
      {(agent) => {
        // 只有招它的人读得到它怎么跑、也只有他能改（服务器对别人一律拒绝，管理员也一样）。
        const run = hiredRun(agent);
        return run && edit === "run" && agent.mine ? (
          <div className="mt-6">
            <HireSettings
              deviceId={run.deviceId}
              editing={{
                agentId: agent.id,
                name: agent.name,
                department: agent.department ?? null,
                external: run,
              }}
              harness={run.harness}
              onCancel={leaveEdit}
              onHired={leaveEdit}
            />
          </div>
        ) : (
          <>
            <SetupSections agent={agent} />
            {agent.external ? null : <ProjectSection profile={agent} />}
            <AssembleSections profile={agent} />
          </>
        );
      }}
    </BotSubpage>
  );
}

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalUnattendedNote } from "@/components/agents/external/external-marks";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";
import { agentQueryOptions } from "@/lib/agents/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId)).data;
  // 外部员工这一步不接定时任务（外部员工规格「不做」）：不给新建的按钮，列表换成一句说明。
  const external = Boolean(agent?.external);
  return (
    <BotSubpage
      action={
        agent && !external ? <NewRoutineButton agentId={agentId} /> : undefined
      }
      agentId={agentId}
      description="管理这位员工的定时任务：可以暂停、立即运行或删除。"
      title="定时任务"
    >
      {(profile) =>
        profile.external ? (
          <ExternalUnattendedNote />
        ) : (
          <RoutinesList agentId={profile.id} />
        )
      }
    </BotSubpage>
  );
}

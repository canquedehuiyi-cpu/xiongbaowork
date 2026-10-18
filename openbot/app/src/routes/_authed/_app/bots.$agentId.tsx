import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotProfile } from "@/components/bot-profile/profile";
import { PageShell } from "@/components/layout/page-shell";
import { agentQueryOptions } from "@/lib/agents/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId));
  return (
    <PageShell
      backButton={{ label: "Bot 会话", linkProps: { to: "/bots" } }}
      description="这位员工在为你做什么，以及它怎么运行。"
      title={agent.data?.name ?? "员工"}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          你联系不到这位员工。
        </p>
      ) : (
        <BotProfile agent={agent.data} />
      )}
    </PageShell>
  );
}

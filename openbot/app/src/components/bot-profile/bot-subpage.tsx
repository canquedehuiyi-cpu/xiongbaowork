import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";

/**
 * The frame of every `/bots/$agentId/<area>` page: back to the employee's page under 员工管理
 * (`/wakers/$agentId`, where `/bots/$agentId` forwards) by name, then the area.
 *
 * One frame so each area page is only its own rows, and so a Bot the person cannot reach says so in
 * the same words everywhere.
 */
export function BotSubpage({
  agentId,
  title,
  description,
  children,
}: {
  agentId: string;
  title: string;
  description: string;
  children: (agent: AgentProfile) => React.ReactNode;
}) {
  const agent = useQuery(agentQueryOptions(agentId));
  return (
    <PageShell
      backButton={{
        label: agent.data?.name ?? "员工",
        linkProps: { params: { agentId }, to: "/wakers/$agentId" },
      }}
      description={description}
      title={title}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          打不开这位员工，可能没有共享给你。
        </p>
      ) : (
        children(agent.data)
      )}
    </PageShell>
  );
}

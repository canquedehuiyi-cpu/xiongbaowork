import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import logo256 from "@/assets/brand/xiongbao-logo-256.png";
import { usePortraitSrc } from "@/components/portraits/use-portrait";
import {
  type AgentProfile,
  type SummonResult,
  summonAgentMutationOptions,
} from "@/lib/agents/queries";
import { SummonCardFlip } from "./summon-card-flip";

/** Why a summon was refused, said beside the employee it was for. */
export type SummonProblem = { agentId: string; message: string };

/** The card flip for one summon in flight, drawn with the face the roster shows for that employee. */
function SummonFlight({
  agent,
  result,
  onDone,
  onFail,
}: {
  agent: AgentProfile;
  result: Promise<SummonResult>;
  onDone: () => void;
  onFail: (error: unknown) => void;
}) {
  const portrait = usePortraitSrc("coworker", agent.id);
  return (
    <SummonCardFlip
      agentId={agent.id}
      name={agent.name}
      onDone={onDone}
      onFail={onFail}
      portrait={portrait ?? logo256}
      result={result}
      title={agent.title || agent.roleDescription}
    />
  );
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : "没能召唤这位员工";

/**
 * 召唤 one employee on 人才市场 (`/bots`), the one place summoning happens (召唤员工 Task 10): the
 * summon request, the card flip while it is answered, and then the 1:1 conversation it returns.
 *
 * `overlay` is the flip, to be drawn by the caller; `problem` says why the last summon was refused.
 */
export function useSummon(): {
  start: (agent: AgentProfile) => void;
  busy: boolean;
  problem: SummonProblem | null;
  overlay: ReactNode;
} {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const summon = useMutation(summonAgentMutationOptions(queryClient));
  const [flight, setFlight] = useState<{
    agent: AgentProfile;
    result: Promise<SummonResult>;
  } | null>(null);
  const [problem, setProblem] = useState<SummonProblem | null>(null);
  const openConversation = ({ channelId }: SummonResult) =>
    navigate({ to: "/channel/$channelId", params: { channelId } });
  const busy = flight !== null || summon.isPending;
  const start = (agent: AgentProfile) => {
    if (busy) return;
    setProblem(null);
    setFlight({ agent, result: summon.mutateAsync(agent.id) });
  };
  const overlay = flight ? (
    <SummonFlight
      agent={flight.agent}
      onDone={() => {
        const { result } = flight;
        setFlight(null);
        void result.then(openConversation);
      }}
      onFail={(error) => {
        setFlight(null);
        setProblem({ agentId: flight.agent.id, message: reason(error) });
      }}
      result={flight.result}
    />
  ) : null;
  return { start, busy, problem, overlay };
}

import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import logo256 from "@/assets/brand/xiongbao-logo-256.png";
import { usePortraitSrc } from "@/components/portraits/use-portrait";
import type { SummonProblem } from "@/components/summon/use-summon";
import { Button } from "@/components/ui/button";
import {
  CARD_SURFACE,
  CARD_TAG,
  GRID,
  PERSONAL_SURFACE,
} from "@/components/wakers/card-chrome";
import type { AgentProfile } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

/** The anchor a 待召唤 card answers to, so 「去人才市场」 elsewhere can land on that employee. */
export function summonAnchor(agentId: string): string {
  return `summon-${agentId}`;
}

/**
 * 人才市场's 待召唤 (召唤员工 Task 10): the presets and the 分身 the person has not summoned yet, each a
 * card with its 熊宝 portrait and one primary 「召唤」. Summoning is `useSummon`'s, owned by the page,
 * so one flip plays at a time and a second press while it runs does nothing.
 *
 * A link to `/bots#summon-<id>` brings that card into view.
 */
export function SummonGrid({
  agents,
  avatarId,
  busy,
  problem,
  onSummon,
}: {
  agents: readonly AgentProfile[];
  avatarId: string | null;
  busy: boolean;
  problem: SummonProblem | null;
  onSummon: (agent: AgentProfile) => void;
}) {
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash)?.scrollIntoView?.({ block: "center" });
  }, [hash]);
  return (
    <div
      className={cn(GRID, "mt-4")}
      data-section="pending"
      data-testid="summon-grid"
    >
      {agents.map((agent) => (
        <SummonCard
          agent={agent}
          busy={busy}
          isAvatar={agent.id === avatarId || agent.summonKind === "avatar"}
          key={agent.id}
          onSummon={() => onSummon(agent)}
          problem={problem?.agentId === agent.id ? problem.message : null}
        />
      ))}
    </div>
  );
}

function SummonCard({
  agent,
  busy,
  isAvatar,
  onSummon,
  problem,
}: {
  agent: AgentProfile;
  busy: boolean;
  isAvatar: boolean;
  onSummon: () => void;
  problem: string | null;
}) {
  const portrait = usePortraitSrc("coworker", agent.id) ?? logo256;
  const role = isAvatar ? "个人分身" : agent.title.trim();
  const duties = agent.roleDescription.trim();
  return (
    <div
      className={cn(CARD_SURFACE, "gap-[10px]", isAvatar && PERSONAL_SURFACE)}
      data-testid="summon-card"
      id={summonAnchor(agent.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={CARD_TAG}>待召唤</span>
      </div>
      <div className="flex min-w-0 items-center gap-[12px]">
        <img
          alt=""
          className="size-[64px] shrink-0 rounded-[14px] border border-foreground/[0.13] bg-muted object-cover"
          draggable={false}
          src={portrait}
        />
        <div className="min-w-0">
          <p className="truncate font-semibold text-[16px]" data-card-name="">
            {agent.name}
          </p>
          {role ? (
            <p className="truncate text-[12px] text-muted-foreground">{role}</p>
          ) : null}
        </div>
      </div>
      {duties ? (
        <p className="line-clamp-2 text-[12px] text-muted-foreground">
          {duties}
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-end">
        <Button
          aria-label={`召唤 ${agent.name}`}
          disabled={busy}
          onClick={onSummon}
          size="sm"
        >
          召唤
        </Button>
      </div>
      {problem ? (
        <p className="text-[12px] text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

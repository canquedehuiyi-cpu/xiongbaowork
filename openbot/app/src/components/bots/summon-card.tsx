import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import type { SummonProblem } from "@/components/summon/use-summon";
import { Button } from "@/components/ui/button";
import {
  CARD_SURFACE,
  CardFooter,
  CardIndex,
  GRID,
  ordinal,
  PERSONAL_SURFACE,
} from "@/components/wakers/card-chrome";
import { FACE_RING } from "@/components/wakers/coworker-card";
import type { AgentProfile } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

/** The anchor a 待召唤 card answers to, so 「去人才市场」 elsewhere can land on that employee. */
export function summonAnchor(agentId: string): string {
  return `summon-${agentId}`;
}

/**
 * 人才市场's 待召唤 (召唤员工 Task 10): the presets and the 分身 the person has not summoned yet, each the
 * page's own profile card with its 熊宝 portrait, a 待召唤 chip and one primary 「召唤」. Summoning is `useSummon`'s, owned by the page,
 * so one flip plays at a time and a second press while it runs does nothing.
 *
 * A link to `/bots#summon-<id>` brings that card into view, focuses it and lights it briefly — each
 * time the link is followed, not only the first (every navigation has its own history key).
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
  const visit = useLocation({ select: (location) => location.state.__TSR_key });
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!hash || !visit) return;
    const card = document.getElementById(hash);
    if (!card) return;
    card.scrollIntoView?.({ block: "center" });
    card.focus({ preventScroll: true });
    setLit(hash);
    const done = setTimeout(() => setLit(null), LIT_MS);
    return () => clearTimeout(done);
  }, [hash, visit]);
  return (
    <div
      className={cn(GRID, "mt-4")}
      data-section="pending"
      data-testid="summon-grid"
    >
      {agents.map((agent, position) => (
        <SummonCard
          agent={agent}
          busy={busy}
          index={ordinal(position)}
          isAvatar={agent.id === avatarId || agent.summonKind === "avatar"}
          key={agent.id}
          onSummon={() => onSummon(agent)}
          lit={lit === summonAnchor(agent.id)}
          problem={problem?.agentId === agent.id ? problem.message : null}
        />
      ))}
    </div>
  );
}

/** How long a card reached through its anchor stays lit. */
const LIT_MS = 1600;

function SummonCard({
  agent,
  busy,
  index,
  isAvatar,
  lit,
  onSummon,
  problem,
}: {
  agent: AgentProfile;
  busy: boolean;
  /** The card's place on the page as drawn, for its `PROFILE / 01` index. */
  index: string;
  isAvatar: boolean;
  /** Reached just now through its anchor. */
  lit: boolean;
  onSummon: () => void;
  problem: string | null;
}) {
  const role = isAvatar ? "个人分身" : agent.title.trim();
  const description =
    agent.roleDescription.trim() ||
    (role !== agent.title.trim() ? agent.title.trim() : "") ||
    "还没写职责。";
  /*
   * The same profile card as every other employee on the page (`CoworkerCard`: the index and a status
   * chip on top, the 44px face beside the name and role, one line of duties, a footer under a
   * hairline) and the same theme tokens, so it reads alike in light and dark and under every skin. Its
   * chip says 待召唤 and its footer carries the one thing to do: 召唤.
   */
  return (
    <div
      className={cn(
        CARD_SURFACE,
        "outline-none hover:border-foreground/20",
        isAvatar && cn(PERSONAL_SURFACE, "hover:border-signal/40"),
        lit && "ring-2 ring-signal/70",
      )}
      data-highlighted={lit ? "" : undefined}
      data-testid="summon-card"
      id={summonAnchor(agent.id)}
      tabIndex={-1}
    >
      <div className="flex min-w-0 flex-col" data-slot="item-title">
        <div className="flex min-h-[21px] items-start justify-between gap-[5px]">
          <span className="flex min-w-0 flex-wrap items-center gap-[4px]">
            <CardIndex index={index} kind="Profile" />
          </span>
          <span
            className="inline-flex h-[21px] shrink-0 items-center rounded-full bg-foreground/[0.085] px-[8px] font-semibold text-[11px] text-foreground whitespace-nowrap"
            data-status="pending"
          >
            待召唤
          </span>
        </div>
        <div className="mt-[12px] flex min-w-0 items-center gap-[10px]">
          <span className={FACE_RING}>
            <AbstractAvatar
              name={agent.name}
              portrait={{ kind: "coworker", id: agent.id }}
              seed={agent.avatarSeed}
              size={44}
            />
          </span>
          <div className="min-w-0">
            <h3
              className="truncate font-bold text-[16px] leading-[22px] tracking-[-0.01em]"
              data-card-name=""
            >
              {agent.name}
            </h3>
            {role ? (
              <span className="mt-px block truncate text-[12px] text-muted-foreground leading-[17px]">
                {role}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p
        className="mt-[10px] mb-[10px] truncate text-[12px] text-muted-foreground leading-[18px]"
        title={description}
      >
        {description}
      </p>
      <CardFooter
        left={<span className="truncate">召唤后成为你的员工</span>}
        right={
          <Button
            aria-label={`召唤 ${agent.name}`}
            className="h-[24px] px-[10px] text-[12px]"
            disabled={busy}
            onClick={onSummon}
            size="sm"
          >
            召唤
          </Button>
        }
      />
      {problem ? (
        <p className="mt-[6px] text-[12px] text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

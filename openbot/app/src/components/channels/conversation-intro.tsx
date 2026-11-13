import { useQuery } from "@tanstack/react-query";
import { type RefObject, useCallback, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { BotOrb } from "@/components/agents/bot-orb";
import { ChosenPortrait } from "@/components/channels/avatar";
import type { AvatarMotionState } from "@/components/portraits/preset-animations";
import { Skeleton } from "@/components/ui/skeleton";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { cn } from "@/lib/utils";

/**
 * The top of a conversation with one Bot: its orb, its name, what it does, and who can see it.
 *
 * Drawn from the Bot's profile, with visibility shown only in the team edition.
 * It is the first thing in the transcript's scroll content and scrolls away with it; once it has,
 * `ConversationIntroBar` keeps the Bot named at the top of the pane (see `useIntroScrolledAway`).
 *
 * The empty-state pattern sits behind the orb as a halo (`.orb-pattern` in styles.css), so it follows
 * the `--empty-pattern*` tokens and a skin that turns the pattern off turns this off too.
 */
export function ConversationIntro({
  agent,
  motion,
}: {
  /** The state the portrait plays in, when it has an animation; still without it. */
  motion?: AvatarMotionState;
  agent: {
    id: string;
    name: string;
    title?: string | null;
    roleDescription?: string | null;
    avatarSeed?: string | null;
    visibility: "public" | "private";
  };
}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const about = [agent.title, agent.roleDescription]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
  return (
    <div className="flex items-center gap-5 pt-4 pb-2">
      <div className="relative isolate grid shrink-0 place-items-center">
        <div aria-hidden className="orb-pattern" />
        {/* A portrait somebody chose (头像) replaces the orb, and plays its animation in `motion`. */}
        <span className="block size-24">
          <ChosenPortrait id={agent.id} motion={motion} size={96}>
            <BotOrb
              name={agent.name}
              seed={agent.avatarSeed || agent.id}
              size={96}
            />
          </ChosenPortrait>
        </span>
      </div>
      <div className="min-w-0">
        <h1 className="font-bold text-3xl tracking-tight">{agent.name}</h1>
        {/* Two lines at most: a role can run to a paragraph, and the intro introduces, it doesn't brief.
            The whole role is on the Bot's page and in the detail pane. */}
        {about ? (
          <p
            className="mt-1 line-clamp-2 max-w-[60ch] text-muted-foreground"
            title={about}
          >
            {about}
          </p>
        ) : null}
        {personal ? null : (
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex h-6.5 items-center rounded-lg bg-muted px-2.5 font-semibold text-[13px] text-muted-foreground">
              {agent.visibility === "public" ? "公开" : "仅自己"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where the intro will be, while the Bot it introduces is still being picked.
 *
 * A message sent from home opens a conversation before a Bot is chosen (`/start/$startId`). The
 * conversation it becomes has this intro above the message, and lands scrolled to its end, so the
 * message sits where the end of the scroll puts it. Without something in the intro's place above
 * it, the placeholder had nothing to scroll and drew the message at the top, and the message
 * dropped 48px when the conversation arrived. The same footprint as `ConversationIntro`, line for
 * line, so the conversation that replaces it moves nothing but the orb and the words coming in.
 */
export function ConversationIntroPlaceholder() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <div aria-hidden className="flex items-center gap-5 pt-4 pb-2">
      <div className="relative isolate grid shrink-0 place-items-center">
        <div className="orb-pattern" />
        <Skeleton className="size-24 rounded-full" />
      </div>
      <div className="min-w-0 flex-1">
        {/* The heading's line, then two lines of role, as `line-clamp-2` allows. */}
        <div className="flex h-9 items-center">
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="mt-1 flex h-12 max-w-[60ch] flex-col justify-around">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        {personal ? null : (
          <div className="mt-3 flex">
            <Skeleton className="h-6.5 w-16 rounded-lg" />
          </div>
        )}
      </div>
    </div>
  );
}

type IntroAgent = Parameters<typeof ConversationIntro>[0]["agent"];

/**
 * Whether the intro has scrolled out of the top of the transcript's viewport. Call `update` from
 * the viewport's scroll handler (and after the intro changes); put `introRef` on the intro's
 * wrapper. Measured, not observed, so the answer is exact on the frame the scroll lands.
 */
export function useIntroScrolledAway(
  viewportRef: RefObject<HTMLElement | null>,
) {
  const introRef = useRef<HTMLDivElement | null>(null);
  const [away, setAway] = useState(false);
  const update = useCallback(() => {
    const viewport = viewportRef.current;
    const intro = introRef.current;
    if (!viewport || !intro) {
      setAway(false);
      return;
    }
    setAway(
      intro.getBoundingClientRect().bottom <=
        viewport.getBoundingClientRect().top + 1,
    );
  }, [viewportRef]);
  return { introRef, away, update };
}

/**
 * The intro folded to one line, laid over the top of the transcript once the full intro has
 * scrolled away: a small face, the name, and the role on one ellipsised line. It is an overlay with
 * an opaque ground, not a row above the scroller, so showing and hiding it never resizes the
 * viewport and the reader's scroll position cannot move. Hidden (and out of the accessibility tree)
 * while the full intro is on screen.
 */
export function ConversationIntroBar({
  agent,
  visible,
  motion,
}: {
  agent: IntroAgent;
  visible: boolean;
  motion?: AvatarMotionState;
}) {
  const about = [agent.title, agent.roleDescription]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "absolute inset-x-0 top-0 z-10 border-border border-b bg-background transition-[opacity,transform] duration-150 motion-reduce:transition-none",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none -translate-y-1 opacity-0",
      )}
      data-slot="conversation-intro-bar"
      data-visible={visible}
    >
      <div className="mx-auto flex h-10 w-full min-w-0 max-w-3xl items-center gap-2 px-4">
        <AbstractAvatar
          decorative
          motion={visible ? motion : undefined}
          name={agent.name}
          portrait={{ kind: "coworker", id: agent.id }}
          seed={agent.avatarSeed || agent.id}
          size={22}
        />
        <span className="shrink-0 font-semibold text-sm">{agent.name}</span>
        {about ? (
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground text-xs"
            title={about}
          >
            {about}
          </span>
        ) : null}
      </div>
    </div>
  );
}

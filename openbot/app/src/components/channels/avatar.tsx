import { QueryClientContext, useQuery } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { memo, type ReactNode, useContext } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { useBotLook } from "@/components/agents/bot-look";
import { BotOrb } from "@/components/agents/bot-orb";
import type { AvatarMotionState } from "@/components/portraits/preset-animations";
import { usePortraitSrc } from "@/components/portraits/use-portrait";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 *
 * Where Bots are orbs (`useBotLook`), each is drawn from its `avatarSeed`, as `AbstractAvatar`
 * draws it, so a Bot is one color everywhere; a skin that has not opted in keeps the faces. The orbs
 * are hidden from screen readers: the row beside the avatar names the conversation, and an id read
 * aloud would name nothing.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
  motion,
  motionIds,
  groupId,
}: {
  participantIds: string[];
  size?: number;
  /** The group this chat belongs to: a portrait chosen for it stands in for the stacked faces. */
  groupId?: string;
  typing?: boolean;
  /**
   * Play the chosen portrait's animation or video in this state. Without it the face is still, as
   * every list draws it. It reaches only a participant who has a portrait (and, with reduced motion
   * or no video, falls back to the still picture).
   */
  motion?: AvatarMotionState;
  /** Limit `motion` to these participants, so a group animates only whoever is speaking. */
  motionIds?: readonly string[];
}) {
  const orbs = useBotLook() === "orb";
  const draw = orbs ? orbFace : boringFace;
  const face = (id: string, faceSize: number) =>
    draw(
      id,
      faceSize,
      motionIds && !motionIds.includes(id) ? undefined : motion,
    );
  const avatar =
    participantIds.length === 1 ? (
      face(participantIds[0], size)
    ) : (
      <GroupFaces
        face={face}
        layout={orbs ? ORB_PAIR : participantIds.length === 2 ? 2 : 3}
        participantIds={participantIds}
        size={size}
      />
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {groupId ? (
        <GroupPortrait groupId={groupId} size={size}>
          {avatar}
        </GroupPortrait>
      ) : (
        avatar
      )}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/** The picture somebody chose for the group, filling the avatar's square; `children` when none. */
function GroupPortrait({
  groupId,
  size,
  children,
}: {
  groupId: string;
  size: number;
  children: ReactNode;
}) {
  const src = usePortraitSrc("group", groupId);
  if (!src) return children;
  return (
    <span className="block size-full overflow-hidden rounded-[8px]">
      <img
        alt=""
        className="size-full object-cover"
        data-portrait=""
        height={size}
        src={src}
        width={size}
      />
    </span>
  );
}

/** Where each face sits in a group's avatar, as fractions of its size, back to front. */
const LAYOUTS = {
  2: {
    diameter: 0.68,
    at: [
      [0, 0],
      [0.32, 0.32],
    ],
  },
  3: {
    diameter: 0.56,
    at: [
      [0.22, 0],
      [0, 0.44],
      [0.44, 0.44],
    ],
  },
} as const;

type Layout = {
  diameter: number;
  at: readonly (readonly [number, number])[];
};

/** The orbs' group: the first two Bots side by side, overlapping by a third of an orb. */
const ORB_PAIR: Layout = {
  diameter: 0.6,
  at: [
    [0, 0.2],
    [0.4, 0.2],
  ],
};

function boringFace(id: string, size: number, motion?: AvatarMotionState) {
  return (
    <ChosenPortrait id={id} motion={motion} size={size}>
      <Avatar className="size-full" name={id} size={size} />
    </ChosenPortrait>
  );
}

function orbFace(id: string, size: number, motion?: AvatarMotionState) {
  return (
    <ChosenPortrait id={id} motion={motion} size={size}>
      <OrbFace id={id} size={size} />
    </ChosenPortrait>
  );
}

/**
 * A portrait somebody chose (头像) for this participant wins over the seed's drawing, so a
 * coworker looks the same in a conversation's header and list as in the roster. A participant with
 * none, or a face drawn where there is no query client to read portraits with, keeps `children`.
 */
export function ChosenPortrait({
  id,
  motion,
  size,
  children,
}: {
  id: string;
  motion?: AvatarMotionState;
  size: number;
  children: ReactNode;
}) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) return children;
  return (
    <ChosenPortraitFace id={id} motion={motion} size={size}>
      {children}
    </ChosenPortraitFace>
  );
}

function ChosenPortraitFace({
  id,
  motion,
  size,
  children,
}: {
  id: string;
  motion?: AvatarMotionState;
  size: number;
  children: ReactNode;
}) {
  const chosen = usePortraitSrc("coworker", id);
  if (!chosen) return children;
  return (
    <span className="block size-full overflow-hidden rounded-full">
      <AbstractAvatar
        decorative
        motion={motion}
        name=""
        portrait={{ kind: "coworker", id }}
        seed={id}
        size={size}
      />
    </span>
  );
}

/**
 * A participant that is not a listed Bot, such as a computer, is seeded by its id. Its label is the
 * Bot's name and never the id, hidden or not: whatever reads the orb's label should hear a Bot.
 */
function OrbFace({ id, size }: { id: string; size: number }) {
  const { data: bot } = useQuery({
    ...agentListQueryOptions(),
    select: (agents) => agents.find((agent) => agent.id === id),
  });
  return (
    <span aria-hidden="true" className="contents">
      <BotOrb name={bot?.name ?? ""} seed={bot?.avatarSeed ?? id} size={size} />
    </span>
  );
}

/**
 * A group's first Bots, as many as the layout places, overlapping inside the avatar's own square so
 * the row around it keeps its layout. Each face is cut out where a later one covers it, leaving a gap that reads
 * on any background — selected, hovered, or the conversation's header.
 */
function GroupFaces({
  face,
  layout: chosen,
  participantIds,
  size,
}: {
  face: (id: string, size: number) => ReactNode;
  layout: keyof typeof LAYOUTS | Layout;
  participantIds: string[];
  size: number;
}) {
  const layout: Layout = typeof chosen === "number" ? LAYOUTS[chosen] : chosen;
  const shown = participantIds.slice(0, layout.at.length);
  const diameter = Math.round(size * layout.diameter);
  const gap = Math.max(1, size * 0.05);
  const at = layout.at.map(([x, y]) => [x * size, y * size]);
  return (
    <div className="relative size-full">
      {shown.map((id, i) => {
        const cuts = at.slice(i + 1).map(([x, y]) => {
          const cx = x - at[i][0] + diameter / 2;
          const cy = y - at[i][1] + diameter / 2;
          const r = diameter / 2 + gap;
          return `radial-gradient(circle at ${cx}px ${cy}px, transparent ${r}px, #000 ${r + 0.5}px)`;
        });
        const mask = cuts.length > 0 ? cuts.join(", ") : undefined;
        return (
          <div
            className="absolute overflow-hidden rounded-full"
            key={id}
            style={{
              left: at[i][0],
              top: at[i][1],
              height: diameter,
              width: diameter,
              maskImage: mask,
              WebkitMaskImage: mask,
              maskComposite: "intersect",
              WebkitMaskComposite: "source-in",
            }}
          >
            {face(id, diameter)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
export function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">处理中…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}

import { QueryClientContext } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { useContext, useEffect, useState } from "react";
import { useBotLook } from "@/components/agents/bot-look";
import { BotOrb } from "@/components/agents/bot-orb";
import {
  AVATAR_MOTION_CLASS,
  type AvatarMotionState,
} from "@/components/portraits/preset-animations";
import { usePortraitSrc, usePortraitVideo } from "@/components/portraits/use-portrait";
import type { PortraitKind } from "@/lib/portraits/queries";

type FaceProps = {
  name: string;
  seed: string;
  size?: number;
  /**
   * The name is already written beside it (a roster row, a header): draw the face only, so the
   * coworker is announced once and nothing else carries their bare name as a label.
   */
  decorative?: boolean;
  /**
   * Whose face this is. With it, a portrait somebody chose for that coworker or group (头像) is drawn
   * in place of the abstract one; without it, or until one is chosen, the seed's drawing is.
   */
  portrait?: { kind: PortraitKind; id: string };
  /**
   * The motion state to play — one of the seven states a Muse avatar has. Without it the face is
   * still: a list never plays a video on its own, and a detail view plays only the state it is in.
   */
  motion?: AvatarMotionState;
};

/** A coworker's avatar: a chosen portrait, else its orb, or its face in a skin that has not opted in to orbs. */
export function AbstractAvatar(props: FaceProps) {
  const look = useBotLook();
  /*
   * Only read the workspace's portraits where there is a query client to read them with. A face is
   * also drawn in isolated previews and tests that have none, and there the seed's drawing is right.
   */
  const queryClient = useContext(QueryClientContext);
  if (props.portrait && queryClient) {
    return <PortraitFace {...props} look={look} portrait={props.portrait} />;
  }
  return <Face {...props} look={look} />;
}

function PortraitFace(
  props: FaceProps & {
    look: "orb" | "face";
    portrait: { kind: PortraitKind; id: string };
  },
) {
  const src = usePortraitSrc(props.portrait.kind, props.portrait.id);
  const videoUrl = usePortraitVideo(
    props.portrait.kind,
    props.portrait.id,
    props.motion,
  );
  return (
    <Face
      {...props}
      src={src ?? undefined}
      videoUrl={videoUrl ?? undefined}
    />
  );
}

/**
 * Whether the viewer asked for less motion. A CSS media query cannot stop a <video>, so the
 * video branch reads this directly and falls back to the poster when motion is reduced.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function Face({
  name,
  seed,
  size = 40,
  decorative = false,
  src,
  videoUrl,
  motion,
  look,
}: FaceProps & {
  src?: string;
  videoUrl?: string;
  look: "orb" | "face";
}) {
  const [videoFailed, setVideoFailed] = useState(false);
  // A failed video stays failed only for that URL: a replacement upload retries playback.
  useEffect(() => {
    if (videoUrl) setVideoFailed(false);
  }, [videoUrl]);
  const prefersReducedMotion = usePrefersReducedMotion();
  const motionClass = motion ? AVATAR_MOTION_CLASS[motion] : undefined;
  // A skin that draws coworkers as orbs still shows a portrait somebody chose for them.
  if (look === "orb" && !src) {
    const orb = <BotOrb name={name} seed={seed} size={size} />;
    if (!motionClass) {
      return decorative ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {orb}
        </span>
      ) : (
        orb
      );
    }
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 ${motionClass}`}
      >
        {orb}
      </span>
    );
  }
  const drawing =
    videoUrl && motion && !videoFailed && !prefersReducedMotion ? (
      <video
        autoPlay
        className="size-full object-cover"
        data-portrait-video=""
        draggable={false}
        height={size}
        loop
        muted
        onError={() => setVideoFailed(true)}
        playsInline
        poster={src}
        src={videoUrl}
        width={size}
      />
    ) : src ? (
      <img
        alt=""
        className="size-full object-cover"
        data-portrait=""
        decoding="async"
        draggable={false}
        height={size}
        src={src}
        width={size}
      />
    ) : (
      <Avatar name={seed} size={size} />
    );
  if (decorative) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 overflow-hidden rounded-[30%] ${motionClass ?? ""}`}
        style={{ height: size, width: size }}
      >
        {drawing}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={name}
      className={`inline-flex shrink-0 overflow-hidden rounded-[30%] ${motionClass ?? ""}`}
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <span aria-hidden="true" className="contents">
        {drawing}
      </span>
    </span>
  );
}

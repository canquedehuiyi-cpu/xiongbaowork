import { QueryClientContext } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { useContext } from "react";
import { usePortraitSrc } from "@/components/portraits/use-portrait";
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
};

export function AbstractAvatar(props: FaceProps) {
  /*
   * Only read the workspace's portraits where there is a query client to read them with. A face is
   * also drawn in isolated previews and tests that have none, and there the seed's drawing is right.
   */
  const queryClient = useContext(QueryClientContext);
  if (props.portrait && queryClient) {
    return <PortraitFace {...props} portrait={props.portrait} />;
  }
  return <Face {...props} />;
}

function PortraitFace(
  props: FaceProps & { portrait: { kind: PortraitKind; id: string } },
) {
  const src = usePortraitSrc(props.portrait.kind, props.portrait.id);
  return <Face {...props} src={src ?? undefined} />;
}

function Face({
  name,
  seed,
  size = 40,
  decorative = false,
  src,
}: FaceProps & { src?: string }) {
  const drawing = src ? (
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
        className="inline-flex shrink-0 overflow-hidden rounded-full"
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
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <span aria-hidden="true" className="contents">
        {drawing}
      </span>
    </span>
  );
}

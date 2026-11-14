import { useQuery } from "@tanstack/react-query";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type PortraitKind,
  type PortraitPreset,
  portraitIndex,
  portraitsQueryOptions,
} from "@/lib/portraits/queries";
import { type AvatarMotionState, PRESET_ANIMATIONS } from "./preset-animations";
import { PRESET_IMAGES } from "./preset-images";

/**
 * The picture to draw for this coworker or group, if somebody chose one: a 熊宝 expression's image,
 * or the uploaded picture's URL. Null means "draw the default face". One cached read serves every
 * face on the screen.
 */
export function usePortraitSrc(kind: PortraitKind, id: string): string | null {
  const portraits = useQuery(portraitsQueryOptions());
  /*
   * A coworker with no portrait row of its own wears the preset face it was made with (`presetPortrait`,
   * set on a shared preset and on the copy summoned from it). Read from the roster already in the cache,
   * never fetched from here (`enabled: false`), so drawing a face costs no request.
   */
  const agents = useQuery({ ...agentListQueryOptions(), enabled: false });
  const chosen = portraitIndex(portraits.data).get(`${kind}:${id}`);
  if (chosen) {
    return chosen.preset ? PRESET_IMAGES[chosen.preset] : chosen.imageUrl;
  }
  if (kind !== "coworker") return null;
  return presetPortraitSrc(agents.data?.find((agent) => agent.id === id));
}

/** The picture of the preset face an employee was made with, or null when it has none. */
export function presetPortraitSrc(
  agent: { presetPortrait?: PortraitPreset | null } | undefined,
): string | null {
  const preset = agent?.presetPortrait ?? null;
  return preset ? (PRESET_IMAGES[preset] ?? null) : null;
}

/**
 * The video loop for this coworker or group, if there is one: an uploaded video first, else the
 * shipped video for the face's preset in the motion state that is playing. The picture above is
 * its poster, and the video only plays where a motion state is active — a list always draws the
 * still. Null means there is no video to play.
 */
export function usePortraitVideo(
  kind: PortraitKind,
  id: string,
  motion?: AvatarMotionState,
): string | null {
  const portraits = useQuery(portraitsQueryOptions());
  const chosen = portraitIndex(portraits.data).get(`${kind}:${id}`);
  if (!chosen) return null;
  if (chosen.videoUrl) return chosen.videoUrl;
  if (chosen.preset && motion) {
    return PRESET_ANIMATIONS[chosen.preset][motion]?.videoUrl ?? null;
  }
  return null;
}

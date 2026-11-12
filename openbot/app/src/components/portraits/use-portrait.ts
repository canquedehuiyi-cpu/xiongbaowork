import { useQuery } from "@tanstack/react-query";
import {
  type PortraitKind,
  portraitIndex,
  portraitsQueryOptions,
} from "@/lib/portraits/queries";
import { PRESET_IMAGES } from "./preset-images";

/**
 * The picture to draw for this coworker or group, if somebody chose one: a 熊宝 expression's image,
 * or the uploaded picture's URL. Null means "draw the default face". One cached read serves every
 * face on the screen.
 */
export function usePortraitSrc(kind: PortraitKind, id: string): string | null {
  const portraits = useQuery(portraitsQueryOptions());
  const chosen = portraitIndex(portraits.data).get(`${kind}:${id}`);
  if (!chosen) return null;
  return chosen.preset ? PRESET_IMAGES[chosen.preset] : chosen.imageUrl;
}

/**
 * An uploaded video for this coworker or group, if somebody uploaded one: the picture above is
 * its poster, and the video only plays where a motion state is active — a list always draws the
 * still. Null means there is no video to play.
 */
export function usePortraitVideo(kind: PortraitKind, id: string): string | null {
  const portraits = useQuery(portraitsQueryOptions());
  return portraitIndex(portraits.data).get(`${kind}:${id}`)?.videoUrl ?? null;
}

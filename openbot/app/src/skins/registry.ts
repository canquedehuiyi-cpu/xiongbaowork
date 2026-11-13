import { appConfig } from "@/lib/generated/application-config";
import { opendots } from "./opendots";
import { openduet } from "./openduet";
import { openmuse } from "./openmuse";
import { useSkinId } from "./store";
import type { Skin, SkinId } from "./types";

/*
 * The default is the product as `brand.yaml` names it, so a deployment that renames OpenBot sees
 * its own name here too. The description says nothing a rename could make untrue.
 */
const xiongbao: Skin = {
  id: "xiongbao",
  name: appConfig.brand.productName,
  description: "标准外观，对话列在侧栏里。",
  botLook: "orb",
};

/** Keyed by every id in `SKIN_IDS`, so a skin cannot be listed without being registered. */
export const SKINS: Record<SkinId, Skin> = {
  xiongbao,
  openduet,
  opendots,
  openmuse,
};

export function useActiveSkin(): Skin {
  return SKINS[useSkinId()];
}

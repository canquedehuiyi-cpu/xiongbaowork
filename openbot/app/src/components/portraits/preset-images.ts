import cool from "@/assets/brand/xiongbao-cool.png";
import cute from "@/assets/brand/xiongbao-cute.png";
import happy from "@/assets/brand/xiongbao-happy.png";
import naughty from "@/assets/brand/xiongbao-naughty.png";
import sweet from "@/assets/brand/xiongbao-sweet.png";
import type { PortraitPreset } from "@/lib/portraits/queries";

/** The five expressions on the brand's character sheet (表情特写), each cut to a round portrait. */
export const PRESET_IMAGES: Record<PortraitPreset, string> = {
  naughty,
  cute,
  cool,
  happy,
  sweet,
};

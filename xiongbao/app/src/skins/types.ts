import type { SkinId } from "@openbot/shared/user-preferences";
import type { ComponentType, ReactNode } from "react";

/*
 * The ids live in `shared/` because the choice is saved on the person's account and the server
 * checks it. They are re-exported here so a skin reads them from beside its own type.
 */
export {
  DEFAULT_SKIN,
  normalizeSkinId,
  SKIN_IDS,
  type SkinId,
} from "@openbot/shared/user-preferences";

export type Skin = {
  id: SkinId;
  /** The product name this skin presents as, shown in the picker and inside its own frame. */
  name: string;
  /** One line for the picker. */
  description: string;
  /**
   * Replaces OpenBot's sidebar frame around every page under `/_authed/_app`. It must render
   * `children` (the page) and must give the person a way to reach Settings, so a skin can always
   * be switched back. Absent, the page keeps OpenBot's own frame.
   */
  Frame?: ComponentType<{ children: ReactNode }>;
  /**
   * Whether `Frame` also goes around Settings and Admin, which otherwise keep the app's own shells
   * whatever the skin. Only the default skin's workbench asks for it: its rail has to stay on screen
   * when 「我 › 设置」 or 工作台's 管理 is opened.
   */
  frameCoversSettings?: boolean;
  /**
   * How this skin draws a Bot: as its orb, with the orb, name and role at the top of a conversation,
   * or as the generated face. Absent, a face.
   */
  botLook?: "orb" | "face";
  /**
   * Screens only this skin has, served at `/s/<key>`. They draw OpenBot's existing data; a skin
   * adds no endpoint. A key the active skin does not have goes home.
   */
  screens?: Record<string, ComponentType>;
};

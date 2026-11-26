/**
 * The generative-interface catalog's id. Kept apart from a2ui.ts, which loads the agent SDK's
 * generative-UI module, so that what needs only the id does not pull that module (and its optional
 * peers) in with it.
 */

/** The catalog's id, stamped by the runtime on every interface it draws (see `XIONGBAO_UI`). */
export const XIONGBAO_UI_ID = "xiongbao/ui@1";

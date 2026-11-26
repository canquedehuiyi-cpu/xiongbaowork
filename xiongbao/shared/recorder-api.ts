/*
 * The shapes of the retained recorder tables' columns (server/src/db/schema/recorder.ts). The browser Recorder these
 * tables served is gone, and the tables stay until a later phase drops them; nothing here reads or writes them now.
 */

/** How a browser was connected: `web`, `desktop`, XiongBao's own browser (the third value), or a Bot's browser for
 * one recording (`bot-browser`). Rows stored before v0.2.16 spell the third value with the product's earlier name;
 * nothing reads them, and the tables go in a later phase. */
export type RecorderConnectVia =
  | "web"
  | "desktop"
  | "xiongbao-browser"
  | "bot-browser";

/** What a connected Recorder last said it was doing (`recorder_connections.activity`). */
export type RecorderActivity = {
  phase: "idle" | "starting" | "recording" | "stopping";
  recordingId?: string;
  title?: string;
  startedAt?: number;
  actions: number;
};

import { z } from "zod";

/**
 * THE BAR OVER A BROWSER XIONGBAO SHOWS: its tabs and the tab in front's address, back, forward and reload. A Bot's
 * browser has it (`shared/bot-browser.ts`), worked by the person holding the Bot's wheel. This file is the part of that
 * contract the computer (`agent-computer`), the server and the app share for the tabs and the address.
 */

/**
 * Where a browser shows. `native`: a window on the person's own desktop (local Chrome). `screen`: a browser on a
 * computer the app shows through the live screen.
 */
export type BrowserWindow = "native" | "screen";

export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  active: boolean;
};

/** A browser's tabs as the computer reports them: none while it is closed. */
export type BrowserState = {
  open: boolean;
  tabs: BrowserTab[];
};

export const browserTabsRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("new"), url: z.string().max(2000).optional() })
    .strict(),
  z
    .object({ action: z.literal("activate"), tabId: z.string().min(1) })
    .strict(),
  z.object({ action: z.literal("close"), tabId: z.string().min(1) }).strict(),
]);
export type BrowserTabsRequest = z.infer<typeof browserTabsRequestSchema>;

export const browserNavigateRequestSchema = z.union([
  z.object({ url: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.enum(["back", "forward", "reload"]) }).strict(),
]);
export type BrowserNavigateRequest = z.infer<
  typeof browserNavigateRequestSchema
>;

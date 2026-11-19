import type { ReactNode } from "react";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { AppSidebar } from "./app-sidebar";

/**
 * The app's frame: the sidebar (conversations, the destinations and the account menu, upstream's
 * shape) and the main area.
 *
 * `secondary` is a column a shell draws between the two: settings passes its own navigation, so a
 * settings page keeps the app sidebar and gains a second column rather than swapping the whole frame
 * for another one. The app's own pages pass the conversation workspace (`_app.tsx`), which draws a
 * column only beside a conversation.
 *
 * The sidebar is flat on 熊宝's sidebar token rather than upstream's inset panel, 300px before anybody
 * drags its edge: wide enough for a two-line conversation row with its faces.
 */
export function AppShell({
  children,
  secondary,
}: {
  children: ReactNode;
  /** A column drawn between the sidebar and the main area. */
  secondary?: ReactNode;
}) {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" name="app" width="300px">
      <AppSidebar />
      {secondary ?? null}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Only inside OpenBot Desktop: the banner asks the desktop app, and draws nothing in a browser. */}
        <UpdateBanner />
        <SelfHostBanner />
        {children}
      </main>
    </SidebarShell>
  );
}

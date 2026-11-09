import type { ReactNode } from "react";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { AppSidebar } from "./app-sidebar";
import { ConversationWorkspace } from "./conversation-workspace";

/**
 * The app's frame: the 240px sidebar, an optional middle column, and the main area.
 *
 * The middle column is the conversation workspace on conversation routes, or whatever `secondary` a
 * shell passes in its place — settings passes its own navigation, so a settings page keeps the app
 * sidebar and gains a second column rather than swapping the whole frame for another one.
 */
export function AppShell({
  children,
  secondary,
}: {
  children: ReactNode;
  /** A column drawn between the sidebar and the main area instead of the conversation workspace. */
  secondary?: ReactNode;
}) {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" width="226px">
      <AppSidebar />
      {secondary ?? <ConversationWorkspace />}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <SelfHostBanner />
        {children}
      </main>
    </SidebarShell>
  );
}

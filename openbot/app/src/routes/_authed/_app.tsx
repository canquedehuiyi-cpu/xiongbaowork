import { createFileRoute, Outlet } from "@tanstack/react-router";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { AppShell } from "@/components/app-sidebar/app-shell";
=======
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { SidebarInset } from "@/components/ui/sidebar";
import { useActiveSkin } from "@/skins/registry";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  const { Frame } = useActiveSkin();

  if (Frame) {
    return (
      <Frame>
        <Outlet />
      </Frame>
    );
  }

  return (
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    <AppShell>
      <Outlet />
    </AppShell>
=======
    /*
     * The content sits in a panel inset from the window, on the sidebar's tint, so the sidebar and
     * the window's edge read as one frame and the page as the thing inside it. Before, the sidebar,
     * the page and the cards on it were three near-identical whites told apart only by hairlines.
     *
     * One viewport, never scrolls: panes scroll inside the panel, which is also what keeps its
     * rounded corners on screen. A growable shell lets the transcript's scroller size against the
     * page, grow it, and grow again. Admin and settings use the same panel.
     */
    <SidebarShell className="h-svh overflow-hidden" name="app" width="340px">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <UpdateBanner />
        <SelfHostBanner />
        <Outlet />
      </SidebarInset>
    </SidebarShell>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  );
}

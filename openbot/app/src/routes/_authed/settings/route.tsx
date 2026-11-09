import { createFileRoute, Outlet } from "@tanstack/react-router";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { AppShell } from "@/components/app-sidebar/app-shell";
import { SettingsNav } from "@/components/settings/settings-sidebar";
=======
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

/*
 * Settings inside the app shell (description (7) of the parity brief): the app sidebar stays, and
 * settings' own navigation is the second column. The pages keep their `PageShell`, whose own
 * scroller fits the shell's one-viewport frame.
 */
function RouteComponent() {
  return (
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    <AppShell secondary={<SettingsNav />}>
      <Outlet />
    </AppShell>
=======
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell
      className="h-svh overflow-hidden"
      name="settings"
      width="300px"
    >
      <SettingsSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  );
}

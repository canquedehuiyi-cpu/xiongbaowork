import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-sidebar/app-shell";
import { SettingsNav } from "@/components/settings/settings-sidebar";

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
    <AppShell secondary={<SettingsNav />}>
      <Outlet />
    </AppShell>
  );
}

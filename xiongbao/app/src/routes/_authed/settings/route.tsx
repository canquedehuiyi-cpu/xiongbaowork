import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-sidebar/app-shell";
import { SettingsNav } from "@/components/settings/settings-sidebar";
import { useActiveSkin } from "@/skins/registry";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

/*
 * Settings inside the app shell (description (7) of the parity brief): the app sidebar stays, and
 * settings' own navigation is the second column. The pages keep their `PageShell`, whose own
 * scroller fits the shell's one-viewport frame.
 */
function RouteComponent() {
  const { Frame, frameCoversSettings } = useActiveSkin();
  /*
   * The default skin's workbench keeps its frame on Settings too (`frameCoversSettings`), so the
   * rail stays and 我 stays lit; settings' navigation becomes a column inside the frame's main area.
   * Every other skin, 经典 included, keeps the app shell here exactly as before.
   */
  if (Frame && frameCoversSettings) {
    return (
      <Frame>
        <div className="flex min-h-0 min-w-0 flex-1">
          <SettingsNav />
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </div>
      </Frame>
    );
  }
  return (
    <AppShell secondary={<SettingsNav />}>
      <Outlet />
    </AppShell>
  );
}

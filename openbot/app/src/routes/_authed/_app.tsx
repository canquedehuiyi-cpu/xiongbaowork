import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-sidebar/app-shell";
import { useActiveSkin } from "@/skins/registry";

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

  // The desktop update bar (upstream's `UpdateBanner` at this level) is drawn inside AppShell, above
  // its SelfHostBanner, so settings, which share the shell, show it too.
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

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

  // M4: 待接入 上游在这一层加了桌面端更新提示（components/layout/update-banner.tsx 的 UpdateBanner），fork 的 AppShell 只有 SelfHostBanner
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

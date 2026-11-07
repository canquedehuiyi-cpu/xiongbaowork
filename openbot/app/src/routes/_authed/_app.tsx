import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-sidebar/app-shell";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

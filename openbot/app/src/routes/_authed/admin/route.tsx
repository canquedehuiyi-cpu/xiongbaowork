import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminNav, AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { personalAdminRedirect } from "@/lib/manage-paths";
import { useActiveSkin } from "@/skins/registry";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context, location }) => {
    /*
     * The personal edition has no Admin. An old address opens the same page under Settings, or
     * Settings itself, never an empty page.
     */
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (capabilities?.edition === "personal") {
      throw redirect({
        href: personalAdminRedirect(location.pathname),
        replace: true,
      });
    }
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { Frame, frameCoversSettings } = useActiveSkin();
  /*
   * The default skin's workbench keeps its frame on Admin too (`frameCoversSettings`), so the rail
   * stays and 工作台 stays lit; Admin's navigation becomes a column inside the frame's main area.
   * Every other skin keeps Admin's own sidebar shell, unchanged.
   */
  if (Frame && frameCoversSettings) {
    return (
      <Frame>
        <div className="flex min-h-0 min-w-0 flex-1">
          <AdminNav />
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </div>
      </Frame>
    );
  }
  return (
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell className="h-svh overflow-hidden" name="admin" width="300px">
      <AdminSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  );
}

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context }) => {
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
  return (
    <SidebarShell width="300px">
      <AdminSidebar />
      {/*
       * `min-w-0`: a flex item will not shrink below its content by default, so a wide table (the
       * audit log) used to stretch the whole pane past a phone's width instead of scrolling inside
       * its own panel.
       */}
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </SidebarShell>
  );
}

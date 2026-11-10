import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/permissions")({
  component: PermissionsPage,
});

/** Admin, Permissions: what people may do with Bots, for everybody and per role or group. */
export function PermissionsPage() {
  return (
    <PageShell
      description="每个开关都对所有人生效。角色可以覆盖它，目录分组也可以拿到组织关掉的权限。所有改动都会记入审计。"
      title="权限"
    >
      <CapabilitiesSection />
    </PageShell>
  );
}

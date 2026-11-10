import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SetupChecklist } from "@/components/setup/setup-checklist";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { mayOpenSetup } from "@/lib/setup/queries";

/**
 * Settings → Setup: the setup checklist, where an admin checks what OpenBot has and still needs. Its
 * fixes say "set this, then restart OpenBot", so this is where they come back to check again.
 *
 * For an admin, and for the one person running OpenBot on their own machine. A member is sent to
 * General: they can't change any of it, and their admin sets it up.
 */
export const Route = createFileRoute("/_authed/settings/setup")({
  beforeLoad: async ({ context }) => {
    const [user, capabilities] = await Promise.all([
      context.queryClient.ensureQueryData(currentUserQueryOptions()),
      // A failed read means no local install is known of, so the role alone decides.
      context.queryClient
        .ensureQueryData(deploymentCapabilitiesQueryOptions())
        .catch(() => undefined),
    ]);
    if (!mayOpenSetup(user, capabilities)) throw redirect({ to: "/settings" });
  },
  component: SetupSettingsPage,
});

function SetupSettingsPage() {
  const navigate = useNavigate();
  return (
    <PageShell
      description="看看哪些已经就绪、哪些还要设置。改完设置并重启后，回到这里再检查一遍。"
      title="部署设置"
    >
      <SetupChecklist openPage={(target) => navigate({ to: target.path })} />
    </PageShell>
  );
}

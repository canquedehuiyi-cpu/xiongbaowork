import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * 角色模板现在是能力 › 角色模板（`/capabilities/roles`，M5b）。原页面剪到了
 * `components/roles/role-templates-page.tsx`。
 */
export const Route = createFileRoute("/_authed/_app/role-templates")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/role-templates"], replace: true });
  },
});

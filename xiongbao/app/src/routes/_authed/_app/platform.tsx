import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * 平台管理搬进了管理（`/admin/platform`，M5b）。原页面剪到了 `components/platform/platform-page.tsx`。
 */
export const Route = createFileRoute("/_authed/_app/platform")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/platform"], replace: true });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";
import { wakersSearchFromAgents } from "@/components/wakers/wakers-search";

/**
 * 员工列表, archived into 员工管理 (`/wakers`): the two pages listed the same employees, so the
 * create dialog (`?new=true`) and the edit dialog (`?agent=<id>`) now open on `/wakers` under the
 * same parameters, and each card there carries what this roster used to say (已置顶, 共享给你,
 * 已隐藏) and its own 编辑.
 *
 * The file stays so the address keeps resolving: bookmarks, links in old conversations (a Bot was
 * told a new employee's profile is at `/agents?agent=<id>`) and anything else that still points
 * here are redirected with their meaning intact. `replace`, so Back does not land on the redirect
 * and bounce forward again.
 */
export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: (search: Record<string, unknown>) =>
    wakersSearchFromAgents(search),
  beforeLoad: ({ search }) => {
    throw redirect({ replace: true, search, to: "/wakers" });
  },
});

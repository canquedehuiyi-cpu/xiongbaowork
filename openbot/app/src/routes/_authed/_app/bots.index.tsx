import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Bot 会话, archived into 员工管理 (`/wakers`): this page listed the same employees as the wall, each
 * with what it needs from the person. That summary is now on each card there (from the same
 * `GET /api/bots/attention` read the sidebar already makes), and each card links to the employee's
 * own `/bots/$agentId` profile, which stays where it was.
 *
 * The file stays so `/bots` keeps resolving for bookmarks and old links. It carried no parameters,
 * so the wall opens unfiltered. `replace`, so Back does not bounce through the redirect.
 */
export const Route = createFileRoute("/_authed/_app/bots/")({
  beforeLoad: () => {
    throw redirect({ replace: true, search: {}, to: "/wakers" });
  },
});

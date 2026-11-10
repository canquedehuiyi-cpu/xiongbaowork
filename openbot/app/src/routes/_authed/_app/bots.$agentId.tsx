import { createFileRoute, redirect } from "@tanstack/react-router";

/*
 * Archived (user decision: 合并成一个详情页). The employee's profile — 对你, activity, tool
 * permissions, update routing — now lives on its one detail page under 员工管理. The path stays so
 * bookmarks, notifications and links in old messages still arrive; `replace` keeps Back from
 * bouncing through it.
 *
 * Only `/bots/$agentId` itself is sent on. This route is also the parent of the pages kept under it
 * (`/bots/$agentId/activity`, where the employee page's 动态 row opens), and a parent's
 * `beforeLoad` runs for its children too: redirecting on every match sent the activity page back to
 * the employee page it was opened from.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  beforeLoad: ({ matches, params, routeId }) => {
    if (matches.at(-1)?.routeId !== routeId) return;
    throw redirect({
      to: "/wakers/$agentId",
      params: { agentId: params.agentId },
      replace: true,
    });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

/*
 * Archived (user decision: 合并成一个详情页). The employee's profile — 对你, activity, tool
 * permissions, update routing — now lives on its one detail page under 员工管理. The path stays so
 * bookmarks, notifications and links in old messages still arrive; `replace` keeps Back from
 * bouncing through it.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/wakers/$agentId",
      params: { agentId: params.agentId },
      replace: true,
    });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyAssembleTarget } from "@/lib/agents/legacy-routes";

/**
 * 装配（`/assemble/$agentId`）搬进了员工的「设置」分页（`/bots/$agentId/setup`，M5b）。原页面剪到了
 * `components/bot-profile/assemble.tsx`。
 *
 * 地址保留成重定向，旧链接仍然能到。
 */
export const Route = createFileRoute("/_authed/_app/assemble/$agentId")({
  beforeLoad: ({ params }) => {
    throw redirect(legacyAssembleTarget(params.agentId));
  },
});

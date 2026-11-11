import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyWakerTarget } from "@/lib/agents/legacy-routes";

/**
 * 员工详情（`/wakers/$agentId`）搬进了上游的员工页（`/bots/$agentId` 及其分页，M5b）。原来一页里的各段剪到了
 * `components/bot-profile/waker-detail-sections.tsx`，由各分页接过去。
 *
 * 地址保留成重定向，书签、通知和旧消息里的链接仍然能到。
 */
export const Route = createFileRoute("/_authed/_app/wakers_/$agentId")({
  beforeLoad: ({ params }) => {
    throw redirect(legacyWakerTarget(params.agentId));
  },
});

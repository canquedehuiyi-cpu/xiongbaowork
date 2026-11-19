import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * `/memory` 早先并进了能力与资源 › 信息源与记忆，现在是能力 › 记忆（M5b，与上游一致）。没有地址参数可带。
 */
export const Route = createFileRoute("/_authed/_app/memory")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/memory"], replace: true });
  },
});

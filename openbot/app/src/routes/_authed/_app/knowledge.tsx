import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/**
 * `/knowledge` 早先并进了能力与资源 › 知识库，现在是能力 › 知识库（M5b）。没有地址参数可带。
 */
export const Route = createFileRoute("/_authed/_app/knowledge")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/knowledge"], replace: true });
  },
});

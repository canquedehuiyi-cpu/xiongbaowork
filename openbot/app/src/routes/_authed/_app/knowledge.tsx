import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/knowledge` was archived into 能力与资源 › 知识库: the screen that was here — create a knowledge
 * base, keep 资料 in it, decide which employees may read it — is that tab now
 * (`components/knowledge/knowledge-screen.tsx`).
 *
 * The path stays so bookmarks and older links keep working. It took no search parameters, so there
 * is nothing to carry over. Replace, not push, so Back does not land here again only to be sent
 * forward.
 */
export const Route = createFileRoute("/_authed/_app/knowledge")({
  beforeLoad: () => {
    throw redirect({
      to: "/resources",
      search: { tab: "knowledge" },
      replace: true,
    });
  },
});

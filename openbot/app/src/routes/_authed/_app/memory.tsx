import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/memory` was archived into 能力与资源 › 信息源与记忆: the screen that was here — the connected
 * apps' sources, what employees remember, and the background research with its suggestions — is
 * that tab now (`components/memory/memory-screen.tsx`).
 *
 * The path stays so bookmarks and older links keep working. It took no search parameters, so there
 * is nothing to carry over. Replace, not push, so Back does not land here again only to be sent
 * forward.
 */
export const Route = createFileRoute("/_authed/_app/memory")({
  beforeLoad: () => {
    throw redirect({
      to: "/resources",
      search: { tab: "sources" },
      replace: true,
    });
  },
});

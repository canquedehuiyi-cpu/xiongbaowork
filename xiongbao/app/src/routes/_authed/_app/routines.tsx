import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * 定时任务, archived into 自主工作 (`/autonomous`): every row this page listed, with its switch, its
 * 立即运行 and its delete, is a row of the unified list there, and the warning this page gave when
 * no runner is executing schedules is said there too. So `/routines` opens that list narrowed to the
 * schedule trigger (`?trigger=schedule`, parsed by `autonomousSearch`), which is the question this
 * page answered.
 *
 * A routine's wording is still changed in conversation, not in a form. A coworker's own routines,
 * with each one's full run history, remain on its own page (`/bots/$agentId/routines`).
 *
 * The file stays so the address keeps resolving for bookmarks and old links. `replace`, so Back does
 * not bounce through the redirect.
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  beforeLoad: () => {
    throw redirect({
      replace: true,
      search: { trigger: "schedule" },
      to: "/autonomous",
    });
  },
});

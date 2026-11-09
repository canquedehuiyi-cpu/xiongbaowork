import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * 定时任务, archived into 自主工作 (`/autonomous`): every row this page listed, with its switch, its
 * 立即运行 and its delete, is a row of the unified list there, and the warning this page gave when
 * no runner is executing schedules is said there too. So `/routines` opens that list narrowed to the
 * schedule trigger (`?trigger=schedule`, parsed by `autonomousSearch`), which is the question this
 * page answered.
 *
 * A routine's wording is still changed in conversation, not in a form. A coworker's own routines,
 * with each one's full run history, remain on its assembly screen (`/assemble/$agentId`).
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======

function RoutinesPage() {
  return (
    <PageShell
      description="Ask a Bot to create or change a scheduled routine. You can review and stop routines here."
      title="Routines"
    >
      <RoutinesList />
    </PageShell>
  );
}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

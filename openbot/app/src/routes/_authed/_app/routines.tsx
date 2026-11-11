<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
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
=======
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * Every routine the person has, across all their Bots: one place to find scheduled work and to set
 * some up, as the Scheduled section of other assistants is. In the sidebar beside Bots and
 * Connections.
 *
 * `_authed/_app`, not Admin: a routine is something anybody has, the same way a skill is. It is
 * scoped to the signed-in person on every read and write, not to the deployment.
 *
 * New routine opens its own screen (`routines_.new.tsx`) with a picker of common schedules. Asking
 * a Bot in a conversation still works for anything the picker does not cover, and changing a
 * routine stays conversational: this page has no edit form.
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d
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
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
=======

function RoutinesPage() {
  return (
    <PageShell
      action={<NewRoutineButton />}
      description="Bots do work for you on a schedule and post what they did. Set one up here, or ask a Bot something like “every weekday at 9, send me…”."
      title="Routines"
    >
      <RoutinesList />
    </PageShell>
  );
}
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d

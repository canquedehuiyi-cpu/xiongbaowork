import { createFileRoute, redirect } from "@tanstack/react-router";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371

/**
 * `/skills` was archived into 能力与资源 › 技能: the screen that was here — your own skills with
 * their edit and delete menu, the deployment's, and the authoring panel — is that tab now
 * (`components/skills/skills-screen.tsx`).
 *
 * The path stays so bookmarks and older links keep working, and it keeps its meaning: its search
 * parameters are carried over, so `/skills?new=true` still opens the authoring form and
 * `/skills?edit=<slug>` still opens that skill. Replace, not push, so Back does not land here again
 * only to be sent forward.
 */
export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: (search: Record<string, unknown>) => {
    // A numeric slug arrives as a number: the default search parser reads `?edit=42` as JSON.
    const edit =
      typeof search.edit === "number" ? String(search.edit) : search.edit;
    return {
      ...(search.new === true || search.new === "true"
        ? { new: true as const }
        : {}),
      ...(typeof edit === "string" && edit ? { edit } : {}),
    } as { new?: true; edit?: string };
  },
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/resources",
      search: {
        tab: "skills",
        ...(search.new ? { new: true as const } : {}),
        ...(search.edit ? { edit: search.edit } : {}),
      },
      replace: true,
    });
=======
import { z } from "zod";

/**
 * `/skills` moved under Capabilities. Kept as a redirect because a skill proposed in a conversation links
 * to it, and those messages stay in people's history. The panel's `new` and `edit` travel with it.
 */
export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    edit: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/capabilities/skills", search, replace: true });
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  },
});

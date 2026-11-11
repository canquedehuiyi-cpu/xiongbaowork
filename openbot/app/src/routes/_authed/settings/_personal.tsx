import { createFileRoute, Outlet } from "@tanstack/react-router";
import { personalOnly } from "@/lib/edition-guard";

/**
 * What the personal edition keeps of Admin: the plugins, skills, credentials, computer and activity
 * pages, under Settings because there is no Admin to hold them.
 *
 * Pathless, so it adds a guard and no segment. The team edition has these pages under Admin and
 * nowhere else, so an address here sends it back to Settings; so does a deployment whose edition
 * could not be read, which is the team edition's answer too (`personalOnly` reads it that way).
 */
export const Route = createFileRoute("/_authed/settings/_personal")({
  beforeLoad: personalOnly("/settings"),
  component: Outlet,
});

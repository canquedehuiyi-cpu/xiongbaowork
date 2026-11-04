/*
 * Story RES2, phase 1: the two dormant project tables of 0104 become live (spec
 * 2026-11-04-res2-resource-projects §3.1, decision D1, option R-A).
 *
 *  - `resource_projects`: a project on one paired machine. `public` is offered to every coworker of
 *    the tenant on that machine; `agent` only to the one coworker it names.
 *  - `project_context_bindings`: the project one coworker is currently working in on one machine,
 *    one row per (tenant, device, coworker).
 *
 * NOTHING OF 0104 OR 0122 IS CHANGED. The tables' columns, indexes, foreign keys, CHECKs and their
 * owner and Team Bot policies are pinned byte for byte (`resource-project-foundations.ts`, by length
 * and sha256, and `recovery-resource-project-foundations.test.ts`) and stay exactly as they are. This
 * migration only adds, as decision D1 allows:
 *
 *  - FORCE ROW LEVEL SECURITY, which every live tenant table has and these two lacked, so the table
 *    owner is bound too.
 *  - The platform frame's read, as one `platform_scope_select` policy on each (permissive policies
 *    add up, so the old ones keep meaning what they meant). Read only: nothing in the platform frame
 *    writes a project, so no write branch is opened.
 *  - `resource_projects_source_check`: `source` is exactly one of the two shapes of
 *    `shared/projects.ts`, with no other key. A local project names the runner's opaque folder
 *    reference, never a path; a Git project names an `https://`, `ssh://` or `user@host:path`
 *    address with no password or token in it, a branch name `git` would accept, and, after a sync,
 *    the clone's reference and commit. The whole expression is wrapped in COALESCE because a CHECK
 *    that evaluates to NULL passes, and a missing key reads as NULL.
 *  - An explicit GRANT to the application role, beside the schema's default privileges (0054).
 */
ALTER TABLE "public"."resource_projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."project_context_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."resource_projects" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."project_context_bindings" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
ALTER TABLE "public"."resource_projects" ADD CONSTRAINT "resource_projects_source_check" CHECK (COALESCE(
  jsonb_typeof("source") = 'object'
  AND jsonb_typeof("source"->'writable') = 'boolean'
  AND (
    (
      "source"->>'kind' = 'local'
      AND ("source" - ARRAY['kind', 'rootRef', 'label', 'writable']) = '{}'::jsonb
      AND jsonb_typeof("source"->'rootRef') = 'string'
      AND ("source"->>'rootRef') ~ '^fld_[A-Za-z0-9_-]{22}$'
      AND jsonb_typeof("source"->'label') = 'string'
      AND char_length("source"->>'label') BETWEEN 1 AND 60
    )
    OR (
      "source"->>'kind' = 'git'
      AND ("source" - ARRAY['kind', 'url', 'branch', 'rootRef', 'writable', 'syncedAt', 'commit']) = '{}'::jsonb
      AND jsonb_typeof("source"->'url') = 'string'
      AND char_length("source"->>'url') BETWEEN 1 AND 500
      AND ("source"->>'url') !~ '[[:space:][:cntrl:]]'
      AND position('::' in ("source"->>'url')) = 0
      AND (
        ("source"->>'url') ~* '^https://[^/@:\[\]-][^/@:\[\]]*(:[0-9]+)?/.+'
        OR ("source"->>'url') ~* '^ssh://([A-Za-z0-9._][A-Za-z0-9._-]*@)?[^/@:\[\]-][^/@:\[\]]*(:[0-9]+)?/.+'
        OR ("source"->>'url') ~ '^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9.][A-Za-z0-9.-]*:[^-].*'
      )
      AND jsonb_typeof("source"->'branch') = 'string'
      AND ("source"->>'branch') ~ '^[A-Za-z0-9._/-]{1,200}$'
      AND ("source"->>'branch') !~ '(^[-/.])|([/.]$)|(\.\.)|(//)|(/\.)|(\.lock$)|(\.lock/)'
      AND ("source"->>'branch') NOT IN ('HEAD', '@')
      AND jsonb_typeof("source"->'rootRef') IN ('null', 'string')
      AND (jsonb_typeof("source"->'rootRef') = 'null' OR ("source"->>'rootRef') ~ '^fld_[A-Za-z0-9_-]{22}$')
      AND jsonb_typeof("source"->'syncedAt') IN ('null', 'string')
      AND jsonb_typeof("source"->'commit') IN ('null', 'string')
      AND (jsonb_typeof("source"->'commit') = 'null' OR ("source"->>'commit') ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
    )
  ),
  false
));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."resource_projects" TO openbot_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."project_context_bindings" TO openbot_app;

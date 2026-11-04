/*
 * Story WF8, phase 3: every saved version of a WakerFlow's plan, and rollback (spec
 * 2026-11-04-wf8-flow-inputs-confirm-events-versions §3.6, option V-A, D8, D9).
 *
 * WHAT A ROW IS. One Save of a `json-plan-v1` Flow: the whole plan as it was saved (members,
 * inputs, steps, name, description), the planning model it was saved with, the template Save
 * compiled it into, who saved it and when. `revision` is the Flow's revision AFTER that Save, the
 * number the editor shows. A group template keeps only the steps, so it cannot say what a version
 * was; this table can, and a rollback is "save that plan again" (a new revision, a new template),
 * never an edit of history. `flow_source_versions` is the JS-source mode's table under the
 * activation contract and is not used for this.
 *
 * APPEND-ONLY. A version is a fact about the past: the application role is granted SELECT and
 * INSERT only (the schema's default privileges would also give it UPDATE and DELETE, so those are
 * revoked here), and the UPDATE and DELETE policies admit nothing, as 0108 does for `flow_source_*`.
 * Removing a Flow is a soft delete, which hides its versions with it (D9); nothing is cleaned up.
 * The foreign key cascades only when a Flow row itself is removed, which the product never does.
 *
 * ROW SECURITY. The owner's frame reads its own rows and the platform frame reads every row, the two
 * scopes every tenant table has had since 0072. An insert names a Flow of the inserting tenant, read
 * through the Flow's own row security (a foreign key does not look through it), like 0084. FORCE
 * binds the owner of the table too.
 *
 * BACKFILL. A Flow saved before this migration has no history to recover: it gets exactly one row,
 * its current version, read from `waker_flows`. No earlier version is invented. The statement runs
 * as `platform` (FORCE binds the migrator), set locally and cleared at the end, like 0129 and 0130.
 */
CREATE TABLE "public"."waker_flow_versions" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "flow_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "plan" jsonb NOT NULL,
  "model_ref" uuid,
  "template_id" uuid,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "waker_flow_versions_pkey" PRIMARY KEY ("tenant_id", "flow_id", "revision"),
  CONSTRAINT "waker_flow_versions_flow_id_waker_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."waker_flows"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "waker_flow_versions_revision_positive" CHECK ("revision" >= 1),
  CONSTRAINT "waker_flow_versions_plan_object" CHECK (jsonb_typeof("plan") = 'object')
);
--> statement-breakpoint
CREATE INDEX "waker_flow_versions_flow_idx" ON "public"."waker_flow_versions" ("flow_id", "revision" DESC);
--> statement-breakpoint
ALTER TABLE "public"."waker_flow_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."waker_flow_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."waker_flow_versions" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."waker_flow_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "waker_flow_versions"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true))) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."waker_flow_versions" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."waker_flow_versions" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
GRANT SELECT, INSERT ON "public"."waker_flow_versions" TO openbot_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."waker_flow_versions" FROM openbot_app;
--> statement-breakpoint
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
INSERT INTO public.waker_flow_versions (tenant_id, flow_id, revision, plan, model_ref, template_id, created_by, created_at)
SELECT f.tenant_id, f.id, f.revision, f.plan, f.model_ref, f.template_id, NULL, f.updated_at
  FROM public.waker_flows f
 WHERE f.definition_mode = 'json-plan-v1'
   AND f.plan IS NOT NULL
   AND f.group_id IS NOT NULL
   AND f.template_id IS NOT NULL
   AND f.revision >= 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);

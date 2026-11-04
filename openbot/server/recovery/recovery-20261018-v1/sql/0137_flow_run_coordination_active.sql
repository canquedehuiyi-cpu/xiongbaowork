/*
 * Story WF8, phase 5: the three dormant run-coordination tables of 0088 become live (spec
 * 2026-11-04-wf8-flow-inputs-confirm-events-versions §3.3-§3.5 and §3.7, decision D1).
 *
 *  - `flow_run_events`: every state change of a WakerFlow run, written in the same transaction as
 *    the change itself (the pipeline's `writeRun`), so a change that did not happen leaves no event.
 *  - `flow_confirmations`: a Flow step that stopped on a question, and the person's answer or skip.
 *  - `flow_run_retries`: a retry of a failed run from its failed step (written from phase 6 on).
 *
 * NOTHING OF 0088 IS CHANGED. The tables' columns, indexes, foreign keys and their four tenant
 * policies are pinned by `tests/recovery-flow-run-coordination.test.ts` and stay exactly as they
 * are. This migration only adds, as §3.7 allows:
 *
 *  - FORCE ROW LEVEL SECURITY, which every live tenant table has and these three lacked, so the
 *    table owner is bound too.
 *  - The platform scope every tenant table has had since 0072, as four new `platform_scope_*`
 *    policies beside the old ones (permissive policies add up, so the old ones keep meaning what they
 *    meant).
 *  - A restrictive insert check on each table that the run it names is a run of the Flow it names, in
 *    the inserting tenant: a foreign key does not look through row security, so without it a row
 *    could point at another workspace's run. The platform frame is exempt, as in every sibling.
 *  - CHECKs the live code relies on: an answered confirmation has an answer and only an answered one
 *    does; a question and an inputs snapshot are JSON objects; an event's type is one of the kinds
 *    the code writes and its payload a JSON object.
 *  - USAGE on the event sequence for the application role. The schema's default privileges grant
 *    tables, not sequences, and `sequence` is a bigserial, so without it no event could be written.
 */
ALTER TABLE "public"."flow_confirmations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."flow_run_retries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_confirmations" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_confirmations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_confirmations" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_confirmations" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_run_events" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_run_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_run_events" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_run_events" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_run_retries" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_run_retries" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_run_retries" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_run_retries" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "own_flow_run_insert" ON "public"."flow_confirmations" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.group_task_runs AS owned_run WHERE owned_run.id = "flow_confirmations"."run_id" AND owned_run.flow_id = "flow_confirmations"."flow_id" AND owned_run.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_run_insert" ON "public"."flow_run_events" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.group_task_runs AS owned_run WHERE owned_run.id = "flow_run_events"."run_id" AND owned_run.flow_id = "flow_run_events"."flow_id" AND owned_run.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_run_insert" ON "public"."flow_run_retries" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.group_task_runs AS owned_run WHERE owned_run.id = "flow_run_retries"."source_run_id" AND owned_run.flow_id = "flow_run_retries"."flow_id" AND owned_run.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
ALTER TABLE "public"."flow_confirmations" ADD CONSTRAINT "flow_confirmation_answer_check" CHECK (("status" = 'answered') = ("answer" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "public"."flow_confirmations" ADD CONSTRAINT "flow_confirmation_json_check" CHECK (jsonb_typeof("question") = 'object' AND jsonb_typeof("inputs") = 'object');
--> statement-breakpoint
ALTER TABLE "public"."flow_run_events" ADD CONSTRAINT "flow_run_events_type_check" CHECK ("type" IN ('run_started','step_started','step_done','step_parked','step_answered','step_skipped','step_failed','run_done','run_failed','run_aborted','run_retried','branch_taken'));
--> statement-breakpoint
ALTER TABLE "public"."flow_run_events" ADD CONSTRAINT "flow_run_events_payload_check" CHECK (jsonb_typeof("payload") = 'object');
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "public"."flow_run_events_sequence_seq" TO openbot_app;

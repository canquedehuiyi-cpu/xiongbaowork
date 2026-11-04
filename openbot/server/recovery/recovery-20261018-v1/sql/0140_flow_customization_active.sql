/*
 * Story WF9, phase 1: the three dormant customization tables of 0091 and 0093 become live (spec
 * 2026-11-04-wf9-flow-sessions-sharing §3.1, decisions D2 and D3, option S-A).
 *
 *  - `flow_customization_sessions`: one person's conversation about changing one Flow.
 *  - `flow_customization_heads`: the session a Flow's page opens on, one row per (tenant, Flow).
 *  - `flow_customization_turns`: one change request of a session, written in the same transaction
 *    that claims its planning request (`waker_flow_requests`, kind `customize`, same request id),
 *    which is where its outcome lives.
 *
 * NOTHING OF 0091 OR 0093 IS CHANGED. The tables' columns, indexes, foreign keys and their four
 * tenant policies are pinned by `tests/recovery-flow-customization-foundations.test.ts` and
 * `tests/recovery-flow-customization-turns.test.ts` and stay exactly as they are. This migration
 * only adds, as decision D2 allows:
 *
 *  - FORCE ROW LEVEL SECURITY, which every live tenant table has and these three lacked, so the
 *    table owner is bound too.
 *  - The platform scope every tenant table has had since 0072, as four new `platform_scope_*`
 *    policies beside the old ones (permissive policies add up, so the old ones keep meaning what they
 *    meant).
 *  - Restrictive checks on insert and update that what a row points at is the writing tenant's own: a
 *    session's Flow, a head's Flow and session (of that same Flow), a turn's session (of that same
 *    Flow). A foreign key does not look through row security, so without them a row could point at
 *    another workspace's Flow or session. The platform frame is exempt, as in every sibling.
 *  - CHECKs the live code relies on: a session's title is 1 to 80 characters and its description at
 *    most 500, its revision is not negative; a turn's change request is 1 to 4000 characters, its
 *    context at most 20000 (D3) and its coworker snapshot a JSON array.
 *  - An explicit GRANT to the application role, beside the schema's default privileges.
 */
ALTER TABLE "public"."flow_customization_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_turns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_customization_sessions" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_customization_heads" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_customization_heads" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_customization_heads" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_customization_heads" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_customization_turns" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_customization_turns" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_customization_turns" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_customization_turns" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "own_flow_session_insert" ON "public"."flow_customization_sessions" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_customization_sessions"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_session_update" ON "public"."flow_customization_sessions" AS RESTRICTIVE FOR UPDATE TO public USING (true) WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_customization_sessions"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_head_insert" ON "public"."flow_customization_heads" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR (EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_customization_heads"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)) AND ("flow_customization_heads"."session_id" IS NULL OR EXISTS (SELECT 1 FROM public.flow_customization_sessions AS owned_session WHERE owned_session.id = "flow_customization_heads"."session_id" AND owned_session.flow_id = "flow_customization_heads"."flow_id" AND owned_session.tenant_id = current_setting('app.tenant_id', true)))));
--> statement-breakpoint
CREATE POLICY "own_flow_head_update" ON "public"."flow_customization_heads" AS RESTRICTIVE FOR UPDATE TO public USING (true) WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR (EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_customization_heads"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)) AND ("flow_customization_heads"."session_id" IS NULL OR EXISTS (SELECT 1 FROM public.flow_customization_sessions AS owned_session WHERE owned_session.id = "flow_customization_heads"."session_id" AND owned_session.flow_id = "flow_customization_heads"."flow_id" AND owned_session.tenant_id = current_setting('app.tenant_id', true)))));
--> statement-breakpoint
CREATE POLICY "own_flow_turn_insert" ON "public"."flow_customization_turns" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.flow_customization_sessions AS owned_session WHERE owned_session.id = "flow_customization_turns"."session_id" AND owned_session.flow_id = "flow_customization_turns"."flow_id" AND owned_session.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_turn_update" ON "public"."flow_customization_turns" AS RESTRICTIVE FOR UPDATE TO public USING (true) WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.flow_customization_sessions AS owned_session WHERE owned_session.id = "flow_customization_turns"."session_id" AND owned_session.flow_id = "flow_customization_turns"."flow_id" AND owned_session.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_sessions" ADD CONSTRAINT "flow_session_text_check" CHECK (char_length("title") BETWEEN 1 AND 80 AND char_length("description") <= 500 AND "revision" >= 0);
--> statement-breakpoint
ALTER TABLE "public"."flow_customization_turns" ADD CONSTRAINT "flow_turn_text_check" CHECK (char_length("prompt") BETWEEN 1 AND 4000 AND char_length("context") <= 20000 AND jsonb_typeof("members") = 'array');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."flow_customization_sessions" TO openbot_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."flow_customization_heads" TO openbot_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."flow_customization_turns" TO openbot_app;

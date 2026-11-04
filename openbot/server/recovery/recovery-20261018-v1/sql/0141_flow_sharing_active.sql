/*
 * Story WF9, phase 3: the two dormant sharing tables of 0096 become live (spec
 * 2026-11-04-wf9-flow-sessions-sharing §3.3-§3.4, decisions D1, D2, D4, D5 and D7, option L-A).
 *
 *  - `flow_share_links`: one share link of a saved Flow. The link holds a copy of the Flow's
 *    definition (the package: no coworker ids, no models, no run output), its digest, the sha256 of
 *    its token (the token itself is never stored), an expiry and a use limit.
 *  - `flow_share_imports`: one import, once per (tenant, request id): the draft Flow it created.
 *
 * Cross-tenant redemption (D1, an approved exception to J3): an importer, in their OWN frame, sets
 * `app.flow_share_token` to the token's hash for one transaction (`SET LOCAL`), which the 0096
 * policies already let read and update exactly that one row. This migration closes what those
 * policies left open: their UPDATE `WITH CHECK` asks only that the token match, so a token holder
 * could have changed any column (extended the expiry, reset the count).
 *
 * NOTHING OF 0096 IS CHANGED. The tables' columns, indexes, foreign keys, CHECKs and policies are
 * pinned by `tests/recovery-flow-sharing-foundations.test.ts` and stay exactly as they are. This
 * migration only adds, as decision D2 allows:
 *
 *  - FORCE ROW LEVEL SECURITY, which every live tenant table has and these two lacked.
 *  - The platform scope, as four new `platform_scope_*` policies on each table.
 *  - Restrictive checks on insert (and an import's update) that the Flow a row names is the writing
 *    tenant's own: a foreign key does not look through row security. The platform frame is exempt.
 *  - CHECKs the live code relies on: a link always has a use limit of at most 100 (D5: there is no
 *    "unlimited") and an expiry at most 30 days after it was made (D4); the package is a JSON object;
 *    the digest and the token hash are sha256 hex; an import's result is an object when present.
 *  - `openbot_flow_share_guard`, a BEFORE UPDATE row trigger on `flow_share_links`. In any frame but
 *    the owner's own and `platform`, the only change allowed is `uses` going up by exactly one, on a
 *    link that is not revoked and not expired (database clock); every other column must stay as it
 *    was. Like `openbot_team_row_guard` (0122) it compares OLD with NEW and reads only the session's
 *    settings, so it runs as the writer (not SECURITY DEFINER), pins its search_path and is revoked
 *    from PUBLIC (`tests/tenant-invariants.test.ts` (f)).
 *  - An explicit GRANT to the application role, beside the schema's default privileges.
 */
ALTER TABLE "public"."flow_share_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."flow_share_imports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_share_links" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_share_links" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_share_links" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_share_links" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_select" ON "public"."flow_share_imports" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_insert" ON "public"."flow_share_imports" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_update" ON "public"."flow_share_imports" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) = 'platform') WITH CHECK (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "platform_scope_delete" ON "public"."flow_share_imports" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "own_flow_share_insert" ON "public"."flow_share_links" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_share_links"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_import_insert" ON "public"."flow_share_imports" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR "flow_share_imports"."flow_id" IS NULL OR EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_share_imports"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
CREATE POLICY "own_flow_import_update" ON "public"."flow_share_imports" AS RESTRICTIVE FOR UPDATE TO public USING (true) WITH CHECK (current_setting('app.tenant_id', true) = 'platform' OR "flow_share_imports"."flow_id" IS NULL OR EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = "flow_share_imports"."flow_id" AND owned_flow.tenant_id = current_setting('app.tenant_id', true)));
--> statement-breakpoint
ALTER TABLE "public"."flow_share_links" ADD CONSTRAINT "flow_share_limits_check" CHECK ("max_uses" IS NOT NULL AND "max_uses" <= 100 AND "expires_at" <= "created_at" + interval '30 days');
--> statement-breakpoint
ALTER TABLE "public"."flow_share_links" ADD CONSTRAINT "flow_share_shape_check" CHECK (jsonb_typeof("package_snapshot") = 'object' AND "digest" ~ '^[0-9a-f]{64}$' AND "token_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "public"."flow_share_imports" ADD CONSTRAINT "flow_import_result_check" CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object');
--> statement-breakpoint
CREATE FUNCTION public.openbot_flow_share_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
BEGIN
  IF frame = 'platform' OR frame = OLD.tenant_id THEN RETURN NEW; END IF;
  IF NEW.uses = OLD.uses + 1
     AND (to_jsonb(NEW) - 'uses') = (to_jsonb(OLD) - 'uses')
     AND OLD.revoked_at IS NULL
     AND OLD.expires_at > now() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a shared WakerFlow link only records one more use' USING ERRCODE = '42501';
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_flow_share_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_flow_share_guard BEFORE UPDATE ON public.flow_share_links
  FOR EACH ROW EXECUTE FUNCTION public.openbot_flow_share_guard();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."flow_share_links" TO openbot_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."flow_share_imports" TO openbot_app;

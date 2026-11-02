/*
 * The approval continuation ledger, readable and lockable by its own tenant.
 *
 * 0101 created approval_continuations and approval_continuation_steps with FORCE RLS and no policy,
 * so nothing but a BYPASSRLS fixture could touch them. The local continuation target store runs as
 * the application role by design (it refuses superuser and BYPASSRLS) and must read and lock the
 * ledger row of the tenant it acts for, and record that tenant's steps. These policies admit exactly
 * that, never another tenant and never the 'system' or 'platform' rows; the ledger itself stays
 * closed to application writes (UPDATE passes USING only so that SELECT ... FOR UPDATE can lock, and
 * its WITH CHECK refuses every actual change).
 */
CREATE POLICY "continuation_tenant_select" ON "public"."approval_continuations" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "continuation_tenant_lock" ON "public"."approval_continuations" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "tenant_id" NOT IN ('system', 'platform')) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "continuation_no_app_insert" ON "public"."approval_continuations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "continuation_no_app_delete" ON "public"."approval_continuations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "continuation_step_tenant_select" ON "public"."approval_continuation_steps" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true) AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "continuation_step_tenant_insert" ON "public"."approval_continuation_steps" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true) AND "tenant_id" NOT IN ('system', 'platform'));
--> statement-breakpoint
CREATE POLICY "continuation_step_no_app_update" ON "public"."approval_continuation_steps" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "continuation_step_no_app_delete" ON "public"."approval_continuation_steps" AS PERMISSIVE FOR DELETE TO public USING (false);

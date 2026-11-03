/*
 * D06 AUT1/AUT3/AUT4: the automation tables get an owner before they get a writer.
 *
 * 0095 and 0097 created automations, automation_triggers and automation_firings as historical
 * structure only: no row security, no policy, and the table rights 0054's default privileges hand
 * openbot_app on every new table. The automation store is about to write them as the application
 * role, so before it does every row is fenced to the tenant that owns it.
 *
 * Four policies per table, one per command, in 0072's shape (a table missing one command sees no
 * rows for it, so an omission fails closed). Each table's scope is the same expression:
 *   - the row's tenant is the session's tenant, or the session is the platform writer;
 *   - and the row is never a 'system' or 'platform' row. An automation is somebody's standing
 *     instruction, never a vendor catalogue entry, so there is no 'system' read branch either, and
 *     an unscoped connection (which runs as 'system') can neither read nor write any of them.
 * A row hung under another row must also carry that row's tenant. A foreign key is checked without
 * row security, so on its own it would let a tenant write a trigger stamped with its own tenant under
 * somebody else's automation (or a firing under somebody else's trigger). The INSERT and UPDATE checks
 * of automation_triggers and automation_firings therefore also require the parent row, read under the
 * writer's own policies, to exist with the same tenant (0072's waker_group_members shape).
 * FORCE so the table owner is fenced too; only a BYPASSRLS fixture role steps around it.
 */
ALTER TABLE "public"."automations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."automations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."automation_triggers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."automation_triggers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."automation_firings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."automation_firings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."automations" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."automations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."automations" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')) WITH CHECK ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."automations" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."automation_triggers" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."automation_triggers" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') AND EXISTS (SELECT 1 FROM "public"."automations" a WHERE a."id" = "automation_triggers"."automation_id" AND a."tenant_id" = "automation_triggers"."tenant_id"));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."automation_triggers" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')) WITH CHECK ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') AND EXISTS (SELECT 1 FROM "public"."automations" a WHERE a."id" = "automation_triggers"."automation_id" AND a."tenant_id" = "automation_triggers"."tenant_id"));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."automation_triggers" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."automation_firings" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."automation_firings" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') AND EXISTS (SELECT 1 FROM "public"."automation_triggers" t WHERE t."id" = "automation_firings"."trigger_id" AND t."automation_id" = "automation_firings"."automation_id" AND t."tenant_id" = "automation_firings"."tenant_id"));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."automation_firings" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')) WITH CHECK ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') AND EXISTS (SELECT 1 FROM "public"."automation_triggers" t WHERE t."id" = "automation_firings"."trigger_id" AND t."automation_id" = "automation_firings"."automation_id" AND t."tenant_id" = "automation_firings"."tenant_id"));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."automation_firings" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" NOT IN ('system', 'platform') AND ("tenant_id" = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'));
--> statement-breakpoint
/*
 * AUT4 in the database as well as in the store: a cap is a positive count, a count never goes
 * negative, and a run past the cap cannot be recorded however two claims race.
 */
ALTER TABLE "public"."automations" ADD CONSTRAINT "automations_max_runs_check" CHECK ("max_runs" IS NULL OR "max_runs" > 0);
--> statement-breakpoint
ALTER TABLE "public"."automations" ADD CONSTRAINT "automations_run_count_check" CHECK ("run_count" >= 0 AND ("max_runs" IS NULL OR "run_count" <= "max_runs"));
--> statement-breakpoint
/*
 * The due index: what the scheduler asks on every pass is "which enabled triggers are due", so
 * only those rows are indexed. 0095's automation_triggers_due_idx stays; it is frozen structure.
 */
CREATE INDEX "automation_triggers_enabled_due_idx" ON "public"."automation_triggers" USING btree ("next_run_at") WHERE "enabled" AND "next_run_at" IS NOT NULL;
--> statement-breakpoint
-- The trigger cap counts one automation's triggers under its row lock.
CREATE INDEX "automation_triggers_automation_idx" ON "public"."automation_triggers" USING btree ("tenant_id", "automation_id");
--> statement-breakpoint
-- The breaker reads one automation's most recent firings, newest first.
CREATE INDEX "automation_firings_breaker_idx" ON "public"."automation_firings" USING btree ("tenant_id", "automation_id", "created_at" DESC);
--> statement-breakpoint
-- What 0054's default privileges already give openbot_app, said out loud for these three tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."automations", "public"."automation_triggers", "public"."automation_firings" TO openbot_app;

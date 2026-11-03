CREATE POLICY "append_only_update" ON "public"."flow_source_versions" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_versions" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_operations" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_operations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_candidates" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_candidates" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_resource_snapshots" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_resource_snapshots" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_runtime_events" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_runtime_events" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_stop_operations" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_stop_operations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_original_activations" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_original_activations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "append_only_update" ON "public"."flow_source_original_projection_observations" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "append_only_delete" ON "public"."flow_source_original_projection_observations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "retained_delete" ON "public"."flow_source_public_operations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "retained_delete" ON "public"."flow_source_runs" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "retained_delete" ON "public"."flow_source_invocations" AS PERMISSIVE FOR DELETE TO public USING (false);
--> statement-breakpoint
CREATE POLICY "retained_delete" ON "public"."flow_source_inline_invocations" AS PERMISSIVE FOR DELETE TO public USING (false);

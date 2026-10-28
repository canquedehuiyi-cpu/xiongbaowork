CREATE TABLE "public"."resource_projects" (
  "id" uuid NOT NULL PRIMARY KEY,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "device_id" uuid NOT NULL,
  "scope" text NOT NULL,
  "agent_id" text,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "source" jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resource_projects_scope_check" CHECK (("resource_projects"."scope" = 'public' AND "resource_projects"."agent_id" IS NULL) OR ("resource_projects"."scope" = 'agent' AND "resource_projects"."agent_id" IS NOT NULL)),
  CONSTRAINT "resource_projects_config_check" CHECK (char_length("resource_projects"."name") BETWEEN 1 AND 80 AND char_length("resource_projects"."description") <= 500 AND "resource_projects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "public"."project_context_bindings" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "device_id" uuid NOT NULL,
  "agent_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_context_bindings_tenant_id_device_id_agent_id_pk" PRIMARY KEY ("tenant_id", "device_id", "agent_id")
);
--> statement-breakpoint
ALTER TABLE "public"."resource_projects" ADD CONSTRAINT "resource_projects_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."resource_projects" ADD CONSTRAINT "resource_projects_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "resource_projects_device_scope_idx" ON "public"."resource_projects" USING btree ("tenant_id" ASC NULLS LAST, "device_id" ASC NULLS LAST, "agent_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE POLICY "project_owner_select" ON "public"."resource_projects" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "project_owner_insert" ON "public"."resource_projects" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
      AND EXISTS (SELECT 1 FROM "registered_devices" d WHERE d."id" = "resource_projects"."device_id" AND d."tenant_id" = "resource_projects"."tenant_id")
      AND ("scope" = 'public' OR EXISTS (SELECT 1 FROM "agents" a JOIN "agent_profiles" p ON p."agent_id" = a."id"
        WHERE a."id" = "resource_projects"."agent_id" AND a."tenant_id" = "resource_projects"."tenant_id"
        AND p."tenant_id" = "resource_projects"."tenant_id" AND p."owner_user_id" = "resource_projects"."tenant_id" AND p."deleted_at" IS NULL)));
--> statement-breakpoint
CREATE POLICY "project_owner_update" ON "public"."resource_projects" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
      AND EXISTS (SELECT 1 FROM "registered_devices" d WHERE d."id" = "resource_projects"."device_id" AND d."tenant_id" = "resource_projects"."tenant_id")
      AND ("scope" = 'public' OR EXISTS (SELECT 1 FROM "agents" a JOIN "agent_profiles" p ON p."agent_id" = a."id"
        WHERE a."id" = "resource_projects"."agent_id" AND a."tenant_id" = "resource_projects"."tenant_id"
        AND p."tenant_id" = "resource_projects"."tenant_id" AND p."owner_user_id" = "resource_projects"."tenant_id" AND p."deleted_at" IS NULL)));
--> statement-breakpoint
CREATE POLICY "project_owner_delete" ON "public"."resource_projects" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."resource_projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."project_context_bindings" ADD CONSTRAINT "project_context_bindings_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."project_context_bindings" ADD CONSTRAINT "project_context_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."project_context_bindings" ADD CONSTRAINT "project_context_bindings_project_id_resource_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."resource_projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE POLICY "project_binding_owner_select" ON "public"."project_context_bindings" AS PERMISSIVE FOR SELECT TO public USING ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "project_binding_owner_insert" ON "public"."project_context_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
      AND EXISTS (SELECT 1 FROM "registered_devices" d WHERE d."id" = "project_context_bindings"."device_id" AND d."tenant_id" = "project_context_bindings"."tenant_id")
      AND EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = "project_context_bindings"."agent_id" AND (a."tenant_id" = "project_context_bindings"."tenant_id" OR a."tenant_id" = 'system'))
      AND EXISTS (SELECT 1 FROM "resource_projects" p WHERE p."id" = "project_context_bindings"."project_id"
        AND p."tenant_id" = "project_context_bindings"."tenant_id" AND p."device_id" = "project_context_bindings"."device_id"
        AND (p."scope" = 'public' OR p."agent_id" = "project_context_bindings"."agent_id")));
--> statement-breakpoint
CREATE POLICY "project_binding_owner_update" ON "public"."project_context_bindings" AS PERMISSIVE FOR UPDATE TO public USING ("tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)
      AND EXISTS (SELECT 1 FROM "registered_devices" d WHERE d."id" = "project_context_bindings"."device_id" AND d."tenant_id" = "project_context_bindings"."tenant_id")
      AND EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = "project_context_bindings"."agent_id" AND (a."tenant_id" = "project_context_bindings"."tenant_id" OR a."tenant_id" = 'system'))
      AND EXISTS (SELECT 1 FROM "resource_projects" p WHERE p."id" = "project_context_bindings"."project_id"
        AND p."tenant_id" = "project_context_bindings"."tenant_id" AND p."device_id" = "project_context_bindings"."device_id"
        AND (p."scope" = 'public' OR p."agent_id" = "project_context_bindings"."agent_id")));
--> statement-breakpoint
CREATE POLICY "project_binding_owner_delete" ON "public"."project_context_bindings" AS PERMISSIVE FOR DELETE TO public USING ("tenant_id" = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."project_context_bindings" ENABLE ROW LEVEL SECURITY;

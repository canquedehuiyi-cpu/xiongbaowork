CREATE TABLE "public"."employee_device_bindings" (
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "registration_id" uuid,
  "revision" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "employee_device_bindings_tenant_id_agent_id_pk" PRIMARY KEY ("tenant_id", "agent_id"),
  CONSTRAINT "employee_device_binding_tenant" CHECK ("employee_device_bindings"."tenant_id" NOT IN ('system','platform')),
  CONSTRAINT "employee_device_binding_revision" CHECK ("employee_device_bindings"."revision" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "public"."runner_device_connection_leases" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "registration_id" uuid NOT NULL,
  "device_id" text NOT NULL,
  "session_id" text NOT NULL,
  "credential_version" text NOT NULL,
  "owner_replica_id" uuid NOT NULL,
  "epoch" bigint NOT NULL,
  "state" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "runner_device_connection_leases_pk" PRIMARY KEY ("tenant_id", "registration_id"),
  CONSTRAINT "runner_device_connection_leases_epoch_safe" CHECK ("runner_device_connection_leases"."epoch" >= 1 AND "runner_device_connection_leases"."epoch" <= 9007199254740991),
  CONSTRAINT "runner_device_connection_leases_state" CHECK ("runner_device_connection_leases"."state" IN ('connected','disconnected')),
  CONSTRAINT "runner_device_connection_leases_credential" CHECK ("runner_device_connection_leases"."credential_version" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "runner_device_connection_leases_identity" CHECK ("runner_device_connection_leases"."tenant_id" <> '' AND "runner_device_connection_leases"."device_id" <> '' AND "runner_device_connection_leases"."session_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "public"."employee_device_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "employee_device_bindings_owner_select" ON "public"."employee_device_bindings" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "employee_device_bindings_owner_insert" ON "public"."employee_device_bindings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "employee_device_bindings_owner_update" ON "public"."employee_device_bindings" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "employee_device_bindings_owner_delete" ON "public"."employee_device_bindings" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "public"."runner_device_connection_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "runner_device_connection_leases_owner_select" ON "public"."runner_device_connection_leases" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id',true));
--> statement-breakpoint
CREATE POLICY "runner_device_connection_leases_owner_insert" ON "public"."runner_device_connection_leases" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
--> statement-breakpoint
CREATE POLICY "runner_device_connection_leases_owner_update" ON "public"."runner_device_connection_leases" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id',true)) WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
--> statement-breakpoint
CREATE POLICY "runner_device_connection_leases_owner_delete" ON "public"."runner_device_connection_leases" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id',true));

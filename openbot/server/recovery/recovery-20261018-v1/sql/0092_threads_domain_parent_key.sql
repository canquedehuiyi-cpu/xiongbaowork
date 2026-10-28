ALTER TABLE "public"."threads" ADD CONSTRAINT "threads_id_tenant_agent_unique" UNIQUE ("id", "tenant_id", "agent_id");

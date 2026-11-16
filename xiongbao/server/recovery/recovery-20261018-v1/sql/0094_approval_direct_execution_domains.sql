CREATE TABLE "public"."approval_direct_execution_domains" (
  "domain_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "source_run_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "execution_kind" text NOT NULL DEFAULT 'direct_thread',
  "backend" text NOT NULL DEFAULT 'local_postgres',
  "release_id" text NOT NULL,
  "contract_version" text NOT NULL,
  "state" text NOT NULL DEFAULT 'reserved',
  "admission_fence" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "admitted_at" timestamptz,
  "creation_key" text NOT NULL,
  CONSTRAINT "approval_direct_execution_domains_pkey" PRIMARY KEY ("domain_id") NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_thread_unique" UNIQUE ("thread_id") NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_scope_genesis_unique" UNIQUE ("tenant_id", "owner_user_id", "source_run_id") NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_scope_binding_unique" UNIQUE ("domain_id", "tenant_id", "owner_user_id", "thread_id", "agent_id") NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_creation_unique" UNIQUE ("tenant_id", "owner_user_id", "creation_key") NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_allocation_binding_unique" UNIQUE ("domain_id", "tenant_id", "owner_user_id", "thread_id", "agent_id", "source_run_id", "release_id", "backend") NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE,
  CONSTRAINT "approval_direct_execution_domains_thread_binding_fk" FOREIGN KEY ("thread_id", "tenant_id", "agent_id") REFERENCES "public"."threads" ("id", "tenant_id", "agent_id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE,
  CONSTRAINT "domain_nonblank_text_check" CHECK (length(btrim(tenant_id))>0 AND length(btrim(owner_user_id))>0 AND length(btrim(thread_id))>0 AND length(btrim(source_run_id))>0 AND length(btrim(agent_id))>0 AND length(btrim(release_id))>0 AND length(btrim(contract_version))>0 AND length(btrim(creation_key))>0),
  CONSTRAINT "domain_execution_kind_check" CHECK (execution_kind='direct_thread'),
  CONSTRAINT "domain_backend_check" CHECK (backend='local_postgres'),
  CONSTRAINT "domain_reserved_admitted_pair_check" CHECK ((state='reserved' AND admission_fence=0 AND admitted_at IS NULL) OR (state='admitted' AND admission_fence=1 AND admitted_at IS NOT NULL)),
  CONSTRAINT "domain_contract_version_check" CHECK (contract_version='ap-direct-domain-v2')
);
--> statement-breakpoint
ALTER TABLE "public"."approval_direct_execution_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."approval_direct_execution_domains" FORCE ROW LEVEL SECURITY;

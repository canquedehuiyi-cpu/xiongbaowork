/*
 * The platform model pool (stories H1, K1): the experience models every plan may bind a coworker to
 * without connecting a key of its own, Free included.
 *
 * Platform-owned, so there is no tenant_id and no row-level security: every tenant reads the same
 * catalogue, and the application may only read it. The key behind a row is never stored here:
 * `api_key_env` is the NAME of a deployment environment variable, restricted to the OPENBOT_POOL_
 * prefix so a row can never point the resolver at DATABASE_URL or the vault key. `tiers` says which
 * plans may use the row; a plan outside it resolves to the deployment default.
 *
 * The default privileges of 0054 hand openbot_app SELECT, INSERT, UPDATE and DELETE on every new
 * table, so the grant is replaced rather than added to, the same shape 0109 gave user_roles: REVOKE
 * ALL first (MAINTAIN on PG17 included), then SELECT alone. Rows are written by the operator.
 *
 * agent_profiles gains platform_model_ref beside model_ref. A coworker speaks with its tenant's own
 * library model or with a pool model, never both, and a pool row still bound to a coworker cannot be
 * deleted out from under it (disable it instead).
 */
CREATE TABLE "public"."platform_model_pool" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "base_url" text,
  "model_name" text NOT NULL,
  "label" text NOT NULL,
  "api_key_env" text NOT NULL,
  "tiers" text[] DEFAULT '{free,pro}'::text[] NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_model_pool_provider_model_unique" UNIQUE ("provider", "model_name"),
  CONSTRAINT "platform_model_pool_api_key_env" CHECK ("api_key_env" ~ '^OPENBOT_POOL_[A-Z0-9_]{1,64}$'),
  CONSTRAINT "platform_model_pool_tiers" CHECK ("tiers" <@ '{free,pro}'::text[])
);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."platform_model_pool" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."platform_model_pool" FROM openbot_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "public"."platform_model_pool" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD COLUMN "platform_model_ref" uuid;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_platform_model_ref_platform_model_pool_id_fk" FOREIGN KEY ("platform_model_ref") REFERENCES "public"."platform_model_pool"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_single_model_binding" CHECK ("model_ref" IS NULL OR "platform_model_ref" IS NULL);

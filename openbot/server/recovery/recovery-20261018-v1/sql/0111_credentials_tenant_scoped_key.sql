-- Audit #9: one live credential per key PER TENANT, not per deployment.
-- The global index let tenant A's key block tenant B from storing one under the same
-- (kind, provider, key_id), and the 23505 it raised told B that A's row existed.
-- Strictly looser than the index it replaces (global uniqueness implies per-tenant uniqueness),
-- so it holds on every existing row and touches none.
DROP INDEX IF EXISTS "credentials_active_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_tenant_active_key_idx" ON "credentials" USING btree ("tenant_id","kind","provider","key_id") WHERE "credentials"."revoked_at" IS NULL;

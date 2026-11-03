-- Audit #9, skills: a skill name is unique PER TENANT, not per deployment.
--
-- `skills_slug_key` was global and `skills.id` was the slug, so the first tenant to write `/standup`
-- took that name from every other tenant, and the 23505 the second one got told it the first existed.
--
-- Only the platform's `system` rows keep `id = slug`: the package sync upserts on it and
-- `plugin_grants.ref` names it. Every tenant row moves onto a uuid, old ones included, so a tenant row
-- can never hold the id a catalogue skill of the same slug needs.
--
-- `skill_tools.skill_id` follows the re-key through ON UPDATE CASCADE. Foreign-key actions run outside
-- row security, so the cascade reaches every declaration whichever role runs this.
ALTER TABLE "skill_tools" DROP CONSTRAINT IF EXISTS "skill_tools_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_tools" ADD CONSTRAINT "skill_tools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
-- Row security OFF for the re-key, so a migrator that is subject to it fails loudly here instead of
-- silently re-keying nothing. A superuser or owner-with-BYPASSRLS is unaffected; anybody else is told.
-- A tenant row left on `id = slug` would make the next catalogue sync of that slug fail on the
-- primary key and take the boot with it.
SET LOCAL row_security = off;
--> statement-breakpoint
UPDATE "skills" SET "id" = gen_random_uuid()::text WHERE "tenant_id" <> 'system';
--> statement-breakpoint
SET LOCAL row_security = on;
--> statement-breakpoint
-- Strictly looser than the index it replaces (global uniqueness implies per-tenant uniqueness), so it
-- holds on every existing row.
DROP INDEX IF EXISTS "skills_slug_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tenant_slug_key" ON "skills" USING btree ("tenant_id","slug");

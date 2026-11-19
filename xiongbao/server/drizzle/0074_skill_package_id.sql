ALTER TABLE "skills" ADD COLUMN "package_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_package_id_deployment_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."deployment_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_package_idx" ON "skills" USING btree ("package_id");--> statement-breakpoint
-- ADR/029: attribute the shipped catalogue skills to the brand that brought them in, so a later sweep
-- can take its own back without reaching into another packages rows.
--
-- The grant pairing is the only surviving trail (`plugin_grants.ref` is the slug, and the grant names an
-- agent, which does carry its package). A skill claimed by agents of TWO packages is left NULL on
-- purpose: guessing which brand owned it would delete the other ones content, and the column being
-- unknown is recoverable while a deleted skill somebody else shipped is not. Skills a person wrote are
-- outside the statement entirely -- they have an owner and their origin is not `catalogue`.
UPDATE "skills" s
SET "package_id" = claimed.package_id
FROM (
  SELECT g."ref" AS slug, MIN(a."package_id"::text)::uuid AS package_id
  FROM "plugin_grants" g
  JOIN "agents" a ON a."id" = g."agent_id"
  WHERE g."kind" = 'skill' AND a."package_id" IS NOT NULL
  GROUP BY g."ref"
  HAVING COUNT(DISTINCT a."package_id") = 1
) claimed
WHERE claimed.slug = s."slug"
  AND s."package_id" IS NULL
  AND s."origin" = 'catalogue'
  AND s."owner_user_id" IS NULL;

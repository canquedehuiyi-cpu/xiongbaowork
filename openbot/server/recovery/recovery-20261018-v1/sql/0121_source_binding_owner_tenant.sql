/*
 * GitHub source bindings, and the signing secrets of bindings and triggers, belong to the person who
 * owns them (G01-C).
 *
 * Since G01-C the legacy GitHub webhook (`POST /api/events/github/:bindingId`) reads its binding as
 * `platform` and ingests in the tenant stamped on the binding row, confirmed by `owner_user_id`; a
 * binding stamped `system`, `platform` or nothing is answered like an unknown binding. Bindings made
 * before the responsibility routes ran in the owner's frame carry exactly those stamps (the
 * `tenant_id` default is `current_setting('app.tenant_id', true)`), and 0115 restamped responsibilities
 * and their triggers but not `responsibility_source_bindings`, so every such repository would stop
 * delivering. `owner_user_id` is NOT NULL and is the person the binding was registered for; a
 * person's tenant is their user id, so that is the stamp the row should always have carried. Rows
 * already stamped with a person are left alone, including one that disagrees with its owner: that is
 * a conflict, and the ingress refuses it on its own (owner/tenant mismatch).
 *
 * THE SECRET GOES WITH ITS ROW. A binding's (and a trigger's) signing secret lives in `credentials`,
 * written in the same unframed transaction, so a legacy one is stamped `system` too. The ingress reads
 * it as `platform` and does not care, but every other use of it does: under 0072's write scope the
 * owner's frame cannot UPDATE a `system` row, so removing the binding (`vault.store.revoke`) or a
 * trigger, or rotating a trigger's secret, finds no credential and fails with a 404 inside the
 * owner's own transaction — and meanwhile the encrypted secret sits where every tenant's SELECT
 * policy admits it. 0115 restamped the triggers but left their credentials behind the same way. So
 * the live credential each binding and trigger points at moves to the owner too, only when it is
 * nobody's and only when its row is now stamped with its owner; a row in conflict keeps its
 * credential where it is.
 *
 * WHY THE FRAME. Same as 0114/0115: FORCE ROW LEVEL SECURITY binds the table owner too, so the
 * statement runs as the platform writer, which the write-scope policies admit for any row and any new
 * stamp. The setting is transaction-local and restored afterwards so a later migration in the same
 * run does not inherit the platform frame. A superuser or BYPASSRLS migrator touches the same rows.
 */
DO $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);
  UPDATE "public"."responsibility_source_bindings"
     SET "tenant_id" = "owner_user_id"
   WHERE "tenant_id" IN ('system', 'platform', '')
     AND "owner_user_id" IS NOT NULL
     AND "owner_user_id" NOT IN ('system', 'platform', '');
  UPDATE "public"."credentials" AS "credential"
     SET "tenant_id" = "binding"."owner_user_id"
    FROM "public"."responsibility_source_bindings" AS "binding"
   WHERE "credential"."id" = "binding"."credential_id"
     AND "credential"."tenant_id" IN ('system', 'platform', '')
     AND "binding"."tenant_id" = "binding"."owner_user_id"
     AND "binding"."owner_user_id" NOT IN ('system', 'platform', '');
  UPDATE "public"."credentials" AS "credential"
     SET "tenant_id" = "trigger"."owner_user_id"
    FROM "public"."responsibility_triggers" AS "trigger"
   WHERE "credential"."id" = "trigger"."credential_id"
     AND "credential"."tenant_id" IN ('system', 'platform', '')
     AND "trigger"."tenant_id" = "trigger"."owner_user_id"
     AND "trigger"."owner_user_id" NOT IN ('system', 'platform', '');
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;

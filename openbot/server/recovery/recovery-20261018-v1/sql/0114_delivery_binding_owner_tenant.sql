/*
 * Delivery bindings belong to the person who owns them (G01).
 *
 * A binding linked before the OpenTag/Slack/SMS link routes ran in the owner's frame was written with
 * no tenant context, so its `tenant_id` default (`current_setting('app.tenant_id', true)`) stamped it
 * `system` (or, from an operator path, `platform`, or the empty string). Since G01-B delivery takes
 * the tenant from the binding row and refuses every binding that names nobody, so those people
 * stopped receiving and answering anything until they linked again. `owner_user_id` is NOT NULL and
 * is the person the binding was linked for; a person's tenant is their user id, so that is the stamp
 * the row should always have carried. Rows already stamped with a person's tenant are not touched,
 * including one that disagrees with its owner: that is not a legacy default but a conflict, and the
 * delivery paths refuse it on their own (owner/tenant mismatch).
 *
 * WHY THE FRAME. `delivery_bindings` has FORCE ROW LEVEL SECURITY (0053/0059), which applies to the
 * table owner as well, so a migration run as the owner with no `app.tenant_id` would see only the
 * `system` rows through the SELECT policy and could reach none of them through the UPDATE policy
 * (0072 write scope: `tenant_id = current_setting('app.tenant_id', true)` or the platform writer) —
 * the UPDATE would succeed with zero rows and the bindings would stay unreachable. So the statement
 * runs as the platform writer, which 0072's UPDATE USING and WITH CHECK both admit for any row and
 * any new stamp. A superuser or BYPASSRLS migrator is unaffected by the frame and touches the same
 * rows. The setting is transaction-local and restored afterwards, because the migrator applies every
 * pending migration in one transaction and a later migration must not inherit the platform frame.
 */
DO $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);
  UPDATE "public"."delivery_bindings"
     SET "tenant_id" = "owner_user_id"
   WHERE "tenant_id" IN ('system', 'platform', '')
     AND "owner_user_id" IS NOT NULL
     AND "owner_user_id" NOT IN ('system', 'platform', '');
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;

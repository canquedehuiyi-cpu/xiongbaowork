/*
 * Routines, memory sources and responsibilities belong to the person who owns them (G01).
 *
 * Since G01-B3 the routine sweep only offers a routine whose `tenant_id` is its owner, and memory
 * sync only syncs a source whose `tenant_id` is its owner. Rows created before the routes ran in the
 * owner's frame were stamped by the `tenant_id` default (`current_setting('app.tenant_id', true)`)
 * as `system` (or, from an operator path, `platform`, or the empty string), so those routines stopped
 * firing and those sources stopped syncing. `owner_user_id` is NOT NULL on both tables and is the
 * person the row was created for; a person's tenant is their user id (as 0114 restamped delivery
 * bindings), so that is the stamp these rows should always have carried. Rows already stamped with a
 * person are not touched, including one that disagrees with its owner: that is a conflict, not a
 * legacy default, and the sweep and sync refuse it on their own.
 *
 * IMPORTED MEMORIES GO WITH THEIR SOURCE. A source's sync writes its facts with
 * `INSERT ... ON CONFLICT (source_id, external_id) DO UPDATE` in the source's tenant. A fact imported
 * while the source was stamped `system` carries `system` too, and an ON CONFLICT update of a row the
 * UPDATE policy does not admit is an error, not a skip — so a restamped source would fail every sync
 * on its first already-imported fact, and its facts would stay out of its owner's recall. A fact is
 * restamped only when it is nobody's, has a source, and that source is its owner's and now stamped
 * with that owner; facts the person or a Bot formed (no source) are not this migration's business.
 *
 * RESPONSIBILITIES AND THEIR TRIGGERS. A Slack event is now fanned out to each trigger in the tenant
 * stamped on the trigger row, and only when that is its owner (G01-B4); a trigger stamped `system`
 * is refused as naming nobody. Unframed, the old fan-out could only see `system` triggers, so those
 * are exactly the ones that used to fire. Their responsibility must move with them: the ingest locks
 * the responsibility `FOR UPDATE` in the owner's frame, the UPDATE policy filters a `system` row out
 * of that lock without an error, and the event would be recorded with no run. Same rule as above:
 * rows of nobody's go to their owner, rows stamped with a person are left alone.
 *
 * Routine run history (`routine_runs`) is not restamped: nothing since G01-B3 compares a run's stamp
 * with its routine's, and new runs are opened in the routine's own tenant.
 *
 * WHY THE FRAME. Same as 0114: these tables have FORCE ROW LEVEL SECURITY, which binds the table
 * owner too, so a migrator with no `app.tenant_id` would update zero rows. The statements run as the
 * platform writer, which the write-scope policies admit for any row and any new stamp, and the
 * setting is transaction-local and restored afterwards so a later migration in the same run does not
 * inherit the platform frame. A superuser or BYPASSRLS migrator touches the same rows.
 */
DO $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);
  UPDATE "public"."routines"
     SET "tenant_id" = "owner_user_id"
   WHERE "tenant_id" IN ('system', 'platform', '')
     AND "owner_user_id" IS NOT NULL
     AND "owner_user_id" NOT IN ('system', 'platform', '');
  UPDATE "public"."memory_sources"
     SET "tenant_id" = "owner_user_id"
   WHERE "tenant_id" IN ('system', 'platform', '')
     AND "owner_user_id" IS NOT NULL
     AND "owner_user_id" NOT IN ('system', 'platform', '');
  UPDATE "public"."responsibilities"
     SET "tenant_id" = "owner_user_id"
   WHERE "tenant_id" IN ('system', 'platform', '')
     AND "owner_user_id" IS NOT NULL
     AND "owner_user_id" NOT IN ('system', 'platform', '');
  UPDATE "public"."responsibility_triggers"
     SET "tenant_id" = "owner_user_id"
   WHERE "tenant_id" IN ('system', 'platform', '')
     AND "owner_user_id" IS NOT NULL
     AND "owner_user_id" NOT IN ('system', 'platform', '');
  UPDATE "public"."personal_memories" AS "memory"
     SET "tenant_id" = "memory"."owner_user_id"
    FROM "public"."memory_sources" AS "source"
   WHERE "memory"."tenant_id" IN ('system', 'platform', '')
     AND "memory"."source_id" = "source"."id"
     AND "source"."owner_user_id" = "memory"."owner_user_id"
     AND "source"."tenant_id" = "memory"."owner_user_id"
     AND "memory"."owner_user_id" NOT IN ('system', 'platform', '');
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;

/*
 * G01-E P8b: public and published Bots live in the shared `team` tenant.
 *
 * Until now a public Bot was stamped with its owner's tenant, so row security showed it to its owner
 * alone and every other person saw it only where it happened to carry the legacy `system` stamp. The
 * profile store now moves a Bot to `team` when it is made public (the owner's explicit move, keyed by
 * `app.team_move`, admitted by 0122's row guard), and teammates read it through `team_read`, gated by
 * `openbot_team_bot_visible`. This moves every Bot made public or published before.
 *
 * Only rows their legitimate writer stamped are moved. Before 0122 anybody could insert a row stamped
 * with their OWN tenant naming any agent id (a publication, an audience or assignment row, a grant),
 * and this migration runs as `platform`, past row security: re-stamping such a row `team` would turn
 * a stranger's row into the Bot's own, publishing somebody's private Bot or putting a stranger's tool
 * on somebody's public one. So:
 *   - the profile moves when it is stamped with its owner, live, and public or published BY ITS OWNER
 *     (a publication stamped with and published by the owner; publishing is owner-only);
 *   - its `agents` row, audience rows and plugin grants move when stamped with the owner;
 *   - its publication moves when stamped with and published by the owner;
 *   - an assignment moves when stamped with its assigner and that assigner is an administrator
 *     (assigning is an administrator's act, written in their own frame);
 *   - every other row naming the Bot keeps its stamp and stays inert: `openbot_team_bot_visible` and
 *     `team_read` count only rows stamped `team`.
 * Not moved: the Bot's child rows (security policy, knowledge bindings, device projects), which stay
 * with the owner (I8); 0122's `*_team_bot_*` policies keep them reachable for the owner. A profile
 * without an owner, a deleted one, and the `system`/`platform` catalogue are left where they are.
 *
 * The row guard (0122) also gets the owner check its comment promises: the explicit move under
 * `app.team_move` is the OWNER's, so the frame must own the Bot named by the GUC. Without it an
 * administrator with the capability (who passes the plugin_grants team policies) could set the GUC
 * and re-stamp a team Bot's grants out to their own tenant.
 *
 * The 0122 row guard admits a tenant_id change only under `platform`, and drizzle runs every pending
 * migration in one transaction, so the frame is set locally here and cleared at the end.
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE agent_profiles p SET tenant_id = 'team'
 WHERE p.owner_user_id IS NOT NULL AND p.tenant_id = p.owner_user_id
   AND p.tenant_id NOT IN ('system', 'platform', 'team') AND p.deleted_at IS NULL
   AND (p.visibility = 'public'
        OR EXISTS (SELECT 1 FROM team_bot_publications pub
                    WHERE pub.agent_id = p.agent_id AND pub.tenant_id = p.owner_user_id
                      AND pub.published_by = p.owner_user_id));
--> statement-breakpoint
UPDATE agents a SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = a.id AND p.tenant_id = 'team' AND a.tenant_id = p.owner_user_id;
--> statement-breakpoint
UPDATE team_bot_publications pub SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = pub.agent_id AND p.tenant_id = 'team'
   AND pub.tenant_id = p.owner_user_id AND pub.published_by = p.owner_user_id;
--> statement-breakpoint
UPDATE team_bot_audience au SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = au.agent_id AND p.tenant_id = 'team' AND au.tenant_id = p.owner_user_id;
--> statement-breakpoint
UPDATE team_bot_assignments x SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = x.agent_id AND p.tenant_id = 'team' AND x.tenant_id = x.assigned_by
   AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = x.assigned_by AND r.role = 'admin');
--> statement-breakpoint
UPDATE plugin_grants g SET tenant_id = 'team' FROM agent_profiles p
 WHERE p.agent_id = g.agent_id AND p.tenant_id = 'team' AND g.tenant_id = p.owner_user_id;
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
--> statement-breakpoint
/*
 * 0122's guard, with the owner check on the explicit move. The check reads agent_profiles under the
 * caller's row security (the function is not a definer): the owner sees their own profile whether it
 * is stamped with them or `team`, and nobody else's frame both sees it and owns it.
 */
CREATE OR REPLACE FUNCTION public.openbot_team_row_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
  col text;
  moving text;
BEGIN
  IF frame = 'platform' THEN RETURN NEW; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    moving := CASE WHEN TG_TABLE_NAME = 'agents' THEN to_jsonb(OLD)->>'id' ELSE to_jsonb(OLD)->>'agent_id' END;
    IF NOT coalesce(TG_TABLE_NAME IN ('agents','agent_profiles','plugin_grants')
            AND moving IS NOT NULL
            AND current_setting('app.team_move', true) = moving
            AND frame NOT IN ('system','team','')
            AND 'team' IN (OLD.tenant_id, NEW.tenant_id)
            AND frame IN (OLD.tenant_id, NEW.tenant_id)
            AND EXISTS (SELECT 1 FROM public.agent_profiles p
                         WHERE p.agent_id = moving AND p.owner_user_id = frame), false) THEN
      RAISE EXCEPTION 'tenant_id of % is fixed', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  END IF;
  -- TG_ARGV is NULL, not empty, for a trigger created without arguments.
  IF TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col)
         -- The one foreign key with ON DELETE SET NULL on a fixed link: agent_profiles.owner_user_id
         -- when that user is deleted. It runs inside the referential trigger, one level down. Depth
         -- alone proves nothing (a session with TEMP can nest its own trigger), so the user must
         -- also be gone.
         AND NOT (pg_trigger_depth() > 1 AND TG_TABLE_NAME = 'agent_profiles' AND col = 'owner_user_id'
                  AND jsonb_typeof(to_jsonb(NEW) -> col) = 'null'
                  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = to_jsonb(OLD)->>col)) THEN
        RAISE EXCEPTION '%.% is fixed', TG_TABLE_NAME, col USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  -- Deleting a shared group and bringing it back are both the creator's: a member who could clear
  -- deleted_at would resurrect a group the creator deleted for everyone.
  IF TG_TABLE_NAME = 'channels' AND OLD.tenant_id = 'team'
     AND (to_jsonb(OLD)->'deleted_at') IS DISTINCT FROM (to_jsonb(NEW)->'deleted_at')
     AND (to_jsonb(OLD)->>'created_by') IS DISTINCT FROM frame THEN
    RAISE EXCEPTION 'only the creator deletes or restores a shared group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;

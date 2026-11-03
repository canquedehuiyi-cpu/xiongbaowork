/*
 * G01-E P10: MCP servers and their tools live in `team`; a team server's secret is reached through a
 * definer broker; a Bot's grants carry the Bot's own stamp.
 *
 * SERVERS AND TOOLS. An administrator's connector was stamped with the administrator's tenant, so row
 * security showed it to that administrator alone: every teammate's Bot was offered nothing, and the
 * only shared connectors were the legacy `system` rows. They are now stamped `team`, which 0122's
 * `team_read` shows to every person and its `team_write_*` lets only an administrator holding the
 * capability write. Two administrators who each added the same catalogue entry would collide on
 * `mcp_servers_tenant_catalogue_key` once both rows are `team`, so that is refused up front with the
 * step to take. Row ids are kept: tool rows, grants (`<catalogue key>/<tool>`) and people's
 * connections (`mcp_user_credentials.server_id`) point at them. Only what a legitimate writer stamped
 * moves (0125's and 0126's rule): a server stamped with an administrator in `user_roles`, the
 * platform, or nobody, and a tool carrying its server's stamp. Before P10 anybody could insert a
 * server or tool row stamped with their own tenant; such a row is deleted rather than shown to the
 * whole team. From here on a server or tool row is written outside `platform` and `system` only as
 * `team` (connector_stamp_insert), and a tool always carries its server's stamp (trigger).
 *
 * SECRETS (I8, R5, Q3). A team server's own token (`mcp`) and the deployment's OAuth client for it
 * (`mcp_oauth_client`, linked the same way: `mcp_servers.credential_id`, written by the plugin store's
 * `writeOAuthClient`) are sealed to `team`. Nobody's frame SELECTs them through the 0072
 * `tenant_isolation` policy (`team` is not a person), and no member policy is added: a member reaches
 * exactly one secret, the one a named team server points at, through
 * `openbot_team_server_secret(server_id)`, and never by id (`readSecret`). An administrator holding the
 * capability reads and writes them, to add, rotate and revoke. Existing credentials are NOT moved:
 * a v2 envelope is bound to its row's tenant (AAD), so a re-stamped row could not be opened. The
 * moved servers keep pointing at their old rows, which the broker does not return; those rows are
 * revoked here, and an administrator re-enters or rotates each one once after deploy (the operator
 * step in the release notes).
 *
 * GRANTS (carried forward from P8b, (d)(a)). `plugin_grants` is keyed by (kind, ref, agent_id) with no
 * tenant, and since 0072 anybody could insert a row stamped with their OWN tenant naming any agent
 * id. Such a row offers nothing (`listForAgent` reads only the Bot's own stamp), but it holds the key:
 * the owner's later grant of the same tool was refused on a row the owner could neither see nor
 * delete. So, outside `platform`, a grant may only be written carrying the Bot's own stamp: `team`
 * for a team Bot, the owner's tenant for a private one (an administrator's grant on somebody's
 * private Bot runs in the owner's frame, through `adminActAsOwner`). Catalogue Bots (`system`,
 * `platform`) are left as they were. `openbot_grant_stamp_guard` is a definer trigger because the Bot
 * may not be visible to the frame that names it (a team Bot published to others, somebody's private
 * Bot), and a check under the caller's row security would answer "no such Bot, so anything goes".
 * INSERT-only, like 0126: an UPDATE cannot change a grant's stamp or Bot outside `platform` (0122 row
 * guard), so the insert is the only way in.
 *
 * The rows already in the way are settled first, by 0125's and 0126's rule: a grant stamped with an
 * administrator is that administrator's act and takes the Bot's own stamp (it is what the same grant
 * would be stamped today); every other grant whose stamp is not the Bot's is a stranger's and is
 * removed. Both run as `platform`, set locally and cleared afterwards, like 0123, 0125 and 0126.
 *
 * The kinds are compared as text: on a fresh database every pending migration runs in one
 * transaction, and the enum value `mcp_oauth_client` (added by an earlier migration of the same run)
 * may not be used as an enum literal before that transaction commits.
 *
 * Numbering: the plan reserved 0126 for this package; P9 took it, so this is 0127.
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0127 must run as a role with BYPASSRLS (owner of the openbot_* definer functions)';
  END IF;
END $$;
--> statement-breakpoint
/*
 * The rows that will be `team` once this has run: the ones already `team`, and the ones it moves (an
 * administrator's, the platform's, unstamped). Two of them with one catalogue key would collide on
 * `mcp_servers_tenant_catalogue_key`, so that is refused before anything is changed, naming each key
 * and whose rows hold it. The release notes give the query and a merge that keeps people's
 * connections ("Before upgrading").
 */
DO $$ DECLARE clash text; BEGIN
  SELECT string_agg(format('%s (%s)', m.catalogue_key, m.holders), '; ' ORDER BY m.catalogue_key) INTO clash
    FROM (SELECT s.catalogue_key,
                 string_agg(format('%s: %s', s.tenant_id, s.id), ', ' ORDER BY s.tenant_id, s.id) AS holders
            FROM public.mcp_servers s
           WHERE s.catalogue_key IS NOT NULL AND s.tenant_id <> 'system'
             AND (s.tenant_id IN ('team', 'platform', '')
                  OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = s.tenant_id AND r.role = 'admin'))
           GROUP BY s.catalogue_key HAVING count(*) > 1) m;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION '0127: the same catalogue server is installed by several administrators; merge them into one first'
      USING DETAIL = 'catalogue_key (tenant: server id, ...): ' || clash,
            HINT = 'See "Before upgrading" for migration 0127_team_connectors in CHANGELOG.md.';
  END IF;
END $$;
--> statement-breakpoint
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
/*
 * A tool stamped other than its server is nobody's listing but its stamper's (a squat, or a stale
 * refresh): removed, so every tool left carries its server's stamp (the trigger below keeps it so).
 */
DELETE FROM public.mcp_tools t USING public.mcp_servers s
 WHERE s.id = t.server_id AND t.tenant_id IS DISTINCT FROM s.tenant_id;
--> statement-breakpoint
/*
 * A server stamped with a person who is not an administrator was never added through the admin
 * screens: a planted row, removed rather than shown to the whole team (its tools and the people's
 * connections to it go with it).
 */
DELETE FROM public.mcp_servers s
 WHERE s.tenant_id NOT IN ('system', 'team', 'platform', '')
   AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = s.tenant_id AND r.role = 'admin');
--> statement-breakpoint
/*
 * The secrets the moving servers point at stay sealed to their old stamp, so the broker can never
 * return them and the administrator re-enters each (Q3). Revoked here, so the old secret is not left
 * live for a `platform` read by id, or for a later "find the live one" to land on.
 */
UPDATE public.credentials c SET revoked_at = now(), updated_at = now()
  FROM public.mcp_servers s
 WHERE s.credential_id = c.id AND s.tenant_id NOT IN ('system', 'team')
   AND c.tenant_id <> 'team' AND c.kind::text IN ('mcp', 'mcp_oauth_client') AND c.revoked_at IS NULL;
--> statement-breakpoint
UPDATE public.mcp_servers SET tenant_id = 'team' WHERE tenant_id NOT IN ('system', 'team');
--> statement-breakpoint
UPDATE public.mcp_tools t SET tenant_id = 'team' FROM public.mcp_servers s
 WHERE s.id = t.server_id AND s.tenant_id = 'team' AND t.tenant_id <> 'team';
--> statement-breakpoint
UPDATE public.plugin_grants g SET tenant_id = b.stamp
  FROM (SELECT a.id, CASE WHEN a.tenant_id = 'team'
                            OR EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = a.id AND p.tenant_id = 'team')
                          THEN 'team' ELSE a.tenant_id END AS stamp
          FROM public.agents a WHERE a.tenant_id NOT IN ('system', 'platform', '')) b
 WHERE b.id = g.agent_id AND g.tenant_id <> b.stamp
   AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = g.tenant_id AND r.role = 'admin');
--> statement-breakpoint
DELETE FROM public.plugin_grants g
 USING (SELECT a.id, CASE WHEN a.tenant_id = 'team'
                            OR EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = a.id AND p.tenant_id = 'team')
                          THEN 'team' ELSE a.tenant_id END AS stamp
          FROM public.agents a WHERE a.tenant_id NOT IN ('system', 'platform', '')) b
 WHERE b.id = g.agent_id AND g.tenant_id <> b.stamp;
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
--> statement-breakpoint
/*
 * Team server secrets: an administrator holding the capability, and only a server secret's kinds.
 * Named `team_read` like every other table's read of its `team` rows, but it is NOT a member's read:
 * its predicate is the administrator's (I8).
 */
CREATE POLICY team_read ON public.credentials AS PERMISSIVE FOR SELECT TO public
  USING (tenant_id = 'team' AND kind::text IN ('mcp', 'mcp_oauth_client')
         AND current_setting('app.capability', true) = 'admin'
         AND EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.credentials AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (tenant_id = 'team' AND kind::text IN ('mcp', 'mcp_oauth_client')
              AND current_setting('app.capability', true) = 'admin'
              AND EXISTS (SELECT 1 FROM public.user_roles r
                           WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.credentials AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = 'team' AND kind::text IN ('mcp', 'mcp_oauth_client')
         AND current_setting('app.capability', true) = 'admin'
         AND EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role))
  WITH CHECK (tenant_id = 'team' AND kind::text IN ('mcp', 'mcp_oauth_client')
              AND current_setting('app.capability', true) = 'admin'
              AND EXISTS (SELECT 1 FROM public.user_roles r
                           WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.credentials AS PERMISSIVE FOR DELETE TO public
  USING (tenant_id = 'team' AND kind::text IN ('mcp', 'mcp_oauth_client')
         AND current_setting('app.capability', true) = 'admin'
         AND EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.credentials AS RESTRICTIVE FOR SELECT TO public
  USING (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team');
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.credentials AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team');
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.credentials AS RESTRICTIVE FOR UPDATE TO public
  USING (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team')
  WITH CHECK (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team');
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.credentials AS RESTRICTIVE FOR DELETE TO public
  USING (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team');
--> statement-breakpoint
/*
 * The one door a member has onto a team server's secret: the credential the named team server points
 * at, of a server secret's kind, stamped `team`, for a person's frame. `created_at` is when the client
 * was stored, which the OAuth re-registration backoff is measured against.
 */
CREATE FUNCTION public.openbot_team_server_secret(p_server_id text)
  RETURNS TABLE (id uuid, encrypted_value text, revoked_at timestamptz, tenant_id text,
                 kind public.credential_kind, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT c.id, c.encrypted_value, c.revoked_at, c.tenant_id, c.kind, c.created_at
    FROM public.mcp_servers s JOIN public.credentials c ON c.id = s.credential_id
   WHERE coalesce(current_setting('app.tenant_id', true), '') NOT IN ('system', 'platform', 'team', '')
     AND s.id = p_server_id AND s.tenant_id = 'team'
     AND c.tenant_id = 'team' AND c.kind::text IN ('mcp', 'mcp_oauth_client') $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_server_secret(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_team_server_secret(text) TO openbot_app;
--> statement-breakpoint
/*
 * Whether a grant row may name this Bot with this stamp: a team Bot's grants are `team`, a private
 * Bot's are its owner's, and a catalogue Bot (or none: the foreign key answers that) is not judged.
 * A trigger rather than a definer function called from a policy: a policy's function has to be
 * executable by the application role, and then anybody could call it on its own to learn whether a
 * Bot they cannot see is a team Bot, or whose private Bot it is. A trigger function cannot be called,
 * and its refusal reads exactly like the row-security refusal a wrong stamp would otherwise meet.
 */
CREATE FUNCTION public.openbot_grant_stamp_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  bot_stamp text;
  team_bot boolean;
BEGIN
  IF coalesce(current_setting('app.tenant_id', true), '') = 'platform' THEN
    RETURN NEW;
  END IF;
  SELECT a.tenant_id,
         a.tenant_id = 'team'
           OR EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = a.id AND p.tenant_id = 'team')
    INTO bot_stamp, team_bot
    FROM public.agents a WHERE a.id = NEW.agent_id;
  IF FOUND AND (CASE WHEN team_bot THEN NEW.tenant_id IS DISTINCT FROM 'team'
                     WHEN bot_stamp NOT IN ('system', 'platform', '') THEN NEW.tenant_id IS DISTINCT FROM bot_stamp
                     ELSE false END) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "plugin_grants"'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_grant_stamp_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_grant_stamp_guard BEFORE INSERT ON public.plugin_grants
  FOR EACH ROW EXECUTE FUNCTION public.openbot_grant_stamp_guard();
--> statement-breakpoint
/*
 * No squatting on the deployment's connectors. A server's id (`team:<key>`, `composio-<slug>`, an
 * administrator's custom id) and a tool's (server_id, name) are global keys, and 0072's
 * `tenant_isolation_insert` let any person's frame insert a row stamped with its OWN tenant: a member
 * could take an id or a tool name first, so the administrator's add or refresh then failed on a row
 * nobody else could see, and a squatted tool row carried the member's own effect and destructive
 * flags. Outside `platform` and the catalogue's own `system` frame, a server or tool row can now only
 * be written as `team`, which 0122's `team_write_insert` admits only for an administrator holding the
 * capability. The frame test is written as "not a person, and neither `team` nor unset" (the PERSON
 * fragment, negated), which admits exactly `platform` and `system`. RESTRICTIVE and INSERT-only: an
 * UPDATE cannot change a row's stamp or its server outside `platform` (0122 row guard), and the rows
 * of this kind already in place were settled above.
 */
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['mcp_servers', 'mcp_tools'] LOOP
    EXECUTE format($q$CREATE POLICY connector_stamp_insert ON public.%I AS RESTRICTIVE FOR INSERT TO public
      WITH CHECK (tenant_id = 'team'
                  OR (current_setting('app.tenant_id', true) NOT IN ('system', 'platform', 'team', '')) IS FALSE
                     AND current_setting('app.tenant_id', true) NOT IN ('team', ''))$q$, t);
  END LOOP;
END $$;
--> statement-breakpoint
/*
 * A tool carries its server's stamp, in every frame: a `team` tool on a catalogue (`system`) server
 * would otherwise be an administrator's name taken on the catalogue's shelf, and a tool stamped other
 * than its server is read by nobody who reads the server. A trigger and not a policy, because the
 * server may be hidden from the frame that names it, and a definer function callable from a policy
 * would also be callable on its own (an oracle for hidden server ids). For the same reason a refusal
 * outside `platform` and `system` reads exactly like the row-security refusal it stands beside.
 */
CREATE FUNCTION public.openbot_mcp_tool_stamp_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  server_stamp text;
BEGIN
  SELECT s.tenant_id INTO server_stamp FROM public.mcp_servers s WHERE s.id = NEW.server_id;
  -- No such server: the foreign key answers that.
  IF FOUND AND server_stamp IS DISTINCT FROM NEW.tenant_id THEN
    IF coalesce(current_setting('app.tenant_id', true), '') IN ('platform', 'system') THEN
      RAISE EXCEPTION 'mcp_tools: a tool is stamped % but its server % is stamped %',
        NEW.tenant_id, NEW.server_id, server_stamp USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'new row violates row-level security policy for table "mcp_tools"'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_mcp_tool_stamp_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_mcp_tool_stamp_guard BEFORE INSERT OR UPDATE OF tenant_id, server_id ON public.mcp_tools
  FOR EACH ROW EXECUTE FUNCTION public.openbot_mcp_tool_stamp_guard();

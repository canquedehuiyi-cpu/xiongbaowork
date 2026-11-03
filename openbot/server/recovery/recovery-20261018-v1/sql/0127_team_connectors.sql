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
 * connections (`mcp_user_credentials.server_id`) point at them.
 *
 * SECRETS (I8, R5, Q3). A team server's own token (`mcp`) and the deployment's OAuth client for it
 * (`mcp_oauth_client`, linked the same way: `mcp_servers.credential_id`, written by the plugin store's
 * `writeOAuthClient`) are sealed to `team`. Nobody's frame SELECTs them through the 0072
 * `tenant_isolation` policy (`team` is not a person), and no member policy is added: a member reaches
 * exactly one secret, the one a named team server points at, through
 * `openbot_team_server_secret(server_id)`, and never by id (`readSecret`). An administrator holding the
 * capability reads and writes them, to add, rotate and revoke. Existing credentials are NOT moved:
 * a v2 envelope is bound to its row's tenant (AAD), so a re-stamped row could not be opened. The
 * moved servers keep pointing at their old rows, which the broker does not return; an administrator
 * re-enters or rotates each one once after deploy (the operator step in the release notes).
 *
 * GRANTS (carried forward from P8b, (d)(a)). `plugin_grants` is keyed by (kind, ref, agent_id) with no
 * tenant, and since 0072 anybody could insert a row stamped with their OWN tenant naming any agent
 * id. Such a row offers nothing (`listForAgent` reads only the Bot's own stamp), but it holds the key:
 * the owner's later grant of the same tool was refused on a row the owner could neither see nor
 * delete. So, outside `platform`, a grant may only be written carrying the Bot's own stamp: `team`
 * for a team Bot, the owner's tenant for a private one (an administrator's grant on somebody's
 * private Bot runs in the owner's frame, through `adminActAsOwner`). Catalogue Bots (`system`,
 * `platform`) are left as they were. `openbot_grant_stamp_admissible` is a definer because the Bot
 * may not be visible to the frame that names it (a team Bot published to others, somebody's private
 * Bot), and a check under the caller's row security would answer "no such Bot, so anything goes".
 * RESTRICTIVE and INSERT-only, like 0126: an UPDATE cannot change a grant's stamp or Bot outside
 * `platform` (0122 row guard), so the insert is the only way in.
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
  IF EXISTS (SELECT catalogue_key FROM public.mcp_servers
              WHERE tenant_id <> 'system' AND catalogue_key IS NOT NULL
              GROUP BY catalogue_key HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0127: the same catalogue server is installed by several administrators; remove all but one of them first';
  END IF;
END $$;
--> statement-breakpoint
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE public.mcp_tools t SET tenant_id = 'team' FROM public.mcp_servers s
 WHERE s.id = t.server_id AND s.tenant_id NOT IN ('system', 'team') AND t.tenant_id <> 'team';
--> statement-breakpoint
UPDATE public.mcp_servers SET tenant_id = 'team' WHERE tenant_id NOT IN ('system', 'team');
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
 * Whether a grant row stamped `p_stamp` may name this Bot: a team Bot's grants are `team`, a private
 * Bot's are its owner's, and a catalogue Bot (or none: the foreign key answers that) is not judged.
 */
CREATE FUNCTION public.openbot_grant_stamp_admissible(p_agent_id text, p_stamp text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT coalesce((
    SELECT CASE
             WHEN a.tenant_id = 'team'
               OR EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = a.id AND p.tenant_id = 'team')
               THEN p_stamp IS NOT DISTINCT FROM 'team'
             WHEN a.tenant_id NOT IN ('system', 'platform', '')
               THEN p_stamp IS NOT DISTINCT FROM a.tenant_id
             ELSE true
           END
      FROM public.agents a WHERE a.id = p_agent_id), true) $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_grant_stamp_admissible(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_grant_stamp_admissible(text, text) TO openbot_app;
--> statement-breakpoint
CREATE POLICY grant_stamp_insert ON public.plugin_grants AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (current_setting('app.tenant_id', true) = 'platform'
              OR public.openbot_grant_stamp_admissible(agent_id, tenant_id));

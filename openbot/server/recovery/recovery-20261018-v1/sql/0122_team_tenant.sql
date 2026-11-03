/*
 * G01-E: the shared `team` tenant (policies only, no data moved).
 *
 * Team rows are STAMPED `team` from the writer's own frame and admitted by additive PERMISSIVE
 * policies that carry an ownership predicate (owner, member, or admin with the capability). No frame
 * is ever `team`: the client refuses it, and the RESTRICTIVE `team_frame_refused_*` policies below
 * refuse every command for a session that sets `app.tenant_id = 'team'` by hand. The 0072
 * `tenant_isolation*` policies are untouched.
 *
 * WHY A TRIGGER. PostgreSQL combines the USING clauses of permissive policies and their WITH CHECK
 * clauses independently, so a row admitted by one policy's USING can be written back through another
 * policy's CHECK: a member could re-stamp a shared row into their own tenant, insert their own
 * membership into a stranger's group and then re-stamp it `team`, or move a membership to another
 * channel. `openbot_team_row_guard` (BEFORE UPDATE) is what keeps `tenant_id` and the link columns
 * fixed outside `platform`. The only re-stamp it allows is the owner's explicit Bot move, keyed by
 * the transaction-local `app.team_move = <agent id>`. It also refuses a soft delete of a shared
 * group by anybody but its creator.
 *
 * WHY SECURITY DEFINER. The membership and Bot-visibility questions read FORCE-RLS tables whose rows
 * the asking person cannot see yet (the creator's first membership insert cannot see the channel it
 * is for), so they are answered by functions owned by the migrator, which bypasses row security.
 * Every function pins its `search_path`, is revoked from PUBLIC and granted to `openbot_app` only.
 *
 * `openbot_team_bot_visible` mirrors `src/team-bots/access.ts` (`teamBotAccess`, `describedForTeam`,
 * `PLACEHOLDER_BOT_NAMES`) plus public and owner; tests/team-bot-visibility-parity.integration.test.ts
 * fails when the two disagree.
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0122 must run as a role with BYPASSRLS (owner of the openbot_team_* functions)';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.users ADD CONSTRAINT users_id_not_reserved CHECK (id NOT IN ('system','platform','team'));
--> statement-breakpoint
/*
 * Who opened a channel. Not declared in the Drizzle schema: filled by the DEFAULT from the inserting
 * frame, read only by policies, functions and the trigger. Existing rows stay NULL.
 */
ALTER TABLE public.channels ADD COLUMN created_by text;
--> statement-breakpoint
ALTER TABLE public.channels ALTER COLUMN created_by SET DEFAULT current_setting('app.tenant_id', true);
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_member(p_channel_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT coalesce(current_setting('app.tenant_id', true), '') NOT IN ('system','platform','team','')
     AND EXISTS (SELECT 1 FROM public.channel_memberships m
                  WHERE m.channel_id = p_channel_id AND m.tenant_id = 'team'
                    AND m.user_id = current_setting('app.tenant_id', true)) $f$;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_seedable(p_channel_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT coalesce(current_setting('app.tenant_id', true), '') NOT IN ('system','platform','team','')
     AND EXISTS (SELECT 1 FROM public.channels c WHERE c.id = p_channel_id AND c.tenant_id = 'team'
                  AND c.created_by = current_setting('app.tenant_id', true))
     AND NOT EXISTS (SELECT 1 FROM public.channel_memberships m
                      WHERE m.channel_id = p_channel_id AND m.tenant_id = 'team') $f$;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_creator(p_channel_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT public.openbot_team_channel_member(p_channel_id)
     AND EXISTS (SELECT 1 FROM public.channels c WHERE c.id = p_channel_id AND c.tenant_id = 'team'
                  AND c.created_by = current_setting('app.tenant_id', true)) $f$;
--> statement-breakpoint
/*
 * Mirror of src/team-bots/access.ts teamBotAccess + describedForTeam, plus public and owner, for a
 * live Bot profile stamped `team`. Pinned by tests/team-bot-visibility-parity.integration.test.ts.
 */
CREATE FUNCTION public.openbot_team_bot_visible(p_agent_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  WITH me AS (SELECT coalesce(current_setting('app.tenant_id', true), '') AS id),
       my_groups AS (SELECT coalesce((SELECT u.groups FROM public.users u, me WHERE u.id = me.id), '{}'::text[]) AS g)
  SELECT (SELECT id FROM me) NOT IN ('system','platform','team','')
     AND EXISTS (SELECT 1 FROM public.agent_profiles p, me WHERE p.agent_id = p_agent_id AND p.tenant_id = 'team'
                  AND p.deleted_at IS NULL
                  AND (p.visibility = 'public' OR p.owner_user_id = me.id
                       OR EXISTS (SELECT 1 FROM public.team_bot_publications pub
                                   JOIN public.agents a ON a.id = pub.agent_id
                                  WHERE pub.agent_id = p_agent_id
                                    AND btrim(p.role_description) <> ''
                                    AND lower(btrim(a.name)) NOT IN ('', 'new bot', 'new coworker', 'untitled', 'my bot')
                                    AND (pub.audience = 'team'
                                         OR EXISTS (SELECT 1 FROM public.team_bot_audience au, my_groups
                                                     WHERE au.agent_id = pub.agent_id
                                                       AND ((au.kind = 'user' AND au.value = (SELECT id FROM me))
                                                         OR (au.kind = 'group' AND au.value = ANY(my_groups.g))))
                                         OR EXISTS (SELECT 1 FROM public.team_bot_assignments ta, my_groups
                                                     WHERE ta.agent_id = pub.agent_id
                                                       AND (ta.group_name = '*' OR ta.group_name = ANY(my_groups.g))))))) $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_member(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_team_channel_member(text) TO openbot_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_seedable(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_team_channel_seedable(text) TO openbot_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_creator(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_team_channel_creator(text) TO openbot_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_bot_visible(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_team_bot_visible(text) TO openbot_app;
--> statement-breakpoint
/*
 * Row guard: tenant_id and the link columns named as trigger arguments are fixed outside `platform`.
 * The only re-stamp is an owner's explicit Bot move (app.team_move = agent id, set by the profile
 * store's moveToTeam/moveToOwner) between the owner's tenant and `team`. Every condition is
 * coalesced: an unset GUC or a NULL column is a refusal, never an unknown that lets the row through.
 */
CREATE FUNCTION public.openbot_team_row_guard() RETURNS trigger
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
            AND frame IN (OLD.tenant_id, NEW.tenant_id), false) THEN
      RAISE EXCEPTION 'tenant_id of % is fixed', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  END IF;
  -- TG_ARGV is NULL, not empty, for a trigger created without arguments.
  IF TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col)
         -- A foreign key's ON DELETE SET NULL (agent_profiles.owner_user_id when the user is deleted)
         -- runs inside the referential trigger, one level down; clearing a link that way is allowed.
         AND NOT (pg_trigger_depth() > 1 AND jsonb_typeof(to_jsonb(NEW) -> col) = 'null') THEN
        RAISE EXCEPTION '%.% is fixed', TG_TABLE_NAME, col USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  IF TG_TABLE_NAME = 'channels' AND OLD.tenant_id = 'team'
     AND (to_jsonb(OLD)->>'deleted_at') IS NULL AND (to_jsonb(NEW)->>'deleted_at') IS NOT NULL
     AND (to_jsonb(OLD)->>'created_by') IS DISTINCT FROM frame THEN
    RAISE EXCEPTION 'only the creator deletes a shared group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_row_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.channels
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('created_by');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.channel_memberships
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('channel_id', 'user_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.channel_agents
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('channel_id', 'agent_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.group_messages
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('channel_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.group_bot_threads
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('channel_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard();
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('agent_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.team_bot_publications
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('agent_id', 'published_by');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.team_bot_audience
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('agent_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.team_bot_assignments
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('agent_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.plugin_grants
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('agent_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.approval_team_rules
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard();
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.approval_team_settings
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.mcp_servers
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard();
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.mcp_tools
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('server_id');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.sandboxed_components
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('name');
--> statement-breakpoint
CREATE TRIGGER openbot_team_row_guard BEFORE UPDATE ON public.credentials
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_row_guard('kind');
--> statement-breakpoint
/* RESTRICTIVE refusal of a 'team' frame, per command (keeps rls-write-scope's 4-command count). */
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agents','agent_profiles','team_bot_publications','team_bot_audience',
      'team_bot_assignments','approval_team_rules','approval_team_settings','plugin_grants','mcp_servers',
      'mcp_tools','sandboxed_components','channels','channel_memberships','channel_agents',
      'group_messages','group_bot_threads'] LOOP
    EXECUTE format($q$CREATE POLICY team_frame_refused_select ON public.%I AS RESTRICTIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team')$q$, t);
    EXECUTE format($q$CREATE POLICY team_frame_refused_insert ON public.%I AS RESTRICTIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team')$q$, t);
    EXECUTE format($q$CREATE POLICY team_frame_refused_update ON public.%I AS RESTRICTIVE FOR UPDATE TO public USING (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team') WITH CHECK (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team')$q$, t);
    EXECUTE format($q$CREATE POLICY team_frame_refused_delete ON public.%I AS RESTRICTIVE FOR DELETE TO public USING (current_setting('app.tenant_id', true) IS DISTINCT FROM 'team')$q$, t);
  END LOOP;
END $$;
--> statement-breakpoint
/* Governance reads: any person. */
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['approval_team_rules','approval_team_settings','mcp_servers','mcp_tools'] LOOP
    EXECUTE format($q$CREATE POLICY team_read ON public.%I AS PERMISSIVE FOR SELECT TO public
      USING (tenant_id = 'team' AND current_setting('app.tenant_id', true) NOT IN ('system','platform','team',''))$q$, t);
  END LOOP;
END $$;
--> statement-breakpoint
/*
 * Published components: members read the row (drafts are hidden by projection only, Q15); admins with
 * the capability read unpublished ones too.
 */
CREATE POLICY team_read ON public.sandboxed_components AS PERMISSIVE FOR SELECT TO public
  USING (tenant_id = 'team' AND current_setting('app.tenant_id', true) NOT IN ('system','platform','team','')
         AND (published OR (current_setting('app.capability', true) = 'admin' AND EXISTS (SELECT 1 FROM public.user_roles r
              WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role))));
--> statement-breakpoint
/* Bot and roster reads: only where the Bot is visible to this person (R4). */
DO $$ DECLARE t text; col text; BEGIN
  FOREACH t IN ARRAY ARRAY['agents','team_bot_publications','team_bot_audience',
      'team_bot_assignments','plugin_grants'] LOOP
    col := CASE WHEN t = 'agents' THEN 'id' ELSE 'agent_id' END;
    EXECUTE format($q$CREATE POLICY team_read ON public.%I AS PERMISSIVE FOR SELECT TO public
      USING (tenant_id = 'team' AND public.openbot_team_bot_visible(%I))$q$, t, col);
  END LOOP;
END $$;
--> statement-breakpoint
/*
 * The profile also names its owner on the row itself. An UPDATE whose WHERE reads the table must
 * leave a row that passes the SELECT policies, and the owner's move re-stamps the profile in the very
 * statement the definer function would have to see it in (it reads the snapshot from before the
 * statement, where the profile is not `team` yet). So the owner's branch is read from the new row.
 */
CREATE POLICY team_read ON public.agent_profiles AS PERMISSIVE FOR SELECT TO public
  USING (tenant_id = 'team'
         AND ((owner_user_id = current_setting('app.tenant_id', true)
               AND current_setting('app.tenant_id', true) NOT IN ('system','platform','team',''))
              OR public.openbot_team_bot_visible(agent_id)));
--> statement-breakpoint
/* Admin-written governance rows (ADMIN includes the capability, R6). */
DO $$ DECLARE t text; admin_team text :=
  $a$tenant_id = 'team' AND current_setting('app.capability', true) = 'admin' AND EXISTS (SELECT 1 FROM public.user_roles r
     WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role)$a$;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_team_rules','approval_team_settings','team_bot_assignments',
      'mcp_servers','mcp_tools','sandboxed_components'] LOOP
    EXECUTE format('CREATE POLICY team_write_insert ON public.%I AS PERMISSIVE FOR INSERT TO public WITH CHECK (%s)', t, admin_team);
    EXECUTE format('CREATE POLICY team_write_update ON public.%I AS PERMISSIVE FOR UPDATE TO public USING (%s) WITH CHECK (%s)', t, admin_team, admin_team);
    EXECUTE format('CREATE POLICY team_write_delete ON public.%I AS PERMISSIVE FOR DELETE TO public USING (%s)', t, admin_team);
  END LOOP;
END $$;
--> statement-breakpoint
/* Bots: only the owner moves their own rows (the trigger requires app.team_move as well). */
CREATE POLICY team_write_update ON public.agent_profiles AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = 'team' AND owner_user_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = 'team' AND owner_user_id = current_setting('app.tenant_id', true)
    AND EXISTS (SELECT 1 FROM public.agents a WHERE a.id = agent_profiles.agent_id
                 AND a.tenant_id IN (current_setting('app.tenant_id', true), 'team')));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.agents AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = 'team' AND EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = agents.id
          AND p.owner_user_id = current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = 'team' AND EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = agents.id
          AND p.owner_user_id = current_setting('app.tenant_id', true) AND p.tenant_id = 'team'));
--> statement-breakpoint
/* Publications, audience: the owner. plugin_grants: the owner, or an admin with the capability. */
DO $$ DECLARE t text; owns text; BEGIN
  FOREACH t IN ARRAY ARRAY['team_bot_publications','team_bot_audience','plugin_grants'] LOOP
    owns := format($o$tenant_id = 'team' AND (EXISTS (SELECT 1 FROM public.agent_profiles p
       WHERE p.agent_id = %I.agent_id AND p.tenant_id = 'team' AND p.owner_user_id = current_setting('app.tenant_id', true))%s)$o$, t,
       CASE WHEN t = 'plugin_grants' THEN $x$ OR (current_setting('app.capability', true) = 'admin' AND EXISTS (SELECT 1 FROM public.user_roles r
         WHERE r.user_id = current_setting('app.tenant_id', true) AND r.role = 'admin'::role))$x$ ELSE '' END);
    EXECUTE format('CREATE POLICY team_write_insert ON public.%I AS PERMISSIVE FOR INSERT TO public WITH CHECK (%s)', t, owns);
    EXECUTE format('CREATE POLICY team_write_update ON public.%I AS PERMISSIVE FOR UPDATE TO public USING (%s) WITH CHECK (%s)', t, owns, owns);
    EXECUTE format('CREATE POLICY team_write_delete ON public.%I AS PERMISSIVE FOR DELETE TO public USING (%s)', t, owns);
  END LOOP;
END $$;
--> statement-breakpoint
/* Shared groups: membership-only reads (R21); creator powers through definer functions. */
CREATE POLICY team_read ON public.channels AS PERMISSIVE FOR SELECT TO public
  USING (tenant_id = 'team' AND public.openbot_team_channel_member(id));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.channels AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (tenant_id = 'team' AND created_by = current_setting('app.tenant_id', true)
              AND current_setting('app.tenant_id', true) NOT IN ('system','platform','team',''));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.channels AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = 'team' AND public.openbot_team_channel_member(id))
  WITH CHECK (tenant_id = 'team' AND public.openbot_team_channel_member(id));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.channels AS PERMISSIVE FOR DELETE TO public
  USING (tenant_id = 'team' AND public.openbot_team_channel_creator(id));
--> statement-breakpoint
CREATE POLICY team_read ON public.channel_memberships AS PERMISSIVE FOR SELECT TO public
  USING (tenant_id = 'team' AND public.openbot_team_channel_member(channel_id));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.channel_memberships AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (tenant_id = 'team' AND (public.openbot_team_channel_member(channel_id)
    OR (user_id = current_setting('app.tenant_id', true) AND public.openbot_team_channel_seedable(channel_id))));
--> statement-breakpoint
/* Own row only (markRead, setPinned); channel_id/user_id/tenant_id are frozen by the trigger. */
CREATE POLICY team_write_update ON public.channel_memberships AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = 'team' AND user_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = 'team' AND user_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.channel_memberships AS PERMISSIVE FOR DELETE TO public
  USING (tenant_id = 'team' AND (user_id = current_setting('app.tenant_id', true)
         OR public.openbot_team_channel_creator(channel_id)));
--> statement-breakpoint
DO $$ DECLARE t text; own text; BEGIN
  FOREACH t IN ARRAY ARRAY['channel_agents','group_messages','group_bot_threads'] LOOP
    own := CASE WHEN t = 'channel_agents' THEN '' ELSE ' AND owner_user_id = current_setting(''app.tenant_id'', true)' END;
    EXECUTE format('CREATE POLICY team_read ON public.%I AS PERMISSIVE FOR SELECT TO public USING (tenant_id = ''team'' AND public.openbot_team_channel_member(channel_id))', t);
    EXECUTE format('CREATE POLICY team_write_insert ON public.%I AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = ''team'' AND public.openbot_team_channel_member(channel_id)%s)', t, own);
    EXECUTE format('CREATE POLICY team_write_update ON public.%I AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = ''team'' AND public.openbot_team_channel_member(channel_id)%s) WITH CHECK (tenant_id = ''team'' AND public.openbot_team_channel_member(channel_id)%s)', t, own, own);
    EXECUTE format('CREATE POLICY team_write_delete ON public.%I AS PERMISSIVE FOR DELETE TO public USING (tenant_id = ''team'' AND public.openbot_team_channel_member(channel_id)%s)', t, own);
  END LOOP;
END $$;
--> statement-breakpoint
/*
 * A Bot moved to `team` keeps its owner's child rows: ADDITIVE copies of the owner policies (the
 * originals stay byte-identical). Each copy keeps `tenant_id = current_setting(...)`, so the child row
 * is always the writer's own, and names the parent `team` row owned by that writer.
 */
CREATE POLICY agent_security_team_bot_select ON public.agent_security_policies AS PERMISSIVE FOR SELECT TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_policies.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_policies.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_insert ON public.agent_security_policies AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_policies.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_policies.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_update ON public.agent_security_policies AS PERMISSIVE FOR UPDATE TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_policies.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_policies.tenant_id AND p.deleted_at IS NULL)))
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_policies.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_policies.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_delete ON public.agent_security_policies AS PERMISSIVE FOR DELETE TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (EXISTS (SELECT 1 FROM public.agent_profiles p
    WHERE p.agent_id = agent_security_policies.agent_id AND p.tenant_id = 'team'
      AND p.owner_user_id = agent_security_policies.tenant_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY knowledge_binding_team_bot_insert ON public.knowledge_bindings AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (owner_user_id = tenant_id)
    AND (EXISTS (SELECT 1 FROM public.knowledge_notebooks n
      WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id
        AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL))
    AND (EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_profiles p ON p.agent_id = a.id
      WHERE a.id = knowledge_bindings.agent_id AND (a.tenant_id = 'team') AND (p.tenant_id = 'team')
        AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY knowledge_binding_team_bot_update ON public.knowledge_bindings AS PERMISSIVE FOR UPDATE TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (owner_user_id = tenant_id))
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (owner_user_id = tenant_id)
    AND (EXISTS (SELECT 1 FROM public.knowledge_notebooks n
      WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id
        AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL))
    AND (EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_profiles p ON p.agent_id = a.id
      WHERE a.id = knowledge_bindings.agent_id AND (a.tenant_id = 'team') AND (p.tenant_id = 'team')
        AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY knowledge_head_team_bot_insert ON public.knowledge_binding_heads AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (owner_user_id = tenant_id)
    AND (EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_profiles p ON p.agent_id = a.id
      WHERE a.id = knowledge_binding_heads.agent_id AND (a.tenant_id = 'team') AND (p.tenant_id = 'team')
        AND p.owner_user_id = knowledge_binding_heads.owner_user_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY knowledge_head_team_bot_update ON public.knowledge_binding_heads AS PERMISSIVE FOR UPDATE TO public
  USING ((tenant_id = current_setting('app.tenant_id', true)) AND (owner_user_id = tenant_id))
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true)) AND (owner_user_id = tenant_id)
    AND (EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_profiles p ON p.agent_id = a.id
      WHERE a.id = knowledge_binding_heads.agent_id AND (a.tenant_id = 'team') AND (p.tenant_id = 'team')
        AND p.owner_user_id = knowledge_binding_heads.owner_user_id AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY project_team_bot_insert ON public.resource_projects AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true))
    AND (EXISTS (SELECT 1 FROM public.registered_devices d
      WHERE d.id = resource_projects.device_id AND d.tenant_id = resource_projects.tenant_id))
    AND ((scope = 'public') OR (EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_profiles p ON p.agent_id = a.id
      WHERE a.id = resource_projects.agent_id AND (a.tenant_id = 'team') AND (p.tenant_id = 'team')
        AND p.owner_user_id = resource_projects.tenant_id AND p.deleted_at IS NULL))));
--> statement-breakpoint
CREATE POLICY project_team_bot_update ON public.resource_projects AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true))
    AND (EXISTS (SELECT 1 FROM public.registered_devices d
      WHERE d.id = resource_projects.device_id AND d.tenant_id = resource_projects.tenant_id))
    AND ((scope = 'public') OR (EXISTS (SELECT 1 FROM public.agents a JOIN public.agent_profiles p ON p.agent_id = a.id
      WHERE a.id = resource_projects.agent_id AND (a.tenant_id = 'team') AND (p.tenant_id = 'team')
        AND p.owner_user_id = resource_projects.tenant_id AND p.deleted_at IS NULL))));
--> statement-breakpoint
CREATE POLICY project_binding_team_bot_insert ON public.project_context_bindings AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true))
    AND (EXISTS (SELECT 1 FROM public.registered_devices d
      WHERE d.id = project_context_bindings.device_id AND d.tenant_id = project_context_bindings.tenant_id))
    AND (EXISTS (SELECT 1 FROM public.agents a
      WHERE a.id = project_context_bindings.agent_id AND (a.tenant_id = 'team')
        AND EXISTS (SELECT 1 FROM public.agent_profiles q WHERE q.agent_id = a.id
          AND q.tenant_id = 'team' AND q.owner_user_id = project_context_bindings.tenant_id)))
    AND (EXISTS (SELECT 1 FROM public.resource_projects p
      WHERE p.id = project_context_bindings.project_id AND p.tenant_id = project_context_bindings.tenant_id
        AND p.device_id = project_context_bindings.device_id
        AND (p.scope = 'public' OR p.agent_id = project_context_bindings.agent_id))));
--> statement-breakpoint
CREATE POLICY project_binding_team_bot_update ON public.project_context_bindings AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK ((tenant_id = current_setting('app.tenant_id', true))
    AND (EXISTS (SELECT 1 FROM public.registered_devices d
      WHERE d.id = project_context_bindings.device_id AND d.tenant_id = project_context_bindings.tenant_id))
    AND (EXISTS (SELECT 1 FROM public.agents a
      WHERE a.id = project_context_bindings.agent_id AND (a.tenant_id = 'team')
        AND EXISTS (SELECT 1 FROM public.agent_profiles q WHERE q.agent_id = a.id
          AND q.tenant_id = 'team' AND q.owner_user_id = project_context_bindings.tenant_id)))
    AND (EXISTS (SELECT 1 FROM public.resource_projects p
      WHERE p.id = project_context_bindings.project_id AND p.tenant_id = project_context_bindings.tenant_id
        AND p.device_id = project_context_bindings.device_id
        AND (p.scope = 'public' OR p.agent_id = project_context_bindings.agent_id))));

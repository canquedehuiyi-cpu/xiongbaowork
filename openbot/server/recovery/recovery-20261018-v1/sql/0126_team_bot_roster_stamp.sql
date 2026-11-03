/*
 * G01-E P9: a Team Bot's publication, audience and assignment rows are stamped `team`, or not at all.
 *
 * The three tables are keyed by agent id: a publication by `agent_id` alone, audience by
 * (agent_id, kind, value), assignments by (agent_id, group_name). Since 0072 anybody could insert a
 * row stamped with their OWN tenant naming any agent id (`tenant_isolation_insert`). After 0122 and
 * 0125 such a row grants nothing: `openbot_team_bot_visible` and `team_read` count only `team` rows.
 * But it still holds the key. A stranger's own "publication" of somebody's unpublished Bot made the
 * owner's later publish fail on a row the owner could neither see nor delete. A stranger's audience
 * row did the same to the owner's audience. A stranger's '*' assignment made an administrator's
 * assignment of that group silently do nothing (ON CONFLICT DO NOTHING).
 *
 * So, outside `platform`, a row of these tables may only be written stamped `team`. Who may write a
 * `team` row is already decided by 0122's `team_write_*` policies: the Bot's owner for the
 * publication and audience, an administrator with the capability for assignments. No frame is ever
 * `team` (I3), so `tenant_isolation_insert` no longer admits anything here. RESTRICTIVE and per
 * command, like `team_frame_refused_*`, so every table still answers exactly four commands
 * (rls-write-scope). An UPDATE cannot change a stamp outside `platform` (0122 row guard), so the
 * insert is the only way in.
 *
 * The rows already there that are not stamped `team` are removed. Every legitimate one was moved by
 * 0125 (a publication, audience row or assignment its rightful writer stamped, of a Bot that moved to
 * `team`). What is left is either a stranger's row, or a row of a Bot that did not move: deleted,
 * ownerless, or catalogue. Nothing reads any of these, and each one could still block a key. The
 * deletes run as `platform`, set locally like 0123 and 0125 and cleared afterwards, so they reach
 * every row whether or not the migrating role bypasses row security.
 *
 * Numbering: the plan reserved 0126 for P10 (team connectors). P9 landed first and takes 0126; P10
 * becomes 0127 with a later `when`.
 */
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
DELETE FROM public.team_bot_publications WHERE tenant_id <> 'team';
--> statement-breakpoint
DELETE FROM public.team_bot_audience WHERE tenant_id <> 'team';
--> statement-breakpoint
DELETE FROM public.team_bot_assignments WHERE tenant_id <> 'team';
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['team_bot_publications','team_bot_audience','team_bot_assignments'] LOOP
    EXECUTE format($q$CREATE POLICY team_roster_stamp_insert ON public.%I AS RESTRICTIVE FOR INSERT TO public
      WITH CHECK (tenant_id = 'team' OR current_setting('app.tenant_id', true) = 'platform')$q$, t);
  END LOOP;
END $$;

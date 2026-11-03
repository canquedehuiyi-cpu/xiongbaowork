/*
 * G01-E P11: a shared group may only be given a Bot its member could use anyway.
 *
 * 0122 let any member of a `team` group write a `channel_agents` row for that group naming ANY agent
 * id (`team_write_insert` / `team_write_update` checked the membership only). Groups are written as
 * `team` from P11 on, and the group's roster is read through `channel_agents`, so a member could have
 * put another person's private Bot, or a Team Bot published to an audience they are not in, into a
 * group that every member reads: the Bot's id and name on everybody's roster, and a seat the
 * group's turns are offered to. The application already refuses this (the channel store validates
 * every Bot through the profile store, in the creator's frame); the database now refuses it too.
 *
 * A member links a Bot only when, in the member's own frame, it is:
 *  - visible to them as a Team Bot (`openbot_team_bot_visible`: public, theirs, or published to an
 *    audience or assignment that includes them, the same function the Bot tables' `team_read` uses);
 *  - their own private Bot (stamped with their own tenant); or
 *  - a catalogue Bot (`system`): readable by every person (I1) and nobody's private Bot, so linking
 *    one shows the group nothing its members cannot already read.
 * The second and third are read through the member's own row security on `agents`, which admits
 * exactly those two stamps besides `team`, so the subquery cannot see (and so cannot admit) anybody
 * else's private Bot.
 *
 * The UPDATE policy gets the same check: a link's `agent_id` and `channel_id` are frozen by the 0122
 * row guard outside `platform`, so an update cannot swap the Bot either way, and the check keeps the
 * two policies saying the same thing. Rows already written are not re-checked (no code wrote a
 * `team` group before P11). The membership condition and the stamp are unchanged.
 */
ALTER POLICY team_write_insert ON public.channel_agents
  WITH CHECK (tenant_id = 'team' AND public.openbot_team_channel_member(channel_id)
              AND (public.openbot_team_bot_visible(agent_id)
                   OR EXISTS (SELECT 1 FROM public.agents a
                               WHERE a.id = channel_agents.agent_id
                                 AND a.tenant_id IN (current_setting('app.tenant_id', true), 'system'))));
--> statement-breakpoint
ALTER POLICY team_write_update ON public.channel_agents
  USING (tenant_id = 'team' AND public.openbot_team_channel_member(channel_id))
  WITH CHECK (tenant_id = 'team' AND public.openbot_team_channel_member(channel_id)
              AND (public.openbot_team_bot_visible(agent_id)
                   OR EXISTS (SELECT 1 FROM public.agents a
                               WHERE a.id = channel_agents.agent_id
                                 AND a.tenant_id IN (current_setting('app.tenant_id', true), 'system'))));

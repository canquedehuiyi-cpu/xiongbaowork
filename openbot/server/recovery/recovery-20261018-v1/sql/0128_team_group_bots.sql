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
 *
 * The rest of this file closes what the P11 review found in the same group tables: rows stamped
 * with one person that name another (squatting an invitee's or a turn's key), held and running Bot
 * replies readable by every member, a member unlinking any Bot, and a member renaming the group.
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
--> statement-breakpoint
/*
 * A ROW STAMPED WITH A PERSON NAMES THAT PERSON (P11 review).
 *
 * The keys of a person's place in a group are global: `intelligence_channel_mappings` (user_id,
 * channel_id), `channel_memberships` (channel_id, user_id), `group_bot_threads` (owner_user_id,
 * channel_id, agent_id), and `group_messages` by id. The 0072 `tenant_isolation_insert` checks only
 * the stamp, so anybody who knew a group id could write a row stamped with THEMSELVES that named
 * somebody else: a mapping or membership for a person about to be invited (whose own insert then
 * conflicts with a row they cannot see, so they are locked out for good, and `addMember` reports a
 * membership it never wrote), or a Bot thread under somebody else's key (whose turn then fails).
 *
 * These RESTRICTIVE policies narrow every INSERT and UPDATE on those tables: a row whose stamp is a
 * person (a `users.id`) must name that same person. They change nothing else:
 *  - `team` rows are not a person's stamp (`users.id` is never `team`, 0122), so the 0122 team
 *    policies alone decide them: any member may add a member, a group row names its writer;
 *  - the `platform` frame (admin and background work) is not narrowed;
 *  - a `system` row (the unframed fallback, removed in P16) is nobody's stamp either.
 * `users` has no row security, so the subquery reads the same answer in every frame. The new
 * sender-only table below gets the same policy.
 *
 * Rows already written that break the rule are deleted first: they can only be squats (the person
 * they name can never read a row stamped with somebody else) or pre-P11 leftovers of the same shape,
 * and either one blocks the named person's real row.
 */
DO $$ DECLARE t text; col text; BEGIN
  FOR t, col IN SELECT * FROM (VALUES ('intelligence_channel_mappings', 'user_id'),
                                      ('channel_memberships', 'user_id'),
                                      ('group_bot_threads', 'owner_user_id'),
                                      ('group_messages', 'owner_user_id')) AS v(t, col) LOOP
    EXECUTE format('DELETE FROM public.%1$I WHERE %2$I IS DISTINCT FROM tenant_id
                     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = %1$I.tenant_id)', t, col);
  END LOOP;
END $$;
--> statement-breakpoint
/*
 * Held and running Bot replies (P11 review). A group's rows are `team`, so every member reads the
 * whole of each one. A Bot reply that its sender has not allowed to be shown yet (the private-share
 * hold: the reply text and its approval continuation), the reply's partial text while the Bot is
 * still running, and the details of a turn that is waiting on its sender (approval ids, the saved
 * continuation with the conversation so far) must not sit in a row the group reads. They live here,
 * in a row stamped with the sender and read by nobody else; the shared row keeps only the status and
 * what the transcript shows every member. Allowing the share writes the final text into the shared
 * row and deletes this one.
 *
 * Keyed by the message, and tied to its sender by the foreign key on (message_id, owner_user_id):
 * the row must be for a message of the person it names, and (policy below) stamped with them, so
 * nobody can occupy another person's key. There is no `system` read branch: a held reply is never
 * a catalogue row, whatever frame wrote it.
 */
ALTER TABLE public.group_messages ADD CONSTRAINT group_messages_id_owner_unique UNIQUE (id, owner_user_id);
--> statement-breakpoint
CREATE TABLE public.group_message_private (
  message_id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  tenant_id text NOT NULL DEFAULT current_setting('app.tenant_id', true),
  text text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT group_message_private_message_fk FOREIGN KEY (message_id, owner_user_id)
    REFERENCES public.group_messages (id, owner_user_id) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE public.group_message_private ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.group_message_private FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.group_message_private AS PERMISSIVE FOR SELECT TO public
  USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.group_message_private AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.group_message_private AS PERMISSIVE FOR UPDATE TO public
  USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform')
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.group_message_private AS PERMISSIVE FOR DELETE TO public
  USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_message_private TO openbot_app;
--> statement-breakpoint
DO $$ DECLARE t text; col text; named text; BEGIN
  FOR t, col IN SELECT * FROM (VALUES ('intelligence_channel_mappings', 'user_id'),
                                      ('channel_memberships', 'user_id'),
                                      ('group_bot_threads', 'owner_user_id'),
                                      ('group_messages', 'owner_user_id'),
                                      ('group_message_private', 'owner_user_id')) AS v(t, col) LOOP
    named := format($n$(%2$I = tenant_id OR current_setting('app.tenant_id', true) = 'platform'
                        OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = %1$I.tenant_id))$n$, t, col);
    EXECUTE format('CREATE POLICY stamp_names_person_insert ON public.%I AS RESTRICTIVE FOR INSERT TO public WITH CHECK %s', t, named);
    EXECUTE format('CREATE POLICY stamp_names_person_update ON public.%I AS RESTRICTIVE FOR UPDATE TO public USING (true) WITH CHECK %s', t, named);
  END LOOP;
END $$;
--> statement-breakpoint
/*
 * Only the creator takes a Bot out of a shared group (P11 review). 0122 let any member delete any
 * `channel_agents` row of the group, so one member could unlink the Bots everybody else talks to.
 * Linking stays any member's (0128 above limits which Bots).
 */
ALTER POLICY team_write_delete ON public.channel_agents
  USING (tenant_id = 'team' AND public.openbot_team_channel_creator(channel_id));
--> statement-breakpoint
/*
 * What a member may change on a shared group's `channels` row (P11 review). 0122's team_write_update
 * admits any member, and its row guard freezes only the stamp, `created_by` and (for anybody but the
 * creator) `deleted_at`, so a member could rename the group for everybody, forge its summary, or set
 * `package_id`, which makes the creator's delete refuse the group as package-owned. Outside
 * `platform`, on a `team` channel:
 *  - any member moves the activity columns `recordActivity` writes (last_message*, updated_at), and
 *    the creator `deleted_at` (the 0122 guard);
 *  - only the creator changes the name, description, suggested prompts or summary (no route renames
 *    a group today; summaries skip team groups, Q11);
 *  - nobody changes anything else (`package_id`, `override`, `allowed_groups`, `created_at`, `id`,
 *    and any column added later).
 */
CREATE FUNCTION public.openbot_team_channel_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
  activity text[] := ARRAY['last_message', 'last_message_at', 'last_message_agent_id',
                           'last_message_source_id', 'updated_at', 'deleted_at'];
  creator_only text[] := ARRAY['name', 'description', 'suggested_prompts', 'summary', 'summary_at'];
  before jsonb;
  after jsonb;
BEGIN
  IF frame = 'platform' OR OLD.tenant_id IS DISTINCT FROM 'team' THEN RETURN NEW; END IF;
  before := to_jsonb(OLD) - activity;
  after := to_jsonb(NEW) - activity;
  IF before IS NOT DISTINCT FROM after THEN RETURN NEW; END IF;
  IF (before - creator_only) IS DISTINCT FROM (after - creator_only) THEN
    RAISE EXCEPTION 'only the activity columns of a shared group change' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(OLD)->>'created_by') IS DISTINCT FROM frame THEN
    RAISE EXCEPTION 'only the creator renames or describes a shared group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_team_channel_guard BEFORE UPDATE ON public.channels
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_channel_guard();

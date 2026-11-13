/*
 * 群组与群聊合一（PR1）：会话挂一条群组记录（`channels.waker_group_id`）。
 *
 * 归属规则（全文叫「所有者」）：共享群（`tenant_id = 'team'`）的所有者是 `created_by`，个人的多员工频道的
 * 所有者是 `tenant_id`。被挂的群组必须属于所有者，并且不是 WakerFlow 内部群组。
 *
 * 三件事：
 *  1. 新列与两条索引。外键 `ON DELETE SET NULL`：删群组不连带硬删频道，现有的删群组接口照旧能删。
 *     部分唯一索引只数未删的频道：一个群组同一时刻只对应一个活着的群聊，软删后可以重新开一个。
 *     新列不进 Drizzle schema，读写走 `sql` 片段（同 0122 的 `created_by`）。
 *  2. 改写共享群守卫 `openbot_team_channel_guard`（以 0179 为底，原有规则一字不动）。0128 的守卫把
 *     「以后加的列」一律冻住，不改它创建者写不进新列，外键的 `SET NULL` 也会被拒。只加两条放行：
 *     (a) 补挂：旧值为空，当前帧是创建者；
 *     (b) 解挂：新值为空，在外键动作里（`pg_trigger_depth() > 1`），且旧值指向的群组已经不存在
 *         （仿照 0122 对 `agent_profiles.owner_user_id` 的特例：只看深度不够，会话可以自己嵌一层触发器）。
 *     其余（改指、成员挂或解）在 `platform` 帧以外一律拒绝。
 *  3. 挂接校验触发器 `openbot_channel_waker_group_link`。故意不用 SECURITY DEFINER：借当前帧的
 *     RLS 判断「是不是你的群组」。外键检查绕过 RLS，没有它就能拿别人的群组 id 去挂。
 *
 * 为什么「群组已不存在」要单独一个 SECURITY DEFINER 函数：守卫本身不是 SECURITY DEFINER，在成员帧里
 * 直接查 `waker_groups` 会因 RLS 读不到创建者的群组，误判为「已不存在」，成员就能把挂接置空。
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0205 must run as a role with BYPASSRLS (owner of the openbot_team_* functions)';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.channels ADD COLUMN waker_group_id uuid REFERENCES public.waker_groups(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX channels_waker_group_live_idx ON public.channels (waker_group_id)
  WHERE waker_group_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX channels_waker_group_idx ON public.channels (waker_group_id) WHERE waker_group_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION public.openbot_waker_group_absent(p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  SELECT NOT EXISTS (SELECT 1 FROM public.waker_groups WHERE id = p_id) $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_waker_group_absent(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_waker_group_absent(uuid) TO openbot_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openbot_team_channel_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
  activity text[] := ARRAY['last_message', 'last_message_at', 'last_message_agent_id',
                           'last_message_source_id', 'updated_at', 'deleted_at', 'opening'];
  creator_only text[] := ARRAY['name', 'description', 'suggested_prompts', 'summary', 'summary_at',
                               'title'];
  before jsonb;
  after jsonb;
BEGIN
  IF frame = 'platform' OR OLD.tenant_id IS DISTINCT FROM 'team' THEN RETURN NEW; END IF;
  IF OLD.waker_group_id IS DISTINCT FROM NEW.waker_group_id THEN
    IF NOT (coalesce(OLD.waker_group_id IS NULL AND (to_jsonb(OLD)->>'created_by') = frame, false)
            OR coalesce(NEW.waker_group_id IS NULL AND pg_trigger_depth() > 1
                        AND public.openbot_waker_group_absent(OLD.waker_group_id), false)) THEN
      RAISE EXCEPTION 'only the creator links a shared group to its crew' USING ERRCODE = '42501';
    END IF;
  END IF;
  before := to_jsonb(OLD) - activity - 'waker_group_id';
  after := to_jsonb(NEW) - activity - 'waker_group_id';
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
CREATE FUNCTION public.openbot_channel_waker_group_link() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
  owner text;
BEGIN
  IF frame = 'platform' OR NEW.waker_group_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.waker_group_id IS NOT DISTINCT FROM NEW.waker_group_id THEN RETURN NEW; END IF;
  owner := CASE WHEN NEW.tenant_id = 'team' THEN to_jsonb(NEW)->>'created_by' ELSE NEW.tenant_id END;
  -- Read in the current frame on purpose: a crew this frame cannot see is not the owner's.
  IF NOT coalesce(owner IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.waker_groups g WHERE g.id = NEW.waker_group_id AND g.tenant_id = owner)
         AND NOT EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.group_id = NEW.waker_group_id), false) THEN
    RAISE EXCEPTION 'a conversation links only to a crew of its owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_channel_waker_group_link() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_channel_waker_group_link BEFORE INSERT OR UPDATE OF waker_group_id ON public.channels
  FOR EACH ROW EXECUTE FUNCTION public.openbot_channel_waker_group_link();

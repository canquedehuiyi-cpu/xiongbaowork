/*
 * M5：共享群组（`team` 会话）的行守卫认得上游新加的两列。
 *
 * 0128 的守卫把守卫列表之外「以后加的列」一律冻住，所以合进来的两列在共享群组上谁也改不了：
 *  - `opening`（上游 0077，本仓库 0170）：本人的第一句话，`recordActivity` 在写最后一条消息时顺手写入，
 *    和 last_message* 一样是活动列。没有它，成员在共享群组里说的第一句话会被守卫拒掉。
 *  - `title`（上游 0086 / #1393，本仓库 0176）：本人起的会话名，和 name、summary 一样只有创建者能改，
 *    改名路由本身也只放行创建者。
 * 其余照旧：`platform` 帧之外，其它列谁也不能改。
 */
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

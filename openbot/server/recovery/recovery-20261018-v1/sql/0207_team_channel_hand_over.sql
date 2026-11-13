/*
 * 群组与群聊合一（PR1，设计稿 3.1.1）：共享群的创建者退群或被停用后，群组移交给群里最早的在籍成员。
 *
 * 接手人：仍在群里（`channel_memberships`）、账号未停用（`lower(users.email)` 不在 `revoked_access`）的人类
 * 成员中，`channel_memberships.created_at` 最早的那位，平手按 `users.email` 升序。与上游 `people()` 的排序
 * 相同（S/channels/group.ts 的 `people`），上游界面和 `creatorOnly` 认的「发起人」就是 `people()[0]`。
 * 没有接手人时：一个成员都不剩就软删聊天（群组仍归原主，变成「未开始聊天」）；只剩停用的成员就什么都不改。
 * 挂接的群组有未结束的运行（`running`、`awaiting_action`）时报 55006，什么都不改。
 *
 * 为什么不改守卫：`created_by` 被两道守卫冻住，都只放行 `platform` 帧——`openbot_team_row_guard('created_by')`
 * （0122:116-160，现行函数体 0125:69-113 / 0128）与 `openbot_team_channel_guard`（0206:44-73）。0128 的注释
 * 要求改共享群的行在 `platform` 帧里做。所以守卫一行不改，由写入函数切到 `platform` 帧。
 *
 * 为什么用函数级 `SET app.tenant_id = 'platform'`：PostgreSQL 在函数退出或出错时自动还原，调用方的帧不受
 * 影响；不用 0114 那种保存再还原的写法（出错路径还原不了）。只有写入函数这样切帧。
 *
 * 为什么只有一个函数授权给应用：写入、判定（core）、停用三个函数都能在调用方给不出的条件下改所有权，
 * 只有同一属主的函数能调。应用只拿到 `openbot_team_channel_hand_over`：先校验身份（`platform`、
 * `created_by` 本人或现任成员；陌生人与频道不存在报同一个 42501，校验前不加锁），再调 core。现任成员调它
 * 只能让已经发生的离开按规则落地：`created_by` 仍在籍且未停用时 core 什么都不改。接手人由数据库选，调用方
 * 只传频道 id。
 *
 * 为什么挂在 `revoked_access` 上：SCIM 停用、管理员移除、平台停用租户三条路径唯一的共同点是插入这张表
 * （S/auth/scim.ts、S/people/store.ts、S/platform/store.ts），停用生效就在那一刻，移交与插入同一个事务。
 * 这张表没有 RLS（没有 tenant_id），应用本来就能以任何帧写它，写进去就等于把这个人拒之门外，这是现有的
 * 信任边界；触发器的结果是确定的规则（停用的人离开所有共享群，他创建的群交给最早的在籍成员），不接受
 * 调用方给的任何参数，没有扩大这个边界。停用不能失败：遇到 55006 只跳过那一个群，留给自愈点。
 * 恢复（删 `revoked_access` 行）没有触发器：不还群组，也不把人加回群。
 *
 * 搬什么（设计稿 3.1.1 第 5 条，全部跟走，每条都限原主的 tenant_id）：`channels.created_by`；`waker_groups`
 * （撞名按 4.4 加「（2）」…「（99）」，再撞加 id 前 6 位）；群组的 `portraits`、`portrait_media`（先删接手人
 * 名下同键的残行）；`group_task_templates`；`group_task_runs` 以及它们的父卡、步骤卡（`tasks`）、卡的
 * `task_archives`、`group_pipeline_start_receipts`、`flow_confirmations`、`flow_run_events`、`flow_run_retries`。
 * 不搬：`usage_counters`（已消耗的额度记在当时发起的人名下）、审批、`audit_events`、`group_bot_threads`、
 * `waker_group_members`（随父行）。
 *
 * 已软删的频道不移交（core 原样返回 `created_by`）：同一个群组可能还挂着一个新开的聊天，旧聊天的成员不能
 * 把群组从新聊天的所有者手里带走。
 *
 * 存量补做（文件最后一条）：对迁移前已经停用的人各做一次，让他们离开共享群并移交他们创建的群。可重复执行：
 * 已停用的人已不在任何共享群里。
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0207 must run as a role with BYPASSRLS (owner of the openbot_team_* functions)';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_hand_over_write(p_channel_id text, p_from text, p_heir text, p_group_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET app.tenant_id = 'platform' AS $f$
DECLARE
  original text;
  candidate text;
  suffix text;
  attempt int := 1;
  runs uuid[];
  cards uuid[];
BEGIN
  IF p_heir IS NULL THEN
    UPDATE public.channels SET deleted_at = now() WHERE id = p_channel_id AND deleted_at IS NULL;
    RETURN;
  END IF;
  UPDATE public.channels SET created_by = p_heir WHERE id = p_channel_id;
  IF p_group_id IS NULL THEN RETURN; END IF;
  SELECT name INTO original FROM public.waker_groups WHERE id = p_group_id AND tenant_id = p_from FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  LOOP
    IF attempt = 1 THEN
      candidate := original;
    ELSIF attempt <= 99 THEN
      suffix := '（' || attempt || '）';
      candidate := left(original, 80 - length(suffix)) || suffix;
    ELSE
      candidate := left(original, 74) || left(p_group_id::text, 6);
    END IF;
    BEGIN
      UPDATE public.waker_groups SET tenant_id = p_heir, name = candidate, updated_at = now()
       WHERE id = p_group_id AND tenant_id = p_from;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= 100 THEN RAISE; END IF;
    END;
    attempt := attempt + 1;
  END LOOP;

  DELETE FROM public.portraits WHERE tenant_id = p_heir AND subject_kind = 'group' AND subject_id = p_group_id::text;
  UPDATE public.portraits SET tenant_id = p_heir
   WHERE tenant_id = p_from AND subject_kind = 'group' AND subject_id = p_group_id::text;
  DELETE FROM public.portrait_media WHERE tenant_id = p_heir AND subject_kind = 'group' AND subject_id = p_group_id::text;
  UPDATE public.portrait_media SET tenant_id = p_heir
   WHERE tenant_id = p_from AND subject_kind = 'group' AND subject_id = p_group_id::text;

  UPDATE public.group_task_templates SET tenant_id = p_heir WHERE group_id = p_group_id AND tenant_id = p_from;

  runs := ARRAY(SELECT id FROM public.group_task_runs WHERE group_id = p_group_id AND tenant_id = p_from);
  -- The parent cards, the step cards filed under them, and any step card a run points at by id.
  cards := ARRAY(
    SELECT t.id FROM public.tasks t
     WHERE t.tenant_id = p_from
       AND (t.id IN (SELECT r.parent_task_id FROM public.group_task_runs r WHERE r.id = ANY (runs))
            OR t.parent_task_id IN (SELECT r.parent_task_id FROM public.group_task_runs r WHERE r.id = ANY (runs))
            OR t.id IN (SELECT (s->>'taskId')::uuid
                          FROM public.group_task_runs r,
                               jsonb_array_elements(CASE WHEN jsonb_typeof(r.steps) = 'array' THEN r.steps ELSE '[]'::jsonb END) s
                         WHERE r.id = ANY (runs)
                           AND s->>'taskId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')));
  UPDATE public.group_task_runs SET tenant_id = p_heir WHERE id = ANY (runs) AND tenant_id = p_from;
  UPDATE public.tasks SET tenant_id = p_heir WHERE id = ANY (cards) AND tenant_id = p_from;
  UPDATE public.task_archives SET tenant_id = p_heir WHERE task_id = ANY (cards) AND tenant_id = p_from;
  UPDATE public.group_pipeline_start_receipts SET tenant_id = p_heir WHERE run_id = ANY (runs) AND tenant_id = p_from;
  UPDATE public.flow_confirmations SET tenant_id = p_heir WHERE run_id = ANY (runs) AND tenant_id = p_from;
  UPDATE public.flow_run_events SET tenant_id = p_heir WHERE run_id = ANY (runs) AND tenant_id = p_from;
  UPDATE public.flow_run_retries SET tenant_id = p_heir
   WHERE (source_run_id = ANY (runs) OR new_run_id = ANY (runs)) AND tenant_id = p_from;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_hand_over_write(text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_hand_over_core(p_channel_id text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  c record;
  heir text;
BEGIN
  SELECT id, tenant_id, created_by, waker_group_id, deleted_at INTO c
    FROM public.channels WHERE id = p_channel_id FOR UPDATE;
  IF NOT FOUND OR c.tenant_id IS DISTINCT FROM 'team' OR c.created_by IS NULL THEN RETURN NULL; END IF;
  IF c.deleted_at IS NOT NULL THEN RETURN c.created_by; END IF;
  IF EXISTS (SELECT 1 FROM public.channel_memberships m
              WHERE m.channel_id = c.id AND m.tenant_id = 'team' AND m.user_id = c.created_by)
     AND NOT EXISTS (SELECT 1 FROM public.users u JOIN public.revoked_access r ON r.email = lower(u.email)
                      WHERE u.id = c.created_by) THEN
    RETURN c.created_by;
  END IF;
  SELECT m.user_id INTO heir
    FROM public.channel_memberships m JOIN public.users u ON u.id = m.user_id
   WHERE m.channel_id = c.id AND m.tenant_id = 'team'
     AND NOT EXISTS (SELECT 1 FROM public.revoked_access r WHERE r.email = lower(u.email))
   ORDER BY m.created_at, u.email
   LIMIT 1;
  IF heir IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.channel_memberships m WHERE m.channel_id = c.id AND m.tenant_id = 'team') THEN
      PERFORM public.openbot_team_channel_hand_over_write(c.id, c.created_by, NULL, NULL);
      RETURN NULL;
    END IF;
    RETURN c.created_by;
  END IF;
  IF c.waker_group_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.group_task_runs r
                  WHERE r.group_id = c.waker_group_id AND r.status IN ('running', 'awaiting_action')) THEN
    RAISE EXCEPTION 'a crew run is still going' USING ERRCODE = '55006';
  END IF;
  PERFORM public.openbot_team_channel_hand_over_write(c.id, c.created_by, heir, c.waker_group_id);
  RETURN heir;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_hand_over_core(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_hand_over(p_channel_id text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
  creator text;
BEGIN
  IF frame IN ('system', 'team', '') THEN
    RAISE EXCEPTION 'only a member hands a shared group over' USING ERRCODE = '42501';
  END IF;
  IF frame <> 'platform' THEN
    -- Read without a lock: a stranger must not be able to make anyone wait.
    SELECT created_by INTO creator FROM public.channels WHERE id = p_channel_id;
    IF NOT FOUND OR (frame IS DISTINCT FROM creator AND NOT public.openbot_team_channel_member(p_channel_id)) THEN
      RAISE EXCEPTION 'only a member hands a shared group over' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN public.openbot_team_channel_hand_over_core(p_channel_id);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_hand_over(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.openbot_team_channel_hand_over(text) TO openbot_app;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_person_leaves_groups(p_user_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  owned text[];
  channel text;
BEGIN
  owned := ARRAY(SELECT id FROM public.channels WHERE tenant_id = 'team' AND created_by = p_user_id ORDER BY id);
  -- As when someone else takes them out: their mapping rows stay, and lead nowhere.
  DELETE FROM public.channel_memberships WHERE user_id = p_user_id AND tenant_id = 'team';
  FOREACH channel IN ARRAY owned LOOP
    BEGIN
      PERFORM public.openbot_team_channel_hand_over_core(channel);
    EXCEPTION WHEN SQLSTATE '55006' THEN
      -- A crew run is still going: the deactivation stands, the hand-over waits for a heal.
      NULL;
    END;
  END LOOP;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_person_leaves_groups(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_revoked_leaves()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  uid text;
BEGIN
  FOR uid IN SELECT id FROM public.users WHERE lower(email) = NEW.email LOOP
    PERFORM public.openbot_team_person_leaves_groups(uid);
  END LOOP;
  RETURN NULL;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_revoked_leaves() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER openbot_team_revoked_leaves AFTER INSERT ON public.revoked_access
  FOR EACH ROW EXECUTE FUNCTION public.openbot_team_revoked_leaves();
--> statement-breakpoint
DO $$ DECLARE previous text := current_setting('app.tenant_id', true); uid text; BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);
  FOR uid IN SELECT u.id FROM public.users u JOIN public.revoked_access r ON r.email = lower(u.email) LOOP
    PERFORM public.openbot_team_person_leaves_groups(uid);
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;

/*
 * 群组与群聊合一（PR1，设计稿 3.1.1）：共享群的创建者退群或被停用后，群组移交给群里最早的在籍成员。
 *
 * 接手人：仍在群里（`channel_memberships`）、账号未停用（`lower(users.email)` 不在 `revoked_access`）的人类
 * 成员中，`channel_memberships.created_at` 最早的那位，平手按 `users.email` 升序。与上游 `people()` 的排序
 * 相同（S/channels/group.ts 的 `people`），上游界面和 `creatorOnly` 认的「发起人」就是 `people()[0]`。
 * 没有接手人时：一个成员都不剩就软删聊天（群组仍归原主，变成「未开始聊天」）；只剩停用的成员就什么都不改。
 * 挂接的群组有未结束的运行（`running`、`awaiting_action`）时报 55006，什么都不改：退群（应用经
 * `xiongbao_team_channel_hand_over`）一律如此，有没有接手人都一样（用户裁定 Q7「流程正在运行时创建者不能退群」）；
 * 停用只在有人接手时推迟移交，不阻止停用，最后一人被停用照样软删聊天。查运行之前先锁群组行，与解散相同
 * （启动中的运行插入时外键对群组行持有 KEY SHARE 锁，先到的一定被看见）。
 *
 * 加锁顺序：频道行 → 成员行 → 群组行。退群（S/waker-groups/channel-link.ts 的 `leave`）、镜像自愈
 * （`for share` 频道行再写镜像）、上游 `lockedBots` 都先锁频道行；停用也先锁他创建的频道行，再删他的成员行。
 *
 * 为什么不改守卫：`created_by` 被两道守卫冻住，都只放行 `platform` 帧——`openbot_team_row_guard('created_by')`
 * （0122:116-160，现行函数体 0125:69-113 / 0128）与 `openbot_team_channel_guard`（0206:44-73）。0128 的注释
 * 要求改共享群的行在 `platform` 帧里做。所以守卫一行不改，由写入函数切到 `platform` 帧。
 *
 * 为什么用函数级 `SET app.tenant_id = 'platform'`：PostgreSQL 在函数退出或出错时自动还原，调用方的帧不受
 * 影响；不用 0114 那种保存再还原的写法（出错路径还原不了）。只有写入函数这样切帧。
 *
 * 为什么只有一个函数授权给应用：写入、判定（core）、停用三个函数都能在调用方给不出的条件下改所有权，
 * 只有同一属主的函数能调。应用只拿到 `xiongbao_team_channel_hand_over`：先校验身份（`platform`、
 * `created_by` 本人或现任成员；陌生人与频道不存在报同一个 42501，校验前不加锁），再调 core。现任成员调它
 * 只能让已经发生的离开按规则落地：`created_by` 仍在籍且未停用时 core 什么都不改。接手人由数据库选，调用方
 * 只传频道 id。
 *
 * 命名：应用调用的这一个用新名 `xiongbao_` 开头（应用代码里不再写旧品牌名），tests/tenant-invariants.test.ts
 * 的 (f) 显式登记它；其余不授权给应用的内部函数保持 `openbot_team_` 开头，由 (f) 按前缀自动覆盖。
 *
 * 为什么挂在 `revoked_access` 上：SCIM 停用、管理员移除、平台停用租户三条路径唯一的共同点是插入这张表
 * （S/auth/scim.ts、S/people/store.ts、S/platform/store.ts），停用生效就在那一刻，移交与插入同一个事务。
 * 这张表没有 RLS（没有 tenant_id），应用本来就能以任何帧写它，写进去就等于把这个人拒之门外，这是现有的
 * 信任边界；触发器的结果是确定的规则（停用的人离开所有共享群，他创建的群交给最早的在籍成员），不接受
 * 调用方给的任何参数，没有扩大这个边界。停用不能因为移交失败而失败：每个群的移交在自己的子事务里，
 * 任何错误（55006 之外的也一样）只回滚那一个群并记一条 WARNING，留给自愈点；离开共享群这一步（锁频道行、
 * 删成员行）整体也在子事务里，失败（比如调用方的 lock_timeout）同样只记 WARNING。PL/pgSQL 的 `WHEN OTHERS`
 * 按设计不捕获取消（57014：statement_timeout、pg_cancel_backend）与 assert_failure，它们照旧让整条插入失败：
 * 那是调用方或运维在叫停，重试即可（设计稿 3.1.1 第 4.1 条）。
 * 恢复（删 `revoked_access` 行）没有触发器：不还群组，也不把人加回群。
 *
 * 搬什么（设计稿 3.1.1 第 5 条，全部跟走，每条都限原主的 tenant_id）：`channels.created_by`；`waker_groups`
 * （名字按 4.4 以聊天的 title 为准，没有 title 用 name，截 80 字（按码点）；撞名加「（2）」…「（99）」，再撞加
 * id 前 6 位；SQL_ASCII 库（镜像内置库）里文本函数按字节计，取名改按整个 UTF-8 序列截，结果与 UTF8 库相同，
 * 见函数内注释）；群组的 `portraits`、`portrait_media`（先删接手人
 * 名下同键的残行）；`group_task_templates`；`group_task_runs` 以及它们的父卡、步骤卡（`tasks`）、卡的
 * `task_archives`、`group_pipeline_start_receipts`、`flow_confirmations`、`flow_run_events`、`flow_run_retries`。
 * 不搬：`usage_counters`（已消耗的额度记在当时发起的人名下）、审批、`audit_events`、`group_bot_threads`、
 * `waker_group_members`（随父行）。
 *
 * 留痕：每次移交成功，写入函数 `RAISE LOG` 一行（频道、原主、接手人、群组、搬走的运行数），停用路径也有；
 * 同样的内容以事务级设置 `xiongbao.hand_over` 留给应用，应用在退群或自愈提交后记一行
 * `waker-group-handed-over` 日志，与其余 `waker-group-*` 日志同一处。不写 `audit_events`：那里的事件类型由
 * 应用登记、按人归档，而停用路径没有发起移交的人。
 *
 * 已软删的频道不移交（core 原样返回 `created_by`）：同一个群组可能还挂着一个新开的聊天，旧聊天的成员不能
 * 把群组从新聊天的所有者手里带走。
 *
 * 存量补做（文件最后一条）：对迁移前已经停用的人各做一次，让他们离开共享群并移交他们创建的群。可重复执行：
 * 已停用的人已不在任何共享群里，剩下的频道要么已移交、要么已软删、要么仍被运行推迟，再跑一次什么都不改
 * （tests/waker-group-hand-over.integration.test.ts 的「run a second time changes nothing」按行的物理位置断言）。
 *
 * 索引：停用与补做按人查 `channel_memberships.user_id`、`channels.created_by`（共享群）、`lower(users.email)`，
 * 原来都没有索引，每停用一个人要顺序扫三张表。这里补三个最小的（`IF NOT EXISTS`）；建索引时短暂阻塞这三张表
 * 的写入，表大的部署在升级须知里注明。
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0207 must run as a role with BYPASSRLS (owner of the openbot_team_* functions)';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channel_memberships_user_idx ON public.channel_memberships (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channels_team_created_by_idx ON public.channels (created_by) WHERE tenant_id = 'team';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS users_lower_email_idx ON public.users (lower(email));
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_channel_hand_over_write(p_channel_id text, p_from text, p_heir text, p_group_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET app.tenant_id = 'platform' AS $f$
DECLARE
  original text;
  base text;
  candidate text;
  suffix text;
  room int;
  attempt int := 1;
  -- A SQL_ASCII database (the image's embedded cluster: initdb with no locale) counts text in bytes.
  bytewise boolean := current_setting('server_encoding') = 'SQL_ASCII';
  moved boolean := false;
  runs uuid[] := '{}';
  cards uuid[];
BEGIN
  IF p_heir IS NULL THEN
    UPDATE public.channels SET deleted_at = now() WHERE id = p_channel_id AND deleted_at IS NULL;
    RETURN;
  END IF;
  UPDATE public.channels SET created_by = p_heir WHERE id = p_channel_id;
  IF p_group_id IS NOT NULL THEN
    SELECT name INTO original FROM public.waker_groups WHERE id = p_group_id AND tenant_id = p_from FOR UPDATE;
    moved := FOUND;
  END IF;

  IF moved THEN
    -- 4.4: the chat's title is the name's truth (its name when it has none), trimmed and cut to 80
    -- characters, so a crew already called 「周报（2）」 is not handed over as 「周报（2）（2）」. Counted in
    -- code points, as the app's `pickGroupName` counts them.
    --
    -- Written to come out the same in a UTF8 and a SQL_ASCII database. There `left()` and `length()`
    -- count bytes and `btrim()` trims bytes, so: no Unicode escape in a literal (nothing converts one
    -- into SQL_ASCII, and the whole file fails), the ideographic space written as itself and trimmed as a
    -- whole sequence (in UTF-8 it can only start at a character boundary), the suffix's length
    -- counted without looking at its full-width brackets, and the cut, in SQL_ASCII, made by
    -- whole UTF-8 sequences: a lead or ASCII byte with the continuation bytes after it.
    SELECT coalesce(nullif(regexp_replace(title, '^(?:[ \t\r\n]|　)+|(?:[ \t\r\n]|　)+$', '', 'g'), ''),
                    regexp_replace(name, '^(?:[ \t\r\n]|　)+|(?:[ \t\r\n]|　)+$', '', 'g'))
      INTO base FROM public.channels WHERE id = p_channel_id;
    IF coalesce(base, '') = '' THEN base := original; END IF;
    LOOP
      IF attempt = 1 THEN
        suffix := '';
        room := 80;
      ELSIF attempt <= 99 THEN
        suffix := '（' || attempt || '）';
        room := 78 - length(attempt::text);
      ELSE
        suffix := left(p_group_id::text, 6);
        room := 74;
      END IF;
      -- Two statements, not one CASE: the byte pattern is only ever parsed in a SQL_ASCII database.
      IF bytewise THEN
        candidate := substring(base FROM '^(?:[^\x80-\xBF][\x80-\xBF]*){0,' || room || '}') || suffix;
      ELSE
        candidate := left(base, room) || suffix;
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
  END IF;

  /*
   * The trail of a hand-over (the trail does not move, and no audit row names who took a group over):
   * one line in the server log on every path, a deactivation's included; and the same facts, local to
   * this transaction, for the app to log once its leave or heal commits (S/waker-groups/channel-link.ts).
   */
  RAISE LOG 'xiongbao_team_channel_hand_over: channel % handed over from % to %, crew %, % run(s) moved',
    p_channel_id, p_from, p_heir, CASE WHEN moved THEN p_group_id END, cardinality(runs);
  PERFORM set_config('xiongbao.hand_over', json_build_object(
    'channelId', p_channel_id, 'from', p_from, 'to', p_heir,
    'groupId', CASE WHEN moved THEN p_group_id END, 'runs', cardinality(runs))::text, true);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_hand_over_write(text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- p_leaving: true (the default) for a leave, refused while a crew run is going whether or not anyone
-- takes over; false for a deactivation, where a running flow only puts the hand-over off.
CREATE FUNCTION public.openbot_team_channel_hand_over_core(p_channel_id text, p_leaving boolean DEFAULT true)
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
  IF c.waker_group_id IS NOT NULL AND (heir IS NOT NULL OR p_leaving) THEN
    -- The crew's row first, then the check, as dissolving does: a run being inserted holds a key-share
    -- lock on it (the foreign key), so one that got in first is seen here.
    PERFORM 1 FROM public.waker_groups WHERE id = c.waker_group_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.group_task_runs r
                WHERE r.group_id = c.waker_group_id AND r.status IN ('running', 'awaiting_action')) THEN
      RAISE EXCEPTION 'a crew run is still going' USING ERRCODE = '55006';
    END IF;
  END IF;
  IF heir IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.channel_memberships m WHERE m.channel_id = c.id AND m.tenant_id = 'team') THEN
      PERFORM public.openbot_team_channel_hand_over_write(c.id, c.created_by, NULL, NULL);
      RETURN NULL;
    END IF;
    RETURN c.created_by;
  END IF;
  PERFORM public.openbot_team_channel_hand_over_write(c.id, c.created_by, heir, c.waker_group_id);
  RETURN heir;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.openbot_team_channel_hand_over_core(text, boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_hand_over(p_channel_id text)
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
  RETURN public.openbot_team_channel_hand_over_core(p_channel_id, true);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_hand_over(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.xiongbao_team_channel_hand_over(text) TO openbot_app;
--> statement-breakpoint
CREATE FUNCTION public.openbot_team_person_leaves_groups(p_user_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
DECLARE
  owned text[];
  channel text;
BEGIN
  -- The channels they started, locked before any membership row is touched: the order a leave takes
  -- them in (channel row, then the leaver's membership), so the two queue rather than deadlock.
  owned := ARRAY(SELECT id FROM public.channels WHERE tenant_id = 'team' AND created_by = p_user_id
                  ORDER BY id FOR UPDATE);
  -- As when someone else takes them out: their mapping rows stay, and lead nowhere.
  DELETE FROM public.channel_memberships WHERE user_id = p_user_id AND tenant_id = 'team';
  FOREACH channel IN ARRAY owned LOOP
    BEGIN
      PERFORM public.openbot_team_channel_hand_over_core(channel, false);
    EXCEPTION
      WHEN SQLSTATE '55006' THEN
        -- A crew run is still going: the deactivation stands, the hand-over waits for a heal.
        NULL;
      WHEN OTHERS THEN
        -- Only this group's hand-over is undone; the deactivation stands and a heal finishes the job.
        RAISE WARNING 'openbot_team_person_leaves_groups: hand-over of channel % put off for a heal: % (%)',
          channel, SQLERRM, SQLSTATE;
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
    BEGIN
      PERFORM public.openbot_team_person_leaves_groups(uid);
    EXCEPTION WHEN OTHERS THEN
      -- Leaving the groups failed as a whole (say the caller's lock_timeout): the deactivation still
      -- stands. Their groups wait for a heal; the backfill's statement can be run again by the owner.
      RAISE WARNING 'openbot_team_revoked_leaves: % stays in their shared groups for now: % (%)',
        uid, SQLERRM, SQLSTATE;
    END;
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

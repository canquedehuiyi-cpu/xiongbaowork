/*
 * 群组与群聊合一（PR3，设计稿 5.5）：升级台账表 `waker_group_upgrades`。
 *
 * 编号：设计稿与计划起草时用 0208；合入前 main 已有 `0208_skill_runnable`、`0209_channel_kind`，按 3.2 的
 * 「再被占号就顺延」改为 0210；合入前 0210 又被 `0210_skill_blocked_reason` 占用，再顺延为 0211，日志 `when` 晚于 0210。
 *
 * 一个群组一行，记开机升级任务（S/waker-groups/upgrade.ts）对它做了什么：
 * - `outcome`：`started`（转换已开始，还没挂上聊天）、`converted`（已有群组转成了群聊）、`backfilled`（已有
 *   群聊补建了群组）、`pending_members`（可用员工不足 2 位）、`too_many`（超过 20 位，不截断）、`no_owner`
 *   （所有者是保留租户或人已删除）。后三种是终态，任务不再重试。
 * - `channel_id`：转出来的或补挂的频道；`started` 时可以为空（建频道与记 id 之间崩溃，留给孤儿收养，5.3）。
 * - `dropped_agent_ids`：转换时所有者用不了、被筛掉的员工。孤儿收养按它比对员工集合，回滚手册按它补回镜像。
 * - `tenant_id`：所有者，移交时跟着群组改为接手人（见文件末尾）。
 * - `original_owner`：写台账时的所有者，之后不改，移交也不搬。回滚手册第 1 步用它排除已经被移交过的转换
 *   群组：那种群组的聊天没有消息也不能软删，否则群组留在接手人名下，原主再也找不回它（3.1.1 第 5 条）。
 *
 * 三个用途：崩溃恢复、回滚、给运维看升级到底做了什么。表不进 Drizzle schema，upgrade.ts 用 `sql` 读写。
 * 删群组时台账行随外键级联删除。
 *
 * 行安全：照 0072、写法逐字照 0203_portrait_media.sql 换表名。所有者帧读写自己的行，`platform` 帧读写全部；
 * FORCE 让表的属主也受约束。升级任务在 `platform` 帧枚举、写台账，在所有者帧建群聊。
 *
 * 移交（0207，设计稿 3.1.1 第 5 条「全部跟走」）：`openbot_team_channel_hand_over_write` 以 0207 的函数体
 * 为底，只多一句把这个群组的台账行改到接手人名下（限原主的 `tenant_id`，与其余各表相同），其余一字不改，
 * `REVOKE` 照旧。`CREATE OR REPLACE` 保留属主与权限，0207 的 core、停用触发器照旧调用它。函数体里的全角
 * 括号与全角空格照 0207 原样写成字符本身，不用 Unicode 转义：镜像内置库是 SQL_ASCII，转义在那里整个文件
 * 都会失败（tests/waker-group-hand-over-sql-ascii.integration.test.ts 用两种编码各跑一遍全部迁移）。
 *
 * 执行身份：替换 0207 的 SECURITY DEFINER 函数要用 owner 或 BYPASSRLS 身份，文件开头照 0122 自检。
 *
 * 回滚：新表、函数只多一句，旧代码不读这张表；换回旧镜像无害（设计稿 5.6）。
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0211 must run as a role with BYPASSRLS (owner of the openbot_team_* functions)';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.waker_group_upgrades (
  group_id uuid PRIMARY KEY REFERENCES public.waker_groups(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  original_owner text NOT NULL, -- 写台账时的所有者；之后不改，移交不搬（回滚手册第 1 步用它排除已被移交的转换群组）
  channel_id text,
  outcome text NOT NULL CONSTRAINT waker_group_upgrades_outcome
    CHECK (outcome IN ('started','converted','backfilled','pending_members','too_many','no_owner')),
  dropped_agent_ids text[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "public"."waker_group_upgrades" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."waker_group_upgrades" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."waker_group_upgrades" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."waker_group_upgrades" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."waker_group_upgrades" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."waker_group_upgrades" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."waker_group_upgrades" TO openbot_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openbot_team_channel_hand_over_write(p_channel_id text, p_from text, p_heir text, p_group_id uuid)
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
    UPDATE public.waker_group_upgrades SET tenant_id = p_heir WHERE group_id = p_group_id AND tenant_id = p_from;

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

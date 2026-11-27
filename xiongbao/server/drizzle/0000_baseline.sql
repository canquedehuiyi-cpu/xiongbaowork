/*
 * 熊宝业务库的基线迁移（v0.2.17 起）：一条迁移建出 v0.2.16 的全部结构。
 *
 * v0.2.16 之前的迁移链（drizzle 0000–0080 加恢复层 0081–0241，共 222 条）到 v0.2.17 合成这一个文件，
 * 内容等于那条链在空库上跑完的结果：
 *   - 用 v0.2.16（提交 e9a669825）的迁移链在空的 PostgreSQL 16 库上迁移到底，再用 pg_dump 16
 *     `--no-owner --inserts --column-inserts --exclude-schema=drizzle` 整库导出；
 *   - 去掉会话设置（SET、search_path）与 psql 元命令，`ALTER DEFAULT PRIVILEGES` 去掉 FOR ROLE（默认权限
 *     属于执行迁移的角色，各环境名字不同）；每条语句之间加 statement-breakpoint；
 *   - 补上 pg_dump 不导出的集群级内容：两个应用角色（下面第一段），以及迁移器自己建的 drizzle 模式上
 *     给应用角色的 USAGE（文件末尾）。
 *   - pg_dump 把 BETWEEN 印成两个带括号的比较，重新解析时会被并进外层的 AND，存下的表达式就和链建出的
 *     不一样了（意思相同，但结构比对会认出来）。五个这样的 CHECK（flow_session_text_check、
 *     flow_turn_text_check、flow_source_public_operations_input_check、knowledge_directory_title_check、
 *     resource_projects_config_check）照原迁移写回 BETWEEN。
 *   - 链里写进空库的数据（套餐 plans 2 行、模型模板 provider_templates 9 行）随 pg_dump 的数据段一起在
 *     建表之后、建触发器与行级安全之前插入。
 *
 * 新装库直接跑这一条。v0.2.16 的已有库不跑它：启动时迁移器（src/db/baseline-adoption.ts）先确认库是
 * v0.2.16 的、结构与这个基线逐项一致，再在同一事务里把迁移记录改写成这一条。
 *
 * 等价性由测试保证（tests/migration-baseline.test.ts）：本文件建出的库与 v0.2.16 迁移链建出的库结构、
 * 数据一致；现网（v0.2.16）的 --schema-only 导出与本文件归一化后一致。
 *
 * check_function_bodies 关掉是 pg_dump 的做法：SQL 函数体里引用的表可能排在函数之后建。只在本事务内
 * 生效（SET LOCAL），文件末尾恢复。
 */
SET LOCAL check_function_bodies = false;
--> statement-breakpoint
/*
 * 应用角色（集群级，pg_dump 不导出）：xiongbao_app 只有行权限、不是超级用户、不绕过行级安全，口令是
 * 开发 Compose 的公开默认值，部署时由运维（交付镜像里是 migrate.sh）每次启动重设；
 * xiongbao_role_writer 是唯一能写 user_roles 的登录角色，不带口令，由运维或 CI 设。已存在的角色不动。
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'xiongbao_app') THEN
    CREATE ROLE xiongbao_app LOGIN PASSWORD 'xiongbao';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'xiongbao_role_writer') THEN
    CREATE ROLE xiongbao_role_writer LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  END IF;
END $$;
--> statement-breakpoint
ALTER ROLE xiongbao_role_writer LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
--> statement-breakpoint
CREATE TYPE public.agent_type AS ENUM (
    'built_in',
    'remote_ag_ui',
    'remote_mastra',
    'device_acp'
);
--> statement-breakpoint
CREATE TYPE public.agent_visibility AS ENUM (
    'public',
    'private'
);
--> statement-breakpoint
CREATE TYPE public.credential_kind AS ENUM (
    'model',
    'connector',
    'agent',
    'mcp',
    'mcp_oauth_client',
    'mcp_user_token',
    'chat'
);
--> statement-breakpoint
CREATE TYPE public.responsibility_run_status AS ENUM (
    'queued',
    'running',
    'waiting',
    'succeeded',
    'failed',
    'skipped'
);
--> statement-breakpoint
CREATE TYPE public.responsibility_status AS ENUM (
    'active',
    'paused',
    'completed'
);
--> statement-breakpoint
CREATE TYPE public.role AS ENUM (
    'admin',
    'user'
);
--> statement-breakpoint
CREATE TYPE public.routine_run_status AS ENUM (
    'succeeded',
    'failed',
    'skipped',
    'waiting'
);
--> statement-breakpoint
CREATE TYPE public.task_source AS ENUM (
    'chat',
    'routine',
    'responsibility',
    'handoff',
    'group_run'
);
--> statement-breakpoint
CREATE TYPE public.task_status AS ENUM (
    'running',
    'needs_action',
    'awaiting_review',
    'done',
    'failed',
    'cancelled'
);
--> statement-breakpoint
CREATE FUNCTION public.prevent_audit_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  retention_days integer;
BEGIN
  -- Answered before anything else is read, so no setting and no missing OLD record can change it.
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  -- `true` so a session that never set it reads NULL instead of raising, which is the ordinary case
  -- and has to stay a plain refusal.
  BEGIN
    retention_days := nullif(current_setting('xiongbao.audit_retention_days', true), '')::integer;
  EXCEPTION WHEN others THEN
    retention_days := NULL;
  END;

  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  IF OLD.created_at >= now() - (retention_days || ' days')::interval THEN
    RAISE EXCEPTION 'Audit events are append-only within the retention window';
  END IF;

  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_channel_waker_group_link() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_flow_share_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  frame text := coalesce(current_setting('app.tenant_id', true), '');
BEGIN
  IF frame = 'platform' OR frame = OLD.tenant_id THEN RETURN NEW; END IF;
  IF NEW.uses = OLD.uses + 1
     AND (to_jsonb(NEW) - 'uses') = (to_jsonb(OLD) - 'uses')
     AND OLD.revoked_at IS NULL
     AND OLD.expires_at > now() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a shared WakerFlow link only records one more use' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_grant_stamp_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  bot_stamp text;
  team_bot boolean;
BEGIN
  IF coalesce(current_setting('app.tenant_id', true), '') = 'platform' THEN
    RETURN NEW;
  END IF;
  SELECT a.tenant_id,
         a.tenant_id = 'team'
           OR EXISTS (SELECT 1 FROM public.agent_profiles p WHERE p.agent_id = a.id AND p.tenant_id = 'team')
    INTO bot_stamp, team_bot
    FROM public.agents a WHERE a.id = NEW.agent_id;
  IF FOUND AND (CASE WHEN team_bot THEN NEW.tenant_id IS DISTINCT FROM 'team'
                     WHEN bot_stamp NOT IN ('system', 'platform', '') THEN NEW.tenant_id IS DISTINCT FROM bot_stamp
                     ELSE false END) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "plugin_grants"'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_mcp_tool_stamp_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  server_stamp text;
BEGIN
  SELECT s.tenant_id INTO server_stamp FROM public.mcp_servers s WHERE s.id = NEW.server_id;
  -- No such server: the foreign key answers that.
  IF FOUND AND server_stamp IS DISTINCT FROM NEW.tenant_id THEN
    IF coalesce(current_setting('app.tenant_id', true), '') IN ('platform', 'system') THEN
      RAISE EXCEPTION 'mcp_tools: a tool is stamped % but its server % is stamped %',
        NEW.tenant_id, NEW.server_id, server_stamp USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'new row violates row-level security policy for table "mcp_tools"'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_bot_visible(p_agent_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  WITH me AS (SELECT coalesce(current_setting('app.tenant_id', true), '') AS id),
       my_groups AS (SELECT coalesce((SELECT u.groups FROM public.users u, me WHERE u.id = me.id), '{}'::text[]) AS g)
  SELECT (SELECT id FROM me) NOT IN ('system','platform','team','')
     AND EXISTS (SELECT 1 FROM public.agent_profiles p, me WHERE p.agent_id = p_agent_id AND p.tenant_id = 'team'
                  AND p.deleted_at IS NULL
                  AND (p.visibility = 'public' OR p.owner_user_id = me.id
                       OR EXISTS (SELECT 1 FROM public.team_bot_publications pub
                                   JOIN public.agents a ON a.id = pub.agent_id AND a.tenant_id = 'team'
                                  WHERE pub.agent_id = p_agent_id AND pub.tenant_id = 'team'
                                    AND btrim(p.role_description) <> ''
                                    AND lower(btrim(a.name)) NOT IN ('', 'new bot', 'new coworker', 'untitled', 'my bot')
                                    AND (pub.audience = 'team'
                                         OR EXISTS (SELECT 1 FROM public.team_bot_audience au, my_groups
                                                     WHERE au.agent_id = pub.agent_id AND au.tenant_id = 'team'
                                                       AND ((au.kind = 'user' AND au.value = (SELECT id FROM me))
                                                         OR (au.kind = 'group' AND au.value = ANY(my_groups.g))))
                                         OR EXISTS (SELECT 1 FROM public.team_bot_assignments ta, my_groups
                                                     WHERE ta.agent_id = pub.agent_id AND ta.tenant_id = 'team'
                                                       AND (ta.group_name = '*' OR ta.group_name = ANY(my_groups.g))))))) $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_creator(p_channel_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT public.xiongbao_team_channel_member(p_channel_id)
     AND EXISTS (SELECT 1 FROM public.channels c WHERE c.id = p_channel_id AND c.tenant_id = 'team'
                  AND c.created_by = current_setting('app.tenant_id', true)) $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
                        AND public.xiongbao_waker_group_absent(OLD.waker_group_id), false)) THEN
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
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_hand_over(p_channel_id text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
    IF NOT FOUND OR (frame IS DISTINCT FROM creator AND NOT public.xiongbao_team_channel_member(p_channel_id)) THEN
      RAISE EXCEPTION 'only a member hands a shared group over' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN public.xiongbao_team_channel_hand_over_core(p_channel_id, true);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_hand_over_core(p_channel_id text, p_leaving boolean DEFAULT true) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
      PERFORM public.xiongbao_team_channel_hand_over_write(c.id, c.created_by, NULL, NULL);
      RETURN NULL;
    END IF;
    RETURN c.created_by;
  END IF;
  PERFORM public.xiongbao_team_channel_hand_over_write(c.id, c.created_by, heir, c.waker_group_id);
  RETURN heir;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_hand_over_write(p_channel_id text, p_from text, p_heir text, p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET "app.tenant_id" TO 'platform'
    AS $_$
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
END $_$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_member(p_channel_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT coalesce(current_setting('app.tenant_id', true), '') NOT IN ('system','platform','team','')
     AND EXISTS (SELECT 1 FROM public.channel_memberships m
                  WHERE m.channel_id = p_channel_id AND m.tenant_id = 'team'
                    AND m.user_id = current_setting('app.tenant_id', true)) $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_channel_seedable(p_channel_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT coalesce(current_setting('app.tenant_id', true), '') NOT IN ('system','platform','team','')
     AND EXISTS (SELECT 1 FROM public.channels c WHERE c.id = p_channel_id AND c.tenant_id = 'team'
                  AND c.created_by = current_setting('app.tenant_id', true))
     AND NOT EXISTS (SELECT 1 FROM public.channel_memberships m
                      WHERE m.channel_id = p_channel_id AND m.tenant_id = 'team') $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_person_leaves_groups(p_user_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
      PERFORM public.xiongbao_team_channel_hand_over_core(channel, false);
    EXCEPTION
      WHEN SQLSTATE '55006' THEN
        -- A crew run is still going: the deactivation stands, the hand-over waits for a heal.
        NULL;
      WHEN OTHERS THEN
        -- Only this group's hand-over is undone; the deactivation stands and a heal finishes the job.
        RAISE WARNING 'xiongbao_team_person_leaves_groups: hand-over of channel % put off for a heal: % (%)',
          channel, SQLERRM, SQLSTATE;
    END;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_revoked_leaves() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  uid text;
BEGIN
  FOR uid IN SELECT id FROM public.users WHERE lower(email) = NEW.email LOOP
    BEGIN
      PERFORM public.xiongbao_team_person_leaves_groups(uid);
    EXCEPTION WHEN OTHERS THEN
      -- Leaving the groups failed as a whole (say the caller's lock_timeout): the deactivation still
      -- stands. Their groups wait for a heal; the backfill's statement can be run again by the owner.
      RAISE WARNING 'xiongbao_team_revoked_leaves: % stays in their shared groups for now: % (%)',
        uid, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_row_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
            AND frame IN (OLD.tenant_id, NEW.tenant_id)
            AND EXISTS (SELECT 1 FROM public.agent_profiles p
                         WHERE p.agent_id = moving AND p.owner_user_id = frame), false) THEN
      RAISE EXCEPTION 'tenant_id of % is fixed', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  END IF;
  -- TG_ARGV is NULL, not empty, for a trigger created without arguments.
  IF TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col)
         -- The one foreign key with ON DELETE SET NULL on a fixed link: agent_profiles.owner_user_id
         -- when that user is deleted. It runs inside the referential trigger, one level down. Depth
         -- alone proves nothing (a session with TEMP can nest its own trigger), so the user must
         -- also be gone.
         AND NOT (pg_trigger_depth() > 1 AND TG_TABLE_NAME = 'agent_profiles' AND col = 'owner_user_id'
                  AND jsonb_typeof(to_jsonb(NEW) -> col) = 'null'
                  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = to_jsonb(OLD)->>col)) THEN
        RAISE EXCEPTION '%.% is fixed', TG_TABLE_NAME, col USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  -- Deleting a shared group and bringing it back are both the creator's: a member who could clear
  -- deleted_at would resurrect a group the creator deleted for everyone.
  IF TG_TABLE_NAME = 'channels' AND OLD.tenant_id = 'team'
     AND (to_jsonb(OLD)->'deleted_at') IS DISTINCT FROM (to_jsonb(NEW)->'deleted_at')
     AND (to_jsonb(OLD)->>'created_by') IS DISTINCT FROM frame THEN
    RAISE EXCEPTION 'only the creator deletes or restores a shared group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_team_server_secret(p_server_id text) RETURNS TABLE(id uuid, encrypted_value text, revoked_at timestamp with time zone, tenant_id text, kind public.credential_kind, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT c.id, c.encrypted_value, c.revoked_at, c.tenant_id, c.kind, c.created_at
    FROM public.mcp_servers s JOIN public.credentials c ON c.id = s.credential_id
   WHERE coalesce(current_setting('app.tenant_id', true), '') NOT IN ('system', 'platform', 'team', '')
     AND s.id = p_server_id AND s.tenant_id = 'team'
     AND c.tenant_id = 'team' AND c.kind::text IN ('mcp', 'mcp_oauth_client') $$;
--> statement-breakpoint
CREATE FUNCTION public.xiongbao_waker_group_absent(p_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.waker_groups WHERE id = p_id) $$;
--> statement-breakpoint
CREATE TABLE public.accounts (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    issuer text
);
--> statement-breakpoint
CREATE TABLE public.acp_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    device_id text NOT NULL,
    turn_id text NOT NULL,
    status text NOT NULL,
    prompt jsonb NOT NULL,
    last_seq integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT acp_turns_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'running'::text, 'awaiting'::text, 'done'::text, 'interrupted'::text, 'cancelled'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.acp_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.action_policy (
    id text NOT NULL,
    mode text NOT NULL,
    deny text[] NOT NULL,
    allow text[] NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.action_policy FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.action_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    surface text NOT NULL,
    bot_id text,
    actor_user_id text,
    tool_name text NOT NULL,
    command text NOT NULL,
    outcome text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT action_records_surface_check CHECK ((surface = ANY (ARRAY['cloud'::text, 'local'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.action_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.agent_preferences (
    user_id text NOT NULL,
    agent_id text NOT NULL,
    hidden_at timestamp with time zone,
    pinned_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.agent_profiles (
    agent_id text NOT NULL,
    owner_user_id text,
    title text NOT NULL,
    role_description text NOT NULL,
    avatar_seed text NOT NULL,
    visibility public.agent_visibility NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    callback_token_hash text,
    callback_token_issued_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    model_ref uuid,
    persona jsonb,
    platform_model_ref uuid,
    configured_at timestamp with time zone,
    bible text,
    role_template_id uuid,
    role_template_version integer,
    isolated boolean DEFAULT false NOT NULL,
    summoned_from text,
    preset_portrait text,
    department text,
    CONSTRAINT agent_profiles_bible_length CHECK (((bible IS NULL) OR (char_length(bible) <= 8000))),
    CONSTRAINT agent_profiles_department_length CHECK (((department IS NULL) OR (char_length(department) <= 32))),
    CONSTRAINT agent_profiles_preset_portrait CHECK (((preset_portrait IS NULL) OR (preset_portrait = ANY (ARRAY['naughty'::text, 'cute'::text, 'cool'::text, 'happy'::text, 'sweet'::text, 'doctor'::text, 'teacher'::text, 'chef'::text, 'tech-engineer'::text, 'financial-advisor'::text, 'lawyer'::text, 'construction-engineer'::text, 'farmer'::text, 'courier'::text, 'pilot'::text, 'firefighter'::text, 'tour-guide'::text, 'journalist'::text, 'creative-designer'::text, 'fitness-coach'::text, 'general-manager'::text, 'accountant'::text, 'operations-director'::text, 'designer'::text, 'director'::text, 'programmer'::text, 'social-media-operator'::text, 'actor'::text, 'singer'::text, 'product-manager'::text, 'data-analyst'::text, 'marketing-director'::text, 'hr-manager'::text, 'legal-advisor'::text, 'customer-service-manager'::text, 'founder-assistant'::text, 'project-manager'::text, 'admin-specialist'::text, 'sales-consultant'::text, 'business-development'::text, 'customer-success'::text, 'copywriter'::text, 'brand-planner'::text, 'ad-specialist'::text, 'store-manager'::text, 'live-stream-operator'::text, 'private-domain-operator'::text, 'automation-engineer'::text, 'test-engineer'::text, 'security-officer'::text])))),
    CONSTRAINT agent_profiles_role_template_pair CHECK (((role_template_id IS NULL) = (role_template_version IS NULL))),
    CONSTRAINT agent_profiles_role_template_version CHECK (((role_template_version IS NULL) OR (role_template_version > 0))),
    CONSTRAINT agent_profiles_single_model_binding CHECK (((model_ref IS NULL) OR (platform_model_ref IS NULL)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.agent_security_policies (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    config jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_security_config_shape CHECK (((jsonb_typeof(config) = 'object'::text) AND (config ?& ARRAY['enterpriseMode'::text, 'dangerousCommandsEnabled'::text, 'sensitivePathsEnabled'::text, 'sensitivePaths'::text, 'toolModes'::text]) AND ((config -> 'enterpriseMode'::text) = 'false'::jsonb) AND (jsonb_typeof((config -> 'dangerousCommandsEnabled'::text)) = 'boolean'::text) AND (jsonb_typeof((config -> 'sensitivePathsEnabled'::text)) = 'boolean'::text) AND (jsonb_typeof((config -> 'sensitivePaths'::text)) = 'array'::text) AND (jsonb_typeof((config -> 'toolModes'::text)) = 'object'::text))),
    CONSTRAINT agent_security_revision_positive CHECK ((revision > 0))
);
--> statement-breakpoint
CREATE TABLE public.agent_security_settings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    dangerous_commands text DEFAULT 'ask'::text NOT NULL,
    sensitive_paths text DEFAULT 'ask'::text NOT NULL,
    extra_sensitive_paths text[] DEFAULT '{}'::text[] NOT NULL,
    disabled_default_paths text[] DEFAULT '{}'::text[] NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_security_settings_dangerous_commands_check CHECK ((dangerous_commands = ANY (ARRAY['off'::text, 'ask'::text]))),
    CONSTRAINT agent_security_settings_paths_bounded CHECK (((cardinality(extra_sensitive_paths) <= 50) AND (cardinality(disabled_default_paths) <= 50))),
    CONSTRAINT agent_security_settings_sensitive_paths_check CHECK ((sensitive_paths = ANY (ARRAY['off'::text, 'ask'::text]))),
    CONSTRAINT agent_security_settings_tenant_person CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_security_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.agents (
    id text NOT NULL,
    name text NOT NULL,
    type public.agent_type NOT NULL,
    configuration jsonb NOT NULL,
    package_id uuid,
    override jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.agents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.app_access_requests (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id text,
    bot_id text NOT NULL,
    requester_user_id text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    note text,
    decided_by text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    app_key text,
    app_title text,
    CONSTRAINT app_access_requests_app_key_length CHECK ((((app_key IS NULL) OR (char_length(app_key) <= 200)) AND ((app_title IS NULL) OR (char_length(app_title) <= 200)))),
    CONSTRAINT app_access_requests_app_named CHECK (((server_id IS NOT NULL) OR ((app_key IS NOT NULL) AND (app_title IS NOT NULL)))),
    CONSTRAINT app_access_requests_decided CHECK (((status = 'pending'::text) = (decided_at IS NULL))),
    CONSTRAINT app_access_requests_kind_check CHECK ((kind = ANY (ARRAY['enable'::text, 'grant'::text]))),
    CONSTRAINT app_access_requests_note_length CHECK (((note IS NULL) OR (char_length(note) <= 500))),
    CONSTRAINT app_access_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'dismissed'::text, 'cancelled'::text]))),
    CONSTRAINT app_access_requests_tenant_person CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.app_access_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_continuation_steps (
    approval_id text NOT NULL,
    step_key text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    input_digest text NOT NULL,
    admission_id text,
    state text NOT NULL,
    fence bigint DEFAULT 0 NOT NULL,
    receipt jsonb,
    completed_at timestamp with time zone,
    CONSTRAINT approval_continuation_steps_fence_check CHECK ((fence >= 0)),
    CONSTRAINT approval_continuation_steps_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text, 'completed'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuation_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_continuations (
    approval_id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    input_digest text NOT NULL,
    admission_id text NOT NULL,
    branch_kind text NOT NULL,
    branch_target_id text NOT NULL,
    origin text NOT NULL,
    state text NOT NULL,
    fence bigint DEFAULT 0 NOT NULL,
    claim_owner text,
    lease_until timestamp with time zone,
    intent_id text,
    intent_fence bigint,
    proof_id text,
    receipt jsonb,
    last_reason text,
    completed_at timestamp with time zone,
    exact_object_id uuid,
    exact_plaintext_sha256 text,
    CONSTRAINT approval_continuations_fence_check CHECK ((fence >= 0)),
    CONSTRAINT approval_continuations_legacy_check CHECK (((origin <> 'legacy_unknown'::text) OR (state <> ALL (ARRAY['ready'::text, 'claimed'::text, 'dispatched'::text])))),
    CONSTRAINT approval_continuations_origin_check CHECK ((origin = ANY (ARRAY['current'::text, 'legacy_unknown'::text]))),
    CONSTRAINT approval_continuations_receipt_check CHECK (((state = 'completed'::text) = ((receipt IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT approval_continuations_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'claimed'::text, 'dispatched'::text, 'unknown'::text, 'completed'::text]))),
    CONSTRAINT apx_ledger_ref_pair_ck CHECK (((exact_object_id IS NULL) = (exact_plaintext_sha256 IS NULL))),
    CONSTRAINT apx_ledger_ref_sha_ck CHECK (((exact_plaintext_sha256 IS NULL) OR (exact_plaintext_sha256 ~ '^[a-f0-9]{64}$'::text)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_conversation_grants (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    owner_user_id text NOT NULL,
    thread_id text NOT NULL,
    approval_id text NOT NULL,
    bot_id text NOT NULL,
    tool_ref text NOT NULL,
    effect text NOT NULL,
    scope text NOT NULL,
    account text,
    kind text,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_conversation_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_direct_execution_domains (
    domain_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    owner_user_id text NOT NULL,
    thread_id text NOT NULL,
    source_run_id text NOT NULL,
    agent_id text NOT NULL,
    execution_kind text DEFAULT 'direct_thread'::text NOT NULL,
    backend text DEFAULT 'local_postgres'::text NOT NULL,
    release_id text NOT NULL,
    contract_version text NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    admission_fence bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    admitted_at timestamp with time zone,
    creation_key text NOT NULL,
    CONSTRAINT domain_backend_check CHECK ((backend = 'local_postgres'::text)),
    CONSTRAINT domain_contract_version_check CHECK ((contract_version = 'ap-direct-domain-v2'::text)),
    CONSTRAINT domain_execution_kind_check CHECK ((execution_kind = 'direct_thread'::text)),
    CONSTRAINT domain_nonblank_text_check CHECK (((length(btrim(tenant_id)) > 0) AND (length(btrim(owner_user_id)) > 0) AND (length(btrim(thread_id)) > 0) AND (length(btrim(source_run_id)) > 0) AND (length(btrim(agent_id)) > 0) AND (length(btrim(release_id)) > 0) AND (length(btrim(contract_version)) > 0) AND (length(btrim(creation_key)) > 0))),
    CONSTRAINT domain_reserved_admitted_pair_check CHECK ((((state = 'reserved'::text) AND (admission_fence = 0) AND (admitted_at IS NULL)) OR ((state = 'admitted'::text) AND (admission_fence = 1) AND (admitted_at IS NOT NULL))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_exact_input_captures (
    id uuid NOT NULL,
    codec_version text NOT NULL,
    stage text NOT NULL,
    approval_id text NOT NULL,
    tenant_id text NOT NULL,
    owner_user_id text NOT NULL,
    actor_user_id text NOT NULL,
    domain_id uuid NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    approval_run_id text NOT NULL,
    source_actual_run_id text NOT NULL,
    tool_call_id text NOT NULL,
    action_digest text NOT NULL,
    source_binding jsonb NOT NULL,
    source_binding_version text NOT NULL,
    plaintext_sha256 text NOT NULL,
    key_version text NOT NULL,
    envelope_wire_version text NOT NULL,
    envelope_bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT apx_capture_binding_object_ck CHECK ((jsonb_typeof(source_binding) = 'object'::text)),
    CONSTRAINT apx_capture_binding_version_ck CHECK ((source_binding_version = 'XIONGBAO_APPROVAL_EXACT_SOURCE_BINDING_V1'::text)),
    CONSTRAINT apx_capture_codec_ck CHECK ((codec_version = 'XIONGBAO_EXACT_INPUT_JSON_V1'::text)),
    CONSTRAINT apx_capture_key_version_ck CHECK ((octet_length(key_version) > 0)),
    CONSTRAINT apx_capture_scope_budget_ck CHECK (((((((((((((octet_length(approval_id) + octet_length(tenant_id)) + octet_length(owner_user_id)) + octet_length(actor_user_id)) + octet_length(thread_id)) + octet_length(agent_id)) + octet_length(approval_run_id)) + octet_length(source_actual_run_id)) + octet_length(tool_call_id)) + octet_length(action_digest)) + octet_length(source_binding_version)) + octet_length(codec_version)) <= 1536)),
    CONSTRAINT apx_capture_scope_nonempty_ck CHECK (((octet_length(approval_id) > 0) AND (octet_length(tenant_id) > 0) AND (octet_length(owner_user_id) > 0) AND (octet_length(actor_user_id) > 0) AND (octet_length(thread_id) > 0) AND (octet_length(agent_id) > 0) AND (octet_length(approval_run_id) > 0) AND (octet_length(source_actual_run_id) > 0) AND (octet_length(tool_call_id) > 0) AND (octet_length(action_digest) > 0) AND (octet_length(source_binding_version) > 0) AND (octet_length(codec_version) > 0))),
    CONSTRAINT apx_capture_sha_ck CHECK ((plaintext_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT apx_capture_stage_ck CHECK ((stage = 'capture'::text)),
    CONSTRAINT apx_capture_wire_size_ck CHECK (((octet_length(envelope_bytes) >= 65) AND (octet_length(envelope_bytes) <= 1048640))),
    CONSTRAINT apx_capture_wire_version_ck CHECK ((envelope_wire_version = 'XIONGBAO_APPROVAL_EXACT_WIRE_V1'::text))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_exact_input_objects (
    id uuid NOT NULL,
    codec_version text NOT NULL,
    stage text NOT NULL,
    approval_id text NOT NULL,
    tenant_id text NOT NULL,
    owner_user_id text NOT NULL,
    actor_user_id text NOT NULL,
    domain_id uuid NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    approval_run_id text NOT NULL,
    source_actual_run_id text NOT NULL,
    tool_call_id text NOT NULL,
    action_digest text NOT NULL,
    source_binding jsonb NOT NULL,
    source_binding_version text NOT NULL,
    plaintext_sha256 text NOT NULL,
    key_version text NOT NULL,
    envelope_wire_version text NOT NULL,
    envelope_bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    capture_id uuid NOT NULL,
    capture_sha256 text NOT NULL,
    saved_result_digest text NOT NULL,
    admission_id text NOT NULL,
    input_digest text NOT NULL,
    plan_identity text NOT NULL,
    plan_run_id text NOT NULL,
    target_run_id text NOT NULL,
    CONSTRAINT apx_prepared_binding_object_ck CHECK ((jsonb_typeof(source_binding) = 'object'::text)),
    CONSTRAINT apx_prepared_binding_version_ck CHECK ((source_binding_version = 'XIONGBAO_APPROVAL_EXACT_SOURCE_BINDING_V1'::text)),
    CONSTRAINT apx_prepared_capture_sha_ck CHECK ((capture_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT apx_prepared_codec_ck CHECK ((codec_version = 'XIONGBAO_EXACT_INPUT_JSON_V1'::text)),
    CONSTRAINT apx_prepared_key_version_ck CHECK ((octet_length(key_version) > 0)),
    CONSTRAINT apx_prepared_scope_budget_ck CHECK (((((((((((((octet_length(approval_id) + octet_length(tenant_id)) + octet_length(owner_user_id)) + octet_length(actor_user_id)) + octet_length(thread_id)) + octet_length(agent_id)) + octet_length(approval_run_id)) + octet_length(source_actual_run_id)) + octet_length(tool_call_id)) + octet_length(action_digest)) + octet_length(source_binding_version)) + octet_length(codec_version)) <= 1536)),
    CONSTRAINT apx_prepared_scope_nonempty_ck CHECK (((octet_length(approval_id) > 0) AND (octet_length(tenant_id) > 0) AND (octet_length(owner_user_id) > 0) AND (octet_length(actor_user_id) > 0) AND (octet_length(thread_id) > 0) AND (octet_length(agent_id) > 0) AND (octet_length(approval_run_id) > 0) AND (octet_length(source_actual_run_id) > 0) AND (octet_length(tool_call_id) > 0) AND (octet_length(action_digest) > 0) AND (octet_length(source_binding_version) > 0) AND (octet_length(codec_version) > 0))),
    CONSTRAINT apx_prepared_sha_ck CHECK ((plaintext_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT apx_prepared_stage_ck CHECK ((stage = 'prepared'::text)),
    CONSTRAINT apx_prepared_wire_size_ck CHECK (((octet_length(envelope_bytes) >= 65) AND (octet_length(envelope_bytes) <= 1048640))),
    CONSTRAINT apx_prepared_wire_version_ck CHECK ((envelope_wire_version = 'XIONGBAO_APPROVAL_EXACT_WIRE_V1'::text))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_preferences (
    owner_user_id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    auto_review boolean DEFAULT false NOT NULL,
    host_commands text DEFAULT 'ask'::text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT approval_preferences_host_commands_check CHECK ((host_commands = ANY (ARRAY['ask'::text, 'allow'::text, 'never'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_requests (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    run_id text NOT NULL,
    tool_call_id text NOT NULL,
    action_digest text NOT NULL,
    action jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decision text,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    consumed_at timestamp with time zone,
    completed_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    decided_via text,
    CONSTRAINT approval_decided_via_check CHECK ((decided_via = ANY (ARRAY['web'::text, 'wechat'::text, 'slack'::text, 'teams'::text]))),
    CONSTRAINT approval_decision_check CHECK ((decision = ANY (ARRAY['allow_once'::text, 'allow_conversation'::text, 'allow_always'::text, 'deny'::text, 'handled'::text]))),
    CONSTRAINT approval_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'consumed'::text, 'completed'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_rules (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    bot_id text NOT NULL,
    tool_ref text NOT NULL,
    effect text NOT NULL,
    scope text NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    behaviour text DEFAULT 'allow'::text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    kind text,
    account text,
    CONSTRAINT approval_rules_behaviour_check CHECK ((behaviour = ANY (ARRAY['allow'::text, 'pre_approved'::text, 'ask'::text, 'hand_off'::text, 'deny'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_team_rules (
    id text NOT NULL,
    bot_id text NOT NULL,
    tool_ref text NOT NULL,
    effect text NOT NULL,
    scope text NOT NULL,
    behaviour text NOT NULL,
    created_by text,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT approval_team_rules_behaviour_check CHECK ((behaviour = ANY (ARRAY['allow'::text, 'pre_approved'::text, 'ask'::text, 'hand_off'::text, 'deny'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_team_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.approval_team_settings (
    id text NOT NULL,
    enforce_auto_review boolean DEFAULT false NOT NULL,
    custom_rules_enabled boolean DEFAULT true NOT NULL,
    host_commands_cap text DEFAULT 'allow'::text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    enforce_dangerous_commands boolean DEFAULT false NOT NULL,
    action_kinds jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewer_guidance text,
    desktop_action_words text[],
    CONSTRAINT approval_team_settings_host_commands_cap_check CHECK ((host_commands_cap = ANY (ARRAY['ask'::text, 'allow'::text, 'never'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_team_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id text NOT NULL,
    uploaded_by text NOT NULL,
    name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attached_at timestamp with time zone,
    upload_group text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id text,
    event_type text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    initiator_kind text DEFAULT 'person'::text NOT NULL,
    initiator_id text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    subject_tenant_id text
);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.automation_continuations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    firing_id uuid NOT NULL,
    key text NOT NULL,
    run_id uuid NOT NULL,
    card_run_ref text NOT NULL,
    status text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.automation_firings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    automation_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    external_id text NOT NULL,
    fingerprint text NOT NULL,
    target jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    execution_id uuid,
    wait_reason text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_firing_wait_reason_check CHECK (((wait_reason IS NULL) OR (wait_reason = 'device'::text)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_firings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.automation_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    automation_id uuid NOT NULL,
    config jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    secret_hash text,
    last_error text
);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_triggers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    name text NOT NULL,
    target jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    max_runs integer,
    end_date timestamp with time zone,
    run_count integer DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automations_max_runs_check CHECK (((max_runs IS NULL) OR (max_runs > 0))),
    CONSTRAINT automations_run_count_check CHECK (((run_count >= 0) AND ((max_runs IS NULL) OR (run_count <= max_runs))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.automations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.avatar_sources (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id text NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    device_id text,
    root_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    notebook_id uuid,
    server_id text,
    CONSTRAINT avatar_sources_kind CHECK ((kind = ANY (ARRAY['declaration'::text, 'local_folder'::text, 'notebook'::text, 'connector'::text]))),
    CONSTRAINT avatar_sources_kind_refs CHECK ((((kind = 'notebook'::text) = (notebook_id IS NOT NULL)) AND ((kind = 'connector'::text) = (server_id IS NOT NULL)) AND ((kind = 'local_folder'::text) OR ((device_id IS NULL) AND (root_ref IS NULL))))),
    CONSTRAINT avatar_sources_label_length CHECK (((char_length(label) >= 1) AND (char_length(label) <= 60))),
    CONSTRAINT avatar_sources_note_length CHECK ((char_length(note) <= 500)),
    CONSTRAINT avatar_sources_own_avatar CHECK ((agent_id = ('avatar-'::text || tenant_id)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.avatar_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.board_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    title text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    role text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    urgent boolean DEFAULT false NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    task_id uuid,
    claim_count integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT board_cards_claimed CHECK (((status = 'open'::text) OR (claimed_at IS NOT NULL))),
    CONSTRAINT board_cards_status CHECK ((status = ANY (ARRAY['open'::text, 'claimed'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.board_cards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.bot_lifecycle (
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    paused_at timestamp with time zone,
    notify text DEFAULT 'all'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.bot_lifecycle FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.bot_tasks (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    channel_id text NOT NULL,
    suggestion_id text,
    title text NOT NULL,
    why text,
    source_app text,
    source_link text,
    origin text NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_tasks_origin_check CHECK ((origin = 'check_in'::text))
);
--> statement-breakpoint
ALTER TABLE ONLY public.bot_tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.brokered_accounts (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    app text NOT NULL,
    user_id text NOT NULL,
    vendor_user_id text NOT NULL,
    account_id text DEFAULT ''::text NOT NULL,
    identity text,
    is_default boolean DEFAULT false NOT NULL,
    connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brokered_accounts_provider_check CHECK ((provider = ANY (ARRAY['composio'::text, 'arcade'::text]))),
    CONSTRAINT brokered_accounts_tenant_person CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.brokered_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.brokered_identities (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    provider text NOT NULL,
    user_id text NOT NULL,
    vendor_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brokered_identities_provider_check CHECK ((provider = ANY (ARRAY['composio'::text, 'arcade'::text]))),
    CONSTRAINT brokered_identities_tenant_is_user_check CHECK ((tenant_id = user_id))
);
--> statement-breakpoint
ALTER TABLE ONLY public.brokered_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.capability_settings (
    scope_kind text NOT NULL,
    scope_id text DEFAULT ''::text NOT NULL,
    capability text NOT NULL,
    allowed boolean NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_settings_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['organization'::text, 'role'::text, 'group'::text])))
);
--> statement-breakpoint
CREATE TABLE public.channel_agents (
    channel_id text NOT NULL,
    agent_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.channel_agents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.channel_memberships (
    channel_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned_at timestamp with time zone,
    last_read_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.channel_memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.channels (
    id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    suggested_prompts text[] DEFAULT '{}'::text[] NOT NULL,
    allowed_groups text[] DEFAULT '{}'::text[] NOT NULL,
    package_id uuid,
    override jsonb,
    last_message text,
    last_message_at timestamp with time zone,
    last_message_agent_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    summary text,
    summary_at timestamp with time zone,
    last_message_source_id text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    created_by text DEFAULT current_setting('app.tenant_id'::text, true),
    opening text,
    title text,
    waker_group_id uuid,
    kind text DEFAULT 'channel'::text NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.channels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.component_exclusions (
    component_name text NOT NULL,
    agent_id text NOT NULL,
    withheld_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.component_functions (
    component_name text NOT NULL,
    function_name text NOT NULL,
    granted_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.components (
    name text NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    draft_description text NOT NULL,
    published_description text,
    published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.composio_connections (
    toolkit text NOT NULL,
    user_id text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    probe_action text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    provider text DEFAULT 'composio'::text NOT NULL,
    vendor_user_id text,
    CONSTRAINT composio_connections_provider_check CHECK ((provider = ANY (ARRAY['composio'::text, 'arcade'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.composio_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.computer_page_frame (
    computer_id text NOT NULL,
    tool_call_id text NOT NULL,
    url text NOT NULL,
    title text,
    frame text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.computer_page_frame FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.computer_snapshot (
    computer_id text NOT NULL,
    snapshot_id integer NOT NULL,
    url text NOT NULL,
    elements jsonb NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    session text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.computer_snapshot FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.computer_waits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    bot_id text NOT NULL,
    kind text NOT NULL,
    request_id text,
    label text NOT NULL,
    tool_call_id text NOT NULL,
    thread_id text NOT NULL,
    continuation jsonb NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT computer_waits_kind CHECK ((kind = ANY (ARRAY['help'::text, 'secret'::text]))),
    CONSTRAINT computer_waits_status CHECK ((status = ANY (ARRAY['waiting'::text, 'resuming'::text, 'done'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.computer_waits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind public.credential_kind NOT NULL,
    provider text NOT NULL,
    encrypted_value text NOT NULL,
    key_id text NOT NULL,
    metadata jsonb NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.default_opt_outs (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    feature text NOT NULL,
    scope text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT default_opt_outs_feature_check CHECK ((feature = ANY (ARRAY['memory_source'::text, 'proactive_research'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.default_opt_outs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.delivery_bindings (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    channel_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    transport text NOT NULL,
    identity text NOT NULL,
    realm text NOT NULL,
    address text NOT NULL,
    mention_id text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    opted_out_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.delivery_challenges (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    channel_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    transport text NOT NULL,
    address text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.delivery_inbox (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    channel_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    binding_id text,
    source text NOT NULL,
    realm text NOT NULL,
    external_id text NOT NULL,
    text text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_inbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.delivery_outbox (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    channel_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    dedupe_key text NOT NULL,
    binding_id text,
    device_id text,
    transport text NOT NULL,
    text text NOT NULL,
    kind text NOT NULL,
    request_id text,
    state text DEFAULT 'queued'::text NOT NULL,
    provider_id text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.demonstrations (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    bot_id text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'recording'::text NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    draft jsonb,
    skill_slug text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.demonstrations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.deployment_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    source_path text NOT NULL,
    checksum text NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    former_name_digest text
);
--> statement-breakpoint
ALTER TABLE ONLY public.deployment_packages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.device_pair_codes (
    code text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text,
    minted_by_user_id text
);
--> statement-breakpoint
ALTER TABLE ONLY public.device_pair_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.employee_device_bindings (
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    registration_id uuid,
    revision bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_device_binding_revision CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT employee_device_binding_tenant CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))
);
--> statement-breakpoint
CREATE TABLE public.employee_role_snapshots (
    agent_id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    profile jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    source_template_id uuid,
    source_template_version integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_role_profile_check CHECK ((jsonb_typeof(profile) = 'object'::text)),
    CONSTRAINT employee_role_source_check CHECK (((source_template_id IS NULL) = (source_template_version IS NULL))),
    CONSTRAINT employee_role_version_check CHECK ((version > 0))
);
--> statement-breakpoint
ALTER TABLE ONLY public.employee_role_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.enterprise_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.flow_confirmations (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    node_id text NOT NULL,
    question jsonb NOT NULL,
    inputs jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    answer text,
    request_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_confirmation_answer_check CHECK (((status = 'answered'::text) = (answer IS NOT NULL))),
    CONSTRAINT flow_confirmation_json_check CHECK (((jsonb_typeof(question) = 'object'::text) AND (jsonb_typeof(inputs) = 'object'::text))),
    CONSTRAINT flow_confirmation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'answered'::text, 'skipped'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_confirmations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_customization_heads (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    session_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_heads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_customization_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    request_id uuid NOT NULL,
    title text NOT NULL,
    creation_fingerprint text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_session_text_check CHECK (((char_length(title) BETWEEN 1 AND 80) AND (char_length(description) <= 500) AND (revision >= 0)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_customization_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    session_id uuid NOT NULL,
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    prompt text NOT NULL,
    context text NOT NULL,
    model_ref uuid NOT NULL,
    members jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_turn_text_check CHECK (((char_length(prompt) BETWEEN 1 AND 4000) AND (char_length(context) <= 20000) AND (jsonb_typeof(members) = 'array'::text)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_import_proposals (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    fingerprint text NOT NULL,
    token text NOT NULL,
    digest text NOT NULL,
    owner_revision text,
    choices jsonb NOT NULL,
    preview jsonb NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    import_request_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_import_proposals_revision_check CHECK ((revision >= 0)),
    CONSTRAINT flow_import_proposals_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'imported'::text])))
);
--> statement-breakpoint
CREATE TABLE public.flow_official_bindings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    source_id text NOT NULL,
    source_version text NOT NULL,
    source_digest text NOT NULL,
    bindings jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_official_bindings_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT flow_official_bindings_object_check CHECK ((jsonb_typeof(bindings) = 'object'::text))
);
--> statement-breakpoint
CREATE TABLE public.flow_official_source_heads (
    source_id text NOT NULL,
    source_version text NOT NULL,
    source_digest text NOT NULL,
    CONSTRAINT flow_official_source_heads_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text))
);
--> statement-breakpoint
CREATE TABLE public.flow_run_events (
    sequence bigint NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    correlation_id text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_run_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT flow_run_events_type_check CHECK ((type = ANY (ARRAY['run_started'::text, 'step_started'::text, 'step_done'::text, 'step_parked'::text, 'step_answered'::text, 'step_skipped'::text, 'step_failed'::text, 'run_done'::text, 'run_failed'::text, 'run_aborted'::text, 'run_retried'::text, 'branch_taken'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE SEQUENCE public.flow_run_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.flow_run_events_sequence_seq OWNED BY public.flow_run_events.sequence;
--> statement-breakpoint
CREATE TABLE public.flow_run_retries (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    source_revision integer NOT NULL,
    definition_revision integer NOT NULL,
    correlation_id text NOT NULL,
    node_id text NOT NULL,
    new_run_id uuid NOT NULL,
    fingerprint text NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_run_retries_revision_check CHECK (((source_revision >= 0) AND (definition_revision > 0))),
    CONSTRAINT flow_run_retries_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'ready'::text, 'unknown'::text, 'cancelled'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_retries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_share_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    flow_id uuid,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_import_result_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_share_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_share_links (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    token_hash text NOT NULL,
    creation_fingerprint text NOT NULL,
    package_snapshot jsonb NOT NULL,
    digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    max_uses integer,
    uses integer DEFAULT 0 NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_share_limits_check CHECK (((max_uses IS NOT NULL) AND (max_uses <= 100) AND (expires_at <= (created_at + '30 days'::interval)))),
    CONSTRAINT flow_share_max_uses_check CHECK (((max_uses IS NULL) OR (max_uses > 0))),
    CONSTRAINT flow_share_shape_check CHECK (((jsonb_typeof(package_snapshot) = 'object'::text) AND (digest ~ '^[0-9a-f]{64}$'::text) AND (token_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT flow_share_uses_check CHECK (((uses >= 0) AND ((max_uses IS NULL) OR (uses <= max_uses))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_share_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.flow_source_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    fingerprint text NOT NULL,
    generation_fingerprint text,
    base jsonb NOT NULL,
    status text NOT NULL,
    raw_source text NOT NULL,
    source_digest text NOT NULL,
    source_bytes integer NOT NULL,
    compiler jsonb NOT NULL,
    artifact jsonb,
    diagnostics jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_candidates_bytes_check CHECK (((source_bytes = octet_length(raw_source)) AND ((source_bytes >= 1) AND (source_bytes <= 102400)))),
    CONSTRAINT flow_source_candidates_digest_check CHECK ((source_digest = encode(sha256(convert_to(raw_source, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT flow_source_candidates_generation_fingerprint_check CHECK (((generation_fingerprint IS NULL) OR (generation_fingerprint ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT flow_source_candidates_status_check CHECK (COALESCE((((status = 'invalid'::text) AND (artifact IS NULL)) OR ((status = 'prepared'::text) AND (artifact IS NOT NULL) AND (jsonb_typeof(artifact) = 'object'::text) AND ((artifact -> 'runtimeReady'::text) = 'false'::jsonb) AND (((artifact -> 'source'::text) ->> 'sha256'::text) = source_digest) AND (((artifact -> 'source'::text) ->> 'codec'::text) = 'utf8-raw-v1'::text) AND (((artifact -> 'source'::text) -> 'bytes'::text) = to_jsonb(source_bytes)) AND ((artifact -> 'compiler'::text) = compiler))), false))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_inline_invocations (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    parent_invocation_id uuid NOT NULL,
    identity jsonb NOT NULL,
    fingerprint text NOT NULL,
    args jsonb NOT NULL,
    dispatch_key uuid NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    receipt jsonb,
    late_receipt jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_inline_identity_check CHECK (COALESCE((((identity ->> 'tenantId'::text) = tenant_id) AND ((identity ->> 'runId'::text) = (run_id)::text) AND ((identity ->> 'parentInvocationId'::text) = (parent_invocation_id)::text) AND ((identity ->> 'invocationId'::text) = (id)::text) AND ((identity ->> 'childOrdinal'::text) ~ '^[1-9][0-9]*$'::text) AND ((identity ->> 'ownerEpoch'::text) ~ '^[1-9][0-9]*$'::text) AND ((identity ->> 'runRevision'::text) ~ '^[1-9][0-9]*$'::text)), false)),
    CONSTRAINT flow_source_inline_receipt_check CHECK (COALESCE((((receipt IS NULL) OR (((receipt -> 'identity'::text) = identity) AND ((receipt ->> 'dispatchKey'::text) = (dispatch_key)::text) AND ((receipt ->> 'authority'::text) = 'governed-inline-host'::text) AND ((receipt ->> 'state'::text) = state))) AND ((late_receipt IS NULL) OR ((state = 'unknown'::text) AND ((late_receipt -> 'identity'::text) = identity) AND ((late_receipt ->> 'dispatchKey'::text) = (dispatch_key)::text) AND ((late_receipt ->> 'authority'::text) = 'governed-inline-host'::text)))), false)),
    CONSTRAINT flow_source_inline_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'not-dispatched'::text, 'dispatched'::text, 'completed'::text, 'failed-known'::text, 'unknown'::text])))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_invocations (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    identity jsonb NOT NULL,
    fingerprint text NOT NULL,
    args jsonb NOT NULL,
    dispatch_key uuid NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    receipt jsonb,
    late_receipt jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_invocations_correlation_check CHECK (COALESCE(((((identity -> 'original'::text) ->> 'version'::text) = 'original-ordinal-v1'::text) AND (((identity -> 'original'::text) ->> 'runtimeCallOrdinal'::text) ~ '^[1-9][0-9]*$'::text) AND (((identity -> 'original'::text) ->> 'dynamicIndex'::text) ~ '^(0|[1-9][0-9]*)$'::text) AND (((identity -> 'original'::text) ->> 'correlationId'::text) = concat(((identity -> 'original'::text) ->> 'scriptDigest'::text), ':', ((identity -> 'original'::text) ->> 'runtimeCallOrdinal'::text), ':', ((identity -> 'original'::text) ->> 'dynamicIndex'::text)))), false)),
    CONSTRAINT flow_source_invocations_identity_check CHECK (COALESCE((((identity ->> 'tenantId'::text) = tenant_id) AND ((identity ->> 'runId'::text) = (run_id)::text) AND ((identity ->> 'invocationId'::text) = (id)::text) AND (jsonb_typeof((identity -> 'ownerEpoch'::text)) = 'number'::text) AND (jsonb_typeof((identity -> 'runRevision'::text)) = 'number'::text) AND ((identity ->> 'primitive'::text) = ANY (ARRAY['worker'::text, 'action'::text, 'askUser'::text, 'workflow'::text]))), false)),
    CONSTRAINT flow_source_invocations_receipt_check CHECK (COALESCE((((receipt IS NULL) OR (((receipt -> 'identity'::text) = identity) AND ((receipt ->> 'dispatchKey'::text) = (dispatch_key)::text) AND ((receipt ->> 'authority'::text) = 'governed-host'::text) AND ((receipt ->> 'state'::text) = state))) AND ((late_receipt IS NULL) OR ((state = 'unknown'::text) AND ((late_receipt -> 'identity'::text) = identity) AND ((late_receipt ->> 'dispatchKey'::text) = (dispatch_key)::text) AND ((late_receipt ->> 'authority'::text) = 'governed-host'::text)))), false)),
    CONSTRAINT flow_source_invocations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'not-dispatched'::text, 'dispatched'::text, 'completed'::text, 'failed-known'::text, 'unknown'::text])))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_operations_kind_check CHECK ((kind = ANY (ARRAY['apply'::text, 'activate'::text])))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_original_activations (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    fingerprint text NOT NULL,
    input_text text NOT NULL,
    flow_id uuid NOT NULL,
    task_id uuid NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    version_id uuid NOT NULL,
    source_digest text NOT NULL,
    definition_revision integer NOT NULL,
    handle_id text NOT NULL,
    execution_epoch integer NOT NULL,
    activation_owner_epoch integer NOT NULL,
    activation_run_revision integer NOT NULL,
    receipt_text text NOT NULL,
    receipt_digest text NOT NULL,
    owner_record_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_original_activation_epoch_check CHECK (((execution_epoch > 0) AND (activation_owner_epoch = execution_epoch) AND (activation_run_revision > 0) AND (definition_revision >= 0))),
    CONSTRAINT flow_source_original_activation_text_check CHECK (((receipt_digest = encode(sha256(convert_to(receipt_text, 'UTF8'::name)), 'hex'::text)) AND (fingerprint = encode(sha256(convert_to(input_text, 'UTF8'::name)), 'hex'::text))))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_original_projection_observations (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    state text NOT NULL,
    observation_text text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_original_projection_digest_check CHECK ((fingerprint = encode(sha256(convert_to(observation_text, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT flow_source_original_projection_state_check CHECK ((state = ANY (ARRAY['projected'::text, 'unknown'::text])))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_public_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    fingerprint text NOT NULL,
    input_text text NOT NULL,
    state text NOT NULL,
    reason text,
    result_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_public_operations_input_check CHECK (((octet_length(input_text) BETWEEN 1 AND 2162688) AND (fingerprint = encode(sha256(convert_to(input_text, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT flow_source_public_operations_kind_check CHECK ((kind = ANY (ARRAY['start'::text, 'generate'::text]))),
    CONSTRAINT flow_source_public_operations_result_check CHECK ((((state = 'completed'::text) AND (result_text IS NOT NULL) AND (reason IS NULL)) OR ((state <> 'completed'::text) AND (result_text IS NULL)))),
    CONSTRAINT flow_source_public_operations_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'dispatched'::text, 'completed'::text, 'not-dispatched'::text, 'unknown'::text, 'failed-known'::text])))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_resource_snapshots (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    task_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    fingerprint text NOT NULL,
    snapshot_text text NOT NULL,
    snapshot_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_resource_snapshot_digest_check CHECK ((snapshot_digest = encode(sha256(convert_to(snapshot_text, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT source_resource_snapshot_tenant_check CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))),
    CONSTRAINT source_resource_snapshot_text_bytes_check CHECK (((octet_length(snapshot_text) >= 1) AND (octet_length(snapshot_text) <= 65536)))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_runs (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    version_id uuid NOT NULL,
    task_id uuid NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    source_digest text NOT NULL,
    definition_revision integer,
    public_operation_id uuid,
    public_operation_fingerprint text,
    state text DEFAULT 'prepared'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    view_revision integer DEFAULT 1 NOT NULL,
    execution_epoch integer DEFAULT 1 NOT NULL,
    owner_epoch integer DEFAULT 1 NOT NULL,
    admission_open boolean DEFAULT false NOT NULL,
    handle_id text,
    event_sequence integer DEFAULT 0 NOT NULL,
    input_value jsonb,
    lease_expires_at timestamp with time zone NOT NULL,
    final_value jsonb,
    failure bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_runs_admission_check CHECK (((NOT admission_open) OR ((state = 'running'::text) AND (handle_id IS NOT NULL) AND (owner_epoch = execution_epoch)))),
    CONSTRAINT flow_source_runs_definition_revision_check CHECK ((definition_revision >= 0)),
    CONSTRAINT flow_source_runs_epoch_check CHECK (((revision > 0) AND (execution_epoch > 0) AND (owner_epoch >= execution_epoch))),
    CONSTRAINT flow_source_runs_public_origin_check CHECK ((((public_operation_id IS NULL) AND (public_operation_fingerprint IS NULL)) OR ((public_operation_id IS NOT NULL) AND (public_operation_fingerprint IS NOT NULL) AND (public_operation_fingerprint ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT flow_source_runs_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'running'::text, 'waiting'::text, 'stopping'::text, 'stopped'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT flow_source_runs_view_revision_check CHECK ((view_revision > 0))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_runtime_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    sequence integer NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_runtime_events_sequence_check CHECK (((sequence > 0) AND (type = ANY (ARRAY['phase'::text, 'log'::text]))))
);
--> statement-breakpoint
CREATE TABLE public.flow_source_stop_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    run_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.flow_source_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    parent_version_id uuid,
    created_head_revision integer NOT NULL,
    raw_source text NOT NULL,
    source_digest text NOT NULL,
    source_bytes integer NOT NULL,
    compiler jsonb NOT NULL,
    artifact jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT flow_source_versions_artifact_check CHECK (COALESCE(((jsonb_typeof(artifact) = 'object'::text) AND ((artifact -> 'runtimeReady'::text) = 'false'::jsonb) AND (((artifact -> 'source'::text) ->> 'sha256'::text) = source_digest) AND (((artifact -> 'source'::text) ->> 'codec'::text) = 'utf8-raw-v1'::text) AND (((artifact -> 'source'::text) -> 'bytes'::text) = to_jsonb(source_bytes)) AND ((artifact -> 'compiler'::text) = compiler)), false)),
    CONSTRAINT flow_source_versions_bytes_check CHECK (((source_bytes = octet_length(raw_source)) AND ((source_bytes >= 1) AND (source_bytes <= 102400)))),
    CONSTRAINT flow_source_versions_digest_check CHECK ((source_digest = encode(sha256(convert_to(raw_source, 'UTF8'::name)), 'hex'::text)))
);
--> statement-breakpoint
CREATE TABLE public.generated_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    kind text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    bytes bytea NOT NULL,
    prompt text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    channel_id text,
    CONSTRAINT generated_media_bytes_size CHECK (((octet_length(bytes) <= 52428800) AND (size_bytes = octet_length(bytes)))),
    CONSTRAINT generated_media_kind CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT generated_media_mime_type CHECK ((mime_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/gif'::text, 'image/webp'::text, 'video/mp4'::text, 'video/webm'::text]))),
    CONSTRAINT generated_media_prompt_length CHECK ((char_length(prompt) <= 4000))
);
--> statement-breakpoint
ALTER TABLE ONLY public.generated_media FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.group_bot_threads (
    owner_user_id text NOT NULL,
    channel_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.group_bot_threads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.group_message_private (
    message_id text NOT NULL,
    owner_user_id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.group_message_private FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.group_messages (
    id text NOT NULL,
    channel_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text,
    thread_id text,
    text text NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT group_messages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting'::text, 'completed'::text, 'failed'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.group_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.group_pipeline_start_receipts (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    request_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    fingerprint text NOT NULL,
    template_id uuid NOT NULL,
    template_snapshot text NOT NULL,
    task text NOT NULL,
    run_id uuid NOT NULL,
    parent_task_id uuid,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_pipeline_start_receipts_acceptance_check CHECK ((((accepted_at IS NULL) AND (parent_task_id IS NULL)) OR ((accepted_at IS NOT NULL) AND (parent_task_id IS NOT NULL)))),
    CONSTRAINT group_pipeline_start_receipts_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT group_pipeline_start_receipts_version_check CHECK ((version = 1))
);
--> statement-breakpoint
CREATE TABLE public.group_task_runs (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid,
    group_id uuid NOT NULL,
    parent_task_id uuid,
    status text DEFAULT 'running'::text NOT NULL,
    cursor integer DEFAULT 0 NOT NULL,
    steps jsonb NOT NULL,
    initiated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    advance_owner text,
    revision integer DEFAULT 0 NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    flow_id uuid,
    parent_run_id uuid,
    parent_step_id text,
    CONSTRAINT group_task_runs_parent_pair_check CHECK (((parent_run_id IS NULL) = (parent_step_id IS NULL)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.group_task_templates (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    steps jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.heartbeat_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    outcome text DEFAULT 'running'::text NOT NULL,
    thread_id text,
    cards_claimed integer DEFAULT 0 NOT NULL,
    error text,
    CONSTRAINT heartbeat_runs_outcome CHECK ((outcome = ANY (ARRAY['running'::text, 'quiet'::text, 'acted'::text, 'failed'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.heartbeat_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.identity_link_challenges (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    token_hash text NOT NULL,
    provider text NOT NULL,
    user_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.identity_link_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.identity_links (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    provider text NOT NULL,
    realm text NOT NULL,
    subject text NOT NULL,
    user_id text NOT NULL,
    handle text,
    verified_by text NOT NULL,
    credential_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_links_status_check CHECK ((status = ANY (ARRAY['active'::text, 'needs_reconnect'::text]))),
    CONSTRAINT identity_links_verified_by_check CHECK ((verified_by = ANY (ARRAY['challenge'::text, 'oauth'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.identity_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.intelligence_channel_mappings (
    user_id text NOT NULL,
    channel_id text NOT NULL,
    thread_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    model_selection jsonb
);
--> statement-breakpoint
ALTER TABLE ONLY public.intelligence_channel_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.knowledge_binding_heads (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT knowledge_head_revision_check CHECK ((revision >= 0))
);
--> statement-breakpoint
CREATE TABLE public.knowledge_bindings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    notebook_id uuid NOT NULL,
    access_mode text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_binding_mode_check CHECK ((access_mode = ANY (ARRAY['read_only'::text, 'read_write'::text])))
);
--> statement-breakpoint
CREATE TABLE public.knowledge_directories (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    notebook_id uuid NOT NULL,
    parent_id uuid,
    title text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_directory_revision_check CHECK ((revision > 0)),
    CONSTRAINT knowledge_directory_title_check CHECK (((char_length(title) BETWEEN 1 AND 120) AND (title <> ALL (ARRAY['.'::text, '..'::text])) AND (POSITION(('/'::text) IN (title)) = 0) AND (POSITION((chr(92)) IN (title)) = 0)))
);
--> statement-breakpoint
CREATE TABLE public.knowledge_notebooks (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    title text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT knowledge_notebook_revision_check CHECK ((revision > 0)),
    CONSTRAINT knowledge_notebook_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120)))
);
--> statement-breakpoint
CREATE TABLE public.knowledge_receipts (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    logical_operation_id uuid NOT NULL,
    request_hash text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.knowledge_sources (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    notebook_id uuid NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    directory_id uuid,
    filename text,
    raw_content text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    digest text,
    status text NOT NULL,
    error text,
    provenance jsonb,
    document jsonb,
    document_bytes bytea,
    revision integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_document_check CHECK (((((kind = 'document'::text) AND (raw_content = ''::text) AND (filename ~* '[.](pdf|docx)$'::text) AND (document IS NOT NULL) AND (document_bytes IS NOT NULL) AND ((octet_length(document_bytes) >= 1) AND (octet_length(document_bytes) <= 2097152)) AND (jsonb_typeof(document) = 'object'::text) AND (document ?& ARRAY['format'::text, 'sourceDigest'::text, 'bytes'::text, 'filename'::text]) AND (jsonb_typeof((document -> 'format'::text)) = 'string'::text) AND (jsonb_typeof((document -> 'sourceDigest'::text)) = 'string'::text) AND (jsonb_typeof((document -> 'bytes'::text)) = 'number'::text) AND (jsonb_typeof((document -> 'filename'::text)) = 'string'::text) AND ((document ->> 'format'::text) = ANY (ARRAY['pdf'::text, 'docx'::text])) AND ((document ->> 'sourceDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND (((document ->> 'bytes'::text))::integer = octet_length(document_bytes)) AND ((document ->> 'filename'::text) = filename)) OR ((kind <> 'document'::text) AND (document IS NULL) AND (document_bytes IS NULL))) IS TRUE)),
    CONSTRAINT knowledge_source_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'markdown'::text, 'file'::text, 'url'::text, 'document'::text]))),
    CONSTRAINT knowledge_source_raw_check CHECK ((char_length(raw_content) <= 65536)),
    CONSTRAINT knowledge_source_revision_check CHECK ((revision > 0)),
    CONSTRAINT knowledge_source_state_check CHECK ((((status = 'ready'::text) AND (digest ~ '^[a-f0-9]{64}$'::text) AND (error IS NULL) AND ((octet_length(content) >= 1) AND (octet_length(content) <= 262144))) OR ((status = 'error'::text) AND (digest IS NULL) AND (error IS NOT NULL) AND (content = ''::text)))),
    CONSTRAINT knowledge_source_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120)))
);
--> statement-breakpoint
CREATE TABLE public.knowledge_write_claims (
    claim_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    tenant_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    run_id text NOT NULL,
    thread_id text NOT NULL,
    tool_call_id text NOT NULL,
    epoch integer NOT NULL,
    request_hash text NOT NULL,
    sdk_hash text NOT NULL,
    target_hash text NOT NULL,
    action_digest text NOT NULL,
    original_args jsonb NOT NULL,
    action jsonb NOT NULL,
    receipt_identity jsonb,
    approval_identity text,
    attempt_id uuid,
    outcome jsonb,
    state text DEFAULT 'reserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_claim_epoch CHECK ((epoch >= 1)),
    CONSTRAINT knowledge_claim_hashes CHECK (((request_hash ~ '^[a-f0-9]{64}$'::text) AND (sdk_hash ~ '^[a-f0-9]{64}$'::text) AND (target_hash ~ '^[a-f0-9]{64}$'::text) AND (action_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT knowledge_claim_json CHECK (((jsonb_typeof(original_args) = 'object'::text) AND (jsonb_typeof(action) = 'object'::text))),
    CONSTRAINT knowledge_claim_owner CHECK (((owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))),
    CONSTRAINT knowledge_claim_state CHECK ((state = ANY (ARRAY['reserved'::text, 'pending'::text, 'ready'::text, 'unknown'::text, 'applied'::text, 'denied'::text, 'handled'::text])))
);
--> statement-breakpoint
CREATE TABLE public.knowledge_write_executions (
    tenant_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    run_id text NOT NULL,
    thread_id text NOT NULL,
    epoch integer DEFAULT 1 NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    CONSTRAINT knowledge_execution_epoch CHECK ((epoch >= 1)),
    CONSTRAINT knowledge_execution_owner CHECK (((owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))),
    CONSTRAINT knowledge_execution_state CHECK ((state = ANY (ARRAY['active'::text, 'stopped'::text]))),
    CONSTRAINT knowledge_execution_stopped_at CHECK ((((state = 'active'::text) AND (stopped_at IS NULL)) OR ((state = 'stopped'::text) AND (stopped_at IS NOT NULL) AND (epoch >= 2))))
);
--> statement-breakpoint
CREATE TABLE public.learned_skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    skill_slug text NOT NULL,
    origin text NOT NULL,
    use_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_fingerprint text,
    CONSTRAINT learned_skills_origin CHECK ((origin = ANY (ARRAY['tool'::text, 'retrospect'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.learned_skills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.learning_open_skills (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    skill_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_open_skills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.learning_person_spaces (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    container_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_person_spaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.learning_settings (
    id text NOT NULL,
    settings jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_settings_id_length CHECK (((char_length(id) >= 1) AND (char_length(id) <= 64)))
);
--> statement-breakpoint
CREATE TABLE public.learning_skill_approvals (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    skill_name text NOT NULL,
    approved_by text NOT NULL,
    sharing text DEFAULT 'none'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_skill_approvals_approved_by_check CHECK ((approved_by = ANY (ARRAY['person'::text, 'admin'::text]))),
    CONSTRAINT learning_skill_approvals_sharing_check CHECK ((sharing = ANY (ARRAY['none'::text, 'requested'::text, 'approved'::text, 'declined'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_skill_approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.learning_skill_sharing (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    mode text DEFAULT 'closed'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_skill_sharing_mode_check CHECK ((mode = ANY (ARRAY['closed'::text, 'open'::text, 'choose'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_skill_sharing FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.learning_thread_bindings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    container_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_thread_bindings_container_id CHECK (((container_id IS NULL) OR (container_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_thread_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.local_learning_runs (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    outcome text DEFAULT 'running'::text NOT NULL,
    skip_reason text,
    runs_read integer DEFAULT 0 NOT NULL,
    candidates integer DEFAULT 0 NOT NULL,
    CONSTRAINT local_learning_runs_outcome_check CHECK ((outcome = ANY (ARRAY['running'::text, 'proposed'::text, 'nothing'::text, 'skipped'::text, 'failed'::text]))),
    CONSTRAINT local_learning_runs_skip_reason_check CHECK (((skip_reason IS NULL) OR (skip_reason = ANY (ARRAY['off'::text, 'quota'::text, 'no_evidence'::text, 'no_model'::text]))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.local_learning_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.local_learning_state (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    evidence_cursor timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.local_learning_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.local_skill_candidates (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    run_id text NOT NULL,
    agent_id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    instructions text NOT NULL,
    reason text NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending_review'::text NOT NULL,
    skill_slug text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by text,
    CONSTRAINT local_skill_candidates_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.local_skill_candidates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.mcp_servers (
    id text NOT NULL,
    title text NOT NULL,
    vendor text NOT NULL,
    url text NOT NULL,
    provenance text DEFAULT 'first-party'::text NOT NULL,
    credential_id uuid,
    tools_refreshed_at timestamp with time zone,
    last_error text,
    added_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_scheme text,
    logo text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    catalogue_key text,
    listing_revision integer DEFAULT 0 NOT NULL,
    account_mode text DEFAULT 'personal'::text NOT NULL,
    shared_vendor_user_id text,
    shared_connected_at timestamp with time zone,
    shared_connected_by text,
    shared_verified boolean DEFAULT false NOT NULL,
    shared_verified_at timestamp with time zone,
    shared_probe_action text,
    entra_scope text,
    owner_grants text,
    skipped_tools text[],
    owner_grants_chosen_at timestamp with time zone,
    CONSTRAINT mcp_servers_account_mode_check CHECK ((account_mode = ANY (ARRAY['personal'::text, 'shared'::text]))),
    CONSTRAINT mcp_servers_owner_grants_check CHECK (((owner_grants IS NULL) OR (owner_grants = ANY (ARRAY['any'::text, 'admin'::text])))),
    CONSTRAINT mcp_servers_shared_account_check CHECK ((((account_mode = 'shared'::text) AND (shared_vendor_user_id IS NOT NULL) AND ((shared_connected_at IS NULL) OR (shared_connected_by IS NOT NULL))) OR ((account_mode = 'personal'::text) AND (shared_vendor_user_id IS NULL) AND (shared_connected_at IS NULL) AND (shared_connected_by IS NULL) AND (shared_verified = false) AND (shared_verified_at IS NULL) AND (shared_probe_action IS NULL))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_servers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.mcp_tools (
    server_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    input_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    effect text,
    destructive boolean DEFAULT false NOT NULL,
    version text,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    unclassified boolean DEFAULT false NOT NULL,
    vendor_name text
);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_tools FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.mcp_user_credentials (
    server_id text NOT NULL,
    user_id text NOT NULL,
    credential_id uuid NOT NULL,
    scope text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_user_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.memory_embeddings (
    memory_id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    model text NOT NULL,
    dims integer NOT NULL,
    embedding real[] NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_embeddings_dims CHECK (((dims > 0) AND (cardinality(embedding) = dims)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.memory_embeddings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.memory_sources (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    tool_ref text NOT NULL,
    title text NOT NULL,
    args jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sync_status text DEFAULT 'idle'::text NOT NULL,
    sync_error text,
    last_sync_at timestamp with time zone,
    next_sync_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.memory_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.model_registry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    provider text NOT NULL,
    base_url text,
    credential_id uuid,
    model_name text NOT NULL,
    label text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_window integer,
    CONSTRAINT model_registry_context_window_positive CHECK ((context_window > 0))
);
--> statement-breakpoint
ALTER TABLE ONLY public.model_registry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.model_token_calls (
    tenant_id text NOT NULL,
    call_id uuid NOT NULL,
    run_id text NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    execution_epoch bigint NOT NULL,
    model_ref uuid NOT NULL,
    provider text NOT NULL,
    model_name text NOT NULL,
    credential_id uuid NOT NULL,
    credential_digest text NOT NULL,
    original_model_fingerprint text NOT NULL,
    sdk_provider text NOT NULL,
    sdk_model_id text NOT NULL,
    original_text text NOT NULL,
    original_digest text NOT NULL,
    outcome text DEFAULT 'pending'::text NOT NULL,
    usage_status text DEFAULT 'unknown'::text NOT NULL,
    input_tokens bigint,
    output_tokens bigint,
    total_tokens bigint,
    reasoning_tokens bigint,
    cached_input_tokens bigint,
    cache_write_tokens bigint,
    receipt_text text,
    receipt_digest text,
    started_at timestamp with time zone NOT NULL,
    observed_at timestamp with time zone,
    CONSTRAINT model_token_calls_count_0 CHECK (((input_tokens >= 0) AND (input_tokens <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_count_1 CHECK (((output_tokens >= 0) AND (output_tokens <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_count_2 CHECK (((total_tokens >= 0) AND (total_tokens <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_count_3 CHECK (((reasoning_tokens >= 0) AND (reasoning_tokens <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_count_4 CHECK (((cached_input_tokens >= 0) AND (cached_input_tokens <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_count_5 CHECK (((cache_write_tokens >= 0) AND (cache_write_tokens <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_digests CHECK (((credential_digest ~ '^[a-f0-9]{64}$'::text) AND (original_model_fingerprint ~ '^[a-f0-9]{64}$'::text) AND (original_digest ~ '^[a-f0-9]{64}$'::text) AND (original_digest = encode(sha256(convert_to(original_text, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT model_token_calls_epoch CHECK (((execution_epoch >= 1) AND (execution_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT model_token_calls_outcome CHECK ((outcome = ANY (ARRAY['pending'::text, 'completed'::text, 'stopped'::text, 'unknown'::text]))),
    CONSTRAINT model_token_calls_owner CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))),
    CONSTRAINT model_token_calls_receipt CHECK ((((receipt_text IS NULL) AND (receipt_digest IS NULL) AND (outcome <> 'completed'::text)) OR ((receipt_text IS NOT NULL) AND (receipt_digest IS NOT NULL) AND (receipt_digest ~ '^[a-f0-9]{64}$'::text) AND (receipt_digest = encode(sha256(convert_to(receipt_text, 'UTF8'::name)), 'hex'::text)) AND (outcome = 'completed'::text) AND (observed_at IS NOT NULL)))),
    CONSTRAINT model_token_calls_usage CHECK (((usage_status = ANY (ARRAY['unknown'::text, 'partial'::text, 'reported'::text])) AND (((usage_status = 'reported'::text) AND (input_tokens IS NOT NULL) AND (output_tokens IS NOT NULL)) OR ((usage_status = 'partial'::text) AND ((input_tokens IS NULL) <> (output_tokens IS NULL))) OR ((usage_status = 'unknown'::text) AND (input_tokens IS NULL) AND (output_tokens IS NULL)))))
);
--> statement-breakpoint
CREATE TABLE public.model_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text,
    agent_id text NOT NULL,
    thread_id text,
    run_id text,
    model text NOT NULL,
    source text NOT NULL,
    allowed boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT model_usage_source_check CHECK ((source = ANY (ARRAY['configured'::text, 'bound'::text, 'observed'::text, 'unknown'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.model_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.network_policies (
    scope_kind text NOT NULL,
    scope_id text DEFAULT ''::text NOT NULL,
    mode text NOT NULL,
    rules jsonb DEFAULT '{"entries": []}'::jsonb NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT network_policies_mode_check CHECK ((mode = ANY (ARRAY['allow_all'::text, 'defaults_plus_allowlist'::text, 'allowlist_only'::text]))),
    CONSTRAINT network_policies_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['organization'::text, 'group'::text])))
);
--> statement-breakpoint
CREATE TABLE public.pending_authorizations (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    actor_id text NOT NULL,
    server_id text NOT NULL,
    action text,
    holder text NOT NULL,
    user_id text,
    vendor_user_id text NOT NULL,
    auth_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    outcome text,
    CONSTRAINT pending_authorizations_completion_check CHECK (((completed_at IS NULL) = (outcome IS NULL))),
    CONSTRAINT pending_authorizations_holder_check CHECK ((((holder = 'person'::text) AND (user_id IS NOT NULL)) OR ((holder = 'deployment'::text) AND (user_id IS NULL)))),
    CONSTRAINT pending_authorizations_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'unreconciled'::text, 'withdrawn'::text])))),
    CONSTRAINT pending_authorizations_tenant_is_actor_check CHECK ((tenant_id = actor_id)),
    CONSTRAINT pending_authorizations_user_is_actor_check CHECK (((user_id IS NULL) OR (user_id = actor_id)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.pending_authorizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.persona_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    name text NOT NULL,
    persona jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.persona_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.personal_memories (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    source_id text,
    external_id text,
    import_digest text,
    content text NOT NULL,
    provenance text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    review_state text DEFAULT 'unreviewed'::text NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    formed_by text DEFAULT 'person'::text NOT NULL,
    formed_by_agent_id text,
    source_app text,
    source_ref text,
    source_link text,
    observed_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    intelligence_memory_id text,
    intelligence_digest text
);
--> statement-breakpoint
ALTER TABLE ONLY public.personal_memories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.plans (
    id text NOT NULL,
    name text NOT NULL,
    limits jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.platform_model_pool (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    base_url text,
    model_name text NOT NULL,
    label text NOT NULL,
    api_key_env text NOT NULL,
    tiers text[] DEFAULT '{free,pro}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_window integer,
    CONSTRAINT platform_model_pool_api_key_env CHECK ((api_key_env ~ '^XIONGBAO_POOL_[A-Z0-9_]{1,64}$'::text)),
    CONSTRAINT platform_model_pool_context_window_positive CHECK ((context_window > 0)),
    CONSTRAINT platform_model_pool_tiers CHECK ((tiers <@ '{free,pro}'::text[]))
);
--> statement-breakpoint
CREATE TABLE public.plugin_assembly_origins (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publisher_user_id text NOT NULL,
    source_tenant_id text NOT NULL,
    source_id text NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugin_assembly_origin_publisher CHECK (((tenant_id = publisher_user_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))),
    CONSTRAINT plugin_assembly_origins_kind_check CHECK ((kind = ANY (ARRAY['mcp'::text, 'skill'::text])))
);
--> statement-breakpoint
CREATE TABLE public.plugin_assembly_publications (
    id uuid NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    state text NOT NULL,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    source_digest text NOT NULL,
    publisher_label text NOT NULL,
    artifact jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugin_assembly_artifact_kind CHECK (((jsonb_typeof(artifact) = 'object'::text) AND ((artifact ->> 'kind'::text) = kind))),
    CONSTRAINT plugin_assembly_publications_kind_check CHECK ((kind = ANY (ARRAY['mcp'::text, 'skill'::text]))),
    CONSTRAINT plugin_assembly_publications_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT plugin_assembly_publications_state_check CHECK ((state = ANY (ARRAY['published'::text, 'withdrawn'::text, 'stale'::text])))
);
--> statement-breakpoint
CREATE TABLE public.plugin_grants (
    kind text NOT NULL,
    ref text NOT NULL,
    agent_id text NOT NULL,
    granted_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    assembly_binding jsonb,
    granted_as text,
    CONSTRAINT plugin_grants_granted_as_check CHECK (((granted_as IS NULL) OR (granted_as = ANY (ARRAY['admin'::text, 'owner'::text]))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.plugin_install_listings (
    tenant_id text NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    listed_by text NOT NULL,
    listed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugin_install_listings_kind_check CHECK ((kind = ANY (ARRAY['mcp'::text, 'skill'::text]))),
    CONSTRAINT plugin_install_listings_ref_check CHECK (((length(ref) > 0) AND (ref = btrim(ref)))),
    CONSTRAINT plugin_install_listings_tenant_check CHECK ((tenant_id = 'system'::text))
);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_install_listings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.portrait_media (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    content_type text NOT NULL,
    bytes bytea NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portrait_media_bytes_size CHECK ((octet_length(bytes) <= 2097152)),
    CONSTRAINT portrait_media_content_type CHECK ((content_type = ANY (ARRAY['video/mp4'::text, 'video/webm'::text]))),
    CONSTRAINT portrait_media_subject_id_length CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 200))),
    CONSTRAINT portrait_media_subject_kind CHECK ((subject_kind = ANY (ARRAY['coworker'::text, 'group'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.portrait_media FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.portraits (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    preset text,
    content_type text,
    bytes bytea,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    outfit text,
    CONSTRAINT portraits_bytes_size CHECK (((bytes IS NULL) OR (octet_length(bytes) <= 262144))),
    CONSTRAINT portraits_content_type CHECK (((content_type IS NULL) OR (content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'image/gif'::text])))),
    CONSTRAINT portraits_one_choice CHECK ((((preset IS NOT NULL) AND (bytes IS NULL) AND (content_type IS NULL)) OR ((preset IS NULL) AND (bytes IS NOT NULL) AND (content_type IS NOT NULL)))),
    CONSTRAINT portraits_outfit CHECK (((outfit IS NULL) OR (outfit = ANY (ARRAY['street'::text, 'guofeng'::text, 'casual'::text, 'tech'::text, 'lion'::text])))),
    CONSTRAINT portraits_preset CHECK (((preset IS NULL) OR (preset = ANY (ARRAY['naughty'::text, 'cute'::text, 'cool'::text, 'happy'::text, 'sweet'::text, 'doctor'::text, 'teacher'::text, 'chef'::text, 'tech-engineer'::text, 'financial-advisor'::text, 'lawyer'::text, 'construction-engineer'::text, 'farmer'::text, 'courier'::text, 'pilot'::text, 'firefighter'::text, 'tour-guide'::text, 'journalist'::text, 'creative-designer'::text, 'fitness-coach'::text, 'general-manager'::text, 'accountant'::text, 'operations-director'::text, 'designer'::text, 'director'::text, 'programmer'::text, 'social-media-operator'::text, 'actor'::text, 'singer'::text, 'product-manager'::text, 'data-analyst'::text, 'marketing-director'::text, 'hr-manager'::text, 'legal-advisor'::text, 'customer-service-manager'::text, 'founder-assistant'::text, 'project-manager'::text, 'admin-specialist'::text, 'sales-consultant'::text, 'business-development'::text, 'customer-success'::text, 'copywriter'::text, 'brand-planner'::text, 'ad-specialist'::text, 'store-manager'::text, 'live-stream-operator'::text, 'private-domain-operator'::text, 'automation-engineer'::text, 'test-engineer'::text, 'security-officer'::text])))),
    CONSTRAINT portraits_subject_id_length CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 200))),
    CONSTRAINT portraits_subject_kind CHECK ((subject_kind = ANY (ARRAY['coworker'::text, 'group'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.portraits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.proactive_check_in_runs (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    setting_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text,
    trigger text NOT NULL,
    outcome text DEFAULT 'running'::text NOT NULL,
    skip_reason text,
    items_raised integer DEFAULT 0 NOT NULL,
    reads integer DEFAULT 0 NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT proactive_check_in_runs_finished_check CHECK (((outcome = 'running'::text) = (finished_at IS NULL))),
    CONSTRAINT proactive_check_in_runs_outcome_check CHECK ((outcome = ANY (ARRAY['running'::text, 'quiet'::text, 'raised'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT proactive_check_in_runs_skip_reason_check CHECK ((((outcome = 'skipped'::text) AND (skip_reason IS NOT NULL) AND (skip_reason = ANY (ARRAY['off_admin'::text, 'off_person'::text, 'paused'::text, 'capped'::text, 'unreachable'::text, 'no_sources'::text, 'busy'::text, 'quota'::text]))) OR ((outcome <> 'skipped'::text) AND (skip_reason IS NULL)))),
    CONSTRAINT proactive_check_in_runs_trigger_check CHECK ((trigger = ANY (ARRAY['schedule'::text, 'run_now'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_check_in_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.proactive_people (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    last_pinged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_people FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.proactive_pings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    owner_user_id text NOT NULL,
    item_count integer NOT NULL,
    text text NOT NULL,
    push_body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    offered_at timestamp with time zone,
    CONSTRAINT proactive_pings_item_count_check CHECK ((item_count > 0))
);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_pings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.proactive_runs (
    tenant_id text NOT NULL,
    id text NOT NULL,
    request_key text NOT NULL,
    owner_user_id text NOT NULL,
    actor_user_id text,
    agent_id text NOT NULL,
    setting_id text NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    error text,
    result jsonb,
    CONSTRAINT proactive_runs_actor CHECK ((((source = 'run_now'::text) AND (actor_user_id = owner_user_id) AND (actor_user_id IS NOT NULL)) OR ((source = ANY (ARRAY['schedule'::text, 'legacy'::text])) AND (actor_user_id IS NULL)))),
    CONSTRAINT proactive_runs_error CHECK (((error IS NULL) OR (char_length(error) <= 500))),
    CONSTRAINT proactive_runs_finished CHECK ((((status = ANY (ARRAY['queued'::text, 'running'::text])) AND (finished_at IS NULL)) OR ((status <> ALL (ARRAY['queued'::text, 'running'::text])) AND (finished_at IS NOT NULL)))),
    CONSTRAINT proactive_runs_lease CHECK ((((status = 'running'::text) AND (started_at IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (finished_at IS NULL)) OR ((status <> 'running'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT proactive_runs_owner CHECK (((tenant_id = owner_user_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))),
    CONSTRAINT proactive_runs_result CHECK (((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND (result ?& ARRAY['readCount'::text, 'suggestionCount'::text]) AND ((result - ARRAY['readCount'::text, 'suggestionCount'::text]) = '{}'::jsonb) AND (jsonb_typeof((result -> 'readCount'::text)) = 'number'::text) AND (jsonb_typeof((result -> 'suggestionCount'::text)) = 'number'::text) AND ((((result ->> 'readCount'::text))::numeric >= (0)::numeric) AND (((result ->> 'readCount'::text))::numeric <= (200)::numeric)) AND (((result ->> 'readCount'::text))::numeric = trunc(((result ->> 'readCount'::text))::numeric)) AND ((((result ->> 'suggestionCount'::text))::numeric >= (0)::numeric) AND (((result ->> 'suggestionCount'::text))::numeric <= (5)::numeric)) AND (((result ->> 'suggestionCount'::text))::numeric = trunc(((result ->> 'suggestionCount'::text))::numeric))))),
    CONSTRAINT proactive_runs_source CHECK ((source = ANY (ARRAY['schedule'::text, 'run_now'::text, 'legacy'::text]))),
    CONSTRAINT proactive_runs_status CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'unknown'::text])))
);
--> statement-breakpoint
CREATE TABLE public.proactive_settings (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    channel_id text NOT NULL,
    thread_id text NOT NULL,
    focus text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    interval_minutes integer DEFAULT 60 NOT NULL,
    next_run_at timestamp with time zone DEFAULT now() NOT NULL,
    last_run_at timestamp with time zone,
    last_status text DEFAULT 'idle'::text NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    source_link text,
    CONSTRAINT proactive_settings_interval_check CHECK (((interval_minutes >= 60) AND (interval_minutes <= 1440))),
    CONSTRAINT proactive_settings_status_check CHECK ((last_status = ANY (ARRAY['idle'::text, 'running'::text, 'succeeded'::text, 'error'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.proactive_suggestions (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    setting_id text NOT NULL,
    run_id text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    source_app text,
    source_ref text,
    source_link text,
    status text DEFAULT 'open'::text NOT NULL,
    delivered_at timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    dedupe_key text,
    ping_id text,
    CONSTRAINT proactive_suggestions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'dismissed'::text, 'started'::text, 'superseded'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_suggestions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.project_context_bindings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    device_id uuid NOT NULL,
    agent_id text NOT NULL,
    project_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.project_context_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.provider_templates (
    id text NOT NULL,
    label text NOT NULL,
    allows_base_url boolean DEFAULT false NOT NULL,
    probe text DEFAULT 'chat-completions'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.push_devices (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    token text NOT NULL,
    project_id text NOT NULL,
    platform text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.push_devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.recorder_connect_codes (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    code_hash text NOT NULL,
    user_id text NOT NULL,
    via text NOT NULL,
    organization_session text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    organization_session_expires_at timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connect_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.recorder_connections (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    label text NOT NULL,
    via text NOT NULL,
    extension_id text NOT NULL,
    install_id text NOT NULL,
    organization_session text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    activity jsonb,
    activity_at timestamp with time zone,
    organization_session_expires_at timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.recorder_trajectory_bindings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    trajectory_id uuid NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_trajectory_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.registered_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    device_id text NOT NULL,
    name text NOT NULL,
    platform text,
    token_hash text NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    roots jsonb DEFAULT '[]'::jsonb NOT NULL,
    apps jsonb DEFAULT '[]'::jsonb NOT NULL,
    paired_by_user_id text,
    CONSTRAINT registered_devices_apps_shape CHECK (((jsonb_typeof(apps) = 'array'::text) AND (jsonb_array_length(apps) <= 50))),
    CONSTRAINT registered_devices_roots_shape CHECK (((jsonb_typeof(roots) = 'array'::text) AND (jsonb_array_length(roots) <= 50)))
);
--> statement-breakpoint
ALTER TABLE ONLY public.registered_devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.resource_projects (
    id uuid NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    device_id uuid NOT NULL,
    scope text NOT NULL,
    agent_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_projects_config_check CHECK (((char_length(name) BETWEEN 1 AND 80) AND (char_length(description) <= 500) AND (revision > 0))),
    CONSTRAINT resource_projects_scope_check CHECK ((((scope = 'public'::text) AND (agent_id IS NULL)) OR ((scope = 'agent'::text) AND (agent_id IS NOT NULL)))),
    CONSTRAINT resource_projects_source_check CHECK (COALESCE(((jsonb_typeof(source) = 'object'::text) AND (jsonb_typeof((source -> 'writable'::text)) = 'boolean'::text) AND ((((source ->> 'kind'::text) = 'local'::text) AND ((source - ARRAY['kind'::text, 'rootRef'::text, 'label'::text, 'writable'::text]) = '{}'::jsonb) AND (jsonb_typeof((source -> 'rootRef'::text)) = 'string'::text) AND ((source ->> 'rootRef'::text) ~ '^fld_[A-Za-z0-9_-]{22}$'::text) AND (jsonb_typeof((source -> 'label'::text)) = 'string'::text) AND ((char_length((source ->> 'label'::text)) >= 1) AND (char_length((source ->> 'label'::text)) <= 60))) OR (((source ->> 'kind'::text) = 'git'::text) AND ((source - ARRAY['kind'::text, 'url'::text, 'branch'::text, 'rootRef'::text, 'writable'::text, 'syncedAt'::text, 'commit'::text]) = '{}'::jsonb) AND (jsonb_typeof((source -> 'url'::text)) = 'string'::text) AND ((char_length((source ->> 'url'::text)) >= 1) AND (char_length((source ->> 'url'::text)) <= 500)) AND ((source ->> 'url'::text) !~ '[[:space:][:cntrl:]]'::text) AND (POSITION(('::'::text) IN ((source ->> 'url'::text))) = 0) AND (((source ->> 'url'::text) ~* '^https://[^/@:\[\]-][^/@:\[\]]*(:[0-9]+)?/.+'::text) OR ((source ->> 'url'::text) ~* '^ssh://([A-Za-z0-9._][A-Za-z0-9._-]*@)?[^/@:\[\]-][^/@:\[\]]*(:[0-9]+)?/.+'::text) OR ((source ->> 'url'::text) ~ '^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9.][A-Za-z0-9.-]*:[^-].*'::text)) AND (jsonb_typeof((source -> 'branch'::text)) = 'string'::text) AND ((source ->> 'branch'::text) ~ '^[A-Za-z0-9._/-]{1,200}$'::text) AND ((source ->> 'branch'::text) !~ '(^[-/.])|([/.]$)|(\.\.)|(//)|(/\.)|(\.lock$)|(\.lock/)'::text) AND ((source ->> 'branch'::text) <> ALL (ARRAY['HEAD'::text, '@'::text])) AND (jsonb_typeof((source -> 'rootRef'::text)) = ANY (ARRAY['null'::text, 'string'::text])) AND ((jsonb_typeof((source -> 'rootRef'::text)) = 'null'::text) OR ((source ->> 'rootRef'::text) ~ '^fld_[A-Za-z0-9_-]{22}$'::text)) AND (jsonb_typeof((source -> 'syncedAt'::text)) = ANY (ARRAY['null'::text, 'string'::text])) AND (jsonb_typeof((source -> 'commit'::text)) = ANY (ARRAY['null'::text, 'string'::text])) AND ((jsonb_typeof((source -> 'commit'::text)) = 'null'::text) OR ((source ->> 'commit'::text) ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'::text))))), false))
);
--> statement-breakpoint
ALTER TABLE ONLY public.resource_projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.responsibilities (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    channel_id text NOT NULL,
    thread_id text NOT NULL,
    title text NOT NULL,
    instruction text NOT NULL,
    success_criteria text NOT NULL,
    status public.responsibility_status DEFAULT 'active'::public.responsibility_status NOT NULL,
    progress text DEFAULT ''::text NOT NULL,
    last_result text,
    subscriptions jsonb DEFAULT '[]'::jsonb NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    recurring boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibilities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.responsibility_events (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.responsibility_runs (
    id text NOT NULL,
    responsibility_id text NOT NULL,
    event_id text NOT NULL,
    status public.responsibility_run_status DEFAULT 'queued'::public.responsibility_run_status NOT NULL,
    reply_text text,
    error text,
    waiting jsonb,
    continuation jsonb,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.responsibility_source_bindings (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    source text NOT NULL,
    repository text NOT NULL,
    credential_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_source_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.responsibility_triggers (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    responsibility_id text NOT NULL,
    kind text NOT NULL,
    config jsonb NOT NULL,
    credential_id uuid,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_triggers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.revoked_access (
    email text NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.role_generation_requests (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    model_ref uuid NOT NULL,
    state text NOT NULL,
    profile jsonb,
    error text,
    lease_expires_at timestamp with time zone DEFAULT (now() + '00:01:00'::interval) NOT NULL,
    dispatch_started_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_generation_profile_check CHECK (((state = 'completed'::text) = (profile IS NOT NULL))),
    CONSTRAINT role_generation_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'unknown'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.role_generation_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.role_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    name text NOT NULL,
    profile jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_template_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
    CONSTRAINT role_template_profile_check CHECK ((jsonb_typeof(profile) = 'object'::text)),
    CONSTRAINT role_template_version_check CHECK ((version > 0))
);
--> statement-breakpoint
ALTER TABLE ONLY public.role_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.role_write_receipts (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_user_id text NOT NULL,
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_receipt_result_check CHECK ((jsonb_typeof(result) = 'object'::text))
);
--> statement-breakpoint
ALTER TABLE ONLY public.role_write_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.routine_runs (
    id text NOT NULL,
    routine_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status public.routine_run_status,
    error text,
    waiting jsonb,
    source text DEFAULT 'schedule'::text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.routine_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.routine_sweeps (
    id text NOT NULL,
    swept_at timestamp with time zone DEFAULT now() NOT NULL,
    owner text
);
--> statement-breakpoint
CREATE TABLE public.routines (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id text NOT NULL,
    channel_id text NOT NULL,
    instruction text NOT NULL,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone NOT NULL,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    enabled_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    title text,
    goal_id text,
    goal_by_title boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.routines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.runner_device_connection_leases (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    registration_id uuid NOT NULL,
    device_id text NOT NULL,
    session_id text NOT NULL,
    credential_version text NOT NULL,
    owner_replica_id uuid NOT NULL,
    epoch bigint NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT runner_device_connection_leases_credential CHECK ((credential_version ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT runner_device_connection_leases_epoch_safe CHECK (((epoch >= 1) AND (epoch <= '9007199254740991'::bigint))),
    CONSTRAINT runner_device_connection_leases_identity CHECK (((tenant_id <> ''::text) AND (device_id <> ''::text) AND (session_id <> ''::text))),
    CONSTRAINT runner_device_connection_leases_state CHECK ((state = ANY (ARRAY['connected'::text, 'disconnected'::text])))
);
--> statement-breakpoint
CREATE TABLE public.sandboxed_components (
    name text NOT NULL,
    title text NOT NULL,
    draft_description text DEFAULT ''::text NOT NULL,
    draft_html text DEFAULT ''::text NOT NULL,
    draft_css text DEFAULT ''::text NOT NULL,
    draft_js_functions text DEFAULT ''::text NOT NULL,
    draft_argument_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_description text,
    published_html text,
    published_css text,
    published_js_functions text,
    published_argument_schema jsonb,
    sample_arguments jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    authored_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.sandboxed_components FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.saved_logins (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    origin text NOT NULL,
    username text NOT NULL,
    encrypted_password text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.saved_logins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.scim_connection_bindings (
    id text NOT NULL,
    connection_id text NOT NULL,
    connection_key text NOT NULL,
    provisioning_domain_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    decommissioned_at timestamp with time zone,
    decommission_status text DEFAULT 'active'::text NOT NULL,
    decommission_cursor_user_id text,
    decommission_reconciled_user_count integer DEFAULT 0 NOT NULL,
    decommission_batch_count integer DEFAULT 0 NOT NULL,
    decommission_revision integer DEFAULT 0 NOT NULL,
    decommission_completed_at timestamp with time zone,
    decommission_lease_id text,
    decommission_lease_expires_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.scim_group_members (
    id text NOT NULL,
    connection_id text NOT NULL,
    group_id text NOT NULL,
    scim_user_id text NOT NULL,
    membership_key text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.scim_groups (
    id text NOT NULL,
    connection_id text NOT NULL,
    provisioning_domain_id text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    display_name text NOT NULL,
    display_name_key text NOT NULL,
    external_id text,
    external_id_key text,
    order_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.scim_identity_tombstones (
    id text NOT NULL,
    connection_id text NOT NULL,
    provisioning_domain_id text NOT NULL,
    external_id text NOT NULL,
    external_id_key text NOT NULL,
    user_id text NOT NULL,
    profile text NOT NULL,
    deleted_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.scim_projection_grants (
    id text NOT NULL,
    connection_id text NOT NULL,
    provisioning_domain_id text NOT NULL,
    scim_user_id text NOT NULL,
    user_id text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    source_value text,
    role text NOT NULL,
    grant_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.scim_subjects (
    id text NOT NULL,
    user_id text NOT NULL,
    profile_source_id text,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.scim_users (
    id text NOT NULL,
    connection_id text NOT NULL,
    provisioning_domain_id text NOT NULL,
    user_id text NOT NULL,
    connection_user_key text NOT NULL,
    user_name text NOT NULL,
    user_name_key text NOT NULL,
    primary_email text NOT NULL,
    work_email_value_index text NOT NULL,
    email_value_index text NOT NULL,
    display_name text NOT NULL,
    formatted_name text NOT NULL,
    given_name text,
    family_name text,
    serialized_emails text NOT NULL,
    serialized_attributes text,
    external_id text,
    external_id_key text,
    active boolean NOT NULL,
    order_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.security_egress_fences (
    tenant_id text NOT NULL,
    bot_id text NOT NULL,
    registration_id uuid NOT NULL,
    target jsonb NOT NULL,
    owner_epoch bigint NOT NULL,
    revision bigint NOT NULL,
    source_digest text NOT NULL,
    request_id uuid,
    CONSTRAINT security_egress_fence_epoch CHECK (((owner_epoch >= 1) AND (owner_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT security_egress_fence_revision CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT security_egress_fence_tenant CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))
);
--> statement-breakpoint
CREATE TABLE public.security_egress_outbox (
    tenant_id text NOT NULL,
    bot_id text NOT NULL,
    registration_id uuid NOT NULL,
    request_id uuid NOT NULL,
    owner_epoch bigint NOT NULL,
    revision bigint NOT NULL,
    frame jsonb NOT NULL,
    state text NOT NULL,
    receipt jsonb,
    failure text,
    expires_at bigint NOT NULL,
    issued_digest text NOT NULL,
    CONSTRAINT security_egress_outbox_applied CHECK (((state <> 'applied'::text) OR (receipt IS NOT NULL))),
    CONSTRAINT security_egress_outbox_digest CHECK ((issued_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT security_egress_outbox_epoch CHECK (((owner_epoch >= 1) AND (owner_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT security_egress_outbox_expiry CHECK (((expires_at >= 1) AND (expires_at <= '9007199254740991'::bigint))),
    CONSTRAINT security_egress_outbox_revision CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT security_egress_outbox_state CHECK ((state = ANY (ARRAY['pending'::text, 'sending'::text, 'unknown'::text, 'applied'::text, 'superseded'::text]))),
    CONSTRAINT security_egress_outbox_tenant CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))
);
--> statement-breakpoint
CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.shared_use_approval_members (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    server_id text NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    CONSTRAINT shared_use_approval_members_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'group'::text]))),
    CONSTRAINT shared_use_approval_members_tenant_person CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approval_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.shared_use_approvals (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    server_id text NOT NULL,
    audience text NOT NULL,
    outside_input boolean NOT NULL,
    approved_by text NOT NULL,
    approved_as text,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_use_approvals_approved_as_check CHECK (((approved_as IS NULL) OR (approved_as = ANY (ARRAY['admin'::text, 'owner'::text])))),
    CONSTRAINT shared_use_approvals_audience_check CHECK ((audience = ANY (ARRAY['owner'::text, 'people'::text, 'team'::text]))),
    CONSTRAINT shared_use_approvals_tenant_person CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.shared_use_requests (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id text NOT NULL,
    server_id text NOT NULL,
    proposed_audience text NOT NULL,
    proposed_outside_input boolean NOT NULL,
    proposed_members jsonb DEFAULT '[]'::jsonb NOT NULL,
    reason text NOT NULL,
    requested_by text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_use_requests_audience_check CHECK ((proposed_audience = ANY (ARRAY['owner'::text, 'people'::text, 'team'::text]))),
    CONSTRAINT shared_use_requests_decided CHECK (((status = 'pending'::text) = (decided_at IS NULL))),
    CONSTRAINT shared_use_requests_reason_check CHECK ((reason = ANY (ARRAY['publish'::text, 'trigger'::text, 'grant'::text, 'refused_call'::text]))),
    CONSTRAINT shared_use_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'superseded'::text]))),
    CONSTRAINT shared_use_requests_tenant_person CHECK ((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.sign_in_requests (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    bot_id text NOT NULL,
    origin text NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    method text,
    outcome text,
    thread_id text,
    tool_call_id text,
    control_request_id text,
    continuation jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    filling_until timestamp with time zone,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT sign_in_requests_method_check CHECK (((method IS NULL) OR (method = ANY (ARRAY['typed'::text, 'saved'::text, 'takeover'::text])))),
    CONSTRAINT sign_in_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'filling'::text, 'code_required'::text, 'taken_over'::text, 'signed_in'::text, 'failed'::text, 'cancelled'::text, 'expired'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.sign_in_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.skill_assets (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    skill_id text NOT NULL,
    path text NOT NULL,
    media_type text NOT NULL,
    content text NOT NULL,
    bytes integer NOT NULL,
    checksum text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.skill_assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.skill_tools (
    skill_id text NOT NULL,
    ref text NOT NULL,
    declared_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.skill_tools FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.skills (
    id text NOT NULL,
    owner_user_id text,
    slug text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    instructions text NOT NULL,
    origin text DEFAULT 'yours'::text NOT NULL,
    installed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    package_id uuid,
    runnable text,
    blocked_reason text,
    blocked_reason_ref text
);
--> statement-breakpoint
ALTER TABLE ONLY public.skills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.sso_providers (
    id text NOT NULL,
    issuer text NOT NULL,
    oidc_config text,
    saml_config text,
    user_id text,
    provider_id text NOT NULL,
    organization_id text,
    domain text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.staffing_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    owner_id text NOT NULL,
    proposed_by_agent_id text NOT NULL,
    thread_id text,
    kind text NOT NULL,
    draft jsonb NOT NULL,
    base_version text,
    status text DEFAULT 'pending'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT staffing_proposals_kind_check CHECK ((kind = ANY (ARRAY['employee'::text, 'employee_change'::text, 'group'::text, 'group_change'::text]))),
    CONSTRAINT staffing_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applying'::text, 'applied'::text, 'partially_applied'::text, 'discarded'::text, 'expired'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.staffing_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    plan_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.task_archives (
    tenant_id text NOT NULL,
    task_id uuid NOT NULL,
    archived_by text,
    archived_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.task_archives FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.task_briefings (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    kind text NOT NULL,
    local_day date NOT NULL,
    offered integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.task_briefings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.task_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    task_id uuid NOT NULL,
    kind text NOT NULL,
    actor text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.task_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    title text NOT NULL,
    executor_agent_id text,
    source public.task_source NOT NULL,
    status public.task_status DEFAULT 'running'::public.task_status NOT NULL,
    channel_ref text,
    run_ref text,
    parent_task_id uuid,
    deliverable_ref jsonb,
    pending_approval_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text,
    quota_units integer DEFAULT 1 NOT NULL,
    trigger_source text,
    tracked boolean DEFAULT false NOT NULL,
    thread_ref text,
    accepted_at timestamp with time zone,
    due_at timestamp with time zone,
    original_due_at timestamp with time zone,
    overdue_at timestamp with time zone,
    due_reported boolean DEFAULT false NOT NULL,
    criteria text,
    last_error text,
    nudges integer DEFAULT 0 NOT NULL,
    returns integer DEFAULT 0 NOT NULL,
    active_run_ref text,
    return_pending_at timestamp with time zone,
    last_nudged_at timestamp with time zone,
    last_notified_at timestamp with time zone,
    notified_on date,
    notified_count integer DEFAULT 0 NOT NULL,
    reminder_held_at timestamp with time zone,
    nudged_on date,
    nudged_count integer DEFAULT 0 NOT NULL,
    handover_pending_at timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE ONLY public.tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.team_bot_assignments (
    agent_id text NOT NULL,
    group_name text NOT NULL,
    assigned_by text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.team_bot_audience (
    agent_id text NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT team_bot_audience_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'group'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_audience FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.team_bot_consent_defaults (
    user_id text NOT NULL,
    server_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consent_defaults FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.team_bot_consents (
    user_id text NOT NULL,
    agent_id text NOT NULL,
    server_id text NOT NULL,
    decision text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT team_bot_consents_decision_check CHECK ((decision = ANY (ARRAY['always'::text, 'once'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.team_bot_publications (
    agent_id text NOT NULL,
    published_by text NOT NULL,
    audience text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT team_bot_publications_audience_check CHECK ((audience = ANY (ARRAY['team'::text, 'people'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_publications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.text_translations (
    source_hash text NOT NULL,
    locale text NOT NULL,
    source text NOT NULL,
    translated text,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    translated_at timestamp with time zone,
    CONSTRAINT text_translations_attempts CHECK ((attempts >= 0)),
    CONSTRAINT text_translations_locale CHECK ((locale = 'zh-CN'::text)),
    CONSTRAINT text_translations_source_length CHECK (((char_length(source) >= 1) AND (char_length(source) <= 6000)))
);
--> statement-breakpoint
CREATE TABLE public.thread_compactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    upto_message_id text NOT NULL,
    summary text NOT NULL,
    tokens_before integer,
    tokens_after integer,
    summarized_count integer,
    auto boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_compactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.thread_context_breakdowns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    run_id text NOT NULL,
    shares jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_context_breakdowns_shares_keys CHECK (((jsonb_typeof(shares) = 'object'::text) AND (shares ?& ARRAY['messages'::text, 'system'::text, 'tools'::text, 'skills'::text, 'memory'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_context_breakdowns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.thread_run_events (
    thread_id text NOT NULL,
    run_id text NOT NULL,
    seq integer NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.thread_run_liveness (
    run_id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_run_liveness_status CHECK ((status = ANY (ARRAY['running'::text, 'finished'::text, 'interrupted'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_run_liveness FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.thread_runs (
    id text NOT NULL,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    parent_run_id text,
    event_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.threads (
    id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    agent_id text NOT NULL,
    name text,
    messages_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.threads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.update_routing_preferences (
    owner_user_id text NOT NULL,
    kind text NOT NULL,
    transports text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.update_routing_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.usage_counters (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    period text NOT NULL,
    metric text NOT NULL,
    value integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.usage_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.user_instructions (
    user_id text NOT NULL,
    instructions text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.user_roles (
    user_id text NOT NULL,
    role public.role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    name text,
    image text,
    email_verified boolean DEFAULT false NOT NULL,
    groups text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    onboarding_step integer DEFAULT 0 NOT NULL,
    onboarding_completed_at timestamp with time zone,
    last_signed_in_at timestamp with time zone,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT users_id_not_reserved CHECK ((id <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text])))
);
--> statement-breakpoint
CREATE TABLE public.verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.voice_sessions (
    id text NOT NULL,
    channel_id text NOT NULL,
    user_id text NOT NULL,
    anchor_message_id text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    duration_seconds integer NOT NULL,
    transcript jsonb NOT NULL,
    summary text,
    summary_status text DEFAULT 'failed'::text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    CONSTRAINT voice_sessions_duration_check CHECK ((duration_seconds >= 0)),
    CONSTRAINT voice_sessions_summary_check CHECK ((((summary_status = 'ready'::text) AND (summary IS NOT NULL)) OR ((summary_status = 'failed'::text) AND (summary IS NULL))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.voice_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.waker_flow_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    request_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    kind text NOT NULL,
    fingerprint text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    run_id uuid,
    task_id uuid,
    error text,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flow_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.waker_flow_versions (
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    flow_id uuid NOT NULL,
    revision integer NOT NULL,
    plan jsonb NOT NULL,
    model_ref uuid,
    template_id uuid,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT waker_flow_versions_plan_object CHECK ((jsonb_typeof(plan) = 'object'::text)),
    CONSTRAINT waker_flow_versions_revision_positive CHECK ((revision >= 1))
);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flow_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.waker_flows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    idea text DEFAULT ''::text NOT NULL,
    model_ref uuid,
    plan jsonb,
    revision integer DEFAULT 0 NOT NULL,
    group_id uuid,
    template_id uuid,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    definition_mode text DEFAULT 'json-plan-v1'::text NOT NULL,
    active_source_version_id uuid,
    CONSTRAINT waker_flows_definition_mode_check CHECK ((((definition_mode = 'json-plan-v1'::text) AND (active_source_version_id IS NULL)) OR ((definition_mode = 'js-source-v1'::text) AND (active_source_version_id IS NOT NULL) AND (plan IS NULL) AND (group_id IS NULL) AND (template_id IS NULL))))
);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.waker_group_members (
    group_id uuid NOT NULL,
    agent_id text NOT NULL,
    "position" text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_group_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.waker_group_upgrades (
    group_id uuid NOT NULL,
    tenant_id text NOT NULL,
    original_owner text NOT NULL,
    channel_id text,
    outcome text NOT NULL,
    dropped_agent_ids text[] DEFAULT '{}'::text[] NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT waker_group_upgrades_outcome CHECK ((outcome = ANY (ARRAY['started'::text, 'converted'::text, 'backfilled'::text, 'pending_members'::text, 'too_many'::text, 'no_owner'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_group_upgrades FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.waker_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.wechat_accounts (
    id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    ilink_bot_id text NOT NULL,
    ilink_user_id text NOT NULL,
    base_url text NOT NULL,
    credential_id uuid,
    cursor text,
    context_token text,
    last_inbound_at timestamp with time zone,
    last_agent_id text,
    status text DEFAULT 'bound'::text NOT NULL,
    paused_until timestamp with time zone,
    lease_owner text,
    lease_until timestamp with time zone,
    missed_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    bound_at timestamp with time zone,
    recent_message_ids text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT wechat_accounts_status_check CHECK ((status = ANY (ARRAY['bound'::text, 'paused'::text, 'unbound'::text, 'disconnected'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.wechat_bind_attempts (
    id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    qrcode text NOT NULL,
    image_content text,
    status text DEFAULT 'wait'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_bind_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.wechat_prompts (
    id text NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL,
    user_id text NOT NULL,
    code text NOT NULL,
    kind text NOT NULL,
    ref_id text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wechat_prompts_kind_check CHECK ((kind = ANY (ARRAY['approval'::text, 'extension'::text, 'handin'::text, 'overdue'::text, 'pick_agent'::text]))),
    CONSTRAINT wechat_prompts_state_check CHECK ((state = ANY (ARRAY['open'::text, 'done'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_prompts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE public.work_items (
    kind text NOT NULL,
    key text NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    finished_at timestamp with time zone,
    last_error text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text DEFAULT current_setting('app.tenant_id'::text, true) NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.work_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_events ALTER COLUMN sequence SET DEFAULT nextval('public.flow_run_events_sequence_seq'::regclass);
--> statement-breakpoint
INSERT INTO public.plans (id, name, limits) VALUES ('free', 'Free', '{"wakers": 2, "devices": 1, "customModels": false, "tasksPerMonth": 50}');
--> statement-breakpoint
INSERT INTO public.plans (id, name, limits) VALUES ('pro', 'Pro', '{"wakers": 10, "devices": 5, "customModels": true, "tasksPerMonth": 1000}');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('openai', 'OpenAI', true, 'chat-completions');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('anthropic', 'Anthropic', false, 'messages');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('google', 'Google Gemini', false, 'generativelanguage');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('openrouter', 'OpenRouter', false, 'chat-completions');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('deepseek', 'DeepSeek', false, 'chat-completions');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('zhipu', '智谱 GLM (OpenAI 兼容)', true, 'chat-completions');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('moonshot', 'Kimi (OpenAI 兼容)', true, 'chat-completions');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('custom', '自定义 (OpenAI 兼容)', true, 'chat-completions');
--> statement-breakpoint
INSERT INTO public.provider_templates (id, label, allows_base_url, probe) VALUES ('aihub', 'AIHUB 中转 (OpenAI 兼容)', true, 'chat-completions');
--> statement-breakpoint
SELECT pg_catalog.setval('public.flow_run_events_sequence_seq', 1, false);
--> statement-breakpoint
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.acp_turns
    ADD CONSTRAINT acp_turns_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.acp_turns
    ADD CONSTRAINT acp_turns_turn_id_unique UNIQUE (turn_id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_policy
    ADD CONSTRAINT action_policy_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_records
    ADD CONSTRAINT action_records_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_preferences
    ADD CONSTRAINT agent_preferences_user_id_agent_id_pk PRIMARY KEY (user_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_pkey PRIMARY KEY (agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_security_policies
    ADD CONSTRAINT agent_security_policies_tenant_id_agent_id_pk PRIMARY KEY (tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_security_settings
    ADD CONSTRAINT agent_security_settings_tenant_id_agent_id_pk PRIMARY KEY (tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.app_access_requests
    ADD CONSTRAINT app_access_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuation_steps
    ADD CONSTRAINT approval_continuation_steps_admission_id_unique UNIQUE (admission_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuation_steps
    ADD CONSTRAINT approval_continuation_steps_approval_id_step_key_pk PRIMARY KEY (approval_id, step_key);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuations
    ADD CONSTRAINT approval_continuations_admission_id_unique UNIQUE (admission_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuations
    ADD CONSTRAINT approval_continuations_pkey PRIMARY KEY (approval_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_conversation_grants
    ADD CONSTRAINT approval_conversation_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_allocation_binding_unique UNIQUE (domain_id, tenant_id, owner_user_id, thread_id, agent_id, source_run_id, release_id, backend);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_creation_unique UNIQUE (tenant_id, owner_user_id, creation_key);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_pkey PRIMARY KEY (domain_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_scope_binding_unique UNIQUE (domain_id, tenant_id, owner_user_id, thread_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_scope_genesis_unique UNIQUE (tenant_id, owner_user_id, source_run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_thread_unique UNIQUE (thread_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_preferences
    ADD CONSTRAINT approval_preferences_pkey PRIMARY KEY (owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_id_tenant_owner_unique UNIQUE (id, tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_team_rules
    ADD CONSTRAINT approval_team_rules_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_team_settings
    ADD CONSTRAINT approval_team_settings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_approval_scope_uq UNIQUE (approval_id, tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_pk PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_scope_hash_uq UNIQUE (id, approval_id, tenant_id, owner_user_id, plaintext_sha256);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_shared_scope_uq UNIQUE (id, approval_id, tenant_id, owner_user_id, actor_user_id, domain_id, thread_id, agent_id, approval_run_id, source_actual_run_id, tool_call_id, action_digest, source_binding_version, codec_version, plaintext_sha256);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_approval_scope_uq UNIQUE (approval_id, tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_pk PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_scope_hash_uq UNIQUE (id, approval_id, tenant_id, owner_user_id, plaintext_sha256);
--> statement-breakpoint
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_continuations
    ADD CONSTRAINT automation_continuations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_firings
    ADD CONSTRAINT automation_firings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_triggers
    ADD CONSTRAINT automation_triggers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.avatar_sources
    ADD CONSTRAINT avatar_sources_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.board_cards
    ADD CONSTRAINT board_cards_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.bot_lifecycle
    ADD CONSTRAINT bot_lifecycle_owner_user_id_agent_id_pk PRIMARY KEY (owner_user_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.bot_tasks
    ADD CONSTRAINT bot_tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.brokered_accounts
    ADD CONSTRAINT brokered_accounts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.brokered_identities
    ADD CONSTRAINT brokered_identities_provider_user_id_pk PRIMARY KEY (provider, user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.capability_settings
    ADD CONSTRAINT capability_settings_scope_kind_scope_id_capability_pk PRIMARY KEY (scope_kind, scope_id, capability);
--> statement-breakpoint
ALTER TABLE ONLY public.channel_agents
    ADD CONSTRAINT channel_agents_channel_id_agent_id_pk PRIMARY KEY (channel_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.channel_memberships
    ADD CONSTRAINT channel_memberships_channel_id_user_id_pk PRIMARY KEY (channel_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.component_exclusions
    ADD CONSTRAINT component_exclusions_component_name_agent_id_pk PRIMARY KEY (component_name, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.component_functions
    ADD CONSTRAINT component_functions_component_name_function_name_pk PRIMARY KEY (component_name, function_name);
--> statement-breakpoint
ALTER TABLE ONLY public.components
    ADD CONSTRAINT components_pkey PRIMARY KEY (name);
--> statement-breakpoint
ALTER TABLE ONLY public.composio_connections
    ADD CONSTRAINT composio_connections_toolkit_user_id_pk PRIMARY KEY (toolkit, user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.computer_page_frame
    ADD CONSTRAINT computer_page_frame_computer_id_tool_call_id_pk PRIMARY KEY (computer_id, tool_call_id);
--> statement-breakpoint
ALTER TABLE ONLY public.computer_snapshot
    ADD CONSTRAINT computer_snapshot_pkey PRIMARY KEY (computer_id);
--> statement-breakpoint
ALTER TABLE ONLY public.computer_waits
    ADD CONSTRAINT computer_waits_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.default_opt_outs
    ADD CONSTRAINT default_opt_outs_owner_user_id_agent_id_feature_scope_pk PRIMARY KEY (owner_user_id, agent_id, feature, scope);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_bindings
    ADD CONSTRAINT delivery_bindings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_challenges
    ADD CONSTRAINT delivery_challenges_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_inbox
    ADD CONSTRAINT delivery_inbox_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_outbox
    ADD CONSTRAINT delivery_outbox_dedupe_key_unique UNIQUE (dedupe_key);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_outbox
    ADD CONSTRAINT delivery_outbox_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.demonstrations
    ADD CONSTRAINT demonstrations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.deployment_packages
    ADD CONSTRAINT deployment_packages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.deployment_packages
    ADD CONSTRAINT deployment_packages_tenant_id_unique UNIQUE (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY public.device_pair_codes
    ADD CONSTRAINT device_pair_codes_pkey PRIMARY KEY (code);
--> statement-breakpoint
ALTER TABLE ONLY public.employee_device_bindings
    ADD CONSTRAINT employee_device_bindings_tenant_id_agent_id_pk PRIMARY KEY (tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.employee_role_snapshots
    ADD CONSTRAINT employee_role_snapshots_pkey PRIMARY KEY (agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.enterprise_settings
    ADD CONSTRAINT enterprise_settings_pkey PRIMARY KEY (key);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_confirmations
    ADD CONSTRAINT flow_confirmations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_sessions
    ADD CONSTRAINT flow_customization_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_turns
    ADD CONSTRAINT flow_customization_turns_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_import_proposals
    ADD CONSTRAINT flow_import_proposals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_official_bindings
    ADD CONSTRAINT flow_official_bindings_pkey PRIMARY KEY (flow_id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_official_source_heads
    ADD CONSTRAINT flow_official_source_heads_pkey PRIMARY KEY (source_id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_events
    ADD CONSTRAINT flow_run_events_pkey PRIMARY KEY (sequence);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_retries
    ADD CONSTRAINT flow_run_retries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_share_imports
    ADD CONSTRAINT flow_share_imports_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_share_links
    ADD CONSTRAINT flow_share_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_candidates
    ADD CONSTRAINT flow_source_candidates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_inline_invocations
    ADD CONSTRAINT flow_source_inline_invocations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_invocations
    ADD CONSTRAINT flow_source_invocations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_operations
    ADD CONSTRAINT flow_source_operations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_original_activations
    ADD CONSTRAINT flow_source_original_activation_pk PRIMARY KEY (tenant_id, run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_original_projection_observations
    ADD CONSTRAINT flow_source_original_projection_pk PRIMARY KEY (tenant_id, run_id, state);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_public_operations
    ADD CONSTRAINT flow_source_public_operations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_resource_snapshots
    ADD CONSTRAINT flow_source_resource_snapshots_pkey PRIMARY KEY (tenant_id, run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runs
    ADD CONSTRAINT flow_source_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runtime_events
    ADD CONSTRAINT flow_source_runtime_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_stop_operations
    ADD CONSTRAINT flow_source_stop_operations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_versions
    ADD CONSTRAINT flow_source_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.generated_media
    ADD CONSTRAINT generated_media_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_bot_threads
    ADD CONSTRAINT group_bot_threads_owner_user_id_channel_id_agent_id_pk PRIMARY KEY (owner_user_id, channel_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_message_private
    ADD CONSTRAINT group_message_private_pkey PRIMARY KEY (message_id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_id_owner_unique UNIQUE (id, owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_pipeline_start_receipts
    ADD CONSTRAINT group_pipeline_start_receipts_pkey PRIMARY KEY (request_id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_runs
    ADD CONSTRAINT group_task_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_templates
    ADD CONSTRAINT group_task_templates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.heartbeat_runs
    ADD CONSTRAINT heartbeat_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.identity_link_challenges
    ADD CONSTRAINT identity_link_challenges_pkey PRIMARY KEY (token_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.identity_links
    ADD CONSTRAINT identity_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.intelligence_channel_mappings
    ADD CONSTRAINT intelligence_channel_mappings_user_id_channel_id_pk PRIMARY KEY (user_id, channel_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_binding_heads
    ADD CONSTRAINT knowledge_binding_heads_tenant_id_owner_user_id_agent_id_pk PRIMARY KEY (tenant_id, owner_user_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_bindings
    ADD CONSTRAINT knowledge_bindings_tenant_id_owner_user_id_agent_id_notebook_id PRIMARY KEY (tenant_id, owner_user_id, agent_id, notebook_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_claims
    ADD CONSTRAINT knowledge_claim_operation_unique UNIQUE (operation_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_claims
    ADD CONSTRAINT knowledge_claim_sdk_unique UNIQUE (tenant_id, agent_id, run_id, thread_id, tool_call_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_directories
    ADD CONSTRAINT knowledge_directories_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_directories
    ADD CONSTRAINT knowledge_directories_scope_key UNIQUE (id, tenant_id, owner_user_id, notebook_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_notebooks
    ADD CONSTRAINT knowledge_notebooks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_receipts
    ADD CONSTRAINT knowledge_receipts_tenant_id_owner_user_id_logical_operation_id PRIMARY KEY (tenant_id, owner_user_id, logical_operation_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_sources_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_claims
    ADD CONSTRAINT knowledge_write_claims_pkey PRIMARY KEY (claim_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_executions
    ADD CONSTRAINT knowledge_write_executions_tenant_id_agent_id_run_id_thread_id_ PRIMARY KEY (tenant_id, agent_id, run_id, thread_id);
--> statement-breakpoint
ALTER TABLE ONLY public.learned_skills
    ADD CONSTRAINT learned_skills_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_open_skills
    ADD CONSTRAINT learning_open_skills_user_id_skill_name_pk PRIMARY KEY (user_id, skill_name);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_person_spaces
    ADD CONSTRAINT learning_person_spaces_container_id_unique UNIQUE (container_id);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_person_spaces
    ADD CONSTRAINT learning_person_spaces_pkey PRIMARY KEY (user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_settings
    ADD CONSTRAINT learning_settings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_skill_approvals
    ADD CONSTRAINT learning_skill_approvals_user_id_skill_name_pk PRIMARY KEY (user_id, skill_name);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_skill_sharing
    ADD CONSTRAINT learning_skill_sharing_pkey PRIMARY KEY (user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.learning_thread_bindings
    ADD CONSTRAINT learning_thread_bindings_pkey PRIMARY KEY (user_id, thread_id);
--> statement-breakpoint
ALTER TABLE ONLY public.local_learning_runs
    ADD CONSTRAINT local_learning_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.local_learning_state
    ADD CONSTRAINT local_learning_state_pkey PRIMARY KEY (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY public.local_skill_candidates
    ADD CONSTRAINT local_skill_candidates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_server_id_name_pk PRIMARY KEY (server_id, name);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_user_credentials
    ADD CONSTRAINT mcp_user_credentials_server_id_user_id_pk PRIMARY KEY (server_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.memory_embeddings
    ADD CONSTRAINT memory_embeddings_pkey PRIMARY KEY (memory_id);
--> statement-breakpoint
ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.model_registry
    ADD CONSTRAINT model_registry_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.model_token_calls
    ADD CONSTRAINT model_token_calls_tenant_id_call_id_pk PRIMARY KEY (tenant_id, call_id);
--> statement-breakpoint
ALTER TABLE ONLY public.model_usage
    ADD CONSTRAINT model_usage_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.network_policies
    ADD CONSTRAINT network_policies_scope_kind_scope_id_pk PRIMARY KEY (scope_kind, scope_id);
--> statement-breakpoint
ALTER TABLE ONLY public.pending_authorizations
    ADD CONSTRAINT pending_authorizations_pkey PRIMARY KEY (actor_id);
--> statement-breakpoint
ALTER TABLE ONLY public.persona_templates
    ADD CONSTRAINT persona_templates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.personal_memories
    ADD CONSTRAINT personal_memories_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.platform_model_pool
    ADD CONSTRAINT platform_model_pool_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.platform_model_pool
    ADD CONSTRAINT platform_model_pool_provider_model_unique UNIQUE (provider, model_name);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_assembly_origins
    ADD CONSTRAINT plugin_assembly_origins_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_assembly_publications
    ADD CONSTRAINT plugin_assembly_publications_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_grants
    ADD CONSTRAINT plugin_grants_kind_ref_agent_id_pk PRIMARY KEY (kind, ref, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_install_listings
    ADD CONSTRAINT plugin_install_listings_kind_ref_pk PRIMARY KEY (kind, ref);
--> statement-breakpoint
ALTER TABLE ONLY public.portrait_media
    ADD CONSTRAINT portrait_media_pkey PRIMARY KEY (tenant_id, subject_kind, subject_id);
--> statement-breakpoint
ALTER TABLE ONLY public.portraits
    ADD CONSTRAINT portraits_pkey PRIMARY KEY (tenant_id, subject_kind, subject_id);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_check_in_runs
    ADD CONSTRAINT proactive_check_in_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_people
    ADD CONSTRAINT proactive_people_pkey PRIMARY KEY (owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_pings
    ADD CONSTRAINT proactive_pings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_runs
    ADD CONSTRAINT proactive_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_settings
    ADD CONSTRAINT proactive_settings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_suggestions
    ADD CONSTRAINT proactive_suggestions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.project_context_bindings
    ADD CONSTRAINT project_context_bindings_tenant_id_device_id_agent_id_pk PRIMARY KEY (tenant_id, device_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.provider_templates
    ADD CONSTRAINT provider_templates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connect_codes
    ADD CONSTRAINT recorder_connect_codes_pkey PRIMARY KEY (code_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connections
    ADD CONSTRAINT recorder_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connections
    ADD CONSTRAINT recorder_connections_token_hash_unique UNIQUE (token_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_trajectory_bindings
    ADD CONSTRAINT recorder_trajectory_bindings_pkey PRIMARY KEY (trajectory_id);
--> statement-breakpoint
ALTER TABLE ONLY public.registered_devices
    ADD CONSTRAINT registered_devices_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.resource_projects
    ADD CONSTRAINT resource_projects_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibilities
    ADD CONSTRAINT responsibilities_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_events
    ADD CONSTRAINT responsibility_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_runs
    ADD CONSTRAINT responsibility_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_source_bindings
    ADD CONSTRAINT responsibility_source_bindings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_triggers
    ADD CONSTRAINT responsibility_triggers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.revoked_access
    ADD CONSTRAINT revoked_access_pkey PRIMARY KEY (email);
--> statement-breakpoint
ALTER TABLE ONLY public.role_generation_requests
    ADD CONSTRAINT role_generation_requests_tenant_id_owner_user_id_request_id_pk PRIMARY KEY (tenant_id, owner_user_id, request_id);
--> statement-breakpoint
ALTER TABLE ONLY public.role_templates
    ADD CONSTRAINT role_templates_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.role_write_receipts
    ADD CONSTRAINT role_write_receipts_tenant_id_owner_user_id_request_id_pk PRIMARY KEY (tenant_id, owner_user_id, request_id);
--> statement-breakpoint
ALTER TABLE ONLY public.routine_runs
    ADD CONSTRAINT routine_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.routine_sweeps
    ADD CONSTRAINT routine_sweeps_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.runner_device_connection_leases
    ADD CONSTRAINT runner_device_connection_leases_pk PRIMARY KEY (tenant_id, registration_id);
--> statement-breakpoint
ALTER TABLE ONLY public.sandboxed_components
    ADD CONSTRAINT sandboxed_components_pkey PRIMARY KEY (name);
--> statement-breakpoint
ALTER TABLE ONLY public.saved_logins
    ADD CONSTRAINT saved_logins_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_connection_bindings
    ADD CONSTRAINT scim_connection_bindings_connection_key_unique UNIQUE (connection_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_connection_bindings
    ADD CONSTRAINT scim_connection_bindings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_group_members
    ADD CONSTRAINT scim_group_members_membership_key_unique UNIQUE (membership_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_group_members
    ADD CONSTRAINT scim_group_members_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_groups
    ADD CONSTRAINT scim_groups_display_name_key_unique UNIQUE (display_name_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_groups
    ADD CONSTRAINT scim_groups_external_id_key_unique UNIQUE (external_id_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_groups
    ADD CONSTRAINT scim_groups_order_key_unique UNIQUE (order_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_groups
    ADD CONSTRAINT scim_groups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_identity_tombstones
    ADD CONSTRAINT scim_identity_tombstones_external_id_key_unique UNIQUE (external_id_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_identity_tombstones
    ADD CONSTRAINT scim_identity_tombstones_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_projection_grants
    ADD CONSTRAINT scim_projection_grants_grant_key_unique UNIQUE (grant_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_projection_grants
    ADD CONSTRAINT scim_projection_grants_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_subjects
    ADD CONSTRAINT scim_subjects_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_subjects
    ADD CONSTRAINT scim_subjects_user_id_unique UNIQUE (user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_users
    ADD CONSTRAINT scim_users_connection_user_key_unique UNIQUE (connection_user_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_users
    ADD CONSTRAINT scim_users_external_id_key_unique UNIQUE (external_id_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_users
    ADD CONSTRAINT scim_users_order_key_unique UNIQUE (order_key);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_users
    ADD CONSTRAINT scim_users_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.scim_users
    ADD CONSTRAINT scim_users_user_name_key_unique UNIQUE (user_name_key);
--> statement-breakpoint
ALTER TABLE ONLY public.security_egress_fences
    ADD CONSTRAINT security_egress_fences_tenant_id_bot_id_registration_id_pk PRIMARY KEY (tenant_id, bot_id, registration_id);
--> statement-breakpoint
ALTER TABLE ONLY public.security_egress_outbox
    ADD CONSTRAINT security_egress_outbox_generation UNIQUE (tenant_id, bot_id, registration_id, owner_epoch, revision);
--> statement-breakpoint
ALTER TABLE ONLY public.security_egress_outbox
    ADD CONSTRAINT security_egress_outbox_tenant_id_bot_id_registration_id_request PRIMARY KEY (tenant_id, bot_id, registration_id, request_id);
--> statement-breakpoint
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approval_members
    ADD CONSTRAINT shared_use_approval_members_pkey PRIMARY KEY (tenant_id, agent_id, server_id, kind, value);
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approvals
    ADD CONSTRAINT shared_use_approvals_pkey PRIMARY KEY (tenant_id, agent_id, server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_requests
    ADD CONSTRAINT shared_use_requests_pkey PRIMARY KEY (tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.sign_in_requests
    ADD CONSTRAINT sign_in_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.skill_tools
    ADD CONSTRAINT skill_tools_skill_id_ref_pk PRIMARY KEY (skill_id, ref);
--> statement-breakpoint
ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_resource_snapshots
    ADD CONSTRAINT source_resource_snapshot_owner_operation_key UNIQUE (tenant_id, operation_id);
--> statement-breakpoint
ALTER TABLE ONLY public.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.sso_providers
    ADD CONSTRAINT sso_providers_provider_id_unique UNIQUE (provider_id);
--> statement-breakpoint
ALTER TABLE ONLY public.staffing_proposals
    ADD CONSTRAINT staffing_proposals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_tenant_unique UNIQUE (tenant_id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_archives
    ADD CONSTRAINT task_archives_pkey PRIMARY KEY (task_id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_briefings
    ADD CONSTRAINT task_briefings_pkey PRIMARY KEY (tenant_id, kind, local_day);
--> statement-breakpoint
ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_assignments
    ADD CONSTRAINT team_bot_assignments_agent_id_group_name_pk PRIMARY KEY (agent_id, group_name);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_audience
    ADD CONSTRAINT team_bot_audience_agent_id_kind_value_pk PRIMARY KEY (agent_id, kind, value);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consent_defaults
    ADD CONSTRAINT team_bot_consent_defaults_user_id_server_id_pk PRIMARY KEY (user_id, server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consents
    ADD CONSTRAINT team_bot_consents_user_id_agent_id_server_id_pk PRIMARY KEY (user_id, agent_id, server_id);
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_publications
    ADD CONSTRAINT team_bot_publications_pkey PRIMARY KEY (agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.text_translations
    ADD CONSTRAINT text_translations_pkey PRIMARY KEY (source_hash, locale);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_compactions
    ADD CONSTRAINT thread_compactions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_context_breakdowns
    ADD CONSTRAINT thread_context_breakdowns_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_run_events
    ADD CONSTRAINT thread_run_events_thread_id_run_id_seq_pk PRIMARY KEY (thread_id, run_id, seq);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_run_liveness
    ADD CONSTRAINT thread_run_liveness_pkey PRIMARY KEY (run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.thread_runs
    ADD CONSTRAINT thread_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_id_tenant_agent_unique UNIQUE (id, tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.update_routing_preferences
    ADD CONSTRAINT update_routing_preferences_owner_user_id_kind_pk PRIMARY KEY (owner_user_id, kind);
--> statement-breakpoint
ALTER TABLE ONLY public.usage_counters
    ADD CONSTRAINT usage_counters_tenant_id_period_metric_pk PRIMARY KEY (tenant_id, period, metric);
--> statement-breakpoint
ALTER TABLE ONLY public.user_instructions
    ADD CONSTRAINT user_instructions_pkey PRIMARY KEY (user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_pk PRIMARY KEY (user_id, role);
--> statement-breakpoint
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);
--> statement-breakpoint
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flow_requests
    ADD CONSTRAINT waker_flow_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flow_versions
    ADD CONSTRAINT waker_flow_versions_pkey PRIMARY KEY (tenant_id, flow_id, revision);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flows
    ADD CONSTRAINT waker_flows_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_group_members
    ADD CONSTRAINT waker_group_members_group_id_agent_id_pk PRIMARY KEY (group_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_group_upgrades
    ADD CONSTRAINT waker_group_upgrades_pkey PRIMARY KEY (group_id);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_groups
    ADD CONSTRAINT waker_groups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_accounts
    ADD CONSTRAINT wechat_accounts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_bind_attempts
    ADD CONSTRAINT wechat_bind_attempts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_prompts
    ADD CONSTRAINT wechat_prompts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_kind_key_pk PRIMARY KEY (kind, key);
--> statement-breakpoint
CREATE UNIQUE INDEX accounts_provider_account_idx ON public.accounts USING btree (provider_id, account_id);
--> statement-breakpoint
CREATE INDEX acp_turns_tenant_thread_idx ON public.acp_turns USING btree (tenant_id, thread_id, created_at);
--> statement-breakpoint
CREATE INDEX action_records_bot_idx ON public.action_records USING btree (bot_id, created_at);
--> statement-breakpoint
CREATE INDEX action_records_created_idx ON public.action_records USING btree (created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_profiles_owner_summoned_from_unique ON public.agent_profiles USING btree (owner_user_id, summoned_from) WHERE ((summoned_from IS NOT NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX agent_profiles_visibility_deleted_idx ON public.agent_profiles USING btree (visibility, deleted_at);
--> statement-breakpoint
CREATE UNIQUE INDEX app_access_requests_pending_idx ON public.app_access_requests USING btree (tenant_id, requester_user_id, bot_id, COALESCE(server_id, app_key), kind) WHERE (status = 'pending'::text);
--> statement-breakpoint
CREATE INDEX app_access_requests_status_idx ON public.app_access_requests USING btree (status, created_at);
--> statement-breakpoint
CREATE INDEX approval_continuations_owner_idx ON public.approval_continuations USING btree (tenant_id, owner_user_id, state);
--> statement-breakpoint
CREATE INDEX approval_conversation_grants_tenant_idx ON public.approval_conversation_grants USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX approval_conversation_grants_thread_idx ON public.approval_conversation_grants USING btree (owner_user_id, thread_id);
--> statement-breakpoint
CREATE UNIQUE INDEX approval_requests_action_idx ON public.approval_requests USING btree (owner_user_id, run_id, tool_call_id);
--> statement-breakpoint
CREATE INDEX approval_requests_inbox_idx ON public.approval_requests USING btree (owner_user_id, status);
--> statement-breakpoint
CREATE INDEX approval_rules_owner_idx ON public.approval_rules USING btree (owner_user_id);
--> statement-breakpoint
CREATE INDEX apx_capture_domain_idx ON public.approval_exact_input_captures USING btree (domain_id, tenant_id, owner_user_id, thread_id, agent_id);
--> statement-breakpoint
CREATE INDEX apx_ledger_prepared_idx ON public.approval_continuations USING btree (exact_object_id, approval_id, tenant_id, owner_user_id, exact_plaintext_sha256);
--> statement-breakpoint
CREATE INDEX apx_prepared_capture_idx ON public.approval_exact_input_objects USING btree (capture_id, approval_id, tenant_id, owner_user_id, actor_user_id, domain_id, thread_id, agent_id, approval_run_id, source_actual_run_id, tool_call_id, action_digest, source_binding_version, codec_version, capture_sha256);
--> statement-breakpoint
CREATE INDEX apx_prepared_domain_idx ON public.approval_exact_input_objects USING btree (domain_id, tenant_id, owner_user_id, thread_id, agent_id);
--> statement-breakpoint
CREATE INDEX attachments_channel_idx ON public.attachments USING btree (channel_id);
--> statement-breakpoint
CREATE INDEX attachments_staged_idx ON public.attachments USING btree (created_at) WHERE (attached_at IS NULL);
--> statement-breakpoint
CREATE INDEX attachments_upload_group_idx ON public.attachments USING btree (channel_id, uploaded_by, upload_group) WHERE (attached_at IS NULL);
--> statement-breakpoint
CREATE INDEX attachments_uploaded_by_idx ON public.attachments USING btree (uploaded_by);
--> statement-breakpoint
CREATE INDEX audit_events_actor_time_idx ON public.audit_events USING btree (actor_user_id, created_at DESC NULLS LAST, id DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX audit_events_created_at_idx ON public.audit_events USING btree (created_at);
--> statement-breakpoint
CREATE INDEX audit_events_initiator_time_idx ON public.audit_events USING btree (initiator_kind, created_at DESC NULLS LAST, id DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX audit_events_subject_time_idx ON public.audit_events USING btree (subject_tenant_id, created_at DESC NULLS LAST, id DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX audit_events_target_time_idx ON public.audit_events USING btree (target_type, target_id, created_at DESC NULLS LAST, id DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX audit_events_type_time_idx ON public.audit_events USING btree (event_type, created_at DESC NULLS LAST, id DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_continuations_key_idx ON public.automation_continuations USING btree (tenant_id, firing_id, key);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_continuations_run_idx ON public.automation_continuations USING btree (tenant_id, run_id);
--> statement-breakpoint
CREATE INDEX automation_firings_breaker_idx ON public.automation_firings USING btree (tenant_id, automation_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX automation_firings_identity_idx ON public.automation_firings USING btree (tenant_id, trigger_id, external_id);
--> statement-breakpoint
CREATE INDEX automation_triggers_automation_idx ON public.automation_triggers USING btree (tenant_id, automation_id);
--> statement-breakpoint
CREATE INDEX automation_triggers_due_idx ON public.automation_triggers USING btree (next_run_at);
--> statement-breakpoint
CREATE INDEX automation_triggers_enabled_due_idx ON public.automation_triggers USING btree (next_run_at) WHERE (enabled AND (next_run_at IS NOT NULL));
--> statement-breakpoint
CREATE INDEX automations_tenant_idx ON public.automations USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX avatar_sources_active_connector_idx ON public.avatar_sources USING btree (agent_id, server_id) WHERE ((revoked_at IS NULL) AND (server_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX avatar_sources_active_idx ON public.avatar_sources USING btree (agent_id, created_at) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX avatar_sources_active_notebook_idx ON public.avatar_sources USING btree (agent_id, notebook_id) WHERE ((revoked_at IS NULL) AND (notebook_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX board_cards_claimed_by_idx ON public.board_cards USING btree (claimed_by);
--> statement-breakpoint
CREATE INDEX board_cards_open_idx ON public.board_cards USING btree (owner_user_id, role, priority DESC, created_at) WHERE (status = 'open'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX bot_tasks_channel_idx ON public.bot_tasks USING btree (channel_id);
--> statement-breakpoint
CREATE INDEX bot_tasks_owner_created_idx ON public.bot_tasks USING btree (owner_user_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX bot_tasks_suggestion_idx ON public.bot_tasks USING btree (suggestion_id);
--> statement-breakpoint
CREATE INDEX bot_tasks_tenant_idx ON public.bot_tasks USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX brokered_accounts_account_idx ON public.brokered_accounts USING btree (tenant_id, provider, app, user_id, vendor_user_id, account_id);
--> statement-breakpoint
CREATE UNIQUE INDEX brokered_accounts_default_idx ON public.brokered_accounts USING btree (tenant_id, provider, app, user_id) WHERE is_default;
--> statement-breakpoint
CREATE INDEX brokered_accounts_user_idx ON public.brokered_accounts USING btree (user_id);
--> statement-breakpoint
CREATE INDEX channel_memberships_user_idx ON public.channel_memberships USING btree (user_id);
--> statement-breakpoint
CREATE INDEX channels_awaiting_summary_idx ON public.channels USING btree (id) WHERE ((summary IS NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX channels_recent_activity_idx ON public.channels USING btree (COALESCE(last_message_at, created_at) DESC);
--> statement-breakpoint
CREATE INDEX channels_team_created_by_idx ON public.channels USING btree (created_by) WHERE (tenant_id = 'team'::text);
--> statement-breakpoint
CREATE INDEX channels_waker_group_idx ON public.channels USING btree (waker_group_id) WHERE (waker_group_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX channels_waker_group_live_idx ON public.channels USING btree (waker_group_id) WHERE ((waker_group_id IS NOT NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX composio_connections_user_idx ON public.composio_connections USING btree (user_id);
--> statement-breakpoint
CREATE INDEX computer_page_frame_captured_idx ON public.computer_page_frame USING btree (captured_at);
--> statement-breakpoint
CREATE INDEX computer_waits_open_idx ON public.computer_waits USING btree (status, created_at) WHERE (status <> 'done'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX credentials_tenant_active_key_idx ON public.credentials USING btree (tenant_id, kind, provider, key_id) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE INDEX default_opt_outs_tenant_idx ON public.default_opt_outs USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_binding_identity_idx ON public.delivery_bindings USING btree (transport, realm, identity);
--> statement-breakpoint
CREATE INDEX delivery_bindings_owner_idx ON public.delivery_bindings USING btree (owner_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_inbox_dedupe_idx ON public.delivery_inbox USING btree (source, realm, external_id);
--> statement-breakpoint
CREATE INDEX delivery_inbox_owner_idx ON public.delivery_inbox USING btree (owner_user_id, created_at);
--> statement-breakpoint
CREATE INDEX delivery_outbox_owner_idx ON public.delivery_outbox USING btree (owner_user_id, created_at);
--> statement-breakpoint
CREATE INDEX delivery_outbox_provider_idx ON public.delivery_outbox USING btree (transport, provider_id);
--> statement-breakpoint
CREATE UNIQUE INDEX demonstrations_active_bot_idx ON public.demonstrations USING btree (bot_id) WHERE (status = 'recording'::text);
--> statement-breakpoint
CREATE INDEX demonstrations_owner_idx ON public.demonstrations USING btree (owner_user_id, created_at);
--> statement-breakpoint
CREATE INDEX device_pair_codes_expires_idx ON public.device_pair_codes USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX device_pair_codes_tenant_idx ON public.device_pair_codes USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX flow_confirmations_run_idx ON public.flow_confirmations USING btree (tenant_id, run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_import_proposals_request_idx ON public.flow_import_proposals USING btree (tenant_id, request_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_import_request_idx ON public.flow_share_imports USING btree (tenant_id, request_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_official_bindings_owner_flow_idx ON public.flow_official_bindings USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_run_events_correlation_idx ON public.flow_run_events USING btree (tenant_id, run_id, correlation_id);
--> statement-breakpoint
CREATE INDEX flow_run_events_run_idx ON public.flow_run_events USING btree (tenant_id, run_id, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_run_retries_new_idx ON public.flow_run_retries USING btree (tenant_id, new_run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_run_retries_request_idx ON public.flow_run_retries USING btree (tenant_id, request_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_run_retries_source_idx ON public.flow_run_retries USING btree (tenant_id, source_run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_session_heads_flow_idx ON public.flow_customization_heads USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_session_turns_request_idx ON public.flow_customization_turns USING btree (tenant_id, request_id);
--> statement-breakpoint
CREATE INDEX flow_session_turns_session_idx ON public.flow_customization_turns USING btree (tenant_id, session_id);
--> statement-breakpoint
CREATE INDEX flow_sessions_flow_idx ON public.flow_customization_sessions USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_sessions_request_idx ON public.flow_customization_sessions USING btree (tenant_id, request_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_share_token_idx ON public.flow_share_links USING btree (token_hash);
--> statement-breakpoint
CREATE INDEX flow_shares_owner_idx ON public.flow_share_links USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE INDEX flow_source_candidates_flow_idx ON public.flow_source_candidates USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_candidates_operation_idx ON public.flow_source_candidates USING btree (tenant_id, operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_inline_dispatch_idx ON public.flow_source_inline_invocations USING btree (dispatch_key);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_inline_ordinal_idx ON public.flow_source_inline_invocations USING btree (tenant_id, run_id, parent_invocation_id, ((identity ->> 'childOrdinal'::text)));
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_invocations_correlation_idx ON public.flow_source_invocations USING btree (tenant_id, run_id, (((identity -> 'original'::text) ->> 'correlationId'::text)));
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_invocations_dispatch_idx ON public.flow_source_invocations USING btree (dispatch_key);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_invocations_key_idx ON public.flow_source_invocations USING btree (tenant_id, run_id, id);
--> statement-breakpoint
CREATE INDEX flow_source_operations_flow_idx ON public.flow_source_operations USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_operations_operation_idx ON public.flow_source_operations USING btree (tenant_id, operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_original_activation_operation_idx ON public.flow_source_original_activations USING btree (tenant_id, operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_public_operations_owner_fingerprint_idx ON public.flow_source_public_operations USING btree (tenant_id, operation_id, fingerprint);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_public_operations_owner_operation_idx ON public.flow_source_public_operations USING btree (tenant_id, operation_id);
--> statement-breakpoint
CREATE INDEX flow_source_runs_lease_idx ON public.flow_source_runs USING btree (tenant_id, state, lease_expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_runs_owner_idx ON public.flow_source_runs USING btree (tenant_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_runs_public_operation_idx ON public.flow_source_runs USING btree (tenant_id, public_operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_runtime_events_sequence_idx ON public.flow_source_runtime_events USING btree (tenant_id, run_id, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_stop_operations_id_idx ON public.flow_source_stop_operations USING btree (tenant_id, operation_id);
--> statement-breakpoint
CREATE INDEX flow_source_versions_flow_idx ON public.flow_source_versions USING btree (tenant_id, flow_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX flow_source_versions_owner_id_idx ON public.flow_source_versions USING btree (tenant_id, flow_id, id);
--> statement-breakpoint
CREATE INDEX generated_media_channel_idx ON public.generated_media USING btree (channel_id) WHERE (channel_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX generated_media_tenant_idx ON public.generated_media USING btree (tenant_id, agent_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX group_bot_threads_thread_idx ON public.group_bot_threads USING btree (thread_id);
--> statement-breakpoint
CREATE INDEX group_messages_channel_idx ON public.group_messages USING btree (channel_id, created_at, id);
--> statement-breakpoint
CREATE UNIQUE INDEX group_pipeline_start_receipts_run_idx ON public.group_pipeline_start_receipts USING btree (run_id);
--> statement-breakpoint
CREATE INDEX group_task_runs_parent_idx ON public.group_task_runs USING btree (parent_task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX group_task_runs_parent_step_idx ON public.group_task_runs USING btree (tenant_id, parent_run_id, parent_step_id) WHERE (parent_run_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX group_task_runs_tenant_status_idx ON public.group_task_runs USING btree (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX group_task_templates_group_name_idx ON public.group_task_templates USING btree (tenant_id, group_id, name);
--> statement-breakpoint
CREATE INDEX heartbeat_runs_agent_started_idx ON public.heartbeat_runs USING btree (agent_id, started_at);
--> statement-breakpoint
CREATE INDEX identity_link_challenges_expiry_idx ON public.identity_link_challenges USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX identity_link_challenges_tenant_idx ON public.identity_link_challenges USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_link_challenges_user_provider_idx ON public.identity_link_challenges USING btree (user_id, provider);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_links_credential_idx ON public.identity_links USING btree (credential_id) WHERE (credential_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_links_identity_idx ON public.identity_links USING btree (provider, realm, subject);
--> statement-breakpoint
CREATE INDEX identity_links_tenant_idx ON public.identity_links USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_links_user_realm_idx ON public.identity_links USING btree (user_id, provider, realm);
--> statement-breakpoint
CREATE UNIQUE INDEX intelligence_channel_mappings_thread_idx ON public.intelligence_channel_mappings USING btree (thread_id);
--> statement-breakpoint
CREATE INDEX knowledge_bindings_notebook_idx ON public.knowledge_bindings USING btree (tenant_id, owner_user_id, notebook_id);
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_claim_unresolved_target ON public.knowledge_write_claims USING btree (tenant_id, target_hash) WHERE (state = ANY (ARRAY['reserved'::text, 'pending'::text, 'ready'::text, 'unknown'::text]));
--> statement-breakpoint
CREATE INDEX knowledge_directories_notebook_idx ON public.knowledge_directories USING btree (tenant_id, owner_user_id, notebook_id, parent_id);
--> statement-breakpoint
CREATE INDEX knowledge_sources_directory_idx ON public.knowledge_sources USING btree (tenant_id, owner_user_id, notebook_id, directory_id);
--> statement-breakpoint
CREATE INDEX knowledge_sources_notebook_idx ON public.knowledge_sources USING btree (tenant_id, owner_user_id, notebook_id);
--> statement-breakpoint
CREATE INDEX learned_skills_agent_idx ON public.learned_skills USING btree (agent_id);
--> statement-breakpoint
CREATE UNIQUE INDEX learned_skills_tenant_slug_key ON public.learned_skills USING btree (tenant_id, skill_slug);
--> statement-breakpoint
CREATE INDEX learning_open_skills_tenant_idx ON public.learning_open_skills USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX learning_person_spaces_tenant_idx ON public.learning_person_spaces USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX learning_skill_approvals_tenant_idx ON public.learning_skill_approvals USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX learning_skill_sharing_open_idx ON public.learning_skill_sharing USING btree (user_id) WHERE (mode <> 'closed'::text);
--> statement-breakpoint
CREATE INDEX learning_skill_sharing_tenant_idx ON public.learning_skill_sharing USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX learning_thread_bindings_tenant_idx ON public.learning_thread_bindings USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX local_learning_runs_one_running_idx ON public.local_learning_runs USING btree (tenant_id) WHERE (outcome = 'running'::text);
--> statement-breakpoint
CREATE INDEX local_learning_runs_tenant_started_idx ON public.local_learning_runs USING btree (tenant_id, started_at);
--> statement-breakpoint
CREATE INDEX local_skill_candidates_tenant_status_idx ON public.local_skill_candidates USING btree (tenant_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_servers_tenant_catalogue_key ON public.mcp_servers USING btree (tenant_id, catalogue_key);
--> statement-breakpoint
CREATE INDEX mcp_user_credentials_user_idx ON public.mcp_user_credentials USING btree (user_id);
--> statement-breakpoint
CREATE INDEX memory_sources_due_idx ON public.memory_sources USING btree (enabled, next_sync_at);
--> statement-breakpoint
CREATE INDEX memory_sources_owner_idx ON public.memory_sources USING btree (owner_user_id);
--> statement-breakpoint
CREATE INDEX model_registry_tenant_idx ON public.model_registry USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX model_registry_tenant_model_idx ON public.model_registry USING btree (tenant_id, provider, model_name);
--> statement-breakpoint
CREATE INDEX model_token_calls_thread_agent_idx ON public.model_token_calls USING btree (tenant_id, thread_id, agent_id, started_at);
--> statement-breakpoint
CREATE INDEX model_token_calls_time_idx ON public.model_token_calls USING btree (tenant_id, started_at DESC NULLS LAST, call_id DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX model_usage_created_idx ON public.model_usage USING btree (created_at);
--> statement-breakpoint
CREATE INDEX model_usage_model_idx ON public.model_usage USING btree (model, created_at);
--> statement-breakpoint
CREATE INDEX pending_authorizations_server_idx ON public.pending_authorizations USING btree (server_id);
--> statement-breakpoint
CREATE INDEX persona_templates_tenant_idx ON public.persona_templates USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX persona_templates_tenant_name_idx ON public.persona_templates USING btree (tenant_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX personal_memories_formed_digest_per_bot_idx ON public.personal_memories USING btree (owner_user_id, formed_by_agent_id, import_digest) WHERE (formed_by = 'bot'::text);
--> statement-breakpoint
CREATE INDEX personal_memories_formed_idx ON public.personal_memories USING btree (owner_user_id, formed_by_agent_id);
--> statement-breakpoint
CREATE UNIQUE INDEX personal_memories_import_idx ON public.personal_memories USING btree (source_id, external_id);
--> statement-breakpoint
CREATE INDEX personal_memories_intelligence_idx ON public.personal_memories USING btree (owner_user_id, intelligence_memory_id);
--> statement-breakpoint
CREATE INDEX personal_memories_owner_idx ON public.personal_memories USING btree (owner_user_id, enabled);
--> statement-breakpoint
CREATE INDEX plugin_assembly_origins_source_idx ON public.plugin_assembly_origins USING btree (source_tenant_id, kind, source_id);
--> statement-breakpoint
CREATE INDEX plugin_assembly_publications_ref_idx ON public.plugin_assembly_publications USING btree (kind, ref);
--> statement-breakpoint
CREATE INDEX plugin_grants_agent_idx ON public.plugin_grants USING btree (agent_id);
--> statement-breakpoint
CREATE INDEX proactive_check_in_runs_agent_started_idx ON public.proactive_check_in_runs USING btree (agent_id, started_at);
--> statement-breakpoint
CREATE UNIQUE INDEX proactive_check_in_runs_one_running_idx ON public.proactive_check_in_runs USING btree (setting_id) WHERE (outcome = 'running'::text);
--> statement-breakpoint
CREATE INDEX proactive_check_in_runs_owner_started_idx ON public.proactive_check_in_runs USING btree (owner_user_id, started_at);
--> statement-breakpoint
CREATE INDEX proactive_check_in_runs_setting_started_idx ON public.proactive_check_in_runs USING btree (setting_id, started_at);
--> statement-breakpoint
CREATE INDEX proactive_check_in_runs_tenant_idx ON public.proactive_check_in_runs USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX proactive_people_tenant_idx ON public.proactive_people USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX proactive_pings_owner_created_idx ON public.proactive_pings USING btree (owner_user_id, created_at);
--> statement-breakpoint
CREATE INDEX proactive_pings_tenant_idx ON public.proactive_pings USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX proactive_pings_unoffered_idx ON public.proactive_pings USING btree (created_at) WHERE (offered_at IS NULL);
--> statement-breakpoint
CREATE INDEX proactive_runs_history_idx ON public.proactive_runs USING btree (tenant_id, owner_user_id, setting_id, created_at DESC NULLS LAST, id DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX proactive_runs_request_idx ON public.proactive_runs USING btree (tenant_id, request_key);
--> statement-breakpoint
CREATE INDEX proactive_settings_due_idx ON public.proactive_settings USING btree (enabled, next_run_at);
--> statement-breakpoint
CREATE INDEX proactive_settings_owner_agent_idx ON public.proactive_settings USING btree (owner_user_id, agent_id);
--> statement-breakpoint
CREATE UNIQUE INDEX proactive_suggestions_open_dedupe_idx ON public.proactive_suggestions USING btree (owner_user_id, agent_id, dedupe_key) WHERE ((status = 'open'::text) AND (dedupe_key IS NOT NULL));
--> statement-breakpoint
CREATE INDEX proactive_suggestions_owner_idx ON public.proactive_suggestions USING btree (owner_user_id, status, created_at);
--> statement-breakpoint
CREATE INDEX proactive_suggestions_run_idx ON public.proactive_suggestions USING btree (run_id);
--> statement-breakpoint
CREATE INDEX proactive_suggestions_unpinged_idx ON public.proactive_suggestions USING btree (owner_user_id) WHERE ((status = 'open'::text) AND (ping_id IS NULL));
--> statement-breakpoint
CREATE INDEX push_devices_owner_idx ON public.push_devices USING btree (owner_user_id);
--> statement-breakpoint
CREATE INDEX recorder_connect_codes_tenant_idx ON public.recorder_connect_codes USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX recorder_connect_codes_user_idx ON public.recorder_connect_codes USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX recorder_connections_live_install_idx ON public.recorder_connections USING btree (user_id, install_id) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE INDEX recorder_connections_tenant_idx ON public.recorder_connections USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX recorder_connections_user_idx ON public.recorder_connections USING btree (user_id, created_at);
--> statement-breakpoint
CREATE INDEX recorder_trajectory_bindings_tenant_idx ON public.recorder_trajectory_bindings USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX recorder_trajectory_bindings_user_idx ON public.recorder_trajectory_bindings USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX registered_devices_tenant_device_idx ON public.registered_devices USING btree (tenant_id, device_id);
--> statement-breakpoint
CREATE INDEX registered_devices_tenant_idx ON public.registered_devices USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX resource_projects_device_scope_idx ON public.resource_projects USING btree (tenant_id, device_id, agent_id);
--> statement-breakpoint
CREATE INDEX responsibilities_owner_status_idx ON public.responsibilities USING btree (owner_user_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX responsibility_events_source_id_idx ON public.responsibility_events USING btree (owner_user_id, source, external_id);
--> statement-breakpoint
CREATE UNIQUE INDEX responsibility_runs_event_idx ON public.responsibility_runs USING btree (responsibility_id, event_id);
--> statement-breakpoint
CREATE INDEX responsibility_runs_status_idx ON public.responsibility_runs USING btree (status, created_at);
--> statement-breakpoint
CREATE INDEX responsibility_source_bindings_owner_idx ON public.responsibility_source_bindings USING btree (owner_user_id);
--> statement-breakpoint
CREATE INDEX responsibility_triggers_kind_idx ON public.responsibility_triggers USING btree (kind);
--> statement-breakpoint
CREATE INDEX responsibility_triggers_owner_idx ON public.responsibility_triggers USING btree (owner_user_id);
--> statement-breakpoint
CREATE INDEX responsibility_triggers_responsibility_idx ON public.responsibility_triggers USING btree (responsibility_id);
--> statement-breakpoint
CREATE UNIQUE INDEX role_templates_owner_name_idx ON public.role_templates USING btree (tenant_id, owner_user_id, name);
--> statement-breakpoint
CREATE INDEX routine_runs_by_routine_idx ON public.routine_runs USING btree (routine_id, started_at);
--> statement-breakpoint
CREATE INDEX routines_by_owner_idx ON public.routines USING btree (owner_user_id, enabled);
--> statement-breakpoint
CREATE INDEX routines_due_idx ON public.routines USING btree (enabled, next_run_at);
--> statement-breakpoint
CREATE INDEX saved_logins_owner_idx ON public.saved_logins USING btree (owner_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX saved_logins_owner_origin_username_idx ON public.saved_logins USING btree (owner_user_id, origin, username);
--> statement-breakpoint
CREATE INDEX scim_connection_bindings_connection_idx ON public.scim_connection_bindings USING btree (connection_id);
--> statement-breakpoint
CREATE INDEX scim_group_members_connection_idx ON public.scim_group_members USING btree (connection_id);
--> statement-breakpoint
CREATE INDEX scim_group_members_group_idx ON public.scim_group_members USING btree (group_id);
--> statement-breakpoint
CREATE INDEX scim_group_members_scim_user_idx ON public.scim_group_members USING btree (scim_user_id);
--> statement-breakpoint
CREATE INDEX scim_groups_connection_idx ON public.scim_groups USING btree (connection_id);
--> statement-breakpoint
CREATE INDEX scim_groups_domain_idx ON public.scim_groups USING btree (provisioning_domain_id);
--> statement-breakpoint
CREATE INDEX scim_identity_tombstones_connection_idx ON public.scim_identity_tombstones USING btree (connection_id);
--> statement-breakpoint
CREATE INDEX scim_identity_tombstones_domain_idx ON public.scim_identity_tombstones USING btree (provisioning_domain_id);
--> statement-breakpoint
CREATE INDEX scim_identity_tombstones_user_idx ON public.scim_identity_tombstones USING btree (user_id);
--> statement-breakpoint
CREATE INDEX scim_projection_grants_connection_idx ON public.scim_projection_grants USING btree (connection_id);
--> statement-breakpoint
CREATE INDEX scim_projection_grants_domain_idx ON public.scim_projection_grants USING btree (provisioning_domain_id);
--> statement-breakpoint
CREATE INDEX scim_projection_grants_scim_user_idx ON public.scim_projection_grants USING btree (scim_user_id);
--> statement-breakpoint
CREATE INDEX scim_projection_grants_user_idx ON public.scim_projection_grants USING btree (user_id);
--> statement-breakpoint
CREATE INDEX scim_subjects_profile_source_idx ON public.scim_subjects USING btree (profile_source_id);
--> statement-breakpoint
CREATE INDEX scim_users_connection_idx ON public.scim_users USING btree (connection_id);
--> statement-breakpoint
CREATE INDEX scim_users_domain_idx ON public.scim_users USING btree (provisioning_domain_id);
--> statement-breakpoint
CREATE INDEX scim_users_user_idx ON public.scim_users USING btree (user_id);
--> statement-breakpoint
CREATE INDEX shared_use_approvals_server_idx ON public.shared_use_approvals USING btree (tenant_id, server_id);
--> statement-breakpoint
CREATE UNIQUE INDEX shared_use_requests_pending_idx ON public.shared_use_requests USING btree (tenant_id, agent_id, server_id) WHERE (status = 'pending'::text);
--> statement-breakpoint
CREATE INDEX shared_use_requests_status_idx ON public.shared_use_requests USING btree (tenant_id, status, created_at);
--> statement-breakpoint
CREATE INDEX sign_in_requests_owner_idx ON public.sign_in_requests USING btree (owner_user_id, status);
--> statement-breakpoint
CREATE INDEX skill_tools_ref_idx ON public.skill_tools USING btree (ref);
--> statement-breakpoint
CREATE INDEX skills_owner_idx ON public.skills USING btree (owner_user_id);
--> statement-breakpoint
CREATE INDEX skills_package_idx ON public.skills USING btree (package_id);
--> statement-breakpoint
CREATE UNIQUE INDEX skills_tenant_slug_key ON public.skills USING btree (tenant_id, slug);
--> statement-breakpoint
CREATE INDEX staffing_proposals_owner_status_idx ON public.staffing_proposals USING btree (tenant_id, owner_id, status);
--> statement-breakpoint
CREATE INDEX task_events_task_idx ON public.task_events USING btree (tenant_id, task_id, created_at);
--> statement-breakpoint
CREATE INDEX tasks_channel_ref_idx ON public.tasks USING btree (tenant_id, channel_ref, updated_at);
--> statement-breakpoint
CREATE INDEX tasks_executor_idx ON public.tasks USING btree (executor_agent_id, updated_at);
--> statement-breakpoint
CREATE INDEX tasks_run_ref_idx ON public.tasks USING btree (run_ref);
--> statement-breakpoint
CREATE INDEX tasks_tenant_status_updated_idx ON public.tasks USING btree (tenant_id, status, updated_at);
--> statement-breakpoint
CREATE INDEX tasks_tracked_due_idx ON public.tasks USING btree (tenant_id, tracked, status, due_at);
--> statement-breakpoint
CREATE INDEX tasks_tracked_thread_idx ON public.tasks USING btree (tenant_id, thread_ref, executor_agent_id) WHERE tracked;
--> statement-breakpoint
CREATE INDEX text_translations_pending_idx ON public.text_translations USING btree (created_at) WHERE (translated IS NULL);
--> statement-breakpoint
CREATE INDEX thread_compactions_thread_idx ON public.thread_compactions USING btree (tenant_id, thread_id, agent_id, created_at);
--> statement-breakpoint
CREATE INDEX thread_context_breakdowns_thread_idx ON public.thread_context_breakdowns USING btree (tenant_id, thread_id, agent_id, created_at);
--> statement-breakpoint
CREATE INDEX thread_run_events_thread_idx ON public.thread_run_events USING btree (thread_id, seq);
--> statement-breakpoint
CREATE INDEX thread_run_liveness_running_idx ON public.thread_run_liveness USING btree (heartbeat_at) WHERE (status = 'running'::text);
--> statement-breakpoint
CREATE INDEX thread_runs_thread_idx ON public.thread_runs USING btree (thread_id, created_at);
--> statement-breakpoint
CREATE INDEX threads_tenant_created_idx ON public.threads USING btree (tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX users_lower_email_idx ON public.users USING btree (lower(email));
--> statement-breakpoint
CREATE INDEX voice_sessions_channel_started_idx ON public.voice_sessions USING btree (channel_id, started_at, id);
--> statement-breakpoint
CREATE INDEX waker_flow_requests_flow_idx ON public.waker_flow_requests USING btree (tenant_id, flow_id);
--> statement-breakpoint
CREATE UNIQUE INDEX waker_flow_requests_tenant_request_idx ON public.waker_flow_requests USING btree (tenant_id, request_id);
--> statement-breakpoint
CREATE INDEX waker_flow_versions_flow_idx ON public.waker_flow_versions USING btree (flow_id, revision DESC);
--> statement-breakpoint
CREATE INDEX waker_flows_tenant_idx ON public.waker_flows USING btree (tenant_id);
--> statement-breakpoint
CREATE INDEX waker_group_members_agent_idx ON public.waker_group_members USING btree (agent_id);
--> statement-breakpoint
CREATE INDEX waker_groups_tenant_idx ON public.waker_groups USING btree (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX waker_groups_tenant_name_idx ON public.waker_groups USING btree (tenant_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX wechat_accounts_ilink_user_idx ON public.wechat_accounts USING btree (ilink_user_id) WHERE (status = ANY (ARRAY['bound'::text, 'paused'::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX wechat_accounts_user_idx ON public.wechat_accounts USING btree (user_id);
--> statement-breakpoint
CREATE INDEX wechat_bind_attempts_user_idx ON public.wechat_bind_attempts USING btree (user_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX wechat_prompts_open_ref_idx ON public.wechat_prompts USING btree (user_id, kind, ref_id) WHERE (state = 'open'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX wechat_prompts_user_code_idx ON public.wechat_prompts USING btree (user_id, code);
--> statement-breakpoint
CREATE INDEX work_items_claimable_idx ON public.work_items USING btree (kind, run_at);
--> statement-breakpoint
CREATE INDEX work_items_open_thread_idx ON public.work_items USING btree (kind, ((payload ->> 'threadId'::text))) WHERE (finished_at IS NULL);
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_event_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_audit_event_mutation();
--> statement-breakpoint
CREATE TRIGGER xiongbao_channel_waker_group_link BEFORE INSERT OR UPDATE OF waker_group_id ON public.channels FOR EACH ROW EXECUTE FUNCTION public.xiongbao_channel_waker_group_link();
--> statement-breakpoint
CREATE TRIGGER xiongbao_flow_share_guard BEFORE UPDATE ON public.flow_share_links FOR EACH ROW EXECUTE FUNCTION public.xiongbao_flow_share_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_grant_stamp_guard BEFORE INSERT ON public.plugin_grants FOR EACH ROW EXECUTE FUNCTION public.xiongbao_grant_stamp_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_mcp_tool_stamp_guard BEFORE INSERT OR UPDATE OF tenant_id, server_id ON public.mcp_tools FOR EACH ROW EXECUTE FUNCTION public.xiongbao_mcp_tool_stamp_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_channel_guard BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_channel_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_revoked_leaves AFTER INSERT ON public.revoked_access FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_revoked_leaves();
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.agent_profiles FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('agent_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.approval_team_rules FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.approval_team_settings FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.channel_agents FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('channel_id', 'agent_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.channel_memberships FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('channel_id', 'user_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('created_by');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.credentials FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('kind');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.group_bot_threads FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('channel_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.group_message_private FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('message_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.group_messages FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('channel_id', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.mcp_servers FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard();
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.mcp_tools FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('server_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.plugin_grants FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('agent_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.sandboxed_components FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('name');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.team_bot_assignments FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('agent_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.team_bot_audience FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('agent_id');
--> statement-breakpoint
CREATE TRIGGER xiongbao_team_row_guard BEFORE UPDATE ON public.team_bot_publications FOR EACH ROW EXECUTE FUNCTION public.xiongbao_team_row_guard('agent_id', 'published_by');
--> statement-breakpoint
ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_preferences
    ADD CONSTRAINT agent_preferences_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_preferences
    ADD CONSTRAINT agent_preferences_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_model_ref_model_registry_id_fk FOREIGN KEY (model_ref) REFERENCES public.model_registry(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_platform_model_ref_platform_model_pool_id_fk FOREIGN KEY (platform_model_ref) REFERENCES public.platform_model_pool(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_summoned_from_fkey FOREIGN KEY (summoned_from) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_security_policies
    ADD CONSTRAINT agent_security_policies_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_security_settings
    ADD CONSTRAINT agent_security_settings_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_security_settings
    ADD CONSTRAINT agent_security_settings_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_package_id_deployment_packages_id_fk FOREIGN KEY (package_id) REFERENCES public.deployment_packages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.app_access_requests
    ADD CONSTRAINT app_access_requests_bot_id_agents_id_fk FOREIGN KEY (bot_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.app_access_requests
    ADD CONSTRAINT app_access_requests_requester_user_id_users_id_fk FOREIGN KEY (requester_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.app_access_requests
    ADD CONSTRAINT app_access_requests_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuation_steps
    ADD CONSTRAINT approval_continuation_steps_approval_id_approval_continuations_ FOREIGN KEY (approval_id) REFERENCES public.approval_continuations(approval_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuations
    ADD CONSTRAINT approval_continuations_approval_id_approval_requests_id_fk FOREIGN KEY (approval_id) REFERENCES public.approval_requests(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_conversation_grants
    ADD CONSTRAINT approval_conversation_grants_approval_id_approval_requests_id_f FOREIGN KEY (approval_id) REFERENCES public.approval_requests(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_conversation_grants
    ADD CONSTRAINT approval_conversation_grants_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_direct_execution_domains
    ADD CONSTRAINT approval_direct_execution_domains_thread_binding_fk FOREIGN KEY (thread_id, tenant_id, agent_id) REFERENCES public.threads(id, tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_preferences
    ADD CONSTRAINT approval_preferences_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_rules
    ADD CONSTRAINT approval_rules_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_team_rules
    ADD CONSTRAINT approval_team_rules_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_team_settings
    ADD CONSTRAINT approval_team_settings_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_actor_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_agent_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_approval_fk FOREIGN KEY (approval_id, tenant_id, owner_user_id) REFERENCES public.approval_requests(id, tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_domain_fk FOREIGN KEY (domain_id, tenant_id, owner_user_id, thread_id, agent_id) REFERENCES public.approval_direct_execution_domains(domain_id, tenant_id, owner_user_id, thread_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_captures
    ADD CONSTRAINT apx_capture_thread_fk FOREIGN KEY (thread_id, tenant_id, agent_id) REFERENCES public.threads(id, tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_continuations
    ADD CONSTRAINT apx_ledger_prepared_fk FOREIGN KEY (exact_object_id, approval_id, tenant_id, owner_user_id, exact_plaintext_sha256) REFERENCES public.approval_exact_input_objects(id, approval_id, tenant_id, owner_user_id, plaintext_sha256);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_actor_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_agent_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_approval_fk FOREIGN KEY (approval_id, tenant_id, owner_user_id) REFERENCES public.approval_requests(id, tenant_id, owner_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_capture_scope_fk FOREIGN KEY (capture_id, approval_id, tenant_id, owner_user_id, actor_user_id, domain_id, thread_id, agent_id, approval_run_id, source_actual_run_id, tool_call_id, action_digest, source_binding_version, codec_version, capture_sha256) REFERENCES public.approval_exact_input_captures(id, approval_id, tenant_id, owner_user_id, actor_user_id, domain_id, thread_id, agent_id, approval_run_id, source_actual_run_id, tool_call_id, action_digest, source_binding_version, codec_version, plaintext_sha256);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_domain_fk FOREIGN KEY (domain_id, tenant_id, owner_user_id, thread_id, agent_id) REFERENCES public.approval_direct_execution_domains(domain_id, tenant_id, owner_user_id, thread_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_exact_input_objects
    ADD CONSTRAINT apx_prepared_thread_fk FOREIGN KEY (thread_id, tenant_id, agent_id) REFERENCES public.threads(id, tenant_id, agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_users_id_fk FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.automation_continuations
    ADD CONSTRAINT automation_continuations_firing_id_automation_firings_id_fk FOREIGN KEY (firing_id) REFERENCES public.automation_firings(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_firings
    ADD CONSTRAINT automation_firings_automation_id_automations_id_fk FOREIGN KEY (automation_id) REFERENCES public.automations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_firings
    ADD CONSTRAINT automation_firings_trigger_id_automation_triggers_id_fk FOREIGN KEY (trigger_id) REFERENCES public.automation_triggers(id);
--> statement-breakpoint
ALTER TABLE ONLY public.automation_triggers
    ADD CONSTRAINT automation_triggers_automation_id_automations_id_fk FOREIGN KEY (automation_id) REFERENCES public.automations(id);
--> statement-breakpoint
ALTER TABLE ONLY public.avatar_sources
    ADD CONSTRAINT avatar_sources_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.avatar_sources
    ADD CONSTRAINT avatar_sources_notebook_id_knowledge_notebooks_id_fk FOREIGN KEY (notebook_id) REFERENCES public.knowledge_notebooks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.avatar_sources
    ADD CONSTRAINT avatar_sources_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.board_cards
    ADD CONSTRAINT board_cards_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.board_cards
    ADD CONSTRAINT board_cards_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.bot_lifecycle
    ADD CONSTRAINT bot_lifecycle_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bot_lifecycle
    ADD CONSTRAINT bot_lifecycle_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bot_tasks
    ADD CONSTRAINT bot_tasks_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bot_tasks
    ADD CONSTRAINT bot_tasks_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bot_tasks
    ADD CONSTRAINT bot_tasks_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bot_tasks
    ADD CONSTRAINT bot_tasks_suggestion_id_proactive_suggestions_id_fk FOREIGN KEY (suggestion_id) REFERENCES public.proactive_suggestions(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.channel_agents
    ADD CONSTRAINT channel_agents_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.channel_agents
    ADD CONSTRAINT channel_agents_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.channel_memberships
    ADD CONSTRAINT channel_memberships_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.channel_memberships
    ADD CONSTRAINT channel_memberships_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_last_message_agent_id_agents_id_fk FOREIGN KEY (last_message_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_package_id_deployment_packages_id_fk FOREIGN KEY (package_id) REFERENCES public.deployment_packages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_waker_group_id_fkey FOREIGN KEY (waker_group_id) REFERENCES public.waker_groups(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.component_exclusions
    ADD CONSTRAINT component_exclusions_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.component_exclusions
    ADD CONSTRAINT component_exclusions_component_name_components_name_fk FOREIGN KEY (component_name) REFERENCES public.components(name) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.component_functions
    ADD CONSTRAINT component_functions_component_name_components_name_fk FOREIGN KEY (component_name) REFERENCES public.components(name) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.default_opt_outs
    ADD CONSTRAINT default_opt_outs_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.default_opt_outs
    ADD CONSTRAINT default_opt_outs_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_bindings
    ADD CONSTRAINT delivery_bindings_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_bindings
    ADD CONSTRAINT delivery_bindings_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_bindings
    ADD CONSTRAINT delivery_bindings_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_challenges
    ADD CONSTRAINT delivery_challenges_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_challenges
    ADD CONSTRAINT delivery_challenges_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_challenges
    ADD CONSTRAINT delivery_challenges_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_inbox
    ADD CONSTRAINT delivery_inbox_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_inbox
    ADD CONSTRAINT delivery_inbox_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_inbox
    ADD CONSTRAINT delivery_inbox_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_outbox
    ADD CONSTRAINT delivery_outbox_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_outbox
    ADD CONSTRAINT delivery_outbox_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_outbox
    ADD CONSTRAINT delivery_outbox_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.demonstrations
    ADD CONSTRAINT demonstrations_bot_id_agents_id_fk FOREIGN KEY (bot_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.demonstrations
    ADD CONSTRAINT demonstrations_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.employee_role_snapshots
    ADD CONSTRAINT employee_role_snapshots_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.employee_role_snapshots
    ADD CONSTRAINT employee_role_snapshots_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.flow_confirmations
    ADD CONSTRAINT flow_confirmations_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_confirmations
    ADD CONSTRAINT flow_confirmations_run_id_group_task_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.group_task_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_heads
    ADD CONSTRAINT flow_customization_heads_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_heads
    ADD CONSTRAINT flow_customization_heads_session_id_flow_customization_sessions FOREIGN KEY (session_id) REFERENCES public.flow_customization_sessions(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_sessions
    ADD CONSTRAINT flow_customization_sessions_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_turns
    ADD CONSTRAINT flow_customization_turns_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_customization_turns
    ADD CONSTRAINT flow_customization_turns_session_id_flow_customization_sessions FOREIGN KEY (session_id) REFERENCES public.flow_customization_sessions(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_official_bindings
    ADD CONSTRAINT flow_official_bindings_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_official_bindings
    ADD CONSTRAINT flow_official_bindings_source_id_flow_official_source_heads_sou FOREIGN KEY (source_id) REFERENCES public.flow_official_source_heads(source_id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_events
    ADD CONSTRAINT flow_run_events_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_events
    ADD CONSTRAINT flow_run_events_run_id_group_task_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.group_task_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_retries
    ADD CONSTRAINT flow_run_retries_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_retries
    ADD CONSTRAINT flow_run_retries_new_run_id_group_task_runs_id_fk FOREIGN KEY (new_run_id) REFERENCES public.group_task_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_run_retries
    ADD CONSTRAINT flow_run_retries_source_run_id_group_task_runs_id_fk FOREIGN KEY (source_run_id) REFERENCES public.group_task_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_share_imports
    ADD CONSTRAINT flow_share_imports_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_share_links
    ADD CONSTRAINT flow_share_links_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_candidates
    ADD CONSTRAINT flow_source_candidates_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_candidates
    ADD CONSTRAINT flow_source_candidates_generation_owner_fk FOREIGN KEY (tenant_id, operation_id, generation_fingerprint) REFERENCES public.flow_source_public_operations(tenant_id, operation_id, fingerprint);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_inline_invocations
    ADD CONSTRAINT flow_source_inline_parent_owner_fk FOREIGN KEY (tenant_id, run_id, parent_invocation_id) REFERENCES public.flow_source_invocations(tenant_id, run_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_invocations
    ADD CONSTRAINT flow_source_invocations_run_id_flow_source_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.flow_source_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_invocations
    ADD CONSTRAINT flow_source_invocations_run_owner_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.flow_source_runs(tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_operations
    ADD CONSTRAINT flow_source_operations_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_original_activations
    ADD CONSTRAINT flow_source_original_activation_origin_fk FOREIGN KEY (tenant_id, operation_id, fingerprint) REFERENCES public.flow_source_public_operations(tenant_id, operation_id, fingerprint);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_original_activations
    ADD CONSTRAINT flow_source_original_activation_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.flow_source_runs(tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_original_projection_observations
    ADD CONSTRAINT flow_source_original_projection_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.flow_source_runs(tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_public_operations
    ADD CONSTRAINT flow_source_public_operations_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_resource_snapshots
    ADD CONSTRAINT flow_source_resource_snapshots_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runs
    ADD CONSTRAINT flow_source_runs_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runs
    ADD CONSTRAINT flow_source_runs_public_origin_fk FOREIGN KEY (tenant_id, public_operation_id, public_operation_fingerprint) REFERENCES public.flow_source_public_operations(tenant_id, operation_id, fingerprint);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runs
    ADD CONSTRAINT flow_source_runs_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runs
    ADD CONSTRAINT flow_source_runs_version_id_flow_source_versions_id_fk FOREIGN KEY (version_id) REFERENCES public.flow_source_versions(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runs
    ADD CONSTRAINT flow_source_runs_version_owner_fk FOREIGN KEY (tenant_id, flow_id, version_id) REFERENCES public.flow_source_versions(tenant_id, flow_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runtime_events
    ADD CONSTRAINT flow_source_runtime_events_run_id_flow_source_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.flow_source_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_runtime_events
    ADD CONSTRAINT flow_source_runtime_events_run_owner_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.flow_source_runs(tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_stop_operations
    ADD CONSTRAINT flow_source_stop_operations_run_id_flow_source_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.flow_source_runs(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_stop_operations
    ADD CONSTRAINT flow_source_stop_operations_run_owner_fk FOREIGN KEY (tenant_id, run_id) REFERENCES public.flow_source_runs(tenant_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_versions
    ADD CONSTRAINT flow_source_versions_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_versions
    ADD CONSTRAINT flow_source_versions_parent_fk FOREIGN KEY (tenant_id, flow_id, parent_version_id) REFERENCES public.flow_source_versions(tenant_id, flow_id, id);
--> statement-breakpoint
ALTER TABLE ONLY public.generated_media
    ADD CONSTRAINT generated_media_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_bot_threads
    ADD CONSTRAINT group_bot_threads_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_bot_threads
    ADD CONSTRAINT group_bot_threads_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_message_private
    ADD CONSTRAINT group_message_private_message_fk FOREIGN KEY (message_id, owner_user_id) REFERENCES public.group_messages(id, owner_user_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_runs
    ADD CONSTRAINT group_task_runs_group_id_waker_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.waker_groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_runs
    ADD CONSTRAINT group_task_runs_parent_run_id_group_task_runs_id_fk FOREIGN KEY (parent_run_id) REFERENCES public.group_task_runs(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_runs
    ADD CONSTRAINT group_task_runs_template_id_group_task_templates_id_fk FOREIGN KEY (template_id) REFERENCES public.group_task_templates(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.group_task_templates
    ADD CONSTRAINT group_task_templates_group_id_waker_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.waker_groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.heartbeat_runs
    ADD CONSTRAINT heartbeat_runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.identity_links
    ADD CONSTRAINT identity_links_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id);
--> statement-breakpoint
ALTER TABLE ONLY public.intelligence_channel_mappings
    ADD CONSTRAINT intelligence_channel_mappings_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.intelligence_channel_mappings
    ADD CONSTRAINT intelligence_channel_mappings_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_binding_heads
    ADD CONSTRAINT knowledge_binding_heads_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_binding_heads
    ADD CONSTRAINT knowledge_binding_heads_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_bindings
    ADD CONSTRAINT knowledge_bindings_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_bindings
    ADD CONSTRAINT knowledge_bindings_notebook_id_knowledge_notebooks_id_fk FOREIGN KEY (notebook_id) REFERENCES public.knowledge_notebooks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_bindings
    ADD CONSTRAINT knowledge_bindings_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_claims
    ADD CONSTRAINT knowledge_claim_execution_fk FOREIGN KEY (tenant_id, agent_id, run_id, thread_id) REFERENCES public.knowledge_write_executions(tenant_id, agent_id, run_id, thread_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_directories
    ADD CONSTRAINT knowledge_directories_notebook_id_knowledge_notebooks_id_fk FOREIGN KEY (notebook_id) REFERENCES public.knowledge_notebooks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_directories
    ADD CONSTRAINT knowledge_directories_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_directories
    ADD CONSTRAINT knowledge_directory_parent_scope_fk FOREIGN KEY (parent_id, tenant_id, owner_user_id, notebook_id) REFERENCES public.knowledge_directories(id, tenant_id, owner_user_id, notebook_id);
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_notebooks
    ADD CONSTRAINT knowledge_notebooks_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_receipts
    ADD CONSTRAINT knowledge_receipts_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_source_directory_scope_fk FOREIGN KEY (directory_id, tenant_id, owner_user_id, notebook_id) REFERENCES public.knowledge_directories(id, tenant_id, owner_user_id, notebook_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_sources_notebook_id_knowledge_notebooks_id_fk FOREIGN KEY (notebook_id) REFERENCES public.knowledge_notebooks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_sources_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_claims
    ADD CONSTRAINT knowledge_write_claims_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_executions
    ADD CONSTRAINT knowledge_write_executions_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.knowledge_write_executions
    ADD CONSTRAINT knowledge_write_executions_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.learned_skills
    ADD CONSTRAINT learned_skills_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.learned_skills
    ADD CONSTRAINT learned_skills_skill_fk FOREIGN KEY (tenant_id, skill_slug) REFERENCES public.skills(tenant_id, slug) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.learning_open_skills
    ADD CONSTRAINT learning_open_skills_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.learning_person_spaces
    ADD CONSTRAINT learning_person_spaces_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.learning_skill_approvals
    ADD CONSTRAINT learning_skill_approvals_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.learning_skill_sharing
    ADD CONSTRAINT learning_skill_sharing_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.local_learning_runs
    ADD CONSTRAINT local_learning_runs_tenant_id_users_id_fk FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.local_learning_state
    ADD CONSTRAINT local_learning_state_tenant_id_users_id_fk FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.local_skill_candidates
    ADD CONSTRAINT local_skill_candidates_tenant_id_users_id_fk FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_user_credentials
    ADD CONSTRAINT mcp_user_credentials_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_user_credentials
    ADD CONSTRAINT mcp_user_credentials_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_user_credentials
    ADD CONSTRAINT mcp_user_credentials_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.memory_embeddings
    ADD CONSTRAINT memory_embeddings_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.personal_memories(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.model_registry
    ADD CONSTRAINT model_registry_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.pending_authorizations
    ADD CONSTRAINT pending_authorizations_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.pending_authorizations
    ADD CONSTRAINT pending_authorizations_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_memories
    ADD CONSTRAINT personal_memories_formed_by_agent_id_agents_id_fk FOREIGN KEY (formed_by_agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_memories
    ADD CONSTRAINT personal_memories_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.personal_memories
    ADD CONSTRAINT personal_memories_source_id_memory_sources_id_fk FOREIGN KEY (source_id) REFERENCES public.memory_sources(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_assembly_publications
    ADD CONSTRAINT plugin_assembly_publications_id_fkey FOREIGN KEY (id) REFERENCES public.plugin_assembly_origins(id);
--> statement-breakpoint
ALTER TABLE ONLY public.plugin_grants
    ADD CONSTRAINT plugin_grants_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_check_in_runs
    ADD CONSTRAINT proactive_check_in_runs_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_check_in_runs
    ADD CONSTRAINT proactive_check_in_runs_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_check_in_runs
    ADD CONSTRAINT proactive_check_in_runs_setting_id_proactive_settings_id_fk FOREIGN KEY (setting_id) REFERENCES public.proactive_settings(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_people
    ADD CONSTRAINT proactive_people_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_pings
    ADD CONSTRAINT proactive_pings_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_settings
    ADD CONSTRAINT proactive_settings_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_settings
    ADD CONSTRAINT proactive_settings_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_suggestions
    ADD CONSTRAINT proactive_suggestions_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_suggestions
    ADD CONSTRAINT proactive_suggestions_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_suggestions
    ADD CONSTRAINT proactive_suggestions_ping_id_proactive_pings_id_fk FOREIGN KEY (ping_id) REFERENCES public.proactive_pings(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.proactive_suggestions
    ADD CONSTRAINT proactive_suggestions_setting_id_proactive_settings_id_fk FOREIGN KEY (setting_id) REFERENCES public.proactive_settings(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_context_bindings
    ADD CONSTRAINT project_context_bindings_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_context_bindings
    ADD CONSTRAINT project_context_bindings_device_id_registered_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.registered_devices(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_context_bindings
    ADD CONSTRAINT project_context_bindings_project_id_resource_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.resource_projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connect_codes
    ADD CONSTRAINT recorder_connect_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_connections
    ADD CONSTRAINT recorder_connections_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.recorder_trajectory_bindings
    ADD CONSTRAINT recorder_trajectory_bindings_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_projects
    ADD CONSTRAINT resource_projects_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_projects
    ADD CONSTRAINT resource_projects_device_id_registered_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.registered_devices(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibilities
    ADD CONSTRAINT responsibilities_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibilities
    ADD CONSTRAINT responsibilities_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_events
    ADD CONSTRAINT responsibility_events_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_runs
    ADD CONSTRAINT responsibility_runs_event_id_responsibility_events_id_fk FOREIGN KEY (event_id) REFERENCES public.responsibility_events(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_runs
    ADD CONSTRAINT responsibility_runs_responsibility_id_responsibilities_id_fk FOREIGN KEY (responsibility_id) REFERENCES public.responsibilities(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_source_bindings
    ADD CONSTRAINT responsibility_source_bindings_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_source_bindings
    ADD CONSTRAINT responsibility_source_bindings_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_triggers
    ADD CONSTRAINT responsibility_triggers_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id);
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_triggers
    ADD CONSTRAINT responsibility_triggers_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.responsibility_triggers
    ADD CONSTRAINT responsibility_triggers_responsibility_id_responsibilities_id_f FOREIGN KEY (responsibility_id) REFERENCES public.responsibilities(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.role_generation_requests
    ADD CONSTRAINT role_generation_requests_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.role_templates
    ADD CONSTRAINT role_templates_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.role_write_receipts
    ADD CONSTRAINT role_write_receipts_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.routine_runs
    ADD CONSTRAINT routine_runs_routine_id_routines_id_fk FOREIGN KEY (routine_id) REFERENCES public.routines(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_goal_id_responsibilities_id_fk FOREIGN KEY (goal_id) REFERENCES public.responsibilities(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.saved_logins
    ADD CONSTRAINT saved_logins_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_group_members
    ADD CONSTRAINT scim_group_members_group_id_scim_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.scim_groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_group_members
    ADD CONSTRAINT scim_group_members_scim_user_id_scim_users_id_fk FOREIGN KEY (scim_user_id) REFERENCES public.scim_users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_identity_tombstones
    ADD CONSTRAINT scim_identity_tombstones_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_projection_grants
    ADD CONSTRAINT scim_projection_grants_scim_user_id_scim_users_id_fk FOREIGN KEY (scim_user_id) REFERENCES public.scim_users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_projection_grants
    ADD CONSTRAINT scim_projection_grants_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_subjects
    ADD CONSTRAINT scim_subjects_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.scim_users
    ADD CONSTRAINT scim_users_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approval_members
    ADD CONSTRAINT shared_use_approval_members_approval_fk FOREIGN KEY (tenant_id, agent_id, server_id) REFERENCES public.shared_use_approvals(tenant_id, agent_id, server_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approvals
    ADD CONSTRAINT shared_use_approvals_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_approvals
    ADD CONSTRAINT shared_use_approvals_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_requests
    ADD CONSTRAINT shared_use_requests_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shared_use_requests
    ADD CONSTRAINT shared_use_requests_server_id_mcp_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.sign_in_requests
    ADD CONSTRAINT sign_in_requests_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.skill_assets
    ADD CONSTRAINT skill_assets_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.skill_tools
    ADD CONSTRAINT skill_tools_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_package_id_deployment_packages_id_fk FOREIGN KEY (package_id) REFERENCES public.deployment_packages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.flow_source_resource_snapshots
    ADD CONSTRAINT source_resource_snapshot_original_start_fk FOREIGN KEY (tenant_id, operation_id, fingerprint) REFERENCES public.flow_source_public_operations(tenant_id, operation_id, fingerprint);
--> statement-breakpoint
ALTER TABLE ONLY public.sso_providers
    ADD CONSTRAINT sso_providers_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_archives
    ADD CONSTRAINT task_archives_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_assignments
    ADD CONSTRAINT team_bot_assignments_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_assignments
    ADD CONSTRAINT team_bot_assignments_assigned_by_users_id_fk FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_audience
    ADD CONSTRAINT team_bot_audience_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consent_defaults
    ADD CONSTRAINT team_bot_consent_defaults_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consents
    ADD CONSTRAINT team_bot_consents_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_consents
    ADD CONSTRAINT team_bot_consents_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_publications
    ADD CONSTRAINT team_bot_publications_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.team_bot_publications
    ADD CONSTRAINT team_bot_publications_published_by_users_id_fk FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_run_events
    ADD CONSTRAINT thread_run_events_thread_id_threads_id_fk FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_run_liveness
    ADD CONSTRAINT thread_run_liveness_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.thread_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.thread_runs
    ADD CONSTRAINT thread_runs_thread_id_threads_id_fk FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.update_routing_preferences
    ADD CONSTRAINT update_routing_preferences_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.user_instructions
    ADD CONSTRAINT user_instructions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flow_requests
    ADD CONSTRAINT waker_flow_requests_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id);
--> statement-breakpoint
ALTER TABLE ONLY public.waker_flow_versions
    ADD CONSTRAINT waker_flow_versions_flow_id_waker_flows_id_fk FOREIGN KEY (flow_id) REFERENCES public.waker_flows(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.waker_group_members
    ADD CONSTRAINT waker_group_members_group_id_waker_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.waker_groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.waker_group_upgrades
    ADD CONSTRAINT waker_group_upgrades_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.waker_groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_accounts
    ADD CONSTRAINT wechat_accounts_credential_id_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.credentials(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_accounts
    ADD CONSTRAINT wechat_accounts_last_agent_id_agents_id_fk FOREIGN KEY (last_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_accounts
    ADD CONSTRAINT wechat_accounts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_bind_attempts
    ADD CONSTRAINT wechat_bind_attempts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.wechat_prompts
    ADD CONSTRAINT wechat_prompts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.acp_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.action_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.action_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.agent_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.agent_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY agent_security_owner_delete ON public.agent_security_policies FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = agent_security_policies.tenant_id) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_owner_insert ON public.agent_security_policies FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = agent_security_policies.tenant_id) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_owner_select ON public.agent_security_policies FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = agent_security_policies.tenant_id) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_owner_update ON public.agent_security_policies FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = agent_security_policies.tenant_id) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL)))))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = agent_security_policies.tenant_id) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
ALTER TABLE public.agent_security_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.agent_security_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY agent_security_settings_owner_delete ON public.agent_security_settings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = agent_security_settings.tenant_id) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_owner_insert ON public.agent_security_settings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = agent_security_settings.tenant_id) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_owner_select ON public.agent_security_settings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = agent_security_settings.tenant_id) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_owner_update ON public.agent_security_settings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = agent_security_settings.tenant_id) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL)))))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = agent_security_settings.tenant_id) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_delete ON public.agent_security_settings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_insert ON public.agent_security_settings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_select ON public.agent_security_settings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_settings_team_bot_update ON public.agent_security_settings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL)))))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_settings.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_settings.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_delete ON public.agent_security_policies FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_insert ON public.agent_security_policies FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_select ON public.agent_security_policies FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY agent_security_team_bot_update ON public.agent_security_policies FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL)))))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agent_security_policies.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = agent_security_policies.tenant_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.app_access_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_candidates FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_operations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_original_activations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_original_projection_observations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_resource_snapshots FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_runtime_events FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_stop_operations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.flow_source_versions FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.task_events FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_delete ON public.waker_flow_versions FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_candidates FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_operations FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_original_activations FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_original_projection_observations FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_resource_snapshots FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_runtime_events FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_stop_operations FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.flow_source_versions FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.task_events FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY append_only_update ON public.waker_flow_versions FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE public.approval_continuation_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_continuations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_conversation_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_direct_execution_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_exact_input_captures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_exact_input_objects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_team_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.approval_team_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_firings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_triggers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.avatar_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.board_cards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bot_lifecycle ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bot_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.brokered_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.brokered_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.channel_agents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.channel_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.composio_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.computer_page_frame ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.computer_snapshot ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.computer_waits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY connector_stamp_insert ON public.mcp_servers AS RESTRICTIVE FOR INSERT WITH CHECK (((tenant_id = 'team'::text) OR (((current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text])) IS FALSE) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['team'::text, ''::text])))));
--> statement-breakpoint
CREATE POLICY connector_stamp_insert ON public.mcp_tools AS RESTRICTIVE FOR INSERT WITH CHECK (((tenant_id = 'team'::text) OR (((current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text])) IS FALSE) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['team'::text, ''::text])))));
--> statement-breakpoint
CREATE POLICY continuation_no_app_delete ON public.approval_continuations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY continuation_no_app_insert ON public.approval_continuations FOR INSERT WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY continuation_step_no_app_delete ON public.approval_continuation_steps FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY continuation_step_tenant_insert ON public.approval_continuation_steps FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY continuation_step_tenant_select ON public.approval_continuation_steps FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY continuation_step_tenant_update ON public.approval_continuation_steps FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY continuation_tenant_lock ON public.approval_continuations FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY continuation_tenant_select ON public.approval_continuations FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
ALTER TABLE public.credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.default_opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_inbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.demonstrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.device_pair_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employee_device_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employee_device_bindings_owner_delete ON public.employee_device_bindings FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY employee_device_bindings_owner_insert ON public.employee_device_bindings FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY employee_device_bindings_owner_select ON public.employee_device_bindings FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY employee_device_bindings_owner_update ON public.employee_device_bindings FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.employee_role_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_confirmations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_customization_heads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_customization_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_customization_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_import_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_official_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_run_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_run_retries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_share_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_share_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_inline_invocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_invocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_original_activations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_original_projection_observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_public_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_resource_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_runtime_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_stop_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.flow_source_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.generated_media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.group_bot_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.group_message_private ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.group_pipeline_start_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY group_pipeline_start_receipts_owner_delete ON public.group_pipeline_start_receipts FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY group_pipeline_start_receipts_owner_insert ON public.group_pipeline_start_receipts FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY group_pipeline_start_receipts_owner_select ON public.group_pipeline_start_receipts FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY group_pipeline_start_receipts_owner_update ON public.group_pipeline_start_receipts FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.group_task_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.group_task_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.heartbeat_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.identity_link_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.identity_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.intelligence_channel_mappings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.knowledge_binding_heads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_binding_owner_delete ON public.knowledge_bindings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_binding_owner_insert ON public.knowledge_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_bindings.notebook_id) AND (n.tenant_id = knowledge_bindings.tenant_id) AND (n.owner_user_id = knowledge_bindings.owner_user_id) AND (n.deleted_at IS NULL)))) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_bindings.agent_id) AND (a.tenant_id = knowledge_bindings.tenant_id) AND (p.tenant_id = a.tenant_id) AND (p.owner_user_id = knowledge_bindings.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_binding_owner_select ON public.knowledge_bindings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_binding_owner_update ON public.knowledge_bindings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_bindings.notebook_id) AND (n.tenant_id = knowledge_bindings.tenant_id) AND (n.owner_user_id = knowledge_bindings.owner_user_id) AND (n.deleted_at IS NULL)))) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_bindings.agent_id) AND (a.tenant_id = knowledge_bindings.tenant_id) AND (p.tenant_id = a.tenant_id) AND (p.owner_user_id = knowledge_bindings.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_binding_team_bot_insert ON public.knowledge_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_bindings.notebook_id) AND (n.tenant_id = knowledge_bindings.tenant_id) AND (n.owner_user_id = knowledge_bindings.owner_user_id) AND (n.deleted_at IS NULL)))) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_bindings.agent_id) AND (a.tenant_id = 'team'::text) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = knowledge_bindings.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_binding_team_bot_update ON public.knowledge_bindings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_bindings.notebook_id) AND (n.tenant_id = knowledge_bindings.tenant_id) AND (n.owner_user_id = knowledge_bindings.owner_user_id) AND (n.deleted_at IS NULL)))) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_bindings.agent_id) AND (a.tenant_id = 'team'::text) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = knowledge_bindings.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
ALTER TABLE public.knowledge_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.knowledge_directories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_directory_owner_delete ON public.knowledge_directories FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_directory_owner_insert ON public.knowledge_directories FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_directories.notebook_id) AND (n.tenant_id = knowledge_directories.tenant_id) AND (n.owner_user_id = knowledge_directories.owner_user_id) AND (n.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_directory_owner_select ON public.knowledge_directories FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_directory_owner_update ON public.knowledge_directories FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_directories.notebook_id) AND (n.tenant_id = knowledge_directories.tenant_id) AND (n.owner_user_id = knowledge_directories.owner_user_id) AND (n.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_head_owner_delete ON public.knowledge_binding_heads FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_head_owner_insert ON public.knowledge_binding_heads FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_binding_heads.agent_id) AND (a.tenant_id = knowledge_binding_heads.tenant_id) AND (p.tenant_id = a.tenant_id) AND (p.owner_user_id = knowledge_binding_heads.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_head_owner_select ON public.knowledge_binding_heads FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_head_owner_update ON public.knowledge_binding_heads FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_binding_heads.agent_id) AND (a.tenant_id = knowledge_binding_heads.tenant_id) AND (p.tenant_id = a.tenant_id) AND (p.owner_user_id = knowledge_binding_heads.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_head_team_bot_insert ON public.knowledge_binding_heads FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_binding_heads.agent_id) AND (a.tenant_id = 'team'::text) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = knowledge_binding_heads.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_head_team_bot_update ON public.knowledge_binding_heads FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = knowledge_binding_heads.agent_id) AND (a.tenant_id = 'team'::text) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = knowledge_binding_heads.owner_user_id) AND (p.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_notebook_owner_delete ON public.knowledge_notebooks FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_notebook_owner_insert ON public.knowledge_notebooks FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND true));
--> statement-breakpoint
CREATE POLICY knowledge_notebook_owner_select ON public.knowledge_notebooks FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_notebook_owner_update ON public.knowledge_notebooks FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND true));
--> statement-breakpoint
ALTER TABLE public.knowledge_notebooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_receipt_owner_delete ON public.knowledge_receipts FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_receipt_owner_insert ON public.knowledge_receipts FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND true));
--> statement-breakpoint
CREATE POLICY knowledge_receipt_owner_select ON public.knowledge_receipts FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_receipt_owner_update ON public.knowledge_receipts FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND true));
--> statement-breakpoint
ALTER TABLE public.knowledge_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_source_owner_delete ON public.knowledge_sources FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_source_owner_insert ON public.knowledge_sources FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_sources.notebook_id) AND (n.tenant_id = knowledge_sources.tenant_id) AND (n.owner_user_id = knowledge_sources.owner_user_id) AND (n.deleted_at IS NULL))))));
--> statement-breakpoint
CREATE POLICY knowledge_source_owner_select ON public.knowledge_sources FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_source_owner_update ON public.knowledge_sources FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.knowledge_notebooks n
  WHERE ((n.id = knowledge_sources.notebook_id) AND (n.tenant_id = knowledge_sources.tenant_id) AND (n.owner_user_id = knowledge_sources.owner_user_id) AND (n.deleted_at IS NULL))))));
--> statement-breakpoint
ALTER TABLE public.knowledge_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_write_claim_owner_delete ON public.knowledge_write_claims FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_write_claim_owner_insert ON public.knowledge_write_claims FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_write_claim_owner_select ON public.knowledge_write_claims FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_write_claim_owner_update ON public.knowledge_write_claims FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
ALTER TABLE public.knowledge_write_claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_write_execution_owner_delete ON public.knowledge_write_executions FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_write_execution_owner_insert ON public.knowledge_write_executions FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_write_execution_owner_select ON public.knowledge_write_executions FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY knowledge_write_execution_owner_update ON public.knowledge_write_executions FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
ALTER TABLE public.knowledge_write_executions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.learned_skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.learning_open_skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.learning_person_spaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.learning_skill_approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.learning_skill_sharing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.learning_thread_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.local_learning_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.local_learning_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.local_skill_candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_servers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_tools ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_user_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.memory_embeddings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.memory_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.model_token_calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY model_token_calls_owner_delete ON public.model_token_calls FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY model_token_calls_owner_insert ON public.model_token_calls FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY model_token_calls_owner_select ON public.model_token_calls FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY model_token_calls_owner_update ON public.model_token_calls FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.model_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_flow_head_insert ON public.flow_customization_heads AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR ((EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_customization_heads.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true))))) AND ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.flow_customization_sessions owned_session
  WHERE ((owned_session.id = flow_customization_heads.session_id) AND (owned_session.flow_id = flow_customization_heads.flow_id) AND (owned_session.tenant_id = current_setting('app.tenant_id'::text, true)))))))));
--> statement-breakpoint
CREATE POLICY own_flow_head_update ON public.flow_customization_heads AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR ((EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_customization_heads.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true))))) AND ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.flow_customization_sessions owned_session
  WHERE ((owned_session.id = flow_customization_heads.session_id) AND (owned_session.flow_id = flow_customization_heads.flow_id) AND (owned_session.tenant_id = current_setting('app.tenant_id'::text, true)))))))));
--> statement-breakpoint
CREATE POLICY own_flow_import_insert ON public.flow_share_imports AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (flow_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_share_imports.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_import_update ON public.flow_share_imports AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (flow_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_share_imports.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_run_insert ON public.flow_confirmations AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.group_task_runs owned_run
  WHERE ((owned_run.id = flow_confirmations.run_id) AND (owned_run.flow_id = flow_confirmations.flow_id) AND (owned_run.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_run_insert ON public.flow_run_events AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.group_task_runs owned_run
  WHERE ((owned_run.id = flow_run_events.run_id) AND (owned_run.flow_id = flow_run_events.flow_id) AND (owned_run.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_run_insert ON public.flow_run_retries AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.group_task_runs owned_run
  WHERE ((owned_run.id = flow_run_retries.source_run_id) AND (owned_run.flow_id = flow_run_retries.flow_id) AND (owned_run.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_session_insert ON public.flow_customization_sessions AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_customization_sessions.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_session_update ON public.flow_customization_sessions AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_customization_sessions.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_share_insert ON public.flow_share_links AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_share_links.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_turn_insert ON public.flow_customization_turns AS RESTRICTIVE FOR INSERT WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.flow_customization_sessions owned_session
  WHERE ((owned_session.id = flow_customization_turns.session_id) AND (owned_session.flow_id = flow_customization_turns.flow_id) AND (owned_session.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_flow_turn_update ON public.flow_customization_turns AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.flow_customization_sessions owned_session
  WHERE ((owned_session.id = flow_customization_turns.session_id) AND (owned_session.flow_id = flow_customization_turns.flow_id) AND (owned_session.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY own_parent_run_insert ON public.group_task_runs AS RESTRICTIVE FOR INSERT WITH CHECK (((parent_run_id IS NULL) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM public.group_task_runs parent_run
  WHERE ((parent_run.id = group_task_runs.parent_run_id) AND (parent_run.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
ALTER TABLE public.pending_authorizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.persona_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.personal_memories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_confirmations FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_customization_heads FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_customization_sessions FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_customization_turns FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_run_events FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_run_retries FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_share_imports FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_delete ON public.flow_share_links FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_confirmations FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_customization_heads FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_customization_sessions FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_customization_turns FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_run_events FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_run_retries FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_share_imports FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_insert ON public.flow_share_links FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_confirmations FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_customization_heads FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_customization_sessions FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_customization_turns FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_run_events FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_run_retries FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_share_imports FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.flow_share_links FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.project_context_bindings FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_select ON public.resource_projects FOR SELECT USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_confirmations FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_customization_heads FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_customization_sessions FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_customization_turns FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_run_events FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_run_retries FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_share_imports FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY platform_scope_update ON public.flow_share_links FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY plugin_assembly_origin_delete ON public.plugin_assembly_origins FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY plugin_assembly_origin_insert ON public.plugin_assembly_origins FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (publisher_user_id = tenant_id) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = plugin_assembly_origins.tenant_id) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY plugin_assembly_origin_select ON public.plugin_assembly_origins FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (source_tenant_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY plugin_assembly_origin_update ON public.plugin_assembly_origins FOR UPDATE USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE public.plugin_assembly_origins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plugin_assembly_publication_delete ON public.plugin_assembly_publications FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY plugin_assembly_publication_insert ON public.plugin_assembly_publications FOR INSERT WITH CHECK (((state = 'published'::text) AND (EXISTS ( SELECT 1
   FROM (public.plugin_assembly_origins o
     JOIN public.user_roles r ON (((r.user_id = o.publisher_user_id) AND (r.role = 'admin'::public.role))))
  WHERE ((o.id = plugin_assembly_publications.id) AND (o.tenant_id = current_setting('app.tenant_id'::text, true)) AND (o.publisher_user_id = o.tenant_id) AND (o.kind = plugin_assembly_publications.kind))))));
--> statement-breakpoint
CREATE POLICY plugin_assembly_publication_select ON public.plugin_assembly_publications FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY plugin_assembly_publication_update ON public.plugin_assembly_publications FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.plugin_assembly_origins o
  WHERE ((o.id = plugin_assembly_publications.id) AND ((o.tenant_id = current_setting('app.tenant_id'::text, true)) OR (o.source_tenant_id = current_setting('app.tenant_id'::text, true))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.plugin_assembly_origins o
  WHERE ((o.id = plugin_assembly_publications.id) AND ((o.tenant_id = current_setting('app.tenant_id'::text, true)) OR (o.source_tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
ALTER TABLE public.plugin_assembly_publications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.plugin_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.plugin_install_listings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.portrait_media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.portraits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.proactive_check_in_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.proactive_people ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.proactive_pings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.proactive_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY proactive_runs_owner_delete ON public.proactive_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY proactive_runs_owner_insert ON public.proactive_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY proactive_runs_owner_select ON public.proactive_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
CREATE POLICY proactive_runs_owner_update ON public.proactive_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id)));
--> statement-breakpoint
ALTER TABLE public.proactive_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.proactive_suggestions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY project_binding_owner_delete ON public.project_context_bindings FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY project_binding_owner_insert ON public.project_context_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = project_context_bindings.device_id) AND (d.tenant_id = project_context_bindings.tenant_id)))) AND (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = project_context_bindings.agent_id) AND ((a.tenant_id = project_context_bindings.tenant_id) OR (a.tenant_id = 'system'::text))))) AND (EXISTS ( SELECT 1
   FROM public.resource_projects p
  WHERE ((p.id = project_context_bindings.project_id) AND (p.tenant_id = project_context_bindings.tenant_id) AND (p.device_id = project_context_bindings.device_id) AND ((p.scope = 'public'::text) OR (p.agent_id = project_context_bindings.agent_id)))))));
--> statement-breakpoint
CREATE POLICY project_binding_owner_select ON public.project_context_bindings FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY project_binding_owner_update ON public.project_context_bindings FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = project_context_bindings.device_id) AND (d.tenant_id = project_context_bindings.tenant_id)))) AND (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = project_context_bindings.agent_id) AND ((a.tenant_id = project_context_bindings.tenant_id) OR (a.tenant_id = 'system'::text))))) AND (EXISTS ( SELECT 1
   FROM public.resource_projects p
  WHERE ((p.id = project_context_bindings.project_id) AND (p.tenant_id = project_context_bindings.tenant_id) AND (p.device_id = project_context_bindings.device_id) AND ((p.scope = 'public'::text) OR (p.agent_id = project_context_bindings.agent_id)))))));
--> statement-breakpoint
CREATE POLICY project_binding_team_bot_insert ON public.project_context_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = project_context_bindings.device_id) AND (d.tenant_id = project_context_bindings.tenant_id)))) AND (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = project_context_bindings.agent_id) AND (a.tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
           FROM public.agent_profiles q
          WHERE ((q.agent_id = a.id) AND (q.tenant_id = 'team'::text) AND (q.owner_user_id = project_context_bindings.tenant_id))))))) AND (EXISTS ( SELECT 1
   FROM public.resource_projects p
  WHERE ((p.id = project_context_bindings.project_id) AND (p.tenant_id = project_context_bindings.tenant_id) AND (p.device_id = project_context_bindings.device_id) AND ((p.scope = 'public'::text) OR (p.agent_id = project_context_bindings.agent_id)))))));
--> statement-breakpoint
CREATE POLICY project_binding_team_bot_update ON public.project_context_bindings FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = project_context_bindings.device_id) AND (d.tenant_id = project_context_bindings.tenant_id)))) AND (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = project_context_bindings.agent_id) AND (a.tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
           FROM public.agent_profiles q
          WHERE ((q.agent_id = a.id) AND (q.tenant_id = 'team'::text) AND (q.owner_user_id = project_context_bindings.tenant_id))))))) AND (EXISTS ( SELECT 1
   FROM public.resource_projects p
  WHERE ((p.id = project_context_bindings.project_id) AND (p.tenant_id = project_context_bindings.tenant_id) AND (p.device_id = project_context_bindings.device_id) AND ((p.scope = 'public'::text) OR (p.agent_id = project_context_bindings.agent_id)))))));
--> statement-breakpoint
ALTER TABLE public.project_context_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY project_owner_delete ON public.resource_projects FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY project_owner_insert ON public.resource_projects FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = resource_projects.device_id) AND (d.tenant_id = resource_projects.tenant_id)))) AND ((scope = 'public'::text) OR (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = resource_projects.agent_id) AND (a.tenant_id = resource_projects.tenant_id) AND (p.tenant_id = resource_projects.tenant_id) AND (p.owner_user_id = resource_projects.tenant_id) AND (p.deleted_at IS NULL)))))));
--> statement-breakpoint
CREATE POLICY project_owner_select ON public.resource_projects FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY project_owner_update ON public.resource_projects FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = resource_projects.device_id) AND (d.tenant_id = resource_projects.tenant_id)))) AND ((scope = 'public'::text) OR (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = resource_projects.agent_id) AND (a.tenant_id = resource_projects.tenant_id) AND (p.tenant_id = resource_projects.tenant_id) AND (p.owner_user_id = resource_projects.tenant_id) AND (p.deleted_at IS NULL)))))));
--> statement-breakpoint
CREATE POLICY project_team_bot_insert ON public.resource_projects FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = resource_projects.device_id) AND (d.tenant_id = resource_projects.tenant_id)))) AND ((scope = 'public'::text) OR (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = resource_projects.agent_id) AND (a.tenant_id = 'team'::text) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = resource_projects.tenant_id) AND (p.deleted_at IS NULL)))))));
--> statement-breakpoint
CREATE POLICY project_team_bot_update ON public.resource_projects FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.registered_devices d
  WHERE ((d.id = resource_projects.device_id) AND (d.tenant_id = resource_projects.tenant_id)))) AND ((scope = 'public'::text) OR (EXISTS ( SELECT 1
   FROM (public.agents a
     JOIN public.agent_profiles p ON ((p.agent_id = a.id)))
  WHERE ((a.id = resource_projects.agent_id) AND (a.tenant_id = 'team'::text) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = resource_projects.tenant_id) AND (p.deleted_at IS NULL)))))));
--> statement-breakpoint
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.recorder_connect_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.recorder_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.recorder_trajectory_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.registered_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.resource_projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.responsibilities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.responsibility_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.responsibility_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.responsibility_source_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.responsibility_triggers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY retained_delete ON public.flow_source_inline_invocations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY retained_delete ON public.flow_source_invocations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY retained_delete ON public.flow_source_public_operations FOR DELETE USING (false);
--> statement-breakpoint
CREATE POLICY retained_delete ON public.flow_source_runs FOR DELETE USING (false);
--> statement-breakpoint
ALTER TABLE public.role_generation_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY role_owner_scope_delete ON public.employee_role_snapshots FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_delete ON public.role_generation_requests FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_delete ON public.role_templates FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_delete ON public.role_write_receipts FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_insert ON public.employee_role_snapshots FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_insert ON public.role_generation_requests FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_insert ON public.role_templates FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_insert ON public.role_write_receipts FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_select ON public.employee_role_snapshots FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_select ON public.role_generation_requests FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_select ON public.role_templates FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_select ON public.role_write_receipts FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_update ON public.employee_role_snapshots FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_update ON public.role_generation_requests FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_update ON public.role_templates FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
CREATE POLICY role_owner_scope_update ON public.role_write_receipts FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (owner_user_id = tenant_id) AND (tenant_id <> ALL (ARRAY['system'::text, 'platform'::text]))));
--> statement-breakpoint
ALTER TABLE public.role_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.role_write_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.routine_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.routines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.runner_device_connection_leases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY runner_device_connection_leases_owner_delete ON public.runner_device_connection_leases FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY runner_device_connection_leases_owner_insert ON public.runner_device_connection_leases FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY runner_device_connection_leases_owner_select ON public.runner_device_connection_leases FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY runner_device_connection_leases_owner_update ON public.runner_device_connection_leases FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.sandboxed_components ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_logins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_egress_fences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY security_egress_fences_tenant_delete ON public.security_egress_fences FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY security_egress_fences_tenant_insert ON public.security_egress_fences FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY security_egress_fences_tenant_select ON public.security_egress_fences FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY security_egress_fences_tenant_update ON public.security_egress_fences FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.security_egress_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY security_egress_outbox_tenant_delete ON public.security_egress_outbox FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY security_egress_outbox_tenant_insert ON public.security_egress_outbox FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY security_egress_outbox_tenant_select ON public.security_egress_outbox FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY security_egress_outbox_tenant_update ON public.security_egress_outbox FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY share_delete ON public.flow_share_links FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY share_insert ON public.flow_share_links FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY share_select ON public.flow_share_links FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (token_hash = current_setting('app.flow_share_token'::text, true))));
--> statement-breakpoint
CREATE POLICY share_update ON public.flow_share_links FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (token_hash = current_setting('app.flow_share_token'::text, true)))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (token_hash = current_setting('app.flow_share_token'::text, true))));
--> statement-breakpoint
ALTER TABLE public.shared_use_approval_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.shared_use_approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.shared_use_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sign_in_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.skill_assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.skill_tools ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY source_resource_insert ON public.flow_source_resource_snapshots FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.tasks task
  WHERE ((task.id = flow_source_resource_snapshots.task_id) AND (task.tenant_id = flow_source_resource_snapshots.tenant_id) AND (task.run_ref = (flow_source_resource_snapshots.run_id)::text) AND (task.status = 'running'::public.task_status)))) AND (EXISTS ( SELECT 1
   FROM public.flow_source_public_operations op
  WHERE ((op.tenant_id = flow_source_resource_snapshots.tenant_id) AND (op.operation_id = flow_source_resource_snapshots.operation_id) AND (op.fingerprint = flow_source_resource_snapshots.fingerprint) AND (op.kind = 'start'::text) AND (op.state = 'dispatched'::text))))));
--> statement-breakpoint
CREATE POLICY source_resource_select ON public.flow_source_resource_snapshots FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.staffing_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stamp_names_person_insert ON public.channel_memberships AS RESTRICTIVE FOR INSERT WITH CHECK (((user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = channel_memberships.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_insert ON public.group_bot_threads AS RESTRICTIVE FOR INSERT WITH CHECK (((owner_user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = group_bot_threads.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_insert ON public.group_message_private AS RESTRICTIVE FOR INSERT WITH CHECK (((owner_user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = group_message_private.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_insert ON public.group_messages AS RESTRICTIVE FOR INSERT WITH CHECK (((owner_user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = group_messages.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_insert ON public.intelligence_channel_mappings AS RESTRICTIVE FOR INSERT WITH CHECK (((user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = intelligence_channel_mappings.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_update ON public.channel_memberships AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = channel_memberships.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_update ON public.group_bot_threads AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((owner_user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = group_bot_threads.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_update ON public.group_message_private AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((owner_user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = group_message_private.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_update ON public.group_messages AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((owner_user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = group_messages.tenant_id))))));
--> statement-breakpoint
CREATE POLICY stamp_names_person_update ON public.intelligence_channel_mappings AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((user_id = tenant_id) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR (NOT (EXISTS ( SELECT 1
   FROM public.users u
  WHERE (u.id = intelligence_channel_mappings.tenant_id))))));
--> statement-breakpoint
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_archives ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_briefings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.team_bot_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.team_bot_audience ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.team_bot_consent_defaults ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.team_bot_consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.team_bot_publications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.agent_profiles AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.agents AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.approval_team_rules AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.approval_team_settings AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.channel_agents AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.channel_memberships AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.channels AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.credentials AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.group_bot_threads AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.group_message_private AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.group_messages AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.mcp_servers AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.mcp_tools AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.plugin_grants AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.sandboxed_components AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.team_bot_assignments AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.team_bot_audience AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_delete ON public.team_bot_publications AS RESTRICTIVE FOR DELETE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.agent_profiles AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.agents AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.approval_team_rules AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.approval_team_settings AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.channel_agents AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.channel_memberships AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.channels AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.credentials AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.group_bot_threads AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.group_message_private AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.group_messages AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.mcp_servers AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.mcp_tools AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.plugin_grants AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.sandboxed_components AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.team_bot_assignments AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.team_bot_audience AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_insert ON public.team_bot_publications AS RESTRICTIVE FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.agent_profiles AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.agents AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.approval_team_rules AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.approval_team_settings AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.channel_agents AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.channel_memberships AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.channels AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.credentials AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.group_bot_threads AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.group_message_private AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.group_messages AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.mcp_servers AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.mcp_tools AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.plugin_grants AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.sandboxed_components AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.team_bot_assignments AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.team_bot_audience AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_select ON public.team_bot_publications AS RESTRICTIVE FOR SELECT USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.agent_profiles AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.agents AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.approval_team_rules AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.approval_team_settings AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.channel_agents AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.channel_memberships AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.channels AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.credentials AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.group_bot_threads AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.group_message_private AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.group_messages AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.mcp_servers AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.mcp_tools AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.plugin_grants AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.sandboxed_components AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.team_bot_assignments AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.team_bot_audience AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_frame_refused_update ON public.team_bot_publications AS RESTRICTIVE FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) IS DISTINCT FROM 'team'::text));
--> statement-breakpoint
CREATE POLICY team_read ON public.agent_profiles FOR SELECT USING (((tenant_id = 'team'::text) AND (((owner_user_id = current_setting('app.tenant_id'::text, true)) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text]))) OR public.xiongbao_team_bot_visible(agent_id))));
--> statement-breakpoint
CREATE POLICY team_read ON public.agents FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_bot_visible(id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.approval_team_rules FOR SELECT USING (((tenant_id = 'team'::text) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text]))));
--> statement-breakpoint
CREATE POLICY team_read ON public.approval_team_settings FOR SELECT USING (((tenant_id = 'team'::text) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text]))));
--> statement-breakpoint
CREATE POLICY team_read ON public.channel_agents FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.channel_memberships FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.channels FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.credentials FOR SELECT USING (((tenant_id = 'team'::text) AND ((kind)::text = ANY (ARRAY['mcp'::text, 'mcp_oauth_client'::text])) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_read ON public.group_bot_threads FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.group_messages FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.mcp_servers FOR SELECT USING (((tenant_id = 'team'::text) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text]))));
--> statement-breakpoint
CREATE POLICY team_read ON public.mcp_tools FOR SELECT USING (((tenant_id = 'team'::text) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text]))));
--> statement-breakpoint
CREATE POLICY team_read ON public.plugin_grants FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_bot_visible(agent_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.sandboxed_components FOR SELECT USING (((tenant_id = 'team'::text) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text])) AND (published OR ((current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))))));
--> statement-breakpoint
CREATE POLICY team_read ON public.team_bot_assignments FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_bot_visible(agent_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.team_bot_audience FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_bot_visible(agent_id)));
--> statement-breakpoint
CREATE POLICY team_read ON public.team_bot_publications FOR SELECT USING (((tenant_id = 'team'::text) AND public.xiongbao_team_bot_visible(agent_id)));
--> statement-breakpoint
CREATE POLICY team_roster_stamp_insert ON public.team_bot_assignments AS RESTRICTIVE FOR INSERT WITH CHECK (((tenant_id = 'team'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY team_roster_stamp_insert ON public.team_bot_audience AS RESTRICTIVE FOR INSERT WITH CHECK (((tenant_id = 'team'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY team_roster_stamp_insert ON public.team_bot_publications AS RESTRICTIVE FOR INSERT WITH CHECK (((tenant_id = 'team'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.approval_team_rules FOR DELETE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.approval_team_settings FOR DELETE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.channel_agents FOR DELETE USING (((tenant_id = 'team'::text) AND (public.xiongbao_team_channel_creator(channel_id) OR (public.xiongbao_team_channel_member(channel_id) AND (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = channel_agents.agent_id) AND (a.tenant_id = current_setting('app.tenant_id'::text, true)) AND ((a.type)::text = 'device_acp'::text))))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.channel_memberships FOR DELETE USING (((tenant_id = 'team'::text) AND ((user_id = current_setting('app.tenant_id'::text, true)) OR public.xiongbao_team_channel_creator(channel_id))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.channels FOR DELETE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_creator(id)));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.credentials FOR DELETE USING (((tenant_id = 'team'::text) AND ((kind)::text = ANY (ARRAY['mcp'::text, 'mcp_oauth_client'::text])) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.group_bot_threads FOR DELETE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.group_messages FOR DELETE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.mcp_servers FOR DELETE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.mcp_tools FOR DELETE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.plugin_grants FOR DELETE USING (((tenant_id = 'team'::text) AND ((EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = plugin_grants.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))) OR ((current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.sandboxed_components FOR DELETE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.team_bot_assignments FOR DELETE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.team_bot_audience FOR DELETE USING (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_audience.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY team_write_delete ON public.team_bot_publications FOR DELETE USING (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_publications.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.approval_team_rules FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.approval_team_settings FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.channel_agents FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (public.xiongbao_team_bot_visible(agent_id) OR (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = channel_agents.agent_id) AND (a.tenant_id = ANY (ARRAY[current_setting('app.tenant_id'::text, true), 'system'::text]))))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.channel_memberships FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (public.xiongbao_team_channel_member(channel_id) OR ((user_id = current_setting('app.tenant_id'::text, true)) AND public.xiongbao_team_channel_seedable(channel_id)))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.channels FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (created_by = current_setting('app.tenant_id'::text, true)) AND (current_setting('app.tenant_id'::text, true) <> ALL (ARRAY['system'::text, 'platform'::text, 'team'::text, ''::text]))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.credentials FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND ((kind)::text = ANY (ARRAY['mcp'::text, 'mcp_oauth_client'::text])) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.group_bot_threads FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.group_messages FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.mcp_servers FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.mcp_tools FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.plugin_grants FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND ((EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = plugin_grants.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))) OR ((current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.sandboxed_components FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.team_bot_assignments FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.team_bot_audience FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_audience.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY team_write_insert ON public.team_bot_publications FOR INSERT WITH CHECK (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_publications.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.agent_profiles FOR UPDATE USING (((tenant_id = 'team'::text) AND (owner_user_id = current_setting('app.tenant_id'::text, true)))) WITH CHECK (((tenant_id = 'team'::text) AND (owner_user_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = agent_profiles.agent_id) AND (a.tenant_id = ANY (ARRAY[current_setting('app.tenant_id'::text, true), 'team'::text])))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.agents FOR UPDATE USING (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agents.id) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))))) WITH CHECK (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = agents.id) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)) AND (p.tenant_id = 'team'::text))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.approval_team_rules FOR UPDATE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.approval_team_settings FOR UPDATE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.channel_agents FOR UPDATE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id))) WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (public.xiongbao_team_bot_visible(agent_id) OR (EXISTS ( SELECT 1
   FROM public.agents a
  WHERE ((a.id = channel_agents.agent_id) AND (a.tenant_id = ANY (ARRAY[current_setting('app.tenant_id'::text, true), 'system'::text]))))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.channel_memberships FOR UPDATE USING (((tenant_id = 'team'::text) AND (user_id = current_setting('app.tenant_id'::text, true)))) WITH CHECK (((tenant_id = 'team'::text) AND (user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.channels FOR UPDATE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(id))) WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(id)));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.credentials FOR UPDATE USING (((tenant_id = 'team'::text) AND ((kind)::text = ANY (ARRAY['mcp'::text, 'mcp_oauth_client'::text])) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND ((kind)::text = ANY (ARRAY['mcp'::text, 'mcp_oauth_client'::text])) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.group_bot_threads FOR UPDATE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true)))) WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.group_messages FOR UPDATE USING (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true)))) WITH CHECK (((tenant_id = 'team'::text) AND public.xiongbao_team_channel_member(channel_id) AND (owner_user_id = current_setting('app.tenant_id'::text, true))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.mcp_servers FOR UPDATE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.mcp_tools FOR UPDATE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.plugin_grants FOR UPDATE USING (((tenant_id = 'team'::text) AND ((EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = plugin_grants.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))) OR ((current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))))) WITH CHECK (((tenant_id = 'team'::text) AND ((EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = plugin_grants.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))) OR ((current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.sandboxed_components FOR UPDATE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.team_bot_assignments FOR UPDATE USING (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role)))))) WITH CHECK (((tenant_id = 'team'::text) AND (current_setting('app.capability'::text, true) = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles r
  WHERE ((r.user_id = current_setting('app.tenant_id'::text, true)) AND (r.role = 'admin'::public.role))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.team_bot_audience FOR UPDATE USING (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_audience.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))))) WITH CHECK (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_audience.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY team_write_update ON public.team_bot_publications FOR UPDATE USING (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_publications.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true))))))) WITH CHECK (((tenant_id = 'team'::text) AND (EXISTS ( SELECT 1
   FROM public.agent_profiles p
  WHERE ((p.agent_id = team_bot_publications.agent_id) AND (p.tenant_id = 'team'::text) AND (p.owner_user_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.acp_turns FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.action_policy FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.action_records FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.agent_preferences FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.agent_profiles FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.agents FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.app_access_requests FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.approval_conversation_grants FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.approval_preferences FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.approval_requests FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.approval_rules FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.approval_team_rules FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.approval_team_settings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.attachments FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.audit_events FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.automation_firings FOR SELECT USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.automation_triggers FOR SELECT USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.automations FOR SELECT USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.avatar_sources FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.board_cards FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.bot_lifecycle FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.bot_tasks FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.brokered_accounts FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.brokered_identities FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.channel_agents FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.channel_memberships FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.channels FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.composio_connections FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.computer_page_frame FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.computer_snapshot FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.computer_waits FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.credentials FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.default_opt_outs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.delivery_bindings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.delivery_challenges FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.delivery_inbox FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.delivery_outbox FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.demonstrations FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.device_pair_codes FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.generated_media FOR SELECT USING (((current_setting('app.tenant_id'::text, true) = 'platform'::text) OR ((channel_id IS NULL) AND (tenant_id = current_setting('app.tenant_id'::text, true))) OR ((channel_id IS NOT NULL) AND public.xiongbao_team_channel_member(channel_id))));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.group_bot_threads FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.group_message_private FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.group_messages FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.group_task_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.group_task_templates FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.heartbeat_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.identity_link_challenges FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.identity_links FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.intelligence_channel_mappings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.learned_skills FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.learning_open_skills FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.learning_person_spaces FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.learning_skill_approvals FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.learning_skill_sharing FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.learning_thread_bindings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.local_learning_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.local_learning_state FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.local_skill_candidates FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.mcp_servers FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.mcp_tools FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.mcp_user_credentials FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.memory_embeddings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.memory_sources FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.model_registry FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.model_usage FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.pending_authorizations FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.persona_templates FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.personal_memories FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.plugin_grants FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.plugin_install_listings FOR SELECT USING ((tenant_id = 'system'::text));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.portrait_media FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.portraits FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.proactive_check_in_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.proactive_people FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.proactive_pings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.proactive_settings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.proactive_suggestions FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.push_devices FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.recorder_connect_codes FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.recorder_connections FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.recorder_trajectory_bindings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.registered_devices FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.responsibilities FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.responsibility_events FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.responsibility_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.responsibility_source_bindings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.responsibility_triggers FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.routine_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.routines FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sandboxed_components FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.saved_logins FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.shared_use_approval_members FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.shared_use_approvals FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.shared_use_requests FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sign_in_requests FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.skill_assets FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.skill_tools FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.skills FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.staffing_proposals FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscriptions FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.task_archives FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.task_briefings FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.task_events FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tasks FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.team_bot_assignments FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.team_bot_audience FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.team_bot_consent_defaults FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.team_bot_consents FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.team_bot_publications FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.thread_compactions FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.thread_context_breakdowns FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.thread_run_events FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.thread_run_liveness FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.thread_runs FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.threads FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.update_routing_preferences FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.usage_counters FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.voice_sessions FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.waker_flow_requests FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.waker_flow_versions FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.waker_flows FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.waker_group_members FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.waker_groups g
  WHERE ((g.id = waker_group_members.group_id) AND ((g.tenant_id = current_setting('app.tenant_id'::text, true)) OR (g.tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.waker_group_upgrades FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.waker_groups FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.wechat_accounts FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.wechat_bind_attempts FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.wechat_prompts FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.work_items FOR SELECT USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (tenant_id = 'system'::text) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.acp_turns FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.action_policy FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.action_records FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.agent_preferences FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.agent_profiles FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.agents FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.app_access_requests FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.approval_conversation_grants FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.approval_preferences FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.approval_requests FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.approval_rules FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.approval_team_rules FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.approval_team_settings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.attachments FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.audit_events FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.automation_firings FOR DELETE USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.automation_triggers FOR DELETE USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.automations FOR DELETE USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.avatar_sources FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.board_cards FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.bot_lifecycle FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.bot_tasks FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.brokered_accounts FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.brokered_identities FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.channel_agents FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.channel_memberships FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.channels FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.composio_connections FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.computer_page_frame FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.computer_snapshot FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.computer_waits FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.credentials FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.default_opt_outs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.delivery_bindings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.delivery_challenges FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.delivery_inbox FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.delivery_outbox FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.demonstrations FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.device_pair_codes FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.generated_media FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.group_bot_threads FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.group_message_private FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.group_messages FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.group_task_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.group_task_templates FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.heartbeat_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.identity_link_challenges FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.identity_links FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.intelligence_channel_mappings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.learned_skills FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.learning_open_skills FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.learning_person_spaces FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.learning_skill_approvals FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.learning_skill_sharing FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.learning_thread_bindings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.local_learning_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.local_learning_state FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.local_skill_candidates FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.mcp_servers FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.mcp_tools FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.mcp_user_credentials FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.memory_embeddings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.memory_sources FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.model_registry FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.model_usage FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.pending_authorizations FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.persona_templates FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.personal_memories FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.plugin_grants FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.plugin_install_listings FOR DELETE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.portrait_media FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.portraits FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.proactive_check_in_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.proactive_people FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.proactive_pings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.proactive_settings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.proactive_suggestions FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.push_devices FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.recorder_connect_codes FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.recorder_connections FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.recorder_trajectory_bindings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.registered_devices FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.responsibilities FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.responsibility_events FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.responsibility_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.responsibility_source_bindings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.responsibility_triggers FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.routine_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.routines FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.sandboxed_components FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.saved_logins FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.shared_use_approval_members FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.shared_use_approvals FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.shared_use_requests FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.sign_in_requests FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.skill_assets FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.skill_tools FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.skills FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.staffing_proposals FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.subscriptions FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.task_archives FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.task_briefings FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.tasks FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.team_bot_assignments FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.team_bot_audience FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.team_bot_consent_defaults FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.team_bot_consents FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.team_bot_publications FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.thread_compactions FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.thread_context_breakdowns FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.thread_run_events FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.thread_run_liveness FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.thread_runs FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.threads FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.update_routing_preferences FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.usage_counters FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.voice_sessions FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.waker_flow_requests FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.waker_flows FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.waker_group_members FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.waker_groups g
  WHERE ((g.id = waker_group_members.group_id) AND ((g.tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.waker_group_upgrades FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.waker_groups FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.wechat_accounts FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.wechat_bind_attempts FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.wechat_prompts FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_delete ON public.work_items FOR DELETE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.acp_turns FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.action_policy FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.action_records FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.agent_preferences FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.agent_profiles FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.agents FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.app_access_requests FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.approval_conversation_grants FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.approval_preferences FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.approval_requests FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.approval_rules FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.approval_team_rules FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.approval_team_settings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.attachments FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.audit_events FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.automation_firings FOR INSERT WITH CHECK (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)) AND (EXISTS ( SELECT 1
   FROM public.automation_triggers t
  WHERE ((t.id = automation_firings.trigger_id) AND (t.automation_id = automation_firings.automation_id) AND (t.tenant_id = automation_firings.tenant_id))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.automation_triggers FOR INSERT WITH CHECK (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)) AND (EXISTS ( SELECT 1
   FROM public.automations a
  WHERE ((a.id = automation_triggers.automation_id) AND (a.tenant_id = automation_triggers.tenant_id))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.automations FOR INSERT WITH CHECK (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.avatar_sources FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.board_cards FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.bot_lifecycle FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.bot_tasks FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.brokered_accounts FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.brokered_identities FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.channel_agents FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.channel_memberships FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.channels FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.composio_connections FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.computer_page_frame FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.computer_snapshot FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.computer_waits FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.credentials FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.default_opt_outs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.delivery_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.delivery_challenges FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.delivery_inbox FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.delivery_outbox FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.demonstrations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.device_pair_codes FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.generated_media FOR INSERT WITH CHECK ((((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)) AND ((channel_id IS NULL) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text) OR public.xiongbao_team_channel_member(channel_id))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.group_bot_threads FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.group_message_private FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.group_messages FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.group_task_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.group_task_templates FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.heartbeat_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.identity_link_challenges FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.identity_links FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.intelligence_channel_mappings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.learned_skills FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.learning_open_skills FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.learning_person_spaces FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.learning_skill_approvals FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.learning_skill_sharing FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.learning_thread_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.local_learning_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.local_learning_state FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.local_skill_candidates FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.mcp_servers FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.mcp_tools FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.mcp_user_credentials FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.memory_embeddings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.memory_sources FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.model_registry FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.model_usage FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.pending_authorizations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.persona_templates FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.personal_memories FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.plugin_grants FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.plugin_install_listings FOR INSERT WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.portrait_media FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.portraits FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.proactive_check_in_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.proactive_people FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.proactive_pings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.proactive_settings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.proactive_suggestions FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.push_devices FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.recorder_connect_codes FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.recorder_connections FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.recorder_trajectory_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.registered_devices FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.responsibilities FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.responsibility_events FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.responsibility_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.responsibility_source_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.responsibility_triggers FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.routine_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.routines FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.sandboxed_components FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.saved_logins FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.shared_use_approval_members FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.shared_use_approvals FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.shared_use_requests FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.sign_in_requests FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.skill_assets FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.skill_tools FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.skills FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.staffing_proposals FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.subscriptions FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.task_archives FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.task_briefings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.task_events FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.tasks FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.team_bot_assignments FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.team_bot_audience FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.team_bot_consent_defaults FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.team_bot_consents FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.team_bot_publications FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.thread_compactions FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.thread_context_breakdowns FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.thread_run_events FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.thread_run_liveness FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.thread_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.threads FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.update_routing_preferences FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.usage_counters FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.voice_sessions FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.waker_flow_requests FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.waker_flow_versions FOR INSERT WITH CHECK ((((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = waker_flow_versions.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.waker_flows FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.waker_group_members FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.waker_groups g
  WHERE ((g.id = waker_group_members.group_id) AND ((g.tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.waker_group_upgrades FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.waker_groups FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.wechat_accounts FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.wechat_bind_attempts FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.wechat_prompts FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_insert ON public.work_items FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.acp_turns FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.action_policy FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.action_records FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.agent_preferences FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.agent_profiles FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.agents FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.app_access_requests FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.approval_conversation_grants FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.approval_preferences FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.approval_requests FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.approval_rules FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.approval_team_rules FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.approval_team_settings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.attachments FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.audit_events FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.automation_firings FOR UPDATE USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)))) WITH CHECK (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)) AND (EXISTS ( SELECT 1
   FROM public.automation_triggers t
  WHERE ((t.id = automation_firings.trigger_id) AND (t.automation_id = automation_firings.automation_id) AND (t.tenant_id = automation_firings.tenant_id))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.automation_triggers FOR UPDATE USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)))) WITH CHECK (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)) AND (EXISTS ( SELECT 1
   FROM public.automations a
  WHERE ((a.id = automation_triggers.automation_id) AND (a.tenant_id = automation_triggers.tenant_id))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.automations FOR UPDATE USING (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)))) WITH CHECK (((tenant_id <> ALL (ARRAY['system'::text, 'platform'::text])) AND ((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.avatar_sources FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.board_cards FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.bot_lifecycle FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.bot_tasks FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.brokered_accounts FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.brokered_identities FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.channel_agents FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.channel_memberships FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.channels FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.composio_connections FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.computer_page_frame FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.computer_snapshot FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.computer_waits FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.credentials FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.default_opt_outs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.delivery_bindings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.delivery_challenges FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.delivery_inbox FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.delivery_outbox FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.demonstrations FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.device_pair_codes FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.generated_media FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.group_bot_threads FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.group_message_private FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.group_messages FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.group_task_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.group_task_templates FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.heartbeat_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.identity_link_challenges FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.identity_links FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.intelligence_channel_mappings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.learned_skills FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.learning_open_skills FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.learning_person_spaces FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.learning_skill_approvals FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.learning_skill_sharing FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.learning_thread_bindings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.local_learning_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.local_learning_state FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.local_skill_candidates FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.mcp_servers FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.mcp_tools FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.mcp_user_credentials FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.memory_embeddings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.memory_sources FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.model_registry FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.model_usage FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.pending_authorizations FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.persona_templates FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.personal_memories FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.plugin_grants FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.plugin_install_listings FOR UPDATE USING ((current_setting('app.tenant_id'::text, true) = 'platform'::text)) WITH CHECK ((current_setting('app.tenant_id'::text, true) = 'platform'::text));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.portrait_media FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.portraits FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.proactive_check_in_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.proactive_people FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.proactive_pings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.proactive_settings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.proactive_suggestions FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.push_devices FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.recorder_connect_codes FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.recorder_connections FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.recorder_trajectory_bindings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.registered_devices FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.responsibilities FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.responsibility_events FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.responsibility_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.responsibility_source_bindings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.responsibility_triggers FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.routine_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.routines FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.sandboxed_components FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.saved_logins FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.shared_use_approval_members FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.shared_use_approvals FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.shared_use_requests FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.sign_in_requests FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.skill_assets FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.skill_tools FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.skills FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.staffing_proposals FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.subscriptions FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.task_archives FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.task_briefings FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.tasks FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.team_bot_assignments FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.team_bot_audience FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.team_bot_consent_defaults FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.team_bot_consents FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.team_bot_publications FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.thread_compactions FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.thread_context_breakdowns FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.thread_run_events FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.thread_run_liveness FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.thread_runs FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.threads FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.update_routing_preferences FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.usage_counters FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.voice_sessions FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.waker_flow_requests FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.waker_flows FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.waker_group_members FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.waker_groups g
  WHERE ((g.id = waker_group_members.group_id) AND ((g.tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.waker_groups g
  WHERE ((g.id = waker_group_members.group_id) AND ((g.tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))))));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.waker_group_upgrades FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.waker_groups FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.wechat_accounts FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.wechat_bind_attempts FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.wechat_prompts FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_isolation_update ON public.work_items FOR UPDATE USING (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) OR (current_setting('app.tenant_id'::text, true) = 'platform'::text)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_confirmations FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_customization_heads FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_customization_sessions FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_customization_turns FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_import_proposals FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_official_bindings FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_run_events FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_run_retries FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_delete ON public.flow_share_imports FOR DELETE USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_confirmations FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_customization_heads FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_customization_sessions FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_customization_turns FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_import_proposals FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_official_bindings FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_official_bindings.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_run_events FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_run_retries FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_share_imports FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_candidates FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows f
  WHERE ((f.id = flow_source_candidates.flow_id) AND (f.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_inline_invocations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM (public.flow_source_runs r
     JOIN public.flow_source_invocations p ON (((p.run_id = r.id) AND (p.tenant_id = r.tenant_id))))
  WHERE ((r.id = flow_source_inline_invocations.run_id) AND (r.tenant_id = current_setting('app.tenant_id'::text, true)) AND r.admission_open AND (r.state = 'running'::text) AND (r.owner_epoch = ((flow_source_inline_invocations.identity ->> 'ownerEpoch'::text))::integer) AND (r.revision = ((flow_source_inline_invocations.identity ->> 'runRevision'::text))::integer) AND ((r.version_id)::text = (flow_source_inline_invocations.identity ->> 'versionId'::text)) AND ((r.flow_id)::text = (flow_source_inline_invocations.identity ->> 'flowId'::text)) AND ((r.task_id)::text = (flow_source_inline_invocations.identity ->> 'taskId'::text)) AND (r.agent_id = (flow_source_inline_invocations.identity ->> 'agentId'::text)) AND (r.thread_id = (flow_source_inline_invocations.identity ->> 'threadId'::text)) AND (r.source_digest = (flow_source_inline_invocations.identity ->> 'sourceDigest'::text)) AND (p.id = flow_source_inline_invocations.parent_invocation_id) AND (p.state = 'dispatched'::text) AND ((p.identity ->> 'primitive'::text) = 'action'::text))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_invocations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.flow_source_runs r
  WHERE ((r.id = flow_source_invocations.run_id) AND (r.tenant_id = current_setting('app.tenant_id'::text, true)) AND r.admission_open AND (r.state = 'running'::text) AND (r.owner_epoch = ((flow_source_invocations.identity ->> 'ownerEpoch'::text))::integer) AND (r.revision = ((flow_source_invocations.identity ->> 'runRevision'::text))::integer) AND (r.source_digest = ((flow_source_invocations.identity -> 'original'::text) ->> 'scriptDigest'::text)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_operations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows f
  WHERE ((f.id = flow_source_operations.flow_id) AND (f.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_original_activations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.flow_source_runs r
  WHERE ((r.tenant_id = current_setting('app.tenant_id'::text, true)) AND (r.id = flow_source_original_activations.run_id) AND (r.flow_id = flow_source_original_activations.flow_id) AND (r.task_id = flow_source_original_activations.task_id) AND (r.thread_id = flow_source_original_activations.thread_id) AND (r.agent_id = flow_source_original_activations.agent_id) AND (r.version_id = flow_source_original_activations.version_id) AND (r.source_digest = flow_source_original_activations.source_digest) AND (r.definition_revision = flow_source_original_activations.definition_revision) AND (r.public_operation_id = flow_source_original_activations.operation_id) AND (r.public_operation_fingerprint = flow_source_original_activations.fingerprint) AND (r.handle_id = flow_source_original_activations.handle_id) AND (r.state = 'running'::text) AND r.admission_open AND (r.execution_epoch = flow_source_original_activations.execution_epoch) AND (r.owner_epoch = flow_source_original_activations.activation_owner_epoch) AND (r.revision = flow_source_original_activations.activation_run_revision))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_original_projection_observations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.flow_source_runs r
  WHERE ((r.tenant_id = current_setting('app.tenant_id'::text, true)) AND (r.id = flow_source_original_projection_observations.run_id))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_public_operations FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows f
  WHERE ((f.id = flow_source_public_operations.flow_id) AND (f.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_runs FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.tasks card
  WHERE ((card.id = flow_source_runs.task_id) AND (card.tenant_id = current_setting('app.tenant_id'::text, true)) AND (card.run_ref = (flow_source_runs.id)::text) AND (card.executor_agent_id = flow_source_runs.agent_id)))) AND (EXISTS ( SELECT 1
   FROM public.flow_source_versions v
  WHERE ((v.id = flow_source_runs.version_id) AND (v.flow_id = flow_source_runs.flow_id) AND (v.tenant_id = current_setting('app.tenant_id'::text, true)) AND (v.source_digest = flow_source_runs.source_digest))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_runtime_events FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_stop_operations FOR INSERT WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_insert ON public.flow_source_versions FOR INSERT WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows f
  WHERE ((f.id = flow_source_versions.flow_id) AND (f.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_confirmations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_customization_heads FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_customization_sessions FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_customization_turns FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_import_proposals FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_official_bindings FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_run_events FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_run_retries FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_share_imports FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_candidates FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_inline_invocations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_invocations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_operations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_original_activations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_original_projection_observations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_public_operations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_runs FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_runtime_events FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_stop_operations FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_select ON public.flow_source_versions FOR SELECT USING ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_confirmations FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_customization_heads FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_customization_sessions FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_customization_turns FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_import_proposals FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_official_bindings FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (EXISTS ( SELECT 1
   FROM public.waker_flows owned_flow
  WHERE ((owned_flow.id = flow_official_bindings.flow_id) AND (owned_flow.tenant_id = current_setting('app.tenant_id'::text, true)))))));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_run_events FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_run_retries FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_share_imports FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_source_inline_invocations FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_source_invocations FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_source_public_operations FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
CREATE POLICY tenant_scope_update ON public.flow_source_runs FOR UPDATE USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.thread_compactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.thread_context_breakdowns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.thread_run_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.thread_run_liveness ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.thread_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.update_routing_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.voice_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waker_flow_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waker_flow_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waker_flows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waker_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waker_group_upgrades ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waker_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wechat_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wechat_bind_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wechat_prompts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.work_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO xiongbao_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO xiongbao_role_writer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_channel_waker_group_link() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_flow_share_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_grant_stamp_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_mcp_tool_stamp_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_bot_visible(p_agent_id text) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_team_bot_visible(p_agent_id text) TO xiongbao_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_creator(p_channel_id text) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_team_channel_creator(p_channel_id text) TO xiongbao_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_hand_over(p_channel_id text) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_team_channel_hand_over(p_channel_id text) TO xiongbao_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_hand_over_core(p_channel_id text, p_leaving boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_hand_over_write(p_channel_id text, p_from text, p_heir text, p_group_id uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_member(p_channel_id text) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_team_channel_member(p_channel_id text) TO xiongbao_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_channel_seedable(p_channel_id text) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_team_channel_seedable(p_channel_id text) TO xiongbao_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_person_leaves_groups(p_user_id text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_revoked_leaves() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_row_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_team_server_secret(p_server_id text) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_team_server_secret(p_server_id text) TO xiongbao_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.xiongbao_waker_group_absent(p_id uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION public.xiongbao_waker_group_absent(p_id uuid) TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.acp_turns TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.action_policy TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.action_records TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_preferences TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_profiles TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_security_policies TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_security_settings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agents TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.app_access_requests TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_continuation_steps TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_continuations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_conversation_grants TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_direct_execution_domains TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_exact_input_captures TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_exact_input_objects TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_preferences TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_requests TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_rules TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_team_rules TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_team_settings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attachments TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_events TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_continuations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_firings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_triggers TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.avatar_sources TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_cards TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_lifecycle TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_tasks TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.brokered_accounts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.brokered_identities TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.capability_settings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.channel_agents TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.channel_memberships TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.channels TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.component_exclusions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.component_functions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.components TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.composio_connections TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.computer_page_frame TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.computer_snapshot TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.computer_waits TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.credentials TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.default_opt_outs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delivery_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delivery_challenges TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delivery_inbox TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delivery_outbox TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.demonstrations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.deployment_packages TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.device_pair_codes TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employee_device_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employee_role_snapshots TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enterprise_settings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_confirmations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_customization_heads TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_customization_sessions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_customization_turns TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_import_proposals TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_official_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_official_source_heads TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_run_events TO xiongbao_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.flow_run_events_sequence_seq TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_run_retries TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_share_imports TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_share_links TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_candidates TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_inline_invocations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_invocations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_operations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_original_activations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_original_projection_observations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_public_operations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_resource_snapshots TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_runtime_events TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_stop_operations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.flow_source_versions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.generated_media TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_bot_threads TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_message_private TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_messages TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_pipeline_start_receipts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_task_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_task_templates TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.heartbeat_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.identity_link_challenges TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.identity_links TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intelligence_channel_mappings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_binding_heads TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_directories TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_notebooks TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_receipts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_sources TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_write_claims TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_write_executions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learned_skills TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learning_open_skills TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learning_person_spaces TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learning_settings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learning_skill_approvals TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learning_skill_sharing TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.learning_thread_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.local_learning_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.local_learning_state TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.local_skill_candidates TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mcp_servers TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mcp_tools TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mcp_user_credentials TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memory_embeddings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memory_sources TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.model_registry TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.model_token_calls TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.model_usage TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.network_policies TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pending_authorizations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.persona_templates TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.personal_memories TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plans TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.platform_model_pool TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plugin_assembly_origins TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plugin_assembly_publications TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plugin_grants TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plugin_install_listings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portrait_media TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portraits TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proactive_check_in_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proactive_people TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proactive_pings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proactive_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proactive_settings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proactive_suggestions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_context_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provider_templates TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_devices TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recorder_connect_codes TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recorder_connections TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recorder_trajectory_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.registered_devices TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.resource_projects TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.responsibilities TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.responsibility_events TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.responsibility_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.responsibility_source_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.responsibility_triggers TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.revoked_access TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.role_generation_requests TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.role_templates TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.role_write_receipts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routine_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routine_sweeps TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routines TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runner_device_connection_leases TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sandboxed_components TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.saved_logins TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_connection_bindings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_group_members TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_groups TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_identity_tombstones TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_projection_grants TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_subjects TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_users TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.security_egress_fences TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.security_egress_outbox TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shared_use_approval_members TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shared_use_approvals TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shared_use_requests TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sign_in_requests TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.skill_assets TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.skill_tools TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.skills TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sso_providers TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staffing_proposals TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.task_archives TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.task_briefings TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.task_events TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tasks TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_bot_assignments TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_bot_audience TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_bot_consent_defaults TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_bot_consents TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_bot_publications TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.text_translations TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_compactions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_context_breakdowns TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_run_events TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_run_liveness TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_runs TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.threads TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.update_routing_preferences TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_counters TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_instructions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.user_roles TO xiongbao_role_writer;
--> statement-breakpoint
GRANT SELECT ON TABLE public.user_roles TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.verifications TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.voice_sessions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.waker_flow_requests TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.waker_flow_versions TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.waker_flows TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.waker_group_members TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(group_id) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(tenant_id) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(channel_id) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(outcome) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(dropped_agent_ids) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(started_at) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT UPDATE(updated_at) ON TABLE public.waker_group_upgrades TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.waker_groups TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wechat_accounts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wechat_bind_attempts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wechat_prompts TO xiongbao_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.work_items TO xiongbao_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO xiongbao_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA drizzle TO xiongbao_app;
--> statement-breakpoint
RESET check_function_bodies;

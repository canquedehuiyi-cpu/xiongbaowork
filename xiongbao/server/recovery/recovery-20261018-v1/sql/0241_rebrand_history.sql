/*
 * v0.2.16 改名迁移之二（0241，去品牌 R3 · Task 22）：对话历史等落库数据里，系统写下的旧名改成新名。
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，本文件故意写着旧名（要认出它们才能改）；v0.2.17 的
 * 基线迁移把全部历史迁移合成新名基线后，本文件随历史迁移一起退出。
 *
 * 在哪个事务里：与 0240、凭据换密钥同在 `scripts/migrate.ts` 的一个业务库事务里（apply-migrations.ts 的
 * client.begin），迁移记录行（drizzle.__drizzle_migrations）也在同一事务里写入。任何一步出错，整个事务回滚，
 * 交付容器的 rebrand-preflight.sh 按迁移记录条数如实说明业务库没有改动。
 *
 * 只改这些精确字面量（旧 → 新），且只改在系统写的 JSON 字段里（与 scripts/rebrand/protect.json 里本任务
 * 清掉的 R3 条目一一对应）：
 *  1. CUSTOM 事件名（事件的 name，type = 'CUSTOM'）：
 *       openbot.headless.waiting      → xiongbao.headless.waiting
 *       openbot.ap.local-terminal.v1  → xiongbao.ap.local-terminal.v1
 *  2. 中断元数据的键（中断对象的 metadata 里）：openbotWaiting → xiongbaoWaiting
 *  3. 运行属性的键（任何对象的 forwardedProps 里，即 RunAgentInput 与审批续跑快照）：
 *       openbotRun → xiongbaoRun，openbotTimeZone → xiongbaoTimeZone，openbotSkill → xiongbaoSkill
 *  4. 运行上下文条目的标题（带 forwardedProps / messages / threadId 的对象的 context[].description）：
 *       OpenBot standing role / granted tools guidance / Bot id / deployment tools / signed run assertion /
 *       learned skills / personal memory → XiongBao 同后缀
 *  5. 对话行的 id（带 role 的对象的 id）：openbot:personal-memory → xiongbao:personal-memory
 *  6. 工具回答里的卡片标记（role = 'tool' 的消息与 TOOL_CALL_RESULT 事件的 content 字符串里，标记后紧跟
 *     卡片 JSON 的 `{`）：<<openbot:staffing-proposal>>{ → <<xiongbao:staffing-proposal>>{，
 *     <<openbot:app-access-request>>{ → <<xiongbao:app-access-request>>{
 *  7. 生成式界面的目录 id（activityType = 'generative-ui-surface' 的 content.catalogId 与
 *     content.operations[].createSurface.catalogId）：openbot/ui@1 → xiongbao/ui@1
 *  8. 运行错误码（RUN_ERROR 事件的 code）：0240 列出的十个 OPENBOT_<X> → XIONGBAO_<X>。0240 只认存成 JSON
 *     对象的事件；运行事件经 drizzle 自带的 jsonb 写入，绝大多数存成 JSON 字符串（双重编码），这里补上。
 *  9. 规则里的工具引用（approval_rules、approval_team_rules、approval_conversation_grants 的 tool_ref 文本列）：
 *     openbot/ 开头 → xiongbao/ 开头（openbot/share_private_information、openbot/search_tools 与以 openbot/ 开头的通配规则）。
 *
 * 作用在哪些列：thread_run_events.event、threads.messages_snapshot、approval_requests.action 里的
 * continuation、routine_runs.waiting、responsibility_runs.waiting / continuation、computer_waits.continuation、
 * sign_in_requests.continuation（JSON 对象或双重编码的 JSON 字符串都认，写回时保持原来的形式），以及第 9 条
 * 的三个 tool_ref 列。
 *
 * 不碰：用户消息与模型回复的正文（只有上面点名的字段会改，正文里恰好写着旧标记的照旧）；工具调用参数
 * （args）、智能体状态（state / snapshot / delta）；记忆正文；audit_events（只追加，规格 §12 决定 7）；
 * approval_requests.action 里 continuation 以外的部分（toolRef 在动作摘要 action_digest 里，改了摘要就对不上，
 * 读取端新旧都认）。
 *
 * 完整性校验覆盖的行：
 *  - 有续跑账本（approval_continuations）的审批：账本的 input_digest 绑定续跑输入，这些审批的 continuation
 *    整条不改（读取端新旧都认）。
 *  - 本地续跑的终端日志（最后一条是 local-terminal 标记的运行）：回执的 output_digest 覆盖标记之前的事件和
 *    标记里的消息，但不覆盖标记的名字。这些运行只改标记名，其它事件一条不动。
 *
 * 只扫含旧字面量的行：先用 col::text ~ 'openbot|OpenBot|OPENBOT_' 过滤（不解析 JSON），过滤出来的行逐层
 * 只下钻含旧字面量的子树，改完与原值相同的行不写。第二次执行什么都不改。
 *
 * 平台帧：改写在 app.tenant_id = 'platform' 下执行（行守卫与行级安全在 platform 帧放行），结束恢复原值。
 */
CREATE FUNCTION pg_temp.xiongbao_history_names(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  result jsonb;
  props jsonb;
  pair text[];
  content text;
  renamed text;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) NOT IN ('object', 'array')
     OR value::text !~ 'openbot|OpenBot|OPENBOT_' THEN
    RETURN value;
  END IF;

  IF jsonb_typeof(value) = 'array' THEN
    SELECT coalesce(jsonb_agg(pg_temp.xiongbao_history_names(e) ORDER BY n), '[]'::jsonb)
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS t(e, n);
    RETURN result;
  END IF;

  -- 先改子对象；工具调用参数与智能体状态是模型或智能体写的，不下钻。
  SELECT coalesce(jsonb_object_agg(k, CASE
           WHEN k IN ('args', 'state', 'snapshot', 'delta') THEN v
           ELSE pg_temp.xiongbao_history_names(v) END), '{}'::jsonb)
    INTO result
    FROM jsonb_each(value) AS t(k, v);

  -- 1. CUSTOM 事件名
  IF result ->> 'type' = 'CUSTOM' AND result ->> 'name' = 'openbot.headless.waiting' THEN
    result := jsonb_set(result, '{name}', '"xiongbao.headless.waiting"');
  ELSIF result ->> 'type' = 'CUSTOM' AND result ->> 'name' = 'openbot.ap.local-terminal.v1' THEN
    result := jsonb_set(result, '{name}', '"xiongbao.ap.local-terminal.v1"');
  END IF;

  -- 8. 运行错误码
  IF result ->> 'type' = 'RUN_ERROR' AND result ->> 'code' IN (
       'OPENBOT_MODEL_REFUSED', 'OPENBOT_MODEL_BILLING', 'OPENBOT_MODEL_AUTH_REQUIRED',
       'OPENBOT_PROVIDER_REQUEST_REFUSED', 'OPENBOT_LEARNED_SKILLS_ERROR', 'OPENBOT_AP_LOCAL_STREAM_ERROR',
       'OPENBOT_AP_LOCAL_TERMINAL_MISSING', 'OPENBOT_HARNESS_START_FAILED', 'OPENBOT_HEADLESS_TOOL_ERROR',
       'OPENBOT_TOOL_LIMIT_EXCEEDED') THEN
    result := jsonb_set(result, '{code}', to_jsonb('XIONGBAO_' || substr(result ->> 'code', 9)));
  END IF;

  -- 2. 中断元数据的键
  IF jsonb_typeof(result -> 'metadata') = 'object'
     AND (result -> 'metadata') ? 'openbotWaiting'
     AND NOT ((result -> 'metadata') ? 'xiongbaoWaiting') THEN
    result := jsonb_set(result, '{metadata}',
      ((result -> 'metadata') - 'openbotWaiting')
        || jsonb_build_object('xiongbaoWaiting', (result -> 'metadata') -> 'openbotWaiting'));
  END IF;

  -- 3. 运行属性的键
  IF jsonb_typeof(result -> 'forwardedProps') = 'object' THEN
    props := result -> 'forwardedProps';
    FOREACH pair SLICE 1 IN ARRAY ARRAY[
      ARRAY['openbotRun', 'xiongbaoRun'],
      ARRAY['openbotTimeZone', 'xiongbaoTimeZone'],
      ARRAY['openbotSkill', 'xiongbaoSkill']
    ] LOOP
      IF props ? pair[1] AND NOT (props ? pair[2]) THEN
        props := (props - pair[1]) || jsonb_build_object(pair[2], props -> pair[1]);
      END IF;
    END LOOP;
    result := jsonb_set(result, '{forwardedProps}', props);
  END IF;

  -- 4. 运行上下文条目的标题
  IF jsonb_typeof(result -> 'context') = 'array'
     AND (result ? 'forwardedProps' OR result ? 'messages' OR result ? 'threadId') THEN
    result := jsonb_set(result, '{context}', (
      SELECT coalesce(jsonb_agg(CASE
               WHEN jsonb_typeof(c) = 'object' AND c ->> 'description' IN (
                 'OpenBot standing role', 'OpenBot granted tools guidance', 'OpenBot Bot id',
                 'OpenBot deployment tools', 'OpenBot signed run assertion', 'OpenBot learned skills',
                 'OpenBot personal memory')
               THEN jsonb_set(c, '{description}', to_jsonb('XiongBao' || substr(c ->> 'description', 8)))
               ELSE c END ORDER BY n), '[]'::jsonb)
        FROM jsonb_array_elements(result -> 'context') WITH ORDINALITY AS t(c, n)));
  END IF;

  -- 5. 对话行的 id
  IF result ? 'role' AND result ->> 'id' = 'openbot:personal-memory' THEN
    result := jsonb_set(result, '{id}', '"xiongbao:personal-memory"');
  END IF;

  -- 6. 工具回答里的卡片标记
  IF (result ->> 'role' = 'tool' OR result ->> 'type' = 'TOOL_CALL_RESULT')
     AND jsonb_typeof(result -> 'content') = 'string' THEN
    content := result ->> 'content';
    renamed := replace(replace(content,
      '<<openbot:staffing-proposal>>{', '<<xiongbao:staffing-proposal>>{'),
      '<<openbot:app-access-request>>{', '<<xiongbao:app-access-request>>{');
    IF renamed <> content THEN
      result := jsonb_set(result, '{content}', to_jsonb(renamed));
    END IF;
  END IF;

  -- 7. 生成式界面的目录 id
  IF result ->> 'activityType' = 'generative-ui-surface'
     AND jsonb_typeof(result -> 'content') = 'object' THEN
    IF result -> 'content' ->> 'catalogId' = 'openbot/ui@1' THEN
      result := jsonb_set(result, '{content,catalogId}', '"xiongbao/ui@1"');
    END IF;
    IF jsonb_typeof(result -> 'content' -> 'operations') = 'array' THEN
      result := jsonb_set(result, '{content,operations}', (
        SELECT coalesce(jsonb_agg(CASE
                 WHEN jsonb_typeof(o -> 'createSurface') = 'object'
                      AND o -> 'createSurface' ->> 'catalogId' = 'openbot/ui@1'
                 THEN jsonb_set(o, '{createSurface,catalogId}', '"xiongbao/ui@1"')
                 ELSE o END ORDER BY n), '[]'::jsonb)
          FROM jsonb_array_elements(result -> 'content' -> 'operations') WITH ORDINALITY AS t(o, n)));
    END IF;
  END IF;

  RETURN result;
END
$fn$;
--> statement-breakpoint
/* 一个列值：JSON 对象原样处理；双重编码的 JSON 字符串先解开、改完再按字符串写回。解不开的字符串原样留着。 */
CREATE FUNCTION pg_temp.xiongbao_history_value(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  inner_value jsonb;
  renamed jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN
    RETURN pg_temp.xiongbao_history_names(value);
  END IF;
  BEGIN
    inner_value := (value #>> '{}')::jsonb;
  EXCEPTION WHEN data_exception THEN
    RETURN value;
  END;
  IF jsonb_typeof(inner_value) NOT IN ('object', 'array') THEN
    RETURN value;
  END IF;
  renamed := pg_temp.xiongbao_history_names(inner_value);
  IF renamed = inner_value THEN
    RETURN value;
  END IF;
  RETURN to_jsonb(renamed::text);
END
$fn$;
--> statement-breakpoint
/* 一条审批的动作：只改 continuation（审批续跑快照），动作的其余部分（含进摘要的 toolRef）不动。 */
CREATE FUNCTION pg_temp.xiongbao_history_action(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  action jsonb := value;
  renamed jsonb;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    BEGIN
      action := (value #>> '{}')::jsonb;
    EXCEPTION WHEN data_exception THEN
      RETURN value;
    END;
  END IF;
  IF jsonb_typeof(action) IS DISTINCT FROM 'object' OR NOT (action ? 'continuation') THEN
    RETURN value;
  END IF;
  renamed := jsonb_set(action, '{continuation}', pg_temp.xiongbao_history_names(action -> 'continuation'));
  IF renamed = action THEN
    RETURN value;
  END IF;
  IF jsonb_typeof(value) = 'string' THEN
    RETURN to_jsonb(renamed::text);
  END IF;
  RETURN renamed;
END
$fn$;
--> statement-breakpoint
/* 这条运行事件若是本地续跑终端日志的标记，它的名字（新旧都认）；不是则为 NULL。 */
CREATE FUNCTION pg_temp.xiongbao_history_local_marker(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  event jsonb := value;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    BEGIN
      event := (value #>> '{}')::jsonb;
    EXCEPTION WHEN data_exception THEN
      RETURN NULL;
    END;
  END IF;
  IF jsonb_typeof(event) = 'object' AND event ->> 'type' = 'CUSTOM'
     AND event ->> 'name' IN ('openbot.ap.local-terminal.v1', 'xiongbao.ap.local-terminal.v1') THEN
    RETURN event ->> 'name';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
DO $$
DECLARE
  frame text := current_setting('app.tenant_id', true);
  item record;
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);

  -- 运行事件：有本地终端标记的运行不在这里改（见下一段）。
  WITH candidate AS (
    SELECT e.thread_id, e.run_id, e.seq, e.event, pg_temp.xiongbao_history_value(e.event) AS renamed
      FROM public.thread_run_events e
     WHERE e.event::text ~ 'openbot|OpenBot|OPENBOT_'
       AND NOT EXISTS (
         SELECT 1 FROM public.thread_run_events m
          WHERE m.thread_id = e.thread_id AND m.run_id = e.run_id
            AND m.event::text LIKE '%.ap.local-terminal.v1%'
            AND pg_temp.xiongbao_history_local_marker(m.event) IS NOT NULL)
  )
  UPDATE public.thread_run_events t
     SET event = c.renamed
    FROM candidate c
   WHERE t.thread_id = c.thread_id AND t.run_id = c.run_id AND t.seq = c.seq
     AND c.renamed IS DISTINCT FROM c.event;

  -- 本地续跑终端日志：只改标记名（回执摘要不覆盖它），标记里的消息与之前的事件都不动。
  UPDATE public.thread_run_events
     SET event = CASE WHEN jsonb_typeof(event) = 'string'
       THEN to_jsonb(jsonb_set((event #>> '{}')::jsonb, '{name}', '"xiongbao.ap.local-terminal.v1"')::text)
       ELSE jsonb_set(event, '{name}', '"xiongbao.ap.local-terminal.v1"') END
   WHERE event::text LIKE '%openbot.ap.local-terminal.v1%'
     AND pg_temp.xiongbao_history_local_marker(event) = 'openbot.ap.local-terminal.v1';

  WITH candidate AS (
    SELECT id, messages_snapshot, pg_temp.xiongbao_history_value(messages_snapshot) AS renamed
      FROM public.threads
     WHERE messages_snapshot::text ~ 'openbot|OpenBot|OPENBOT_'
  )
  UPDATE public.threads t
     SET messages_snapshot = c.renamed
    FROM candidate c
   WHERE t.id = c.id AND c.renamed IS DISTINCT FROM c.messages_snapshot;

  -- 审批续跑快照：有续跑账本的审批不改（账本的 input_digest 绑定续跑输入）。
  WITH candidate AS (
    SELECT r.id, r.action, pg_temp.xiongbao_history_action(r.action) AS renamed
      FROM public.approval_requests r
     WHERE r.action::text ~ 'openbot|OpenBot|OPENBOT_'
       AND NOT EXISTS (SELECT 1 FROM public.approval_continuations c WHERE c.approval_id = r.id)
  )
  UPDATE public.approval_requests t
     SET action = c.renamed
    FROM candidate c
   WHERE t.id = c.id AND c.renamed IS DISTINCT FROM c.action;

  -- 等人的运行留下的 waiting / continuation（结构同运行事件里的等待详情与续跑快照）。
  FOR item IN
    SELECT * FROM (VALUES
      ('routine_runs', 'waiting'),
      ('responsibility_runs', 'waiting'),
      ('responsibility_runs', 'continuation'),
      ('computer_waits', 'continuation'),
      ('sign_in_requests', 'continuation')
    ) AS v(table_name, column_name)
  LOOP
    EXECUTE format(
      'WITH candidate AS (
         SELECT ctid AS row_id, %2$I AS old_value, pg_temp.xiongbao_history_value(%2$I) AS renamed
           FROM public.%1$I WHERE %2$I::text ~ %3$L)
       UPDATE public.%1$I t SET %2$I = c.renamed FROM candidate c
        WHERE t.ctid = c.row_id AND c.renamed IS DISTINCT FROM c.old_value',
      item.table_name, item.column_name, 'openbot|OpenBot|OPENBOT_');
  END LOOP;

  -- 规则里的工具引用。
  UPDATE public.approval_rules
     SET tool_ref = 'xiongbao/' || substr(tool_ref, 9) WHERE tool_ref LIKE 'openbot/%';
  UPDATE public.approval_team_rules
     SET tool_ref = 'xiongbao/' || substr(tool_ref, 9) WHERE tool_ref LIKE 'openbot/%';
  UPDATE public.approval_conversation_grants
     SET tool_ref = 'xiongbao/' || substr(tool_ref, 9) WHERE tool_ref LIKE 'openbot/%';

  PERFORM set_config('app.tenant_id', coalesce(frame, ''), true);
END $$;
--> statement-breakpoint
DROP FUNCTION pg_temp.xiongbao_history_local_marker(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.xiongbao_history_action(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.xiongbao_history_value(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.xiongbao_history_names(jsonb);

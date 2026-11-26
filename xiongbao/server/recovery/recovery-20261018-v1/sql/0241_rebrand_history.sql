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
 * 只按已知的字段路径改，不按形状在整棵 JSON 里找（路径之外的内容，哪怕形状一样、写着旧字面量，也不碰）。
 * 只改这些精确字面量（旧 → 新），与 scripts/rebrand/protect.json 里本任务清掉的 R3 条目一一对应：
 *  1. 运行事件的名字（type = 'CUSTOM' 的 name）：
 *       openbot.headless.waiting      → xiongbao.headless.waiting
 *       openbot.ap.local-terminal.v1  → xiongbao.ap.local-terminal.v1
 *  2. 中断元数据的键（RUN_FINISHED 的 outcome.interrupts[].metadata）：openbotWaiting → xiongbaoWaiting
 *  3. 运行属性的键（运行输入的 forwardedProps）：openbotRun → xiongbaoRun，openbotTimeZone → xiongbaoTimeZone，
 *     openbotSkill → xiongbaoSkill
 *  4. 运行上下文条目的标题（运行输入的 context[].description）：OpenBot standing role / granted tools guidance /
 *     Bot id / deployment tools / signed run assertion / learned skills / personal memory → XiongBao 同后缀
 *  5. 个人记忆行的 id（运行输入与对话快照里 role = 'system' 的消息的 id）：openbot:personal-memory →
 *     xiongbao:personal-memory
 *  6. 工具回答开头的卡片标记（role = 'tool' 的消息与 TOOL_CALL_RESULT 事件的 content 字符串，只认读取端认的
 *     位置：字符串开头，或外部内容信封里第一行内容的开头，前面可有一个 JSON 字符串的引号；每条只替换这一处）：
 *     <<openbot:staffing-proposal>>{ → <<xiongbao:staffing-proposal>>{，
 *     <<openbot:app-access-request>>{ → <<xiongbao:app-access-request>>{
 *  7. 生成式界面的目录 id（activityType = 'generative-ui-surface' 的活动事件与活动消息的 content.catalogId、
 *     content.operations[].createSurface.catalogId）：openbot/ui@1 → xiongbao/ui@1
 *  8. 运行错误码（RUN_ERROR 事件的 code）：0240 列出的十个 OPENBOT_<X> → XIONGBAO_<X>。0240 只认存成 JSON
 *     对象的事件；运行事件经 drizzle 自带的 jsonb 写入，绝大多数存成 JSON 字符串（双重编码），这里补上。
 *  9. 规则里的工具引用（approval_rules、approval_team_rules、approval_conversation_grants 的 tool_ref 文本列）：
 *     openbot/ 开头 → xiongbao/ 开头（openbot/share_private_information、openbot/search_tools 与以 openbot/ 开头的通配规则）。
 *
 * 路径（「运行输入」指 RunAgentInput 与审批续跑快照，同一结构：forwardedProps、context、messages）：
 *  - thread_run_events.event：CUSTOM 等待事件的 name 与 value.continuation（运行输入）；RUN_FINISHED 的
 *    outcome.interrupts[].metadata 的键与其中等待详情的 continuation；RUN_STARTED 的 input；RUN_ERROR 的 code；
 *    TOOL_CALL_RESULT 的 content；MESSAGES_SNAPSHOT 的 messages；ACTIVITY_SNAPSHOT 的 content。
 *  - threads.messages_snapshot：消息数组。
 *  - approval_requests.action 的 continuation；computer_waits.continuation、sign_in_requests.continuation（运行输入）。
 *  - routine_runs.waiting、responsibility_runs.waiting（等待详情：continuation）；responsibility_runs.continuation
 *    （{ waiting, response }：只看 waiting）。
 *  - 消息数组里：role = 'tool' 的 content（第 6 条）、role = 'activity' 的 content（第 7 条）、role = 'system'
 *    的 id（第 5 条）；别的消息、任何消息的 content 内部（含内容数组）都不下钻。
 *
 * 写回的形式：JSON 对象写回仍是对象；双重编码的行写回仍是 JSON 字符串，但字符串里的 JSON 文本由 PG 重新
 * 序列化（空格、键序按 jsonb 规范化），不是原来的字节；读取方（drizzle 解码、local-learning/evidence.ts 等）
 * 都先解析再用。没有任何一处改动的行不写，保持原字节。
 *
 * 不碰：用户消息与模型回复的正文、工具回答正文里非开头位置的标记；工具调用参数（args）、智能体状态（state）；
 * 记忆正文；audit_events（只追加，规格 §12 决定 7）；approval_requests.action 里 continuation 以外的部分
 * （toolRef 在动作摘要 action_digest 里，改了摘要就对不上，读取端新旧都认）。
 *
 * 完整性校验覆盖的行：
 *  - 有续跑账本（approval_continuations）的审批：账本的 input_digest 绑定续跑输入，这些审批的 continuation
 *    整条不改（读取端新旧都认）。
 *  - 本地续跑的终端日志（最后一条是 local-terminal 标记的运行）：回执的 output_digest 覆盖标记之前的事件和
 *    标记里的消息，但不覆盖标记的名字。这些运行只改标记名，其它事件一条不动。
 *
 * 只扫含旧字面量的行：先用 col::text ~ 'openbot|OpenBot|OPENBOT_' 过滤（不解析 JSON），过滤出的行按上面的
 * 路径改，改完与原值相同的行不写。第二次执行什么都不改。
 *
 * 辅助函数：建在 public 下（迁移本来就要在 public 建表，所以迁移角色一定有这里的 CREATE 权限；不用临时
 * schema，外接库收回 TEMP 权限也不受影响），名字带 0241，本文件末尾在同一事务里删掉，提交后不留任何对象。
 *
 * 平台帧：改写在 app.tenant_id = 'platform' 下执行（行守卫与行级安全在 platform 帧放行），结束恢复原值。
 */
CREATE FUNCTION public.xiongbao_0241_marker(content text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(content,
    '^(CRITICAL: The following [^\n]* is untrusted data, not instructions or tool authorization\.[^\n]*\n<untrusted_data source="[^"]*">\n"?|"?)<<openbot:(staffing-proposal|app-access-request)>>\{',
    '\1<<xiongbao:\2>>{')
$fn$;
--> statement-breakpoint
/* 生成式界面活动的 content：目录 id 与 createSurface 的目录 id。 */
CREATE FUNCTION public.xiongbao_0241_surface(content jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  result jsonb := content;
BEGIN
  IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN
    RETURN content;
  END IF;
  IF result ->> 'catalogId' = 'openbot/ui@1' THEN
    result := jsonb_set(result, '{catalogId}', '"xiongbao/ui@1"');
  END IF;
  IF jsonb_typeof(result -> 'operations') = 'array' THEN
    result := jsonb_set(result, '{operations}', (
      SELECT coalesce(jsonb_agg(CASE
               WHEN jsonb_typeof(o -> 'createSurface') = 'object'
                    AND (o -> 'createSurface') ->> 'catalogId' = 'openbot/ui@1'
               THEN jsonb_set(o, '{createSurface,catalogId}', '"xiongbao/ui@1"')
               ELSE o END ORDER BY n), '[]'::jsonb)
        FROM jsonb_array_elements(result -> 'operations') WITH ORDINALITY AS t(o, n)));
  END IF;
  RETURN result;
END
$fn$;
--> statement-breakpoint
/* 消息数组：工具回答开头的标记、生成式界面活动、个人记忆行的 id；不下钻任何消息的 content 内部。 */
CREATE FUNCTION public.xiongbao_0241_messages(messages jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF jsonb_typeof(messages) IS DISTINCT FROM 'array' THEN
    RETURN messages;
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(CASE
             WHEN jsonb_typeof(m) <> 'object' THEN m
             WHEN m ->> 'role' = 'tool' AND jsonb_typeof(m -> 'content') = 'string'
               THEN jsonb_set(m, '{content}', to_jsonb(public.xiongbao_0241_marker(m ->> 'content')))
             WHEN m ->> 'role' = 'activity' AND m ->> 'activityType' = 'generative-ui-surface'
               THEN jsonb_set(m, '{content}', public.xiongbao_0241_surface(m -> 'content'))
             WHEN m ->> 'role' = 'system' AND m ->> 'id' = 'openbot:personal-memory'
               THEN jsonb_set(m, '{id}', '"xiongbao:personal-memory"')
             ELSE m END ORDER BY n), '[]'::jsonb)
      FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(m, n));
END
$fn$;
--> statement-breakpoint
/* 运行输入（RunAgentInput、审批续跑快照）：forwardedProps 的键、context 的标题、messages。 */
CREATE FUNCTION public.xiongbao_0241_run(run jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  result jsonb := run;
  props jsonb;
  pair text[];
BEGIN
  IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN
    RETURN run;
  END IF;
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
  IF jsonb_typeof(result -> 'context') = 'array' THEN
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
  IF jsonb_typeof(result -> 'messages') = 'array' THEN
    result := jsonb_set(result, '{messages}', public.xiongbao_0241_messages(result -> 'messages'));
  END IF;
  RETURN result;
END
$fn$;
--> statement-breakpoint
/* 等待详情（HeadlessWaiting）：只看它带的 continuation（运行输入）。 */
CREATE FUNCTION public.xiongbao_0241_waiting(waiting jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(waiting) = 'object' AND jsonb_typeof(waiting -> 'continuation') = 'object'
    THEN jsonb_set(waiting, '{continuation}', public.xiongbao_0241_run(waiting -> 'continuation'))
    ELSE waiting END
$fn$;
--> statement-breakpoint
/* 一条运行事件，按它的 type 只看上面列出的字段。 */
CREATE FUNCTION public.xiongbao_0241_event(event jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  result jsonb := event;
  kind text := event ->> 'type';
BEGIN
  IF jsonb_typeof(event) IS DISTINCT FROM 'object' THEN
    RETURN event;
  END IF;
  IF kind = 'CUSTOM' AND result ->> 'name' IN ('openbot.headless.waiting', 'xiongbao.headless.waiting') THEN
    result := jsonb_set(result, '{name}', '"xiongbao.headless.waiting"');
    IF result ? 'value' THEN
      result := jsonb_set(result, '{value}', public.xiongbao_0241_waiting(result -> 'value'));
    END IF;
  ELSIF kind = 'RUN_FINISHED' AND jsonb_typeof(result #> '{outcome,interrupts}') = 'array' THEN
    result := jsonb_set(result, '{outcome,interrupts}', (
      SELECT coalesce(jsonb_agg(CASE
               WHEN jsonb_typeof(i -> 'metadata') = 'object' AND (i -> 'metadata') ? 'openbotWaiting'
                    AND NOT ((i -> 'metadata') ? 'xiongbaoWaiting')
               THEN jsonb_set(i, '{metadata}', ((i -> 'metadata') - 'openbotWaiting')
                      || jsonb_build_object('xiongbaoWaiting',
                           public.xiongbao_0241_waiting((i -> 'metadata') -> 'openbotWaiting')))
               ELSE i END ORDER BY n), '[]'::jsonb)
        FROM jsonb_array_elements(result #> '{outcome,interrupts}') WITH ORDINALITY AS t(i, n)));
  ELSIF kind = 'RUN_STARTED' AND jsonb_typeof(result -> 'input') = 'object' THEN
    result := jsonb_set(result, '{input}', public.xiongbao_0241_run(result -> 'input'));
  ELSIF kind = 'RUN_ERROR' AND result ->> 'code' IN (
       'OPENBOT_MODEL_REFUSED', 'OPENBOT_MODEL_BILLING', 'OPENBOT_MODEL_AUTH_REQUIRED',
       'OPENBOT_PROVIDER_REQUEST_REFUSED', 'OPENBOT_LEARNED_SKILLS_ERROR', 'OPENBOT_AP_LOCAL_STREAM_ERROR',
       'OPENBOT_AP_LOCAL_TERMINAL_MISSING', 'OPENBOT_HARNESS_START_FAILED', 'OPENBOT_HEADLESS_TOOL_ERROR',
       'OPENBOT_TOOL_LIMIT_EXCEEDED') THEN
    result := jsonb_set(result, '{code}', to_jsonb('XIONGBAO_' || substr(result ->> 'code', 9)));
  ELSIF kind = 'TOOL_CALL_RESULT' AND jsonb_typeof(result -> 'content') = 'string' THEN
    result := jsonb_set(result, '{content}', to_jsonb(public.xiongbao_0241_marker(result ->> 'content')));
  ELSIF kind = 'MESSAGES_SNAPSHOT' THEN
    IF jsonb_typeof(result -> 'messages') = 'array' THEN
      result := jsonb_set(result, '{messages}', public.xiongbao_0241_messages(result -> 'messages'));
    END IF;
  ELSIF kind = 'ACTIVITY_SNAPSHOT' AND result ->> 'activityType' = 'generative-ui-surface' THEN
    IF result ? 'content' THEN
      result := jsonb_set(result, '{content}', public.xiongbao_0241_surface(result -> 'content'));
    END IF;
  END IF;
  RETURN result;
END
$fn$;
--> statement-breakpoint
/*
 * 一个列值按它是什么（shape：event / messages / run / waiting / responsibility / action）改：JSON 对象原样处理；
 * 双重编码的 JSON 字符串先解开、改完再写成字符串。解不开的字符串、没有任何改动的值原样返回。
 */
CREATE FUNCTION public.xiongbao_0241_value(value jsonb, shape text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  parsed jsonb := value;
  renamed jsonb;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    BEGIN
      parsed := (value #>> '{}')::jsonb;
    EXCEPTION WHEN data_exception THEN
      RETURN value;
    END;
  END IF;
  IF jsonb_typeof(parsed) NOT IN ('object', 'array') THEN
    RETURN value;
  END IF;
  renamed := CASE shape
    WHEN 'event' THEN public.xiongbao_0241_event(parsed)
    WHEN 'messages' THEN public.xiongbao_0241_messages(parsed)
    WHEN 'run' THEN public.xiongbao_0241_run(parsed)
    WHEN 'waiting' THEN public.xiongbao_0241_waiting(parsed)
    WHEN 'responsibility' THEN CASE
      WHEN jsonb_typeof(parsed -> 'waiting') = 'object'
      THEN jsonb_set(parsed, '{waiting}', public.xiongbao_0241_waiting(parsed -> 'waiting'))
      ELSE parsed END
    WHEN 'action' THEN CASE
      WHEN jsonb_typeof(parsed -> 'continuation') = 'object'
      THEN jsonb_set(parsed, '{continuation}', public.xiongbao_0241_run(parsed -> 'continuation'))
      ELSE parsed END
  END;
  IF renamed = parsed THEN
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
CREATE FUNCTION public.xiongbao_0241_local_marker(value jsonb) RETURNS text
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
    SELECT e.thread_id, e.run_id, e.seq, e.event, public.xiongbao_0241_value(e.event, 'event') AS renamed
      FROM public.thread_run_events e
     WHERE e.event::text ~ 'openbot|OpenBot|OPENBOT_'
       AND NOT EXISTS (
         SELECT 1 FROM public.thread_run_events m
          WHERE m.thread_id = e.thread_id AND m.run_id = e.run_id
            AND m.event::text LIKE '%.ap.local-terminal.v1%'
            AND public.xiongbao_0241_local_marker(m.event) IS NOT NULL)
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
     AND public.xiongbao_0241_local_marker(event) = 'openbot.ap.local-terminal.v1';

  WITH candidate AS (
    SELECT id, messages_snapshot, public.xiongbao_0241_value(messages_snapshot, 'messages') AS renamed
      FROM public.threads
     WHERE messages_snapshot::text ~ 'openbot|OpenBot|OPENBOT_'
  )
  UPDATE public.threads t
     SET messages_snapshot = c.renamed
    FROM candidate c
   WHERE t.id = c.id AND c.renamed IS DISTINCT FROM c.messages_snapshot;

  -- 审批续跑快照：有续跑账本的审批不改（账本的 input_digest 绑定续跑输入）。
  WITH candidate AS (
    SELECT r.id, r.action, public.xiongbao_0241_value(r.action, 'action') AS renamed
      FROM public.approval_requests r
     WHERE r.action::text ~ 'openbot|OpenBot|OPENBOT_'
       AND NOT EXISTS (SELECT 1 FROM public.approval_continuations c WHERE c.approval_id = r.id)
  )
  UPDATE public.approval_requests t
     SET action = c.renamed
    FROM candidate c
   WHERE t.id = c.id AND c.renamed IS DISTINCT FROM c.action;

  -- 等人的运行留下的等待详情与续跑快照。
  FOR item IN
    SELECT * FROM (VALUES
      ('routine_runs', 'waiting', 'waiting'),
      ('responsibility_runs', 'waiting', 'waiting'),
      ('responsibility_runs', 'continuation', 'responsibility'),
      ('computer_waits', 'continuation', 'run'),
      ('sign_in_requests', 'continuation', 'run')
    ) AS v(table_name, column_name, shape)
  LOOP
    EXECUTE format(
      'WITH candidate AS (
         SELECT ctid AS row_id, %2$I AS old_value, public.xiongbao_0241_value(%2$I, %3$L) AS renamed
           FROM public.%1$I WHERE %2$I::text ~ %4$L)
       UPDATE public.%1$I t SET %2$I = c.renamed FROM candidate c
        WHERE t.ctid = c.row_id AND c.renamed IS DISTINCT FROM c.old_value',
      item.table_name, item.column_name, item.shape, 'openbot|OpenBot|OPENBOT_');
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
DROP FUNCTION public.xiongbao_0241_local_marker(jsonb);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_value(jsonb, text);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_event(jsonb);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_waiting(jsonb);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_run(jsonb);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_messages(jsonb);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_surface(jsonb);
--> statement-breakpoint
DROP FUNCTION public.xiongbao_0241_marker(text);

/*
 * v0.2.16 改名迁移（0240，去品牌 R3 · Task 20）：业务库里落在数据库对象与存量数据中的旧名一次改成新名。
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，本文件故意写着旧名（要认出它们才能改）；v0.2.17 的
 * 基线迁移把全部历史迁移合成新名基线后，本文件随历史迁移一起退出。
 *
 * 在哪个事务里：与全部待执行迁移同在 `scripts/migrate.ts` 的一个业务库事务里（apply-migrations.ts 的
 * client.begin），迁移记录行（drizzle.__drizzle_migrations）也在同一事务里写入。任何一步出错，整个事务
 * 回滚：对象名、存量数据、迁移记录都保持升级前的样子，交付容器的 rebrand-preflight.sh 按迁移记录条数
 * 如实说明业务库没有改动。
 *
 * 新装库与已有库走同一条路：新装库先由历史迁移按旧名建好角色、函数、触发器与授权，本迁移再改名。
 *
 * 每一段都可重复执行（第二次执行什么都不改）：先看旧名在不在、新名在不在，再决定做不做。
 *
 * 改了什么（旧 → 新）：
 *  1. 应用角色 openbot_app → xiongbao_app，openbot_role_writer → xiongbao_role_writer。
 *     角色是集群级的。集群里只有旧名：ALTER ROLE … RENAME（oid、口令哈希、成员关系、全部授权与策略随
 *     oid 走）。集群里新旧都有（同一集群上另一个库已经迁移过，本库的历史迁移又按旧名建了旧角色，例如
 *     CI 与测试里同一集群上的多个库）：把本库里授给旧角色的权限、默认权限、策略里的角色与属主全部转给
 *     新角色，确认本库里再没有任何东西引用旧角色；旧角色在整个集群里都没人引用时删掉它（它是 0054 用
 *     公开口令建的登录角色，留着没有用处）。只有新名：什么都不做。
 *  2. public 下全部 openbot_* 函数 → xiongbao_*（ALTER FUNCTION … RENAME），全部 openbot_* 触发器 →
 *     xiongbao_*（ALTER TRIGGER … RENAME）。策略、触发器、默认值按 oid 引用函数，改名后照常生效；函数体
 *     是按源码保存的，其中按名字调用别的函数、提示信息里的函数名、读的 GUC 名，用 pg_get_functiondef 取出
 *     定义、替换旧名后 CREATE OR REPLACE（属主、授权、SECURITY DEFINER、SET 子句不变）。
 *  3. GUC openbot.audit_retention_days → xiongbao.audit_retention_days：审计保留触发器改读新名；库级与
 *     角色级的旧设置拷到新名（新名已有设置的不覆盖），旧设置保留不动。
 *  4. 审批精确输入两表（approval_exact_input_captures / approval_exact_input_objects）的版本串约束换成新串，
 *     线上包装长度随之 +1 字节（版本串长了一个字符）。两表没有写入方，现网核对为 0 行，所以只改约束、不重新
 *     加密。若表里有旧版本串的行，拒绝迁移并整体回滚（这些行的密文绑定了旧版本串，需要逐行解密重加密，本
 *     版本不做）。
 *  5. 平台模型池 platform_model_pool.api_key_env：存的变量名 OPENBOT_POOL_<X> → XIONGBAO_POOL_<X>，约束改认
 *     新前缀。部署环境里旧名的变量由启动时的环境变量别名复制到新名（shared/env-aliases.ts）。
 *  6. 系统写下的来源标记：public 下每张表名为 *_by、actor*、actor_id 的 text 列里，以 openbot: 开头的值改为
 *     xiongbao: 开头（plugin_grants.granted_by、enterprise_settings.updated_by、mcp_servers.added_by 等，
 *     staffing-default / personal-defaults / always-on）。audit_events 不改（只追加，规格 §12 决定 7）。
 *  7. 用户偏好里的旧默认皮肤值：users.preferences 的 skin = 'openbot' → 'xiongbao'。
 *  8. 运行错误码：thread_run_events 里 RUN_ERROR 事件的 code 字段，列出的十个 OPENBOT_<X> → XIONGBAO_<X>，
 *     只改这个字段，不碰事件里的其它内容。
 *  9. 租户包 id：deployment_packages.tenant_id 'openbot' → 'xiongbao'，同一行记下旧部署名的 SHA-256 摘要
 *     （former_name_digest，十六进制，只存摘要不存旧名）。DEPLOYMENT_ID 为空时，服务器用这个摘要算新线程
 *     id 的前缀（server/src/tenant-package.ts 的 deploymentNameOf），升级前后新线程的前缀不变。
 *
 * 平台帧：标记与偏好的改写在 app.tenant_id = 'platform' 下执行（行守卫在 platform 帧放行），每段结束恢复
 * 原值。迁移以库的 owner（超级用户）连接，行级安全对它不生效。
 */
DO $$
DECLARE
  pair text[];
  old_oid oid;
  new_oid oid;
  here oid := (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database());
  item record;
  roles text;
  left_over text;
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['openbot_app', 'xiongbao_app'],
    ARRAY['openbot_role_writer', 'xiongbao_role_writer']
  ] LOOP
    SELECT oid INTO old_oid FROM pg_catalog.pg_roles WHERE rolname = pair[1];
    SELECT oid INTO new_oid FROM pg_catalog.pg_roles WHERE rolname = pair[2];
    CONTINUE WHEN old_oid IS NULL;

    IF new_oid IS NULL THEN
      EXECUTE format('ALTER ROLE %I RENAME TO %I', pair[1], pair[2]);
      CONTINUE;
    END IF;

    -- 集群里新旧都有：把本库里授给旧角色的东西转给新角色。
    FOR item IN
      SELECT c.oid::regclass AS rel, c.relkind, a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(c.relacl) a
       WHERE c.relacl IS NOT NULL AND a.grantee = old_oid
    LOOP
      EXECUTE format('GRANT %s ON %s %s TO %I%s', item.privilege_type,
        CASE WHEN item.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, item.rel, pair[2],
        CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    -- 列级权限先转：撤销表级权限会连同同类的列级权限一起撤掉。
    FOR item IN
      SELECT t.attrelid::regclass AS rel, t.attname, a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_attribute t, LATERAL pg_catalog.aclexplode(t.attacl) a
       WHERE t.attacl IS NOT NULL AND a.grantee = old_oid
    LOOP
      EXECUTE format('GRANT %s (%I) ON TABLE %s TO %I%s', item.privilege_type, item.attname, item.rel,
        pair[2], CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %I', item.privilege_type, item.attname, item.rel,
        pair[1]);
    END LOOP;

    FOR item IN
      SELECT c.oid::regclass AS rel, c.relkind
        FROM pg_catalog.pg_class c
       WHERE c.relacl IS NOT NULL
         AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee = old_oid)
    LOOP
      EXECUTE format('REVOKE ALL ON %s %s FROM %I',
        CASE WHEN item.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, item.rel, pair[1]);
    END LOOP;

    FOR item IN
      SELECT p.oid::regprocedure AS routine, a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
       WHERE p.proacl IS NOT NULL AND a.grantee = old_oid
    LOOP
      EXECUTE format('GRANT %s ON ROUTINE %s TO %I%s', item.privilege_type, item.routine, pair[2],
        CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s ON ROUTINE %s FROM %I', item.privilege_type, item.routine, pair[1]);
    END LOOP;

    FOR item IN
      SELECT n.nspname, a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) a
       WHERE n.nspacl IS NOT NULL AND a.grantee = old_oid
    LOOP
      EXECUTE format('GRANT %s ON SCHEMA %I TO %I%s', item.privilege_type, item.nspname, pair[2],
        CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s ON SCHEMA %I FROM %I', item.privilege_type, item.nspname, pair[1]);
    END LOOP;

    FOR item IN
      SELECT t.oid::regtype AS typ, a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_type t, LATERAL pg_catalog.aclexplode(t.typacl) a
       WHERE t.typacl IS NOT NULL AND a.grantee = old_oid
    LOOP
      EXECUTE format('GRANT %s ON TYPE %s TO %I%s', item.privilege_type, item.typ, pair[2],
        CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s ON TYPE %s FROM %I', item.privilege_type, item.typ, pair[1]);
    END LOOP;

    FOR item IN
      SELECT a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_database d, LATERAL pg_catalog.aclexplode(d.datacl) a
       WHERE d.oid = here AND d.datacl IS NOT NULL AND a.grantee = old_oid
    LOOP
      EXECUTE format('GRANT %s ON DATABASE %I TO %I%s', item.privilege_type, pg_catalog.current_database(),
        pair[2], CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('REVOKE %s ON DATABASE %I FROM %I', item.privilege_type, pg_catalog.current_database(),
        pair[1]);
    END LOOP;

    FOR item IN
      SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS owner, d.defaclnamespace,
             CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
                                  WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END AS kind,
             a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_default_acl d, LATERAL pg_catalog.aclexplode(d.defaclacl) a
       WHERE a.grantee = old_oid
    LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s GRANT %s ON %s TO %I%s', item.owner,
        CASE WHEN item.defaclnamespace = 0 THEN ''
             ELSE format(' IN SCHEMA %I', (SELECT nspname FROM pg_catalog.pg_namespace WHERE oid = item.defaclnamespace)) END,
        item.privilege_type, item.kind, pair[2],
        CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE %s ON %s FROM %I', item.owner,
        CASE WHEN item.defaclnamespace = 0 THEN ''
             ELSE format(' IN SCHEMA %I', (SELECT nspname FROM pg_catalog.pg_namespace WHERE oid = item.defaclnamespace)) END,
        item.privilege_type, item.kind, pair[1]);
    END LOOP;

    FOR item IN
      SELECT p.polname, p.polrelid::regclass AS rel, p.polroles
        FROM pg_catalog.pg_policy p
       WHERE old_oid = ANY (p.polroles)
    LOOP
      SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(r)) END, ', ')
        INTO roles
        FROM (SELECT DISTINCT CASE WHEN r = old_oid THEN new_oid ELSE r END AS r
                FROM unnest(item.polroles) AS r) AS replaced;
      EXECUTE format('ALTER POLICY %I ON %s TO %s', item.polname, item.rel, roles);
    END LOOP;

    EXECUTE format('REASSIGN OWNED BY %I TO %I', pair[1], pair[2]);

    SELECT string_agg(DISTINCT pg_catalog.pg_describe_object(classid, objid, objsubid), '; ')
      INTO left_over
      FROM pg_catalog.pg_shdepend
     WHERE refclassid = 'pg_catalog.pg_authid'::regclass AND refobjid = old_oid AND dbid = here;
    IF left_over IS NOT NULL THEN
      RAISE EXCEPTION '0240: % still holds rights in this database after the move to %: %',
        pair[1], pair[2], left_over;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
                    WHERE refclassid = 'pg_catalog.pg_authid'::regclass AND refobjid = old_oid) THEN
      EXECUTE format('DROP ROLE %I', pair[1]);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  item record;
  definition text;
BEGIN
  FOR item IN
    SELECT p.oid, p.proname
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'openbot\_%'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc q
                WHERE q.pronamespace = 'public'::regnamespace
                  AND q.proname = 'xiongbao_' || substr(item.proname, 9)
                  AND pg_catalog.pg_get_function_identity_arguments(q.oid)
                      = pg_catalog.pg_get_function_identity_arguments(item.oid)) THEN
      RAISE EXCEPTION '0240: both % and % exist; refusing to guess which one to keep',
        item.proname, 'xiongbao_' || substr(item.proname, 9);
    END IF;
    EXECUTE format('ALTER FUNCTION %s RENAME TO %I', item.oid::regprocedure, 'xiongbao_' || substr(item.proname, 9));
  END LOOP;

  FOR item IN
    SELECT t.tgname, t.tgrelid::regclass AS rel
      FROM pg_catalog.pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname LIKE 'openbot\_%'
  LOOP
    EXECUTE format('ALTER TRIGGER %I ON %s RENAME TO %I', item.tgname, item.rel, 'xiongbao_' || substr(item.tgname, 9));
  END LOOP;

  FOR item IN
    SELECT p.oid
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%openbot%'
  LOOP
    definition := pg_catalog.pg_get_functiondef(item.oid);
    definition := replace(definition, 'openbot.audit_retention_days', 'xiongbao.audit_retention_days');
    definition := replace(definition, 'openbot_', 'xiongbao_');
    EXECUTE definition;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  item record;
  here oid := (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database());
  setting text;
BEGIN
  FOR item IN
    SELECT s.setdatabase, s.setrole, c AS cfg
      FROM pg_catalog.pg_db_role_setting s, LATERAL unnest(s.setconfig) AS c
     WHERE c LIKE 'openbot.audit\_retention\_days=%' AND s.setdatabase IN (0, here)
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_db_role_setting n, LATERAL unnest(n.setconfig) AS c
       WHERE n.setdatabase = item.setdatabase AND n.setrole = item.setrole
         AND c LIKE 'xiongbao.audit\_retention\_days=%');
    setting := substr(item.cfg, length('openbot.audit_retention_days=') + 1);
    IF item.setrole = 0 THEN
      EXECUTE format('ALTER DATABASE %I SET xiongbao.audit_retention_days = %L', pg_catalog.current_database(), setting);
    ELSIF item.setdatabase = 0 THEN
      EXECUTE format('ALTER ROLE %I SET xiongbao.audit_retention_days = %L', pg_catalog.pg_get_userbyid(item.setrole), setting);
    ELSE
      EXECUTE format('ALTER ROLE %I IN DATABASE %I SET xiongbao.audit_retention_days = %L',
        pg_catalog.pg_get_userbyid(item.setrole), pg_catalog.current_database(), setting);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  captures bigint;
  objects bigint;
BEGIN
  SELECT count(*) INTO captures FROM public.approval_exact_input_captures
   WHERE codec_version <> 'XIONGBAO_EXACT_INPUT_JSON_V1'
      OR source_binding_version <> 'XIONGBAO_APPROVAL_EXACT_SOURCE_BINDING_V1'
      OR envelope_wire_version <> 'XIONGBAO_APPROVAL_EXACT_WIRE_V1';
  SELECT count(*) INTO objects FROM public.approval_exact_input_objects
   WHERE codec_version <> 'XIONGBAO_EXACT_INPUT_JSON_V1'
      OR source_binding_version <> 'XIONGBAO_APPROVAL_EXACT_SOURCE_BINDING_V1'
      OR envelope_wire_version <> 'XIONGBAO_APPROVAL_EXACT_WIRE_V1';
  IF captures + objects > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('审批精确输入表里有旧版本串的数据（approval_exact_input_captures %s 行，approval_exact_input_objects %s 行）。这些行的密文绑定了旧版本串，改名需要逐行解密再用新版本串重新加密，这个版本不做。改名迁移已拒绝，整个迁移事务回滚，业务库没有任何改动。', captures, objects),
      HINT = '换回 v0.2.15 镜像继续使用（数据没动过）；把这段报错连同两个行数发给开发者，等提供重新加密的版本再升级。不要手工删除这些行。';
  END IF;

  ALTER TABLE public.approval_exact_input_captures
    DROP CONSTRAINT IF EXISTS apx_capture_codec_ck,
    DROP CONSTRAINT IF EXISTS apx_capture_binding_version_ck,
    DROP CONSTRAINT IF EXISTS apx_capture_wire_version_ck,
    DROP CONSTRAINT IF EXISTS apx_capture_wire_size_ck,
    ADD CONSTRAINT apx_capture_codec_ck CHECK ("codec_version" = 'XIONGBAO_EXACT_INPUT_JSON_V1'),
    ADD CONSTRAINT apx_capture_binding_version_ck CHECK ("source_binding_version" = 'XIONGBAO_APPROVAL_EXACT_SOURCE_BINDING_V1'),
    ADD CONSTRAINT apx_capture_wire_version_ck CHECK ("envelope_wire_version" = 'XIONGBAO_APPROVAL_EXACT_WIRE_V1'),
    ADD CONSTRAINT apx_capture_wire_size_ck CHECK (octet_length("envelope_bytes") BETWEEN 65 AND 1048640);
  ALTER TABLE public.approval_exact_input_objects
    DROP CONSTRAINT IF EXISTS apx_prepared_codec_ck,
    DROP CONSTRAINT IF EXISTS apx_prepared_binding_version_ck,
    DROP CONSTRAINT IF EXISTS apx_prepared_wire_version_ck,
    DROP CONSTRAINT IF EXISTS apx_prepared_wire_size_ck,
    ADD CONSTRAINT apx_prepared_codec_ck CHECK ("codec_version" = 'XIONGBAO_EXACT_INPUT_JSON_V1'),
    ADD CONSTRAINT apx_prepared_binding_version_ck CHECK ("source_binding_version" = 'XIONGBAO_APPROVAL_EXACT_SOURCE_BINDING_V1'),
    ADD CONSTRAINT apx_prepared_wire_version_ck CHECK ("envelope_wire_version" = 'XIONGBAO_APPROVAL_EXACT_WIRE_V1'),
    ADD CONSTRAINT apx_prepared_wire_size_ck CHECK (octet_length("envelope_bytes") BETWEEN 65 AND 1048640);
END $$;
--> statement-breakpoint
ALTER TABLE "public"."platform_model_pool" DROP CONSTRAINT IF EXISTS "platform_model_pool_api_key_env";
--> statement-breakpoint
UPDATE "public"."platform_model_pool"
   SET "api_key_env" = 'XIONGBAO_POOL_' || substr("api_key_env", 14)
 WHERE "api_key_env" LIKE 'OPENBOT\_POOL\_%';
--> statement-breakpoint
ALTER TABLE "public"."platform_model_pool"
  ADD CONSTRAINT "platform_model_pool_api_key_env" CHECK ("api_key_env" ~ '^XIONGBAO_POOL_[A-Z0-9_]{1,64}$');
--> statement-breakpoint
DO $$
DECLARE
  frame text := current_setting('app.tenant_id', true);
  item record;
BEGIN
  PERFORM set_config('app.tenant_id', 'platform', true);

  FOR item IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'text' AND c.table_name <> 'audit_events'
       AND (c.column_name LIKE '%\_by' OR c.column_name LIKE 'actor%')
  LOOP
    EXECUTE format('UPDATE public.%I SET %I = %L || substr(%I, 9) WHERE %I LIKE %L',
      item.table_name, item.column_name, 'xiongbao:', item.column_name, item.column_name, 'openbot:%');
  END LOOP;

  UPDATE public.users
     SET preferences = jsonb_set(preferences, '{skin}', '"xiongbao"'::jsonb)
   WHERE preferences ->> 'skin' = 'openbot';

  UPDATE public.thread_run_events
     SET event = jsonb_set(event, '{code}', to_jsonb('XIONGBAO_' || substr(event ->> 'code', 9)))
   WHERE event ->> 'type' = 'RUN_ERROR'
     AND event ->> 'code' IN (
       'OPENBOT_MODEL_REFUSED', 'OPENBOT_MODEL_BILLING', 'OPENBOT_MODEL_AUTH_REQUIRED',
       'OPENBOT_PROVIDER_REQUEST_REFUSED', 'OPENBOT_LEARNED_SKILLS_ERROR', 'OPENBOT_AP_LOCAL_STREAM_ERROR',
       'OPENBOT_AP_LOCAL_TERMINAL_MISSING', 'OPENBOT_HARNESS_START_FAILED', 'OPENBOT_HEADLESS_TOOL_ERROR',
       'OPENBOT_TOOL_LIMIT_EXCEEDED');

  PERFORM set_config('app.tenant_id', coalesce(frame, ''), true);
END $$;
--> statement-breakpoint
ALTER TABLE "public"."deployment_packages" ADD COLUMN IF NOT EXISTS "former_name_digest" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.deployment_packages WHERE tenant_id = 'openbot') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.deployment_packages WHERE tenant_id = 'xiongbao') THEN
    RAISE EXCEPTION USING
      MESSAGE = '0240: deployment_packages 里新旧两个租户包 id 的行都在，不知道该留哪一行。改名迁移已拒绝，整个迁移事务回滚，业务库没有任何改动。',
      HINT = '换回 v0.2.15 镜像继续使用（数据没动过），把这段报错发给开发者。';
  END IF;
  UPDATE public.deployment_packages
     SET tenant_id = 'xiongbao',
         former_name_digest = encode(sha256('openbot'::bytea), 'hex')
   WHERE tenant_id = 'openbot';
END $$;

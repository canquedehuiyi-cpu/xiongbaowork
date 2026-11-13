/*
 * 群组与群聊合一（PR3，设计稿 5.5）：台账 `waker_group_upgrades.original_owner` 写入后不可改。
 *
 * 0210 把整表的 UPDATE 授给了 `openbot_app`，`original_owner` 不变只靠应用代码记得。回滚手册第 1 步靠这一列
 * 认出已经被移交过的转换群组（3.1.1 第 5 条），被悄悄改写时没有任何报错，原主就可能永久丢失群组。这里把表级
 * UPDATE 收回，按列重新授权：除 `original_owner` 外各列照旧可改，改 `original_owner` 一律 42501（`platform`
 * 帧也一样，列权限不看帧）。INSERT、SELECT、DELETE 不变，首次写入照旧带上它。
 *
 * 不影响的写入方：
 * - 升级任务（S/waker-groups/upgrade.ts）续做时只改 `channel_id`、`outcome`、`dropped_agent_ids`、`started_at`、
 *   `updated_at`，`ON CONFLICT DO UPDATE` 也不列 `original_owner`。
 * - 0210 的移交写入函数只改 `tenant_id`，并且以属主身份运行（SECURITY DEFINER），不受应用账号的权限约束。
 *
 * 0210 已经提交，按「只能追加」不改它，另起 0211。
 *
 * 执行身份：改授权要表的属主，文件开头照 0122 自检。
 *
 * 回滚：换回旧镜像无害，旧代码不读这张表；要恢复整表 UPDATE，属主执行
 * `GRANT UPDATE ON public.waker_group_upgrades TO openbot_app;`。
 */
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0211 must run as a role with BYPASSRLS (owner of waker_group_upgrades)';
  END IF;
END $$;
--> statement-breakpoint
REVOKE UPDATE ON "public"."waker_group_upgrades" FROM openbot_app;
--> statement-breakpoint
GRANT UPDATE (group_id, tenant_id, channel_id, outcome, dropped_agent_ids, started_at, updated_at) ON "public"."waker_group_upgrades" TO openbot_app;

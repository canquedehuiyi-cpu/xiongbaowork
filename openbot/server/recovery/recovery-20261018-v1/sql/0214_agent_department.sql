/*
 * 员工部门（聊天工作台 Task 6）：`agent_profiles` 加一列 `department`，通讯录按它把员工分组（组织架构）。
 *
 * - 可空文本，至多 32 个字符（`char_length`，按字计，和接口、包加载的上限一致）；为空表示没有部门，
 *   通讯录里归「未分组」。
 * - 预设员工的部门由包里的 `department:` 写入（包同步），召唤时随复制带到副本；主人可在员工设置里改。
 * - 不回填：此前召唤出的副本没有部门，读取时回退到 `summoned_from` 来源预设的部门（应用层，不改数据）。
 *
 * 可空、无默认值，换回旧镜像无害（旧代码不读）。
 * 授权：应用角色已持有 `agent_profiles` 的表级权限，新增列自动继承，不另行授权。
 *
 * 回滚：先删约束 `agent_profiles_department_length`，再删列 `department`。
 */
ALTER TABLE "public"."agent_profiles" ADD COLUMN "department" text;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_department_length" CHECK ("department" IS NULL OR char_length("department") <= 32);

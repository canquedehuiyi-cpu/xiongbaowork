/*
 * 服务器行上两个原来只能给占位值的字段，各加一列记真值（X7-2）。
 *
 * - `mcp_servers.skipped_tools`（上游 0059_skipped_tools）：上一次存下清单时，因为名字不能交给模型而略过的
 *   动作，照厂商的拼法。是对一次成功刷新的提醒，不是失败，所以不进 `last_error`：一个一直列出带点名字的
 *   服务器否则会在插件列表上永远显示成坏的。NULL 和空数组都是「没有」；下一次干净的刷新写回 NULL。
 * - `mcp_servers.owner_grants_chosen_at`：管理员明确选「谁可以把这个应用给员工」（`owner_grants`，0197）
 *   的时刻。只有管理员的 PUT 写它；回到默认值时清空。0197 把升级前已有的应用回填成 `admin`、切换账号模式
 *   每次写回 `admin`，那两处不写它，所以读的人分得出「管理员选的 admin」和「不是谁选的 admin」。
 *
 * 两列都可空、没有默认值、不回填：升级不替任何人做决定。这之前管理员已经选过的 `admin` 因此读作没选过
 * （当时没有记号可查）；`any` 只有管理员的 PUT 能写，没有记号也读作选过。
 *
 * 行级安全不变：`mcp_servers` 的策略按行，不按列，新列随所在的行（0122 的 team_write：应用行只有持有能力
 * 的管理员能写）。不碰 0122 行守卫看着的租户与关联列。
 */
ALTER TABLE "public"."mcp_servers" ADD COLUMN "skipped_tools" text[];
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD COLUMN "owner_grants_chosen_at" timestamp with time zone;

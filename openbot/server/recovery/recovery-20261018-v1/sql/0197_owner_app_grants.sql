/*
 * 员工的主人自己给员工应用（X3，上游 0064_owner_app_grants，按 fork 改写）。
 *
 * - `mcp_servers.owner_grants`：谁可以把这个应用给员工。`any` 员工的主人可以自己给，`admin` 只有管理员，
 *   NULL 用按账号的默认值（`plugins/app-access.ts` 的 `ownerGrantsOf`：跑在提问人自己账号上的应用和内置的
 *   例行任务默认 `any`，其余 `admin`）。只有持有能力的管理员写（应用行是 `team` 标记，0122 的
 *   team_write 策略）。
 * - `plugin_grants.granted_as`：这条授予是谁做的。`admin`（NULL 也读作管理员，即这之前的每一条授予），或
 *   员工的主人把自己的应用给了自己的员工（`owner`）。主人做的授予在别人的 Team Bot 调用里永远用提问人
 *   自己的账号，不用主人的（`team-bots.ts` 的 `credentialActorFor`）：发布员工不能把主人的邮箱交给队友。
 *   管理员在同一个动作上再授予一次，这条就成了管理员的；主人的授予不会覆盖管理员的。
 *
 * 回填（与上游不同）：这之前已经添加的每个应用都设为 `admin`，升级不改变谁能把它给员工——原来只有
 * 管理员（上架、批准申请），升级后仍然如此，直到管理员在应用设置里明确放开「主人可授予」（`any`）。
 * 这之后新添加的应用为 NULL，按上游的默认值。`granted_as` 不回填：NULL 读作管理员，正是这之前每一条授予
 * 的含义。行安全不变（两张表原有的策略都按行而不是按列）。
 *
 * 应用行有 `team` 标记，FORCE 行安全对表的属主也生效，所以回填在本事务里以 `platform` 帧做，结束时清掉
 * （与 0125 相同的写法）；只改 `owner_grants`，不碰 0122 行守卫看着的租户与关联列。
 */
ALTER TABLE "public"."mcp_servers" ADD COLUMN "owner_grants" text;
--> statement-breakpoint
ALTER TABLE "public"."plugin_grants" ADD COLUMN "granted_as" text;
--> statement-breakpoint
ALTER TABLE "public"."mcp_servers" ADD CONSTRAINT "mcp_servers_owner_grants_check" CHECK ("owner_grants" IS NULL OR "owner_grants" IN ('any', 'admin'));
--> statement-breakpoint
ALTER TABLE "public"."plugin_grants" ADD CONSTRAINT "plugin_grants_granted_as_check" CHECK ("granted_as" IS NULL OR "granted_as" IN ('admin', 'owner'));
--> statement-breakpoint
SELECT set_config('app.tenant_id', 'platform', true);
--> statement-breakpoint
UPDATE "public"."mcp_servers" SET "owner_grants" = 'admin' WHERE "owner_grants" IS NULL;
--> statement-breakpoint
SELECT set_config('app.tenant_id', '', true);

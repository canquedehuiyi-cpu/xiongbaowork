/*
 * 申请访问并入上游的应用访问审批（上游 0060，X2）：一条申请也可以是关于一个这里还没有行的应用。
 *
 * fork 0153 的申请总是指向一行 `mcp_servers`（`server_id` 外键）。上游的申请按应用的键（`app_key`）记，
 * 可以请管理员打开一个还没添加的目录条目或 broker 应用。合成一套的写法是差异迁移，不另建表：
 * - `server_id` 改为可空；没有行的申请记 `app_key` 与 `app_title`（提出时的应用名，收件箱照它显示）。
 *   CHECK 保证两者至少有一个，申请永远说得出是哪个应用。
 * - 有行的申请照旧只记 `server_id`，键和名字在读的时候从行上取，所以 0153 起已有的申请不用回填，原样
 *   带过来。
 * - 去重索引改为按 `coalesce(server_id, app_key)`：有行时与 0153 完全相同，没行时按键去重（NULL 在唯一
 *   索引里互不相等，不改就会让同一个申请重复）。
 *
 * 不变的：`kind` 仍只收 enable 与 grant（`connect_shared` 不收，fork 测试钉住）；行仍属于申请人的租户，
 * ENABLE + FORCE 行安全与四条 tenant_isolation 策略、给 openbot_app 的授权都是 0153 的，这里不动。
 */
ALTER TABLE "public"."app_access_requests" ALTER COLUMN "server_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD COLUMN "app_key" text;
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD COLUMN "app_title" text;
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD CONSTRAINT "app_access_requests_app_named" CHECK ("server_id" IS NOT NULL OR ("app_key" IS NOT NULL AND "app_title" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "public"."app_access_requests" ADD CONSTRAINT "app_access_requests_app_key_length" CHECK (("app_key" IS NULL OR char_length("app_key") <= 200) AND ("app_title" IS NULL OR char_length("app_title") <= 200));
--> statement-breakpoint
DROP INDEX "public"."app_access_requests_pending_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "app_access_requests_pending_idx" ON "public"."app_access_requests" USING btree ("tenant_id", "requester_user_id", "bot_id", coalesce("server_id", "app_key"), "kind") WHERE "status" = 'pending';

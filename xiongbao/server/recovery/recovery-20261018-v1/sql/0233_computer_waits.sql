/*
 * 员工在后台等人接管、等人输密码，等满后留下的记录（0233，期九·三）：`computer_waits`。
 *
 * - 目的：员工在服务器上跑的轮，遇到「请人接管」「请人输入一个值」时在工具里等最多 10 分钟，人交还或填完，
 *   这一轮接着跑。等满 10 分钟请求还开着，这一轮以「需要你」结束；这一行就是那时留下的，里面存着这一轮停下
 *   的位置（和审批存的是同一种快照）。服务器每隔几秒读一次电脑的状态，人交还、填完或取消后，从这一行把
 *   这一轮接着跑完（`server/src/computer/waits.ts`）。登录请求不用这张表，它自己的记录在 `sign_in_requests`。
 * - 列：`kind`（`help` / `secret`，CHECK 约束）、`request_id`（电脑里接管请求的编号；输入值没有）、`label`
 *   （问人的话）、`continuation`（这一轮停下的快照，不含任何密码）、`status`（`waiting` / `resuming` /
 *   `done`，CHECK 约束）、`attempts`、`lease_until`（续跑时的租约）。
 * - 已有数据：新表，没有回填。
 * - 索引：只给没结束的行建，扫描按创建时间取。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部（续跑的扫描在 platform 帧里找行，
 *   在行自己的租户帧里续跑）；FORCE 让表的属主也受约束。
 *
 * 回滚：DROP TABLE "public"."computer_waits";
 */
CREATE TABLE "public"."computer_waits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "owner_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "kind" text NOT NULL,
  "request_id" text,
  "label" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "continuation" jsonb NOT NULL,
  "status" text DEFAULT 'waiting' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "computer_waits_kind" CHECK ("kind" IN ('help', 'secret')),
  CONSTRAINT "computer_waits_status" CHECK ("status" IN ('waiting', 'resuming', 'done'))
);
--> statement-breakpoint
CREATE INDEX "computer_waits_open_idx" ON "public"."computer_waits" USING btree ("status", "created_at") WHERE "status" <> 'done';
--> statement-breakpoint
ALTER TABLE "public"."computer_waits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."computer_waits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."computer_waits" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."computer_waits" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."computer_waits" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."computer_waits" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."computer_waits" TO openbot_app;

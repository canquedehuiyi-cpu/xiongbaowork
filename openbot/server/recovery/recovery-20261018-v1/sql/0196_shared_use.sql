/*
 * 共享使用批准（X3，上游 0052 的 shared_use 三张表与 0065 的 approved_as，按 fork 改写）。
 *
 * 一个 Shared 应用对所有人都是部署的同一个团队账号，所以一位员工被开放给多少人，就等于把这个账号交给了
 * 多少人。这里记管理员批准了什么：某位员工用某个 Shared 应用时，谁可以驾驶这次运行（`audience`：只有主人
 * 与管理员 `owner`、名单上的人与群组 `people`、任何登录的人 `team`），以及外部输入（渠道、Webhook 等
 * 职责来源）能不能驱动它（`outside_input`）。没有批准行就拒绝，管理员也不例外（X1 评审 C1 的闸门）。
 *
 * - `shared_use_approvals`：一位员工在一个应用上一行。`approved_as` 是谁定的：管理员（`admin`，NULL 也
 *   读作管理员），或员工的主人在管理员允许主人决定时自己给的（`owner`，X3 第二部分接上）。
 * - `shared_use_approval_members`：`people` 批准时的名单快照。群组按名字记，谁在群组里仍由目录决定；
 *   之后才加到员工发布名单里的人不在这里，要管理员再批准一次。
 * - `shared_use_requests`：请管理员批准或放宽的申请。提议永远是服务端按员工当前的开放范围算的，不是
 *   申请人写的，所以批准的就是下一次调用会被检查的。
 *
 * 租户：三张表的行都属于员工的主人（个人租户），写法照 0153：tenant_id、ENABLE + FORCE RLS、四条
 * tenant_isolation 策略（本人的帧，或 platform 帧）、GRANT openbot_app，以及「必须是个人租户」的 CHECK。
 * 不建 `team` 标记的共享表（0122 的共享表集合是固定的）。别人用这位员工时，服务端按 `agents/bot-owner.ts`
 * 的身份读取在主人的帧里读批准（与 SEC1 读员工安全底线同一种做法，只读、不写），不放宽任何策略。管理员
 * 批准经已有的 `asBotOwner`（`adminActAsOwner`）在主人的帧里写；收件箱列出所有人的申请经插件路由已有的
 * 那道 `asAdminPlatform`。
 *
 * 主键与每一条索引都以 tenant_id 开头：别人在自己租户里写一行同样员工、同样应用的行，占不住主人的键，
 * 而且服务端只在员工真正的主人的帧里读，那样的行永远不会被读到。申请照 0153 的 `decided` 约束：只有
 * 待处理的申请没有决定时刻，作废（superseded）也算决定。没有主人的员工（目录里的公开员工）没有
 * 可以记批准的租户，团队账号对它们一律拒绝。
 *
 * 无回填：这之前没有任何批准。
 */
CREATE TABLE "public"."shared_use_approvals" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "audience" text NOT NULL,
  "outside_input" boolean NOT NULL,
  "approved_by" text NOT NULL,
  "approved_as" text,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_use_approvals_pkey" PRIMARY KEY ("tenant_id", "agent_id", "server_id"),
  CONSTRAINT "shared_use_approvals_audience_check" CHECK ("audience" IN ('owner', 'people', 'team')),
  CONSTRAINT "shared_use_approvals_approved_as_check" CHECK ("approved_as" IS NULL OR "approved_as" IN ('admin', 'owner')),
  CONSTRAINT "shared_use_approvals_tenant_person" CHECK ("tenant_id" NOT IN ('system', 'platform', 'team'))
);
--> statement-breakpoint
CREATE TABLE "public"."shared_use_approval_members" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "shared_use_approval_members_pkey" PRIMARY KEY ("tenant_id", "agent_id", "server_id", "kind", "value"),
  CONSTRAINT "shared_use_approval_members_kind_check" CHECK ("kind" IN ('user', 'group')),
  CONSTRAINT "shared_use_approval_members_tenant_person" CHECK ("tenant_id" NOT IN ('system', 'platform', 'team'))
);
--> statement-breakpoint
CREATE TABLE "public"."shared_use_requests" (
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "proposed_audience" text NOT NULL,
  "proposed_outside_input" boolean NOT NULL,
  "proposed_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "requested_by" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_use_requests_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "shared_use_requests_audience_check" CHECK ("proposed_audience" IN ('owner', 'people', 'team')),
  CONSTRAINT "shared_use_requests_reason_check" CHECK ("reason" IN ('publish', 'trigger', 'grant', 'refused_call')),
  CONSTRAINT "shared_use_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'declined', 'superseded')),
  CONSTRAINT "shared_use_requests_decided" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "shared_use_requests_tenant_person" CHECK ("tenant_id" NOT IN ('system', 'platform', 'team'))
);
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approval_members" ADD CONSTRAINT "shared_use_approval_members_approval_fk" FOREIGN KEY ("tenant_id", "agent_id", "server_id") REFERENCES "public"."shared_use_approvals" ("tenant_id", "agent_id", "server_id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_requests" ADD CONSTRAINT "shared_use_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_requests" ADD CONSTRAINT "shared_use_requests_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "shared_use_requests_pending_idx" ON "public"."shared_use_requests" USING btree ("tenant_id", "agent_id", "server_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "shared_use_requests_status_idx" ON "public"."shared_use_requests" USING btree ("tenant_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "shared_use_approvals_server_idx" ON "public"."shared_use_approvals" USING btree ("tenant_id", "server_id");
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."shared_use_approvals" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."shared_use_approvals" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."shared_use_approvals" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."shared_use_approvals" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."shared_use_approvals" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approval_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_approval_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."shared_use_approval_members" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."shared_use_approval_members" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."shared_use_approval_members" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."shared_use_approval_members" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."shared_use_approval_members" TO openbot_app;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."shared_use_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."shared_use_requests" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."shared_use_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."shared_use_requests" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."shared_use_requests" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."shared_use_requests" TO openbot_app;

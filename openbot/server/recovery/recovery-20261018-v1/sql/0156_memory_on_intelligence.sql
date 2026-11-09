/*
 * 个人记忆在接入并有权使用 CopilotKit Intelligence 时同步进 Intelligence（上游 0054，#773）。
 * 只加两列和一个索引；`personal_memories` 的租户列与行级安全不变。没有接入 Intelligence 的部署
 * 这两列一直为空。
 */
ALTER TABLE "personal_memories" ADD COLUMN "intelligence_memory_id" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "intelligence_digest" text;--> statement-breakpoint
CREATE INDEX "personal_memories_intelligence_idx" ON "personal_memories" USING btree ("owner_user_id","intelligence_memory_id");

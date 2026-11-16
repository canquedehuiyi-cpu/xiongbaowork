/*
 * 召唤员工（Task 1）：`agent_profiles` 加两列，记下一位员工是从哪个预设召唤出来的。
 *
 * - `summoned_from`：召唤来源的 `agents.id`，删来源时置空（`ON DELETE SET NULL`），员工本身不受影响。
 *   手工创建的员工为空。
 * - `preset_portrait`：这位员工使用的预设形象键，取值与 0204 里 `portraits_preset` 的 50 个键相同
 *   （5 个表情 + 45 个角色脸）；为空表示没有预设形象。
 *
 * 部分唯一索引 `agent_profiles_owner_summoned_from_unique`：同一位主人对同一个来源，同时只能有一位
 * 未删除的召唤员工；软删后（`deleted_at` 有值）可以再召唤一次。
 *
 * 不回填：此前没有召唤功能，所有已有行两列都为空。两列都可空、无默认值，换回旧镜像无害（旧代码不读）。
 * 授权：`openbot_app` 已持有 `agent_profiles` 的表级权限，新增列自动继承，不另行授权。
 *
 * 回滚：先 `DROP INDEX agent_profiles_owner_summoned_from_unique`，再删这两列。
 */
ALTER TABLE "public"."agent_profiles" ADD COLUMN "summoned_from" text REFERENCES "public"."agents"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD COLUMN "preset_portrait" text;
--> statement-breakpoint
ALTER TABLE "public"."agent_profiles" ADD CONSTRAINT "agent_profiles_preset_portrait" CHECK ("preset_portrait" IS NULL OR "preset_portrait" IN ('naughty', 'cute', 'cool', 'happy', 'sweet', 'doctor', 'teacher', 'chef', 'tech-engineer', 'financial-advisor', 'lawyer', 'construction-engineer', 'farmer', 'courier', 'pilot', 'firefighter', 'tour-guide', 'journalist', 'creative-designer', 'fitness-coach', 'general-manager', 'accountant', 'operations-director', 'designer', 'director', 'programmer', 'social-media-operator', 'actor', 'singer', 'product-manager', 'data-analyst', 'marketing-director', 'hr-manager', 'legal-advisor', 'customer-service-manager', 'founder-assistant', 'project-manager', 'admin-specialist', 'sales-consultant', 'business-development', 'customer-success', 'copywriter', 'brand-planner', 'ad-specialist', 'store-manager', 'live-stream-operator', 'private-domain-operator', 'automation-engineer', 'test-engineer', 'security-officer'));
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_owner_summoned_from_unique" ON "public"."agent_profiles" ("owner_user_id", "summoned_from") WHERE "summoned_from" IS NOT NULL AND "deleted_at" IS NULL;

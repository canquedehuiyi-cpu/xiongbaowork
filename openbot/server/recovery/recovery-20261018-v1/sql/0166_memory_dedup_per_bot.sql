/*
 * 上游 0070：员工形成的记忆按员工去重，而不是按人。
 */
DROP INDEX "personal_memories_formed_digest_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "personal_memories_formed_digest_per_bot_idx" ON "personal_memories" USING btree ("owner_user_id","formed_by_agent_id","import_digest") WHERE "personal_memories"."formed_by" = 'bot';

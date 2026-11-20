/*
 * 个人记忆的向量（0235，期 2 · Task 2.3）：新表 `memory_embeddings`，一条记忆一行。
 *
 * - 目的：每轮按和用户最新一条消息的语义相关程度挑记忆（`server/src/memory/rank.ts`、`vectors.ts`）。向量由
 *   部署配置的、兼容 OpenAI 接口的向量服务算出（`XIONGBAO_EMBEDDING_*`），第一次要用到这条记忆时才算、存在这里；
 *   没配向量服务或服务不可用时，这张表不被读也不被写，记忆照旧按词的相关程度排序。
 * - 为什么不是 `personal_memories` 上的一列：那张表的 schema 文件被恢复守卫按字节钉住，不能动；向量也是由记忆
 *   正文派生出来的数据，单独一张表，丢了可以重算。
 * - 为什么是 `real[]` 而不是 pgvector 的 `vector`：`vector` 扩展在 `0010_drop_the_document_index` 里已经随文档索引
 *   一起删掉了，部署的数据库不一定带着它（托管的 PostgreSQL 常常没有），迁移不能因此失败。一个人的记忆只有几十到
 *   几百条，候选先被限在最近的 40 条，余弦相似度在进程里算，不需要索引。
 * - 列：`memory_id`（主键，外键到 `personal_memories.id`，记忆删除时跟着删）、`tenant_id`、`model`（算它用的模型，
 *   换了模型旧向量不再用）、`dims`、`embedding`、`content_digest`（算它时正文的 sha256，正文改过就重算）、
 *   `created_at`。
 * - 已有数据：新表，没有回填：用到时才算。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部；FORCE 让表的属主也受约束。
 * - 授权：应用角色 `openbot_app` 对这张表有增删改查，和 0232、0233 一样；不授权，应用连上来读写会被拒。
 *
 * 回滚：DROP TABLE "public"."memory_embeddings";
 */
CREATE TABLE "public"."memory_embeddings" (
  "memory_id" text PRIMARY KEY NOT NULL REFERENCES "public"."personal_memories"("id") ON DELETE CASCADE,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "model" text NOT NULL,
  "dims" integer NOT NULL,
  "embedding" real[] NOT NULL,
  "content_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memory_embeddings_dims" CHECK ("dims" > 0 AND cardinality("embedding") = "dims")
);
--> statement-breakpoint
ALTER TABLE "public"."memory_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."memory_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."memory_embeddings" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."memory_embeddings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."memory_embeddings" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."memory_embeddings" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."memory_embeddings" TO openbot_app;

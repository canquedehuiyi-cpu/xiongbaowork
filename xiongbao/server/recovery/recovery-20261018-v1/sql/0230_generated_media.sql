/*
 * 员工生成的图片和视频（0230，期五 C）：`generate_image`、`generate_video` 存下来的文件。
 *
 * - 目的：新表 `generated_media`，一行一个文件，字节、类型（按文件头判定）、哪位员工生成的、提示词、
 *   用的哪个服务和模型。服务器在 `/api/media/:id` 把它给登录的、生成时那一轮的那个人看。生成服务给的
 *   链接是临时的、在别人的 CDN 上，员工的电脑也不一定存在，所以图片存在部署自己这里。
 * - 大小：一行最多 50 MiB（视频的上限），`size_bytes` 必须等于实际字节数。
 * - 已有数据：新表，没有回填。
 * - 行级安全：和其它租户表一样，本人的帧读写自己的行，platform 帧读写全部；FORCE 让表的属主也受约束。
 *
 * 回滚：DROP TABLE "public"."generated_media";
 */
CREATE TABLE "public"."generated_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text DEFAULT current_setting('app.tenant_id', true) NOT NULL,
  "agent_id" text NOT NULL,
  "kind" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "bytes" bytea NOT NULL,
  "prompt" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "generated_media_kind" CHECK ("kind" IN ('image', 'video')),
  CONSTRAINT "generated_media_mime_type" CHECK ("mime_type" IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm')),
  CONSTRAINT "generated_media_bytes_size" CHECK (octet_length("bytes") <= 52428800 AND "size_bytes" = octet_length("bytes")),
  CONSTRAINT "generated_media_prompt_length" CHECK (char_length("prompt") <= 4000)
);
--> statement-breakpoint
CREATE INDEX "generated_media_tenant_idx" ON "public"."generated_media" USING btree ("tenant_id", "agent_id", "created_at");
--> statement-breakpoint
ALTER TABLE "public"."generated_media" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."generated_media" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."generated_media" AS PERMISSIVE FOR SELECT TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."generated_media" AS PERMISSIVE FOR INSERT TO public WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_update" ON "public"."generated_media" AS PERMISSIVE FOR UPDATE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
CREATE POLICY "tenant_isolation_delete" ON "public"."generated_media" AS PERMISSIVE FOR DELETE TO public USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "public"."generated_media" TO openbot_app;

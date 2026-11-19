/*
 * 群聊里员工生成的图片和视频，群里其他成员也能看（0231，期五 C 跟进）。
 *
 * - 目的：0230 的行级安全只认「为谁生成的」那个租户，群里别的成员打开 `/api/media/:id` 是 404。新增一列
 *   `channel_id`，记下它是在哪个共享群里生成的；读的规矩改成：没有频道（单聊）的行只给本人，有频道的行给
 *   「现在还在这个群里」的人，用群里其它行同一个函数 `openbot_team_channel_member`（0122）判断，所以退群后
 *   读不到，生成它的人退群后也读不到。platform 帧照旧读全部。
 * - 写：存进某个群的行，只有群里的人才能存（platform 帧不受限）；update、delete 的规矩不变。
 * - 租户隔离：没有频道的行读写都和 0230 一样按租户；`channel_id` 只在共享群（`team`）里才会写，别的租户
 *   既读不到，也不能把媒体塞进自己不在的群。
 * - 已有数据：新列可空，已有行都是单聊，读法不变。频道删除时它的媒体跟着删（ON DELETE CASCADE）。
 *
 * 回滚：DROP POLICY "tenant_isolation" ON "public"."generated_media"; 按 0230 重建 select 与 insert 两条策略
 * （USING / WITH CHECK 都用 tenant_id = current_setting('app.tenant_id', true) OR current_setting(...) = 'platform'）；
 * DROP INDEX "generated_media_channel_idx"; ALTER TABLE "public"."generated_media" DROP COLUMN "channel_id";
 */
ALTER TABLE "public"."generated_media" ADD COLUMN "channel_id" text;
--> statement-breakpoint
ALTER TABLE "public"."generated_media" ADD CONSTRAINT "generated_media_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "generated_media_channel_idx" ON "public"."generated_media" USING btree ("channel_id") WHERE "channel_id" IS NOT NULL;
--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "public"."generated_media";
--> statement-breakpoint
DROP POLICY "tenant_isolation_insert" ON "public"."generated_media";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "public"."generated_media" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.tenant_id', true) = 'platform' OR (channel_id IS NULL AND tenant_id = current_setting('app.tenant_id', true)) OR (channel_id IS NOT NULL AND public.openbot_team_channel_member(channel_id)));
--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "public"."generated_media" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform') AND (channel_id IS NULL OR current_setting('app.tenant_id', true) = 'platform' OR public.openbot_team_channel_member(channel_id)));

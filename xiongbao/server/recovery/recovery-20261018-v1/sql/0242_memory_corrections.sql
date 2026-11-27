/*
 * 记忆的纠正信号（0242，借鉴改进 PR 3 · Task 4）：`personal_memories` 加三列。
 *
 * - `from_correction`（boolean，非空，默认 false）：这条是本人纠正员工时抽出来的。
 * - `correction_count`（integer，非空，默认 0）：本人就这件事纠正过几次；不是纠正的为 0。
 * - `replaces_id`（text，可空）：本人确认后要取代的同一本人的另一条记忆。故意不加外键：旧条退役走现有删除
 *   路径（留墓碑，不删行），删除时由代码把别的行里指向它的引用清空。
 * - 已有数据：不回填，旧的行取默认值，与以前一样。
 * - 授权：表级的增删改查授权已覆盖新列，无需另写 GRANT。
 *
 * 回滚：
 *   ALTER TABLE "public"."personal_memories" DROP COLUMN "replaces_id";
 *   ALTER TABLE "public"."personal_memories" DROP COLUMN "correction_count";
 *   ALTER TABLE "public"."personal_memories" DROP COLUMN "from_correction";
 */
ALTER TABLE "public"."personal_memories" ADD COLUMN "from_correction" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."personal_memories" ADD COLUMN "correction_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."personal_memories" ADD COLUMN "replaces_id" text;

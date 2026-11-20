/*
 * 自写技能带上来源请求的指纹（0238，期 2 验收修复）：`learned_skills` 加一列 `source_fingerprint`。
 *
 * - 目的：复盘写出的技能把人名、日期、文件名都换成了占位，「什么时候用」很泛，同类任务第二次的请求（看板派活
 *   常常只是一句「先读 …/TASK.md」）和它的字对不上，技能没被放进上下文。存下来源请求的指纹，挑选时拿新请求和
 *   指纹比，同类任务就稳定命中。
 * - 列：`source_fingerprint`（text，可空）：一段 JSON，`{"t": [...], "q": [...]}`，是来源请求前 200 字里的词的
 *   哈希（各 6 位十六进制），`q` 是其中引号里的词。只存哈希，不存请求原文，避免个人数据落库。员工自己调用工具写的
 *   技能没有来源请求，是空。
 * - 已有数据：不回填，旧的行是空，挑选时只靠技能自己的字，和以前一样。
 * - 授权：表上已有应用角色 `openbot_app` 的增删改查（0234），新列随表授权；下面的 GRANT 再写一遍，重复执行无害。
 *
 * 回滚：ALTER TABLE "public"."learned_skills" DROP COLUMN "source_fingerprint";
 */
ALTER TABLE "public"."learned_skills" ADD COLUMN "source_fingerprint" text;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."learned_skills" TO openbot_app;

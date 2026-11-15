/*
 * 压缩会话的分隔线要写「较早的 N 条消息已总结」。
 *
 * - 目的：`thread_compactions.summarized_count`，这次压缩之后被摘要替代的消息条数（含更早几次压缩已经替代的），
 *   界面的分隔线和「看摘要」用它。可空：0216 之后、本迁移之前写的记录没有这个数，界面不写 N。
 * - 回填：无。
 * - 授权：新列继承原表权限与 RLS。
 *
 * 回滚：删列 `summarized_count`。
 */
ALTER TABLE "public"."thread_compactions" ADD COLUMN "summarized_count" integer;

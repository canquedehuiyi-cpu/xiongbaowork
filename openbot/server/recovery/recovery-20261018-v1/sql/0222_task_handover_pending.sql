/*
 * 换人接手的交接待发（spec docs/specs/2026-11-15-delivery-loop.md 第 8 节）。
 *
 * - 目的：换人时，交接消息（标题、验收标准、已经交过的、上一位员工最后的进度）当场发给新员工；如果新员工
 *   的线程正忙，这一轮开不起来，而换人本身已经提交。原来之后只有核对器的通用催办，交接内容就丢了。
 *   加一列 `handover_pending_at`：换人时和换人写在同一个事务里，记下「交接还没发出去」；交接那一轮
 *   开起来后清空。核对器看到它时，在线程空闲后发交接消息，而不是通用催办。新员工接下（`accepted_at`）
 *   时也清空。
 * - 已有的行取默认值（空），即没有待发的交接。
 * - 行级安全不变：`tasks` 原有的按租户策略照样约束这一列。
 *
 * 回滚：删列 `handover_pending_at`。
 */
ALTER TABLE "public"."tasks" ADD COLUMN "handover_pending_at" timestamp with time zone;

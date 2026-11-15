import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** 上下文占用的五个分类，各占 0-1 的比例，和为 1。 */
export type ContextShares = {
  messages: number;
  system: number;
  tools: number;
  skills: number;
  memory: number;
};

/**
 * 一次运行时上下文各部分的占比快照（对话侧栏的「上下文」分类条）。
 *
 * 只存比例，不存内容：总量来自 `model_token_calls` 的真实用量，这里只回答“占的是什么”。
 * 每个员工在每个对话里各有自己的序列，侧栏取最新一行。迁移 0216。
 */
export const threadContextBreakdowns = pgTable(
  "thread_context_breakdowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    runId: text("run_id").notNull(),
    shares: jsonb("shares").$type<ContextShares>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("thread_context_breakdowns_thread_idx").on(
      table.tenantId,
      table.threadId,
      table.agentId,
      table.createdAt,
    ),
  ],
);

/**
 * 一次上下文压缩：把某条消息之前的历史换成一段摘要（自动或人手动触发）。
 *
 * `uptoMessageId` 是摘要覆盖到的最后一条消息，之后的消息照常进上下文；
 * `tokensBefore` / `tokensAfter` 供侧栏显示压缩省了多少。迁移 0216。
 */
export const threadCompactions = pgTable(
  "thread_compactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    uptoMessageId: text("upto_message_id").notNull(),
    summary: text("summary").notNull(),
    tokensBefore: integer("tokens_before"),
    tokensAfter: integer("tokens_after"),
    auto: boolean("auto").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("thread_compactions_thread_idx").on(
      table.tenantId,
      table.threadId,
      table.agentId,
      table.createdAt,
    ),
  ],
);

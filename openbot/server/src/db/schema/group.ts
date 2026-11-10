import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";

export const groupBotThreads = pgTable(
  "group_bot_threads",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerUserId, table.channelId, table.agentId],
    }),
    uniqueIndex("group_bot_threads_thread_idx").on(table.threadId),
  ],
);

export const groupMessages = pgTable(
  "group_messages",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    threadId: text("thread_id"),
    text: text("text").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "waiting" | "completed" | "failed">()
      .notNull()
      .default("completed"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("group_messages_channel_idx").on(
      table.channelId,
      table.createdAt,
      table.id,
    ),
    check(
      "group_messages_status_check",
      sql`${table.status} IN ('queued', 'running', 'waiting', 'completed', 'failed')`,
    ),
    // The key `group_message_private` hangs from, so a private row is always its sender's (0128).
    unique("group_messages_id_owner_unique").on(table.id, table.ownerUserId),
  ],
);

/**
 * What a Bot reply holds back from the group while it is not shown yet (0128): its partial text
 * while the Bot runs, and, while it waits on its sender, the held reply and the wait's details
 * (approval id, saved continuation). Stamped with the sender, read by nobody else; the shared
 * `group_messages` row keeps only the status and what every member's transcript shows.
 */
export const groupMessagePrivate = pgTable(
  "group_message_private",
  {
    messageId: text("message_id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    tenantId: tenantId(),
    text: text("text").notNull().default(""),
    details: jsonb("details").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "group_message_private_message_fk",
      columns: [table.messageId, table.ownerUserId],
      foreignColumns: [groupMessages.id, groupMessages.ownerUserId],
    }).onDelete("cascade"),
  ],
);

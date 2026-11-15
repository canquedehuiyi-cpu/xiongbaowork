import { sql } from "drizzle-orm";
import {
  check,
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
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** The states of one ACP turn, from the server queueing it to the device finishing it. */
export const ACP_TURN_STATUSES = [
  "queued",
  "sent",
  "running",
  "awaiting",
  "done",
  "interrupted",
  "cancelled",
] as const;
export type AcpTurnStatus = (typeof ACP_TURN_STATUSES)[number];

/**
 * One turn of an external ACP agent (Codex, Claude Code, Hermes) running on a tenant's own device.
 *
 * The turn is a row rather than an in-memory request so a server restart or a device reconnect can
 * resume it: `lastSeq` is the last event sequence number the server has taken in, which is where a
 * reconnecting device replays from. Migration 0215.
 */
export const acpTurns = pgTable(
  "acp_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    deviceId: text("device_id").notNull(),
    turnId: text("turn_id").notNull().unique(),
    status: text("status").$type<AcpTurnStatus>().notNull(),
    /** The prompt as ACP content blocks, kept so a turn that was never sent can be sent later. */
    prompt: jsonb("prompt").$type<unknown>().notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("acp_turns_tenant_thread_idx").on(
      table.tenantId,
      table.threadId,
      table.createdAt,
    ),
    check(
      "acp_turns_status_check",
      sql`${table.status} IN ('queued','sent','running','awaiting','done','interrupted','cancelled')`,
    ),
  ],
);

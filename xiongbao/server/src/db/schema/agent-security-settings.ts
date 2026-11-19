import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { SecurityFloorMode } from "../../approvals/types";
import { agents, users } from "./core";
import { tenantId } from "./tenant";

/**
 * One Bot's own security floors (SEC1 §4.1 B1, migration 0131), set by its owner and stamped with
 * the owner: the dangerous-command and sensitive-path switches, the paths added beside the defaults,
 * and the defaults switched off (a default is never removed, D8). No row means every default.
 *
 * Row security is the owner's alone (0099's owner policies and 0122's `_team_bot_` copies, command
 * for command); another person using the Bot reaches it only through the gate reading it in the
 * owner's frame. Not `agent_security_policies`, which stays dormant (D3).
 */
export const agentSecuritySettings = pgTable(
  "agent_security_settings",
  {
    tenantId: tenantId(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    dangerousCommands: text("dangerous_commands")
      .$type<SecurityFloorMode>()
      .notNull()
      .default("ask"),
    sensitivePaths: text("sensitive_paths")
      .$type<SecurityFloorMode>()
      .notNull()
      .default("ask"),
    extraSensitivePaths: text("extra_sensitive_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    disabledDefaultPaths: text("disabled_default_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "agent_security_settings_tenant_id_agent_id_pk",
      columns: [table.tenantId, table.agentId],
    }),
    check(
      "agent_security_settings_dangerous_commands_check",
      sql`${table.dangerousCommands} IN ('off', 'ask')`,
    ),
    check(
      "agent_security_settings_sensitive_paths_check",
      sql`${table.sensitivePaths} IN ('off', 'ask')`,
    ),
    check(
      "agent_security_settings_paths_bounded",
      sql`cardinality(${table.extraSensitivePaths}) <= 50 AND cardinality(${table.disabledDefaultPaths}) <= 50`,
    ),
    check(
      "agent_security_settings_tenant_person",
      sql`${table.tenantId} NOT IN ('system', 'platform', 'team')`,
    ),
  ],
).enableRLS();

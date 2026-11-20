import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./core";
import { skills } from "./plugins";
import { tenantId } from "./tenant";

const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/** 一条技能是员工自己调用 `save_skill` 写的，还是做完复盘后写的。 */
export type LearnedSkillOrigin = "tool" | "retrospect";

/**
 * 员工自己写下来的、自己生效的技能的账（迁移 0234，期 2 · Task 2.4）。
 *
 * 技能本身在 `skills` 里（和人写的同一张表、同一套授予）；这里只记是哪位员工写的、怎么来的、最近什么时候
 * 被用过：用来给每位员工的技能数量设上限、只让员工修改自己写的技能，以及让最近 30 天没用过的技能在挑选时
 * 降权。要共享给别的员工的技能不在这里，它们进 `local_skill_candidates` 等本人批准。
 */
export const learnedSkills = pgTable(
  "learned_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillSlug: text("skill_slug").notNull(),
    origin: text("origin").$type<LearnedSkillOrigin>().notNull(),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("learned_skills_tenant_slug_key").on(
      table.tenantId,
      table.skillSlug,
    ),
    index("learned_skills_agent_idx").on(table.agentId),
    check("learned_skills_origin", sql`${table.origin} IN ('tool', 'retrospect')`),
    foreignKey({
      name: "learned_skills_skill_fk",
      columns: [table.tenantId, table.skillSlug],
      foreignColumns: [skills.tenantId, skills.slug],
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "select",
      to: "public",
      using: tenantScope,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: tenantScope,
      withCheck: tenantScope,
    }),
    pgPolicy("tenant_isolation_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: tenantScope,
    }),
  ],
);

import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { personalMemories } from "./memory";
import { tenantId } from "./tenant";

const tenantScope = sql`tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = 'platform'`;

/**
 * 一条个人记忆的向量（迁移 0235，期 2 · Task 2.3）。向量是由记忆正文派生出来的数据：第一次要按语义挑记忆时才
 * 算，存在这里，记忆删除时跟着删，正文改过（`contentDigest` 对不上）或换了向量模型（`model` 对不上）就重算。
 * 列是 `real[]`，不是 pgvector 的 `vector`：见迁移的说明。
 */
export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    memoryId: text("memory_id")
      .primaryKey()
      .references(() => personalMemories.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    model: text("model").notNull(),
    dims: integer("dims").notNull(),
    embedding: real("embedding").array().notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "memory_embeddings_dims",
      sql`${table.dims} > 0 AND cardinality(${table.embedding}) = ${table.dims}`,
    ),
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

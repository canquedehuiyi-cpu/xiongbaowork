import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { approvalContinuations, approvalContinuationSteps, approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
type Column = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number | boolean;
};
type Index = {
  name: string;
  columns: {
    expression: string;
    isExpression: boolean;
    asc: boolean;
    nulls: string;
  }[];
  isUnique: boolean;
  concurrently: boolean;
  method: string;
  with: Record<string, unknown>;
};
type FK = {
  name: string;
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete: string;
  onUpdate: string;
};
type Policy = {
  name: string;
  as: string;
  for: string;
  to: string[];
  using?: string;
  withCheck?: string;
};
type Table = {
  name: string;
  schema: string;
  columns: Record<string, Column>;
  indexes: Record<string, Index>;
  foreignKeys: Record<string, FK>;
  compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
  uniqueConstraints: Record<string, unknown>;
  policies: Record<string, Policy>;
  checkConstraints: Record<string, { name: string; value: string }>;
  isRLSEnabled: boolean;
};
type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, Table>;
  [key: string]: unknown;
};
type Entry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
type Journal = { version: string; dialect: string; entries: Entry[] };

// Independent full28-column source matrix approved before implementation, not a historical150 table.
// central9255 SHA61ca3d5b4ea5287ef22f30c8522fdaa7b176587a98c7603de495a3f2b5a27742;
// matrix input69085 SHAb64ea803577c6f7c8563aea765b57d7fca2f24684adb0e17aa2288c671cd3a52.
const expectedRaw="{\n  \"public.approval_continuations\": {\n    \"name\": \"approval_continuations\",\n    \"schema\": \"\",\n    \"columns\": {\n      \"approval_id\": {\n        \"name\": \"approval_id\",\n        \"type\": \"text\",\n        \"primaryKey\": true,\n        \"notNull\": true\n      },\n      \"tenant_id\": {\n        \"name\": \"tenant_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": \"current_setting('app.tenant_id', true)\"\n      },\n      \"owner_user_id\": {\n        \"name\": \"owner_user_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"input_digest\": {\n        \"name\": \"input_digest\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"admission_id\": {\n        \"name\": \"admission_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"branch_kind\": {\n        \"name\": \"branch_kind\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"branch_target_id\": {\n        \"name\": \"branch_target_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"origin\": {\n        \"name\": \"origin\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"state\": {\n        \"name\": \"state\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"fence\": {\n        \"name\": \"fence\",\n        \"type\": \"bigint\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": 0\n      },\n      \"claim_owner\": {\n        \"name\": \"claim_owner\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"lease_until\": {\n        \"name\": \"lease_until\",\n        \"type\": \"timestamp with time zone\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"intent_id\": {\n        \"name\": \"intent_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"intent_fence\": {\n        \"name\": \"intent_fence\",\n        \"type\": \"bigint\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"proof_id\": {\n        \"name\": \"proof_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"receipt\": {\n        \"name\": \"receipt\",\n        \"type\": \"jsonb\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"last_reason\": {\n        \"name\": \"last_reason\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"completed_at\": {\n        \"name\": \"completed_at\",\n        \"type\": \"timestamp with time zone\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      }\n    },\n    \"indexes\": {\n      \"approval_continuations_owner_idx\": {\n        \"name\": \"approval_continuations_owner_idx\",\n        \"columns\": [\n          {\n            \"expression\": \"tenant_id\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          },\n          {\n            \"expression\": \"owner_user_id\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          },\n          {\n            \"expression\": \"state\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          }\n        ],\n        \"isUnique\": false,\n        \"concurrently\": false,\n        \"method\": \"btree\",\n        \"with\": {}\n      }\n    },\n    \"foreignKeys\": {\n      \"approval_continuations_approval_id_approval_requests_id_fk\": {\n        \"name\": \"approval_continuations_approval_id_approval_requests_id_fk\",\n        \"tableFrom\": \"approval_continuations\",\n        \"tableTo\": \"approval_requests\",\n        \"columnsFrom\": [\n          \"approval_id\"\n        ],\n        \"columnsTo\": [\n          \"id\"\n        ],\n        \"onDelete\": \"cascade\",\n        \"onUpdate\": \"no action\"\n      }\n    },\n    \"compositePrimaryKeys\": {},\n    \"uniqueConstraints\": {\n      \"approval_continuations_admission_id_unique\": {\n        \"name\": \"approval_continuations_admission_id_unique\",\n        \"nullsNotDistinct\": false,\n        \"columns\": [\n          \"admission_id\"\n        ]\n      }\n    },\n    \"policies\": {},\n    \"checkConstraints\": {\n      \"approval_continuations_state_check\": {\n        \"name\": \"approval_continuations_state_check\",\n        \"value\": \"\\\"approval_continuations\\\".\\\"state\\\" in ('ready','claimed','dispatched','unknown','completed')\"\n      },\n      \"approval_continuations_origin_check\": {\n        \"name\": \"approval_continuations_origin_check\",\n        \"value\": \"\\\"approval_continuations\\\".\\\"origin\\\" in ('current','legacy_unknown')\"\n      },\n      \"approval_continuations_legacy_check\": {\n        \"name\": \"approval_continuations_legacy_check\",\n        \"value\": \"\\\"approval_continuations\\\".\\\"origin\\\" <> 'legacy_unknown' or \\\"approval_continuations\\\".\\\"state\\\" not in ('ready','claimed','dispatched')\"\n      },\n      \"approval_continuations_receipt_check\": {\n        \"name\": \"approval_continuations_receipt_check\",\n        \"value\": \"(\\\"approval_continuations\\\".\\\"state\\\" = 'completed') = (\\\"approval_continuations\\\".\\\"receipt\\\" is not null and \\\"approval_continuations\\\".\\\"completed_at\\\" is not null)\"\n      },\n      \"approval_continuations_fence_check\": {\n        \"name\": \"approval_continuations_fence_check\",\n        \"value\": \"\\\"approval_continuations\\\".\\\"fence\\\" >= 0\"\n      }\n    },\n    \"isRLSEnabled\": true\n  },\n  \"public.approval_continuation_steps\": {\n    \"name\": \"approval_continuation_steps\",\n    \"schema\": \"\",\n    \"columns\": {\n      \"approval_id\": {\n        \"name\": \"approval_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"step_key\": {\n        \"name\": \"step_key\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"tenant_id\": {\n        \"name\": \"tenant_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": \"current_setting('app.tenant_id', true)\"\n      },\n      \"owner_user_id\": {\n        \"name\": \"owner_user_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"input_digest\": {\n        \"name\": \"input_digest\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"admission_id\": {\n        \"name\": \"admission_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"state\": {\n        \"name\": \"state\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"fence\": {\n        \"name\": \"fence\",\n        \"type\": \"bigint\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": 0\n      },\n      \"receipt\": {\n        \"name\": \"receipt\",\n        \"type\": \"jsonb\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"completed_at\": {\n        \"name\": \"completed_at\",\n        \"type\": \"timestamp with time zone\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      }\n    },\n    \"indexes\": {},\n    \"foreignKeys\": {\n      \"approval_continuation_steps_approval_id_approval_continuations_approval_id_fk\": {\n        \"name\": \"approval_continuation_steps_approval_id_approval_continuations_approval_id_fk\",\n        \"tableFrom\": \"approval_continuation_steps\",\n        \"tableTo\": \"approval_continuations\",\n        \"columnsFrom\": [\n          \"approval_id\"\n        ],\n        \"columnsTo\": [\n          \"approval_id\"\n        ],\n        \"onDelete\": \"cascade\",\n        \"onUpdate\": \"no action\"\n      }\n    },\n    \"compositePrimaryKeys\": {\n      \"approval_continuation_steps_approval_id_step_key_pk\": {\n        \"name\": \"approval_continuation_steps_approval_id_step_key_pk\",\n        \"columns\": [\n          \"approval_id\",\n          \"step_key\"\n        ]\n      }\n    },\n    \"uniqueConstraints\": {\n      \"approval_continuation_steps_admission_id_unique\": {\n        \"name\": \"approval_continuation_steps_admission_id_unique\",\n        \"nullsNotDistinct\": false,\n        \"columns\": [\n          \"admission_id\"\n        ]\n      }\n    },\n    \"policies\": {},\n    \"checkConstraints\": {\n      \"approval_continuation_steps_state_check\": {\n        \"name\": \"approval_continuation_steps_state_check\",\n        \"value\": \"\\\"approval_continuation_steps\\\".\\\"state\\\" in ('reserved','running','unknown','completed')\"\n      },\n      \"approval_continuation_steps_fence_check\": {\n        \"name\": \"approval_continuation_steps_fence_check\",\n        \"value\": \"\\\"approval_continuation_steps\\\".\\\"fence\\\" >= 0\"\n      }\n    },\n    \"isRLSEnabled\": true\n  }\n}\n";
assert.equal(createHash("sha256").update(expectedRaw).digest("hex"),"44cf91ebadfc907467d6b95dcb2df8fd02bf944479a959ee60e46f000e82bf7e");
const expected=JSON.parse(expectedRaw) as Record<string,Table>;
const parentUnique={"name": "approval_requests_id_tenant_owner_unique", "columns": ["id", "tenant_id", "owner_user_id"], "nullsNotDistinct": false};
const server=join(import.meta.dir,".."),overlay=join(server,"recovery/recovery-20261018-v1");
const migration=readFileSync(join(overlay,"sql/0101_ap2_parent_schema_reconcile_closed.sql"),"utf8");
const previousRaw=readFileSync(join(overlay,"meta/0100_snapshot.json"));assert.equal(previousRaw.length,498108);assert.equal(createHash("sha256").update(previousRaw).digest("hex"),"fd218591c0165512dbaf63a36fed8ddd775cc577d090083510329c6d6779fc93");
const previous=JSON.parse(previousRaw.toString("utf8")) as Snapshot;
const next=JSON.parse(readFileSync(join(overlay,"meta/0101_snapshot.json"),"utf8")) as Snapshot;
const journal=JSON.parse(readFileSync(join(overlay,"meta/_journal.json"),"utf8")) as Journal;
/** Every non-whitespace character must be a supported SQL token. Comments other than the exact
 * Drizzle separator, dollar quoting, parameters and executable bodies are intentionally unsupported. */
function tokenize(source: string): string[] {
  const input = source.replaceAll("--> statement-breakpoint", " ");
  const pattern =
    /\s+|"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*|\d+|::|->>|->|>=|<=|<>|\?&|\[|\]|[().,;=+><~]/y;
  const out: string[] = [];
  let at = 0;
  while (at < input.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(input);
    assert.ok(match, `unsupported SQL token at ${at}`);
    const token = match[0];
    at = pattern.lastIndex;
    if (!/^\s+$/.test(token)) out.push(token);
  }
  return out;
}
const expression = (s: string): string =>
  tokenize(s)
    .map((token) => (/^[A-Za-z_]/.test(token) ? token.toUpperCase() : token))
    .join(" ");
class Cursor {
  at = 0;
  constructor(readonly tokens: string[]) {}
  peek(): string {
    return this.tokens[this.at]?.toUpperCase() ?? "";
  }
  take(value: string): void {
    assert.equal(this.peek(), value.toUpperCase());
    this.at++;
  }
  id(): string {
    const token = this.tokens[this.at++];
    assert.ok(token && /^"[a-z][a-z0-9_]*"$/.test(token));
    return token.slice(1, -1);
  }
  table(): string {
    assert.equal(this.id(), "public");
    this.take(".");
    return this.id();
  }
  group(): string[] {
    this.take("(");
    let depth = 1;
    const start = this.at;
    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at++];
      if (token === "(") depth++;
      else if (token === ")") {
        depth--;
        if (depth === 0) return this.tokens.slice(start, this.at - 1);
      }
    }
    throw new Error("unclosed group");
  }
  ids(): string[] {
    const cursor = new Cursor(this.group());
    const result = [cursor.id()];
    while (cursor.peek()) {
      cursor.take(",");
      result.push(cursor.id());
    }
    return result;
  }
  finish(): void {
    assert.equal(this.at, this.tokens.length, "unconsumed SQL");
  }
}
function parts(tokens: string[], separator: string): string[][] {
  let depth = 0;
  let start = 0;
  const out: string[][] = [];
  for (let at = 0; at < tokens.length; at++) {
    if (tokens[at] === "(") depth++;
    if (tokens[at] === ")") depth--;
    assert.ok(depth >= 0);
    if (tokens[at] === separator && depth === 0) {
      assert.ok(at > start);
      out.push(tokens.slice(start, at));
      start = at + 1;
    }
  }
  assert.equal(depth, 0);
  if (start < tokens.length) out.push(tokens.slice(start));
  return out;
}
function put<T>(record: Record<string, T>, name: string, value: T): void {
  assert.ok(!Object.hasOwn(record, name), `duplicate ${name}`);
  record[name] = value;
}
function parseSQL(source: string): {
  tables: Record<string, Table>;
  forced: string[];
  parentUniques: Record<string,unknown>;
} {
  const out: Record<string, Table> = {};
  const forced: string[] = [];
  const parentUniques: Record<string,unknown> = {};
  const tokens = tokenize(source);
  assert.equal(tokens.at(-1), ";");
  for (const statement of parts(tokens, ";")) {
    const c = new Cursor(statement);
    if (c.peek() === "ALTER") {
      c.take("ALTER");
      c.take("TABLE");
      const name = c.table();
      if (name === "approval_requests") {
        c.take("ADD"); c.take("CONSTRAINT"); const constraint=c.id();
        c.take("UNIQUE"); const columns=c.ids(); c.finish();
        put(parentUniques,constraint,{name:constraint,columns,nullsNotDistinct:false});
        continue;
      }
      const table = out[`public.${name}`];
      assert.ok(table);
      if (c.peek() === "ADD") {
        c.take("ADD");
        c.take("CONSTRAINT");
        const constraint = c.id();
        c.take("FOREIGN");
        c.take("KEY");
        const columnsFrom = c.ids();
        c.take("REFERENCES");
        const tableTo = c.table();
        const columnsTo = c.ids();
        c.take("ON");
        c.take("DELETE");
        let onDelete: "cascade" | "no action";
        if (c.peek() === "CASCADE") {
          c.take("CASCADE");
          onDelete = "cascade";
        } else {
          c.take("NO");
          c.take("ACTION");
          onDelete = "no action";
        }
        c.take("ON");
        c.take("UPDATE");
        c.take("NO");
        c.take("ACTION");
        c.finish();
        if (tableTo === name) {
          assert.ok(
            Object.values(table.indexes).some(
              (index) =>
                index.isUnique &&
                JSON.stringify(
                  index.columns.map((column) => column.expression),
                ) === JSON.stringify(columnsTo),
            ),
            "self-FK target unique index must already exist",
          );
        }
        put(table.foreignKeys, constraint, {
          name: constraint,
          tableFrom: name,
          tableTo,
          columnsFrom,
          columnsTo,
          onDelete,
          onUpdate: "no action",
        });
        continue;
      }
      if (c.peek() === "ENABLE") {
        c.take("ENABLE");
        assert.equal(table.isRLSEnabled, false);
        table.isRLSEnabled = true;
      } else {
        c.take("FORCE");
        assert.ok(table.isRLSEnabled, "ENABLE must precede FORCE");
        assert.ok(!forced.includes(name));
        forced.push(name);
      }
      c.take("ROW");
      c.take("LEVEL");
      c.take("SECURITY");
      c.finish();
      continue;
    }
    c.take("CREATE");
    if (c.peek() === "TABLE") {
      c.take("TABLE");
      const name = c.table();
      const table: Table = {
        name,
        schema: "",
        columns: {},
        indexes: {},
        foreignKeys: {},
        compositePrimaryKeys: {},
        uniqueConstraints: {},
        policies: {},
        checkConstraints: {},
        isRLSEnabled: false,
      };
      for (const definition of parts(c.group(), ",")) {
        const d = new Cursor(definition);
        if (d.peek() === "CONSTRAINT") {
          d.take("CONSTRAINT");
          const constraint = d.id();
          if (d.peek() === "PRIMARY") {
            d.take("PRIMARY");
            d.take("KEY");
            put(table.compositePrimaryKeys, constraint, {
              name: constraint,
              columns: d.ids(),
            });
          } else if (d.peek() === "UNIQUE") {
            d.take("UNIQUE");
            let nullsNotDistinct = false;
            if (d.peek() === "NULLS") {
              d.take("NULLS");
              d.take("NOT");
              d.take("DISTINCT");
              nullsNotDistinct = true;
            }
            put(table.uniqueConstraints, constraint, {
              name: constraint,
              nullsNotDistinct,
              columns: d.ids(),
            });
          } else if (d.peek() === "FOREIGN") {
            d.take("FOREIGN");
            d.take("KEY");
            const columnsFrom = d.ids();
            d.take("REFERENCES");
            const tableTo = d.table();
            const columnsTo = d.ids();
            d.take("ON");
            d.take("DELETE");
            d.take("CASCADE");
            d.take("ON");
            d.take("UPDATE");
            d.take("NO");
            d.take("ACTION");
            put(table.foreignKeys, constraint, {
              name: constraint,
              tableFrom: name,
              tableTo,
              columnsFrom,
              columnsTo,
              onDelete: "cascade",
              onUpdate: "no action",
            });
          } else {
            d.take("CHECK");
            put(table.checkConstraints, constraint, {
              name: constraint,
              value: d.group().join(" "),
            });
          }
        } else {
          const column = d.id();
          const type = d.peek().toLowerCase();
          d.at++;
          assert.ok(
            [
              "text",
              "uuid",
              "integer",
              "jsonb",
              "timestamp",
              "boolean",
              "bytea",
              "bigint",
            ].includes(type),
          );
          const item: Column = {
            name: column,
            type,
            primaryKey: false,
            notNull: false,
          };
          if (type === "timestamp") {
            d.take("WITH");
            d.take("TIME");
            d.take("ZONE");
            item.type = "timestamp with time zone";
          }
          if (d.peek() === "DEFAULT") {
            d.take("DEFAULT");
            const start = d.at;
            let depth = 0;
            while (d.at < d.tokens.length) {
              if (depth === 0 && ["NOT", "PRIMARY"].includes(d.peek())) break;
              const token = d.tokens[d.at++];
              if (token === "(") depth++;
              if (token === ")") depth--;
            }
            const value = d.tokens.slice(start, d.at).join(" ");
            assert.ok(value);
            item.default = /^\d+$/.test(value)
              ? Number(value)
              : /^(true|false)$/i.test(value)
                ? value.toLowerCase() === "true"
                : value;
          }
          if (d.peek() === "NOT") {
            d.take("NOT");
            d.take("NULL");
            item.notNull = true;
          }
          if (d.peek() === "PRIMARY") {
            d.take("PRIMARY");
            d.take("KEY");
            item.primaryKey = true;
            assert.equal(item.notNull, true);
          }
          put(table.columns, column, item);
        }
        d.finish();
      }
      c.finish();
      put(out, `public.${name}`, table);
      continue;
    }
    if (c.peek() === "POLICY") {
      c.take("POLICY");
      const name = c.id();
      c.take("ON");
      const tableName = c.table();
      const table = out[`public.${tableName}`];
      assert.ok(table);
      c.take("AS");
      c.take("PERMISSIVE");
      c.take("FOR");
      const command = c.peek();
      assert.ok(["SELECT", "INSERT", "UPDATE", "DELETE"].includes(command));
      c.at++;
      c.take("TO");
      c.take("PUBLIC");
      const policy: Policy = {
        name,
        as: "PERMISSIVE",
        for: command,
        to: ["public"],
      };
      if (c.peek() === "USING") {
        c.take("USING");
        policy.using = c.group().join(" ");
      }
      if (c.peek() === "WITH") {
        c.take("WITH");
        c.take("CHECK");
        policy.withCheck = c.group().join(" ");
      }
      c.finish();
      put(table.policies, name, policy);
      continue;
    }
    const isUnique = c.peek() === "UNIQUE";
    if (isUnique) c.take("UNIQUE");
    c.take("INDEX");
    const name = c.id();
    c.take("ON");
    const tableName = c.table();
    const table = out[`public.${tableName}`];
    assert.ok(table);
    c.take("USING");
    c.take("BTREE");
    const columns = parts(c.group(), ",").map((part) => {
      const col = new Cursor(part);
      const isExpression = col.peek() === "(";
      const value = isExpression ? `( ${col.group().join(" ")} )` : col.id();
      col.take("ASC");
      col.take("NULLS");
      col.take("LAST");
      col.finish();
      return {
        expression: value,
        isExpression,
        asc: true,
        nulls: "last",
      };
    });
    c.finish();
    put(table.indexes, name, {
      name,
      columns,
      isUnique,
      concurrently: false,
      method: "btree",
      with: {},
    });
  }
  return { tables: out, forced, parentUniques };
}
const dialect = new PgDialect();
function render(sql: SQL): string {
  const query = dialect.sqlToQuery(sql);
  assert.equal(query.params.length, 0, "DDL expressions must be literal SQL");
  return query.sql;
}
// Drizzle0.45.2 getTableConfig only returns extra-config UniqueConstraintBuilder
// in uniqueConstraints. Inline column.unique() remains in readonly column fields.
// Project only those real fields; these descriptors are not fake PgTable/config objects.
type InlineUniqueColumn = Pick<
  ReturnType<typeof getTableConfig>["columns"][number],
  "name" | "isUnique" | "uniqueName" | "uniqueType"
>;
type OrdinaryUniqueDescriptor = {
  name: string;
  columns: readonly string[];
  nullsNotDistinct: boolean | undefined;
};
function ordinaryUniqueMetadata(
  columns: readonly InlineUniqueColumn[],
  extras: readonly OrdinaryUniqueDescriptor[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const column of columns) {
    assert.equal(typeof column.isUnique, "boolean");
    if (!column.isUnique) continue;
    const name = column.uniqueName;
    assert.ok(typeof name === "string" && name.length > 0, "inline unique name required");
    assert.ok(
      column.uniqueType === undefined || column.uniqueType === "distinct" || column.uniqueType === "not distinct",
      "unknown inline unique NULL semantics",
    );
    put(result, name, {
      name,
      columns: [column.name],
      // Undefined is ordinary SQL DISTINCT, never NULLS NOT DISTINCT.
      nullsNotDistinct: column.uniqueType === "not distinct",
    });
  }
  for (const constraint of extras) {
    assert.ok(constraint.name.length > 0);
    assert.ok(constraint.columns.length > 0 && constraint.columns.every(name => name.length > 0));
    assert.ok(constraint.nullsNotDistinct === undefined || typeof constraint.nullsNotDistinct === "boolean");
    put(result, constraint.name, {
      name: constraint.name,
      columns: [...constraint.columns],
      nullsNotDistinct: constraint.nullsNotDistinct === true,
    });
  }
  return result;
}
function uniqueInputs(table: PgTable): {
  columns: InlineUniqueColumn[];
  extras: OrdinaryUniqueDescriptor[];
} {
  const config = getTableConfig(table);
  return {
    columns: config.columns.map(column => ({
      name: column.name,
      isUnique: column.isUnique,
      uniqueName: column.uniqueName,
      uniqueType: column.uniqueType,
    })),
    extras: config.uniqueConstraints.map(constraint => {
      const name = constraint.getName();
      assert.ok(name, "extra-config unique name required");
      return {
        name,
        columns: constraint.columns.map(column => column.name),
        nullsNotDistinct: constraint.nullsNotDistinct,
      };
    }),
  };
}
function metadata(table: PgTable): Table {
  const config = getTableConfig(table);
  const result: Table = {
    name: config.name,
    schema: config.schema ?? "",
    columns: {},
    indexes: {},
    foreignKeys: {},
    compositePrimaryKeys: {},
    uniqueConstraints: {},
    policies: {},
    checkConstraints: {},
    isRLSEnabled: config.enableRLS,
  };
  for (const column of config.columns) {
    const item: Column = {
      name: column.name,
      type: column.getSQLType(),
      primaryKey: column.primary,
      notNull: column.notNull,
    };
    if (column.default !== undefined) {
      const value: unknown = column.default;
      if (is(value, SQL)) item.default = render(value);
      else if (typeof value === "bigint") {
        // Exactly the existing default0n lease ABI, not a generic lossy coercion.
        assert.equal(value, 0n); item.default = 0;
      } else {
        assert.ok(
          typeof value === "number" ||
            typeof value === "string" ||
            typeof value === "boolean",
        );
        // Snapshot string defaults are SQL literals; Drizzle retains the original JS value.
        item.default =
          typeof value === "string"
            ? `'${value.replaceAll("'", "''")}'`
            : value;
      }
    }
    assert.equal(column.hasDefault, column.default !== undefined);
    assert.equal(column.defaultFn, undefined);
    put(result.columns, column.name, item);
  }
  for (const index of config.indexes) {
    const cfg = index.config;
    assert.ok(cfg.name);
    assert.equal(cfg.where, undefined);
    assert.equal(cfg.only, false);
    const columns = cfg.columns.map((column) => {
      if (is(column, SQL)) {
        // Unsuffixed SQL expression: PostgreSQL btree defaults ASC / NULLS LAST.
        // Preserve whole SQL; never strip an added DESC/NULLS/operator suffix.
        return {
          expression: render(column),
          isExpression: true,
          asc: true,
          nulls: "last",
        };
      }
      assert.ok("name" in column && typeof column.name === "string");
      assert.ok("indexConfig" in column && column.indexConfig);
      return {
        expression: column.name,
        isExpression: false,
        asc: column.indexConfig.order === "asc",
        nulls: column.indexConfig.nulls ?? "last",
      };
    });
    put(result.indexes, cfg.name, {
      name: cfg.name,
      columns,
      isUnique: cfg.unique,
      concurrently: cfg.concurrently ?? false,
      method: cfg.method ?? "btree",
      with: cfg.with ?? {},
    });
  }
  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    const name = fk.getName();
    put(result.foreignKeys, name, {
      name,
      tableFrom: config.name,
      tableTo: getTableConfig(ref.foreignTable).name,
      columnsFrom: ref.columns.map((column) => column.name),
      columnsTo: ref.foreignColumns.map((column) => column.name),
      onDelete: fk.onDelete ?? "no action",
      onUpdate: fk.onUpdate ?? "no action",
    });
  }
  for (const pk of config.primaryKeys)
    put(result.compositePrimaryKeys, pk.getName(), {
      name: pk.getName(),
      columns: pk.columns.map((column) => column.name),
    });
  const uniques = uniqueInputs(table);
  result.uniqueConstraints = ordinaryUniqueMetadata(uniques.columns, uniques.extras);
  for (const check of config.checks)
    put(result.checkConstraints, check.name, {
      name: check.name,
      value: render(check.value),
    });
  for (const policy of config.policies) {
    const to = Array.isArray(policy.to) ? policy.to : [policy.to];
    assert.ok(to.every((role): role is string => typeof role === "string"));
    const item: Policy = {
      name: policy.name,
      as: (policy.as ?? "permissive").toUpperCase(),
      for: (policy.for ?? "all").toUpperCase(),
      to,
    };
    if (policy.using) item.using = render(policy.using);
    if (policy.withCheck) item.withCheck = render(policy.withCheck);
    put(result.policies, item.name, item);
  }
  return result;
}
function normalize(table: Table): Table {
  const copy = structuredClone(table);
  for (const column of Object.values(copy.columns))
    if (typeof column.default === "string")
      column.default = expression(column.default);
  for (const index of Object.values(copy.indexes))
    for (const column of index.columns)
      if (column.isExpression)
        column.expression = expression(column.expression);
  for (const check of Object.values(copy.checkConstraints))
    check.value = expression(check.value);
  for (const policy of Object.values(copy.policies)) {
    if (policy.using !== undefined) policy.using = expression(policy.using);
    if (policy.withCheck !== undefined)
      policy.withCheck = expression(policy.withCheck);
  }
  return copy;
}
function equalTargets(actual: Record<string, Table>): void {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [key, table] of Object.entries(expected))
    assert.deepEqual(normalize(actual[key] as Table), normalize(table), key);
}









function rejectSQL(before:string,after:string):void {assert.ok(migration.includes(before),'mutation must match actual original');const changed=migration.replace(before,after);assert.notEqual(changed,migration);expect(()=>checkSQL(changed)).toThrow();}

// Closed AP4 successor delta from the existing independent AP4 contract.
// Check every allowed addition before inverting it for this historical AP2 oracle.
const AP4_LEDGER_DELTA = {
  "columns": {
    "exact_object_id": {
      "name": "exact_object_id",
      "type": "uuid",
      "primaryKey": false,
      "notNull": false
    },
    "exact_plaintext_sha256": {
      "name": "exact_plaintext_sha256",
      "type": "text",
      "primaryKey": false,
      "notNull": false
    }
  },
  "indexes": {
    "apx_ledger_prepared_idx": {
      "name": "apx_ledger_prepared_idx",
      "columns": [
        {
          "expression": "exact_object_id",
          "isExpression": false,
          "asc": true,
          "nulls": "last"
        },
        {
          "expression": "approval_id",
          "isExpression": false,
          "asc": true,
          "nulls": "last"
        },
        {
          "expression": "tenant_id",
          "isExpression": false,
          "asc": true,
          "nulls": "last"
        },
        {
          "expression": "owner_user_id",
          "isExpression": false,
          "asc": true,
          "nulls": "last"
        },
        {
          "expression": "exact_plaintext_sha256",
          "isExpression": false,
          "asc": true,
          "nulls": "last"
        }
      ],
      "isUnique": false,
      "concurrently": false,
      "method": "btree",
      "with": {}
    }
  },
  "foreignKeys": {
    "apx_ledger_prepared_fk": {
      "name": "apx_ledger_prepared_fk",
      "tableFrom": "approval_continuations",
      "tableTo": "approval_exact_input_objects",
      "columnsFrom": [
        "exact_object_id",
        "approval_id",
        "tenant_id",
        "owner_user_id",
        "exact_plaintext_sha256"
      ],
      "columnsTo": [
        "id",
        "approval_id",
        "tenant_id",
        "owner_user_id",
        "plaintext_sha256"
      ],
      "onDelete": "no action",
      "onUpdate": "no action"
    }
  },
  "checkConstraints": {
    "apx_ledger_ref_pair_ck": {
      "name": "apx_ledger_ref_pair_ck",
      "value": "(\"exact_object_id\" IS NULL) = (\"exact_plaintext_sha256\" IS NULL)"
    },
    "apx_ledger_ref_sha_ck": {
      "name": "apx_ledger_ref_sha_ck",
      "value": "\"exact_plaintext_sha256\" IS NULL OR \"exact_plaintext_sha256\" ~ '^[a-f0-9]{64}$'"
    }
  }
} as const;
function ap2ParentView(input: Table): Table {
  if (input.name !== "approval_continuations") return input;
  const table = structuredClone(input);
  for (const key of Object.keys(AP4_LEDGER_DELTA.columns)) {
    const expectedColumn = AP4_LEDGER_DELTA.columns[key as keyof typeof AP4_LEDGER_DELTA.columns];
    assert.deepEqual(table.columns[key], expectedColumn);
    delete table.columns[key];
  }
  for (const key of Object.keys(AP4_LEDGER_DELTA.indexes)) {
    const expectedIndex = AP4_LEDGER_DELTA.indexes[key as keyof typeof AP4_LEDGER_DELTA.indexes];
    assert.deepEqual(table.indexes[key], expectedIndex);
    delete table.indexes[key];
  }
  for (const key of Object.keys(AP4_LEDGER_DELTA.foreignKeys)) {
    const expectedForeignKey = AP4_LEDGER_DELTA.foreignKeys[key as keyof typeof AP4_LEDGER_DELTA.foreignKeys];
    assert.deepEqual(table.foreignKeys[key], expectedForeignKey);
    delete table.foreignKeys[key];
  }
  for (const key of Object.keys(AP4_LEDGER_DELTA.checkConstraints)) {
    const expectedCheck = AP4_LEDGER_DELTA.checkConstraints[key as keyof typeof AP4_LEDGER_DELTA.checkConstraints];
    const actual = table.checkConstraints[key];
    assert.ok(actual);
    assert.deepEqual({name:actual.name,value:expression(actual.value)},
      {name:expectedCheck.name,value:expression(expectedCheck.value)});
    delete table.checkConstraints[key];
  }
  return table;
}
const AP4_SOURCE_INVERSE_EDITS: readonly (readonly [string,string])[] = [["  check,\n  foreignKey,\n", "  check,\n"], ["  uniqueIndex,\n  uuid,\n  type PgTableExtraConfigValue,\n", "  uniqueIndex,\n"], ["import { approvalExactInputObjects } from \"./approval-exact-input-objects\";\n", ""], ["    exactObjectId: uuid(\"exact_object_id\"),\n    exactPlaintextSha256: text(\"exact_plaintext_sha256\"),\n", ""], ["  (table): PgTableExtraConfigValue[] => [", "  (table) => ["], ["    check(\"apx_ledger_ref_pair_ck\", sql`(\"exact_object_id\" IS NULL) = (\"exact_plaintext_sha256\" IS NULL)`),\n    check(\"apx_ledger_ref_sha_ck\", sql`\"exact_plaintext_sha256\" IS NULL OR \"exact_plaintext_sha256\" ~ '^[a-f0-9]{64}$'`),\n    foreignKey({ name: \"apx_ledger_prepared_fk\", columns: [table.exactObjectId, table.approvalId, table.tenantId, table.ownerId, table.exactPlaintextSha256], foreignColumns: [approvalExactInputObjects.id, approvalExactInputObjects.approvalId, approvalExactInputObjects.tenantId, approvalExactInputObjects.ownerUserId, approvalExactInputObjects.plaintextSha256] }).onDelete(\"no action\").onUpdate(\"no action\"),\n    index(\"apx_ledger_prepared_idx\").on(table.exactObjectId.asc().nullsLast(), table.approvalId.asc().nullsLast(), table.tenantId.asc().nullsLast(), table.ownerId.asc().nullsLast(), table.exactPlaintextSha256.asc().nullsLast()),\n", ""]];


const models=[approvalContinuations,approvalContinuationSteps];
const actualMetadata=()=>Object.fromEntries(models.map(t=>{const m=ap2ParentView(metadata(t));return [`public.${m.name}`,m];}));
function checkSQL(source:string):void {const p=parseSQL(source);equalTargets(p.tables);assert.deepEqual(p.parentUniques,{[parentUnique.name]:parentUnique});assert.deepEqual(p.forced,['approval_continuations','approval_continuation_steps']);}
function parentExpected():Table {const parent=previous.tables['public.approval_requests'];assert.ok(parent);const value=structuredClone(parent);assert.ok(!Object.hasOwn(value.uniqueConstraints,parentUnique.name));value.uniqueConstraints[parentUnique.name]=parentUnique;return value;}
function checkSnapshot(s:Snapshot):void {assert.equal(s.id,'5ae0628f-dd5e-42e2-8373-74c4312817aa');assert.equal(s.prevId,'14cbd1fd-93b6-4bc1-91fb-42ea053e7055');assert.equal(previous.id,s.prevId);assert.equal(Object.keys(previous.tables).length,137);assert.equal(Object.keys(s.tables).length,139);const restored=structuredClone(s),added:Record<string,Table>={};for(const key of Object.keys(s.tables))if(!(key in previous.tables)){const t=s.tables[key];assert.ok(t);added[key]=t;delete restored.tables[key];}assert.deepEqual(added,expected);assert.deepEqual(restored.tables['public.approval_requests'],parentExpected());const parent=restored.tables['public.approval_requests'];assert.ok(parent);delete parent.uniqueConstraints[parentUnique.name];restored.id=previous.id;restored.prevId=previous.prevId;assert.deepEqual(restored,previous,'all original137/toplevel retained except precise parentunique addition');}
function checkJournal(j:Journal):void {const original=JSON.parse(readFileSync(join(server,'drizzle/meta/_journal.json'),'utf8')) as Journal;assert.equal(j.version,original.version);assert.equal(j.dialect,original.dialect);assert.ok(j.entries.length>=102,'prefix acceptance is not suffix execution authority');assert.deepEqual(j.entries.slice(0,81),original.entries);assert.equal(createHash('sha256').update(JSON.stringify(j.entries.slice(0,101))).digest('hex'),'926c5ee9dd0b3a96ecdf8927c0fe2efecbd7771bd7043ee42334d2adadb02ba0');const entry=j.entries[101],prev=j.entries[100];assert.ok(entry&&prev);assert.deepEqual(entry,{idx:101,version:prev.version,when:1792382901000,tag:'0101_ap2_parent_schema_reconcile_closed',breakpoints:true});assert.ok(entry.when>prev.when&&entry.when<=Date.now());}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
describe('AP2 current ORM reconcile CLOSED new design, no runtime authorization',()=>{
 test('closed AP4 successor inversion rejects changed additions and unknown columns',()=>{
  const edits: ((table: Table)=>void)[] = [
    table=>{const column=table.columns.exact_object_id;assert.ok(column);column.notNull=true;},
    table=>{const column=table.columns.exact_plaintext_sha256;assert.ok(column);column.type="uuid";},
    table=>{const index=table.indexes.apx_ledger_prepared_idx;assert.ok(index);index.method="hash";},
    table=>{const fk=table.foreignKeys.apx_ledger_prepared_fk;assert.ok(fk);fk.onDelete="cascade";},
    table=>{const check=table.checkConstraints.apx_ledger_ref_pair_ck;assert.ok(check);check.value="TRUE";},
    table=>{delete table.columns.exact_object_id;},
    table=>{table.columns.unapproved={name:"unapproved",type:"text",primaryKey:false,notNull:false};},
  ];
  for(const edit of edits) expect(()=>{
    const actual=actualMetadata(),changed=metadata(approvalContinuations);
    edit(changed);
    actual["public.approval_continuations"]=ap2ParentView(changed);
    equalTargets(actual);
  }).toThrow();
 });

 test('independent full matrix hash and all10 SQL statements consume exactly',()=>{expect(createHash('sha256').update(expectedRaw).digest('hex')).toBe('44cf91ebadfc907467d6b95dcb2df8fd02bf944479a959ee60e46f000e82bf7e');expect(migration.split('--> statement-breakpoint')).toHaveLength(10);checkSQL(migration);});
 test('actual Drizzle28columns2PK2ordinaryUnique1index2FK7CHECK2RLS equal independent source matrix',()=>equalTargets(actualMetadata()));
 test('parent adds only ordered plain scoped unique, preserving old id PK action index and all other metadata',()=>{assert.deepEqual(normalize(metadata(approvalRequests)),normalize(parentExpected()));expect(approvalRequests.id.primary).toBe(true);for(const c of [approvalRequests.id,approvalRequests.tenantId,approvalRequests.ownerUserId]){expect(c.getSQLType()).toBe('text');expect(c.notNull).toBe(true);}const cfg=getTableConfig(approvalRequests);expect(cfg.uniqueConstraints.map(c=>c.getName())).toEqual([parentUnique.name]);expect(cfg.indexes.find(i=>i.config.name==='approval_requests_action_idx')?.config.unique).toBe(true);});
 test('full current9255 declarations survive exact allowed source inverse, never stale5955 overwrite',()=>{let current=readFileSync(join(server,'src/db/schema/approvals.ts'),'utf8');for(const [after,before] of AP4_SOURCE_INVERSE_EDITS){assert.equal(current.split(after).length,2,'each closed AP4 successor edit must match exactly');current=current.replace(after,()=>before);}expect(Buffer.byteLength(current)).toBe(9393);expect(createHash('sha256').update(current).digest('hex')).toBe('149e43894542c7ce97ab1e65641b64de07eebd627fe68921898032598f3b3798');const importLine='  unique,\n';expect(current.split(importLine)).toHaveLength(2);current=current.replace(importLine,'');const uniqueLine='    unique("approval_requests_id_tenant_owner_unique").on(table.id, table.tenantId, table.ownerUserId),\n';expect(current.split(uniqueLine)).toHaveLength(2);current=current.replace(uniqueLine,'');expect(current.split(').enableRLS();')).toHaveLength(3);current=current.replaceAll(').enableRLS();',');');expect(Buffer.byteLength(current)).toBe(9255);expect(createHash('sha256').update(current).digest('hex')).toBe('61ca3d5b4ea5287ef22f30c8522fdaa7b176587a98c7603de495a3f2b5a27742');});
 test('lease fence0n and nullable intentFence remain bigint, not run generation or canonical hash',()=>{for(const column of [approvalContinuations.fence,approvalContinuationSteps.fence]){expect(column.default).toBe(0n);expect(column.columnType).toBe('PgBigInt64');expect(column.dataType).toBe('bigint');expect(column.notNull).toBe(true);expect(dialect.sqlToQuery(sql`select ${sql.param(0n,column)}::bigint`).params[0]).toBe(0n);}expect(approvalContinuations.intentFence.notNull).toBe(false);expect(approvalContinuations.intentFence.hasDefault).toBe(false);for(const c of [approvalContinuations.inputDigest,approvalContinuationSteps.inputDigest]){expect(c.getSQLType()).toBe('text');expect(c.notNull).toBe(true);expect(c.hasDefault).toBe(false);}});
 test('nullable receipts map object identity without double encoding, SQLNULL preserved',()=>{for(const column of [approvalContinuations.receipt,approvalContinuationSteps.receipt]){const value={fixture:true,opaque:'not-an-authority'};expect(column.notNull).toBe(false);expect(column.hasDefault).toBe(false);expect(column.mapToDriverValue(value)).toBe(value);expect(column.mapFromDriverValue(value)).toBe(value);expect(dialect.sqlToQuery(sql`select ${sql.param(value,column)}::jsonb`).params[0]).toBe(value);expect(dialect.sqlToQuery(sql`select ${sql.param(null,column)}`).params[0]).toBeNull();}});
 test('actual users-parent-ledger-steps single-column CASCADE chain and updateNOACTION remain explicit',()=>{const parentFK=getTableConfig(approvalRequests).foreignKeys[0];assert.ok(parentFK);expect(parentFK.reference().foreignTable).toBe(users);for(const [model,parent] of [[approvalContinuations,approvalRequests],[approvalContinuationSteps,approvalContinuations]] as const){const fk=getTableConfig(model).foreignKeys[0];assert.ok(fk);const ref=fk.reference();expect(ref.columns.map(c=>c.name)).toEqual(['approval_id']);expect(ref.foreignTable).toBe(parent);expect(fk.onDelete).toBe('cascade');expect(fk.onUpdate).toBe('no action');}expect(approvalContinuationSteps.admissionId.notNull).toBe(false);expect(approvalContinuations.admissionId.notNull).toBe(true);});
 test('each independent complete CHECK template has a rejecting single constraint mutation',()=>{for(const t of Object.values(expected))for(const [name,c] of Object.entries(t.checkConstraints))rejectSQL('CONSTRAINT "'+name+'" CHECK ('+c.value+')','CONSTRAINT "'+name+'" CHECK (true)');rejectSQL("in ('ready','claimed','dispatched','unknown','completed')","in ('ready','claimed','dispatched','completed')");rejectSQL("<> 'legacy_unknown' or","= 'legacy_unknown' or");rejectSQL("= 'completed') = (","= 'completed') <> (");});
 test('missing/wrong columns nullable defaults global ordinary uniqueness PK/index scope FK delete all reject',()=>{for(const [a,b] of [['"fence" bigint DEFAULT 0 NOT NULL','"fence" bigint DEFAULT 1 NOT NULL'],['"fence" bigint DEFAULT 0 NOT NULL','"fence" bigint DEFAULT \'0\' NOT NULL'],['"input_digest" text NOT NULL','"input_digest" jsonb NOT NULL'],['"admission_id" text NOT NULL','"admission_id" text'],['"intent_fence" bigint','"intent_fence" bigint DEFAULT 0'],['"last_reason" text,\n',''],['UNIQUE ("admission_id")','UNIQUE ("tenant_id", "admission_id")'],['PRIMARY KEY ("approval_id", "step_key")','PRIMARY KEY ("step_key", "approval_id")'],['"tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST, "state" ASC NULLS LAST','"owner_user_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST, "state" ASC NULLS LAST'],['ON DELETE CASCADE','ON DELETE NO ACTION'],['ON UPDATE NO ACTION','ON UPDATE CASCADE']])rejectSQL(a,b);});
 test('exact parent unique rejects missing reordered nullable-distinct deferrable partial and uniqueIndex substitutions',()=>{const clause='ALTER TABLE "public"."approval_requests" ADD CONSTRAINT "approval_requests_id_tenant_owner_unique" UNIQUE ("id", "tenant_id", "owner_user_id");';for(const wrong of ['',clause.replace('"id", "tenant_id", "owner_user_id"','"id", "owner_user_id", "tenant_id"'),clause.replace('UNIQUE (','UNIQUE NULLS NOT DISTINCT ('),clause.replace(';',' DEFERRABLE;'),clause.replace(';',' WHERE true;'),'CREATE UNIQUE INDEX "approval_requests_id_tenant_owner_unique" ON "public"."approval_requests" USING btree ("id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST, "owner_user_id" ASC NULLS LAST);'])rejectSQL(clause,wrong);});
 test('CLOSED requires both ENABLE and FORCE with no added policies grants writer DML or permissive IFNOTEXISTS',()=>{for(const table of ['approval_continuations','approval_continuation_steps'])for(const mode of ['ENABLE','FORCE'])rejectSQL(`ALTER TABLE "public"."${table}" ${mode} ROW LEVEL SECURITY;`,'');for(const extra of ['CREATE POLICY "invented" ON "public"."approval_continuations" AS PERMISSIVE FOR SELECT TO public USING (true);','GRANT ALL ON "public"."approval_continuations" TO public;','UPDATE "public"."approval_continuations" SET "state"=\'ready\';','SELECT 1;'])expect(()=>checkSQL(migration+extra)).toThrow();rejectSQL('CREATE TABLE "public"."approval_continuations"','CREATE TABLE IF NOT EXISTS "public"."approval_continuations"');expect(()=>checkSQL(migration+migration)).toThrow();expect(()=>checkSQL(migration+'$bad$')).toThrow();});
 test('snapshot inverse returns exact137 tables/toplevel and rejects parent/domain/oldtable drift',()=>{checkSnapshot(next);for(const edit of [(s:Snapshot)=>{delete s.tables['public.approval_continuations'];},(s:Snapshot)=>{s.prevId='wrong';},(s:Snapshot)=>{s.id=previous.id;},(s:Snapshot)=>{s.extraTop=true;},(s:Snapshot)=>{const t=s.tables['public.approval_requests'];assert.ok(t);t.uniqueConstraints={};},(s:Snapshot)=>{const t=s.tables['public.threads'];assert.ok(t);t.uniqueConstraints={};},(s:Snapshot)=>{const t=s.tables['public.approval_direct_execution_domains'];assert.ok(t);t.columns={};}]){const s=structuredClone(next);edit(s);expect(()=>checkSnapshot(s)).toThrow();}});
 test('journal0..100 precise prefix accepts successor only as recognition, rejecting old or own tampering',()=>{checkJournal(journal);const successor=structuredClone(journal);successor.entries.push({idx:102,version:'7',when:Date.now(),tag:'untrusted-suffix-fixture',breakpoints:true});checkJournal(successor);for(let i=0;i<=101;i++){const j=structuredClone(journal);const e=j.entries[i];assert.ok(e);e.tag='forged';expect(()=>checkJournal(j)).toThrow();}const j=structuredClone(journal);const e=j.entries[101];assert.ok(e);e.when++;expect(()=>checkJournal(j)).toThrow();});
 test('all original163 and existing40 recovery SQL/snapshots byte identities survive full integration',()=>{const dir=join(server,'drizzle'),files=filesUnder(dir).sort();expect(files).toHaveLength(163);const rows=files.map(p=>{const b=readFileSync(p);return `${relative(dir,p)}\0${b.length}\0${createHash('sha256').update(b).digest('hex')}\n`;});expect(createHash('sha256').update(rows.join('')).digest('hex')).toBe('9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d');expect([
  {
    "path": "recovery/recovery-20261018-v1/meta/0081_snapshot.json",
    "bytes": 292641,
    "sha256": "ef4b170efbc98717bce811b27d3f5d35c274146f5faec50bc787028acbfaa24c"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0082_snapshot.json",
    "bytes": 310313,
    "sha256": "2cc73e7181b11baa27dcad48ab412cf5d89c13d19d0f06a4640e6cdaa7a883e8"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0083_snapshot.json",
    "bytes": 312091,
    "sha256": "159c6313247a705e2dd71efe46c90cc734ee9a8a0be3b66f4c114ef343335d61"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0084_recovery_flow_source_foundations_snapshot.json",
    "bytes": 329146,
    "sha256": "12a3221d57c57de1f3639d126ea90e0724e84e64fd2965e4fb62d197fced2a07"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0085_snapshot.json",
    "bytes": 352947,
    "sha256": "b02d8b70f513bcc764a2be96a4d88184d73392b14eb754a8067b9cd123a00eab"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0086_snapshot.json",
    "bytes": 369468,
    "sha256": "6beec7f83f05e43d212c44f990ba625c4714acb45fdac6b4082df3085e89541a"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0087_snapshot.json",
    "bytes": 389321,
    "sha256": "86cd06c067f98c93911bc639cb3df766c54cb4d7478f95c414bf29b34fafb3ef"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0088_snapshot.json",
    "bytes": 406139,
    "sha256": "eb784f5a88fea45abc65672bf804d7a3ad20642fd81578ccecd236be77e92360"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0089_snapshot.json",
    "bytes": 423098,
    "sha256": "6e16372f22dba1583e1898f3c10e21a1ce7c76f6ddc16595f86a49806a0769cf"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0090_snapshot.json",
    "bytes": 427649,
    "sha256": "f49a5fdbd213a1273b898a925e486499a6b1357243bb74f0a4108bdcb5f6d44e"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0091_snapshot.json",
    "bytes": 436634,
    "sha256": "9d26860fe19084a4de2635a4e28865ff38258e4781eeb8cd1bf45fe1c872e0ef"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0092_snapshot.json",
    "bytes": 436885,
    "sha256": "b0bc37ce370b357d08a9f513dfad13d186c91c161c8b0abadf045b9912a22893"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0093_snapshot.json",
    "bytes": 442363,
    "sha256": "acaa87bf970da9ffd06198e59a365d10d2d9d3f03f56dbc07cfe393d76abc7eb"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0094_snapshot.json",
    "bytes": 449141,
    "sha256": "27e268245fa3f0ed13f13035c751ac27c006d274191c670f92183521863cdfd2"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0095_snapshot.json",
    "bytes": 454058,
    "sha256": "77ed1fad2c312ed16635d95a6fb40fe4e230b96f53c007c7b71a881dcd57cc4b"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0096_snapshot.json",
    "bytes": 463387,
    "sha256": "e28a48738b23d9f2ff41d1e0b515e189ecb5bd44db2befb652af1bdcb126963b"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0097_snapshot.json",
    "bytes": 471291,
    "sha256": "0bc645a65fc289437489a3e000596616f3694bc6325a4be7a10f59597e941a37"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0098_snapshot.json",
    "bytes": 479137,
    "sha256": "58b5758a353915408091102051bdfed77b5bc168e4cd91ec0169bcaa7ba5eb26"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0099_snapshot.json",
    "bytes": 488317,
    "sha256": "e08e4184dbf674fa4c88d6e55f270f2e371b1541a046ab8da29068084fd9ca0c"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0100_snapshot.json",
    "bytes": 498108,
    "sha256": "fd218591c0165512dbaf63a36fed8ddd775cc577d090083510329c6d6779fc93"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0081_recovery_subject_and_binding.sql",
    "bytes": 172,
    "sha256": "0769123048b40af0f80aa8a3c843f67ab19fac5c44ccb9243bbc6819d689bb40"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0082_recovery_role_foundations.sql",
    "bytes": 9833,
    "sha256": "683834fae02b1e3cf3be6ca85340098c2a1bd0cea6de65c7e14b80e3be7a93dc"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0083_recovery_task_flow_audit_contract.sql",
    "bytes": 938,
    "sha256": "ee97d7862077239462aec225a1b71bf2b87d06a9d858b48dcaa7746a2b0856ea"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0084_recovery_flow_source_foundations.sql",
    "bytes": 8236,
    "sha256": "96cb4c921ca065856d4f3d641440907528d9ddf78e483ff09ff100aa2835e541"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0085_recovery_flow_source_run_records.sql",
    "bytes": 12015,
    "sha256": "a94c4a80167f67e79fee01f71483b7964985da4957a0221280f79cebe279e4c2"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0086_recovery_flow_source_runtime_records.sql",
    "bytes": 8857,
    "sha256": "21d90fc2a2505943db1e1687109820527660b8ec7b87d2e8a6b303107fa723bd"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0087_recovery_flow_source_original_records.sql",
    "bytes": 11428,
    "sha256": "e5e5fb88be31f330280ea3e045d29da6d3315e0df2f82d854df16d399a8fd7f9"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0088_recovery_flow_run_coordination.sql",
    "bytes": 7714,
    "sha256": "a7623f0e399a806cbc195dd18f4e4ff2f64aa674a8fae25c4152c71e823c3786"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0089_recovery_flow_official_bindings.sql",
    "bytes": 3140,
    "sha256": "a1ffdceb492b8f3ba00b7fc78f994d608c016a7f171a3ba913a408c800112219"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0090_recovery_group_pipeline_start_receipts.sql",
    "bytes": 2093,
    "sha256": "8c9ae16ca677f0969d8035247443b8428afd02c4b936c96efd7b6d2e81fb0671"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0091_recovery_flow_customization_foundations.sql",
    "bytes": 4376,
    "sha256": "ecaf856fcc358e5e522a22b6e3f86e4aeb5aac64e1ddd48f273e65fdb3ef9a60"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0092_threads_domain_parent_key.sql",
    "bytes": 119,
    "sha256": "5dd8207d87d6f63823de57e60c639a5683341f8891dffa5398e72c6b221ed9dd"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0093_recovery_flow_customization_turns.sql",
    "bytes": 2476,
    "sha256": "ca2502c0d5975497998fbd90c2532da4c47dde49142bd63da13ff00314daf061"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0094_approval_direct_execution_domains.sql",
    "bytes": 2891,
    "sha256": "c0e601568100b1c92bb25f24524a48150629e750f135cfb28e41d5c391e37c82"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0095_recovery_automation_foundations.sql",
    "bytes": 1401,
    "sha256": "1414446cb8749a6a097f843bf9d2cc2e42da63ff0e2c96b613bd78de8db85b3e"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0096_recovery_flow_sharing_foundations.sql",
    "bytes": 4389,
    "sha256": "d8f0f5dd67ce26328745b6b6d94b6e958d3906c7cd8a308d4ecfbc168e067190"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0097_recovery_automation_run_records.sql",
    "bytes": 2530,
    "sha256": "cb2b14e26104fa172d06bac1561e12a78220458d51a038e67630fece6f9f3211"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0098_recovery_device_binding_leases.sql",
    "bytes": 4010,
    "sha256": "ce329e24edef4d46e3355b301b6c004ce0e24cccb68b1216fa0b0e4efff32fc7"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0099_recovery_security_policy_fences.sql",
    "bytes": 5540,
    "sha256": "30f22f1ee9cf0bf2104d6ef5803a51de993ade44c034bc25cd9f72dc046015a2"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0100_recovery_outbox_knowledge_heads.sql",
    "bytes": 5279,
    "sha256": "2780c167f92272e521b0e1cb39d904f61a9f83b643da5c857760f5aa1c532c62"
  }
]).toHaveLength(40);for(const input of [
  {
    "path": "recovery/recovery-20261018-v1/meta/0081_snapshot.json",
    "bytes": 292641,
    "sha256": "ef4b170efbc98717bce811b27d3f5d35c274146f5faec50bc787028acbfaa24c"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0082_snapshot.json",
    "bytes": 310313,
    "sha256": "2cc73e7181b11baa27dcad48ab412cf5d89c13d19d0f06a4640e6cdaa7a883e8"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0083_snapshot.json",
    "bytes": 312091,
    "sha256": "159c6313247a705e2dd71efe46c90cc734ee9a8a0be3b66f4c114ef343335d61"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0084_recovery_flow_source_foundations_snapshot.json",
    "bytes": 329146,
    "sha256": "12a3221d57c57de1f3639d126ea90e0724e84e64fd2965e4fb62d197fced2a07"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0085_snapshot.json",
    "bytes": 352947,
    "sha256": "b02d8b70f513bcc764a2be96a4d88184d73392b14eb754a8067b9cd123a00eab"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0086_snapshot.json",
    "bytes": 369468,
    "sha256": "6beec7f83f05e43d212c44f990ba625c4714acb45fdac6b4082df3085e89541a"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0087_snapshot.json",
    "bytes": 389321,
    "sha256": "86cd06c067f98c93911bc639cb3df766c54cb4d7478f95c414bf29b34fafb3ef"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0088_snapshot.json",
    "bytes": 406139,
    "sha256": "eb784f5a88fea45abc65672bf804d7a3ad20642fd81578ccecd236be77e92360"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0089_snapshot.json",
    "bytes": 423098,
    "sha256": "6e16372f22dba1583e1898f3c10e21a1ce7c76f6ddc16595f86a49806a0769cf"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0090_snapshot.json",
    "bytes": 427649,
    "sha256": "f49a5fdbd213a1273b898a925e486499a6b1357243bb74f0a4108bdcb5f6d44e"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0091_snapshot.json",
    "bytes": 436634,
    "sha256": "9d26860fe19084a4de2635a4e28865ff38258e4781eeb8cd1bf45fe1c872e0ef"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0092_snapshot.json",
    "bytes": 436885,
    "sha256": "b0bc37ce370b357d08a9f513dfad13d186c91c161c8b0abadf045b9912a22893"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0093_snapshot.json",
    "bytes": 442363,
    "sha256": "acaa87bf970da9ffd06198e59a365d10d2d9d3f03f56dbc07cfe393d76abc7eb"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0094_snapshot.json",
    "bytes": 449141,
    "sha256": "27e268245fa3f0ed13f13035c751ac27c006d274191c670f92183521863cdfd2"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0095_snapshot.json",
    "bytes": 454058,
    "sha256": "77ed1fad2c312ed16635d95a6fb40fe4e230b96f53c007c7b71a881dcd57cc4b"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0096_snapshot.json",
    "bytes": 463387,
    "sha256": "e28a48738b23d9f2ff41d1e0b515e189ecb5bd44db2befb652af1bdcb126963b"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0097_snapshot.json",
    "bytes": 471291,
    "sha256": "0bc645a65fc289437489a3e000596616f3694bc6325a4be7a10f59597e941a37"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0098_snapshot.json",
    "bytes": 479137,
    "sha256": "58b5758a353915408091102051bdfed77b5bc168e4cd91ec0169bcaa7ba5eb26"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0099_snapshot.json",
    "bytes": 488317,
    "sha256": "e08e4184dbf674fa4c88d6e55f270f2e371b1541a046ab8da29068084fd9ca0c"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0100_snapshot.json",
    "bytes": 498108,
    "sha256": "fd218591c0165512dbaf63a36fed8ddd775cc577d090083510329c6d6779fc93"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0081_recovery_subject_and_binding.sql",
    "bytes": 172,
    "sha256": "0769123048b40af0f80aa8a3c843f67ab19fac5c44ccb9243bbc6819d689bb40"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0082_recovery_role_foundations.sql",
    "bytes": 9833,
    "sha256": "683834fae02b1e3cf3be6ca85340098c2a1bd0cea6de65c7e14b80e3be7a93dc"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0083_recovery_task_flow_audit_contract.sql",
    "bytes": 938,
    "sha256": "ee97d7862077239462aec225a1b71bf2b87d06a9d858b48dcaa7746a2b0856ea"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0084_recovery_flow_source_foundations.sql",
    "bytes": 8236,
    "sha256": "96cb4c921ca065856d4f3d641440907528d9ddf78e483ff09ff100aa2835e541"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0085_recovery_flow_source_run_records.sql",
    "bytes": 12015,
    "sha256": "a94c4a80167f67e79fee01f71483b7964985da4957a0221280f79cebe279e4c2"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0086_recovery_flow_source_runtime_records.sql",
    "bytes": 8857,
    "sha256": "21d90fc2a2505943db1e1687109820527660b8ec7b87d2e8a6b303107fa723bd"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0087_recovery_flow_source_original_records.sql",
    "bytes": 11428,
    "sha256": "e5e5fb88be31f330280ea3e045d29da6d3315e0df2f82d854df16d399a8fd7f9"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0088_recovery_flow_run_coordination.sql",
    "bytes": 7714,
    "sha256": "a7623f0e399a806cbc195dd18f4e4ff2f64aa674a8fae25c4152c71e823c3786"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0089_recovery_flow_official_bindings.sql",
    "bytes": 3140,
    "sha256": "a1ffdceb492b8f3ba00b7fc78f994d608c016a7f171a3ba913a408c800112219"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0090_recovery_group_pipeline_start_receipts.sql",
    "bytes": 2093,
    "sha256": "8c9ae16ca677f0969d8035247443b8428afd02c4b936c96efd7b6d2e81fb0671"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0091_recovery_flow_customization_foundations.sql",
    "bytes": 4376,
    "sha256": "ecaf856fcc358e5e522a22b6e3f86e4aeb5aac64e1ddd48f273e65fdb3ef9a60"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0092_threads_domain_parent_key.sql",
    "bytes": 119,
    "sha256": "5dd8207d87d6f63823de57e60c639a5683341f8891dffa5398e72c6b221ed9dd"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0093_recovery_flow_customization_turns.sql",
    "bytes": 2476,
    "sha256": "ca2502c0d5975497998fbd90c2532da4c47dde49142bd63da13ff00314daf061"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0094_approval_direct_execution_domains.sql",
    "bytes": 2891,
    "sha256": "c0e601568100b1c92bb25f24524a48150629e750f135cfb28e41d5c391e37c82"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0095_recovery_automation_foundations.sql",
    "bytes": 1401,
    "sha256": "1414446cb8749a6a097f843bf9d2cc2e42da63ff0e2c96b613bd78de8db85b3e"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0096_recovery_flow_sharing_foundations.sql",
    "bytes": 4389,
    "sha256": "d8f0f5dd67ce26328745b6b6d94b6e958d3906c7cd8a308d4ecfbc168e067190"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0097_recovery_automation_run_records.sql",
    "bytes": 2530,
    "sha256": "cb2b14e26104fa172d06bac1561e12a78220458d51a038e67630fece6f9f3211"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0098_recovery_device_binding_leases.sql",
    "bytes": 4010,
    "sha256": "ce329e24edef4d46e3355b301b6c004ce0e24cccb68b1216fa0b0e4efff32fc7"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0099_recovery_security_policy_fences.sql",
    "bytes": 5540,
    "sha256": "30f22f1ee9cf0bf2104d6ef5803a51de993ade44c034bc25cd9f72dc046015a2"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0100_recovery_outbox_knowledge_heads.sql",
    "bytes": 5279,
    "sha256": "2780c167f92272e521b0e1cb39d904f61a9f83b643da5c857760f5aa1c532c62"
  }
]){const b=readFileSync(join(server,input.path));expect(b.length).toBe(input.bytes);expect(createHash('sha256').update(b).digest('hex')).toBe(input.sha256);}});
 test('real inline admission unique descriptors merge with extra-config ordinary uniques without uniqueIndex mixing',()=>{
  for(const model of models){const inputs=uniqueInputs(model),column=inputs.columns.find(c=>c.name==='admission_id');assert.ok(column?.uniqueName);expect(column.isUnique).toBe(true);expect(column.uniqueName).toBe(`${getTableConfig(model).name}_admission_id_unique`);const uniques=ordinaryUniqueMetadata(inputs.columns,inputs.extras);expect(uniques[column.uniqueName]).toEqual({name:column.uniqueName,columns:['admission_id'],nullsNotDistinct:false});}
  const parent=uniqueInputs(approvalRequests),uniques=ordinaryUniqueMetadata(parent.columns,parent.extras);expect(uniques).toEqual({[parentUnique.name]:parentUnique});expect(Object.hasOwn(uniques,'approval_requests_action_idx')).toBe(false);expect(getTableConfig(approvalRequests).indexes.some(i=>i.config.name==='approval_requests_action_idx'&&i.config.unique)).toBe(true);
 });
 test('missing inline unique flag or wrong actual name rejects the unchanged independent oracle',()=>{
  for(const model of models){const inputs=uniqueInputs(model),key=`public.${getTableConfig(model).name}`;for(const change of [(c:InlineUniqueColumn)=>({...c,isUnique:false}),(c:InlineUniqueColumn)=>({...c,uniqueName:'wrong_inline_unique_name'})]){const columns=inputs.columns.map(c=>c.name==='admission_id'?change(c):c),actual=actualMetadata(),table=actual[key];assert.ok(table);table.uniqueConstraints=ordinaryUniqueMetadata(columns,inputs.extras);expect(()=>equalTargets(actual)).toThrow();}}
 });
 test('undefined and explicit DISTINCT stay ordinary, explicit NOT DISTINCT changes SQL NULL semantics and rejects oracle',()=>{
  for(const model of models){const inputs=uniqueInputs(model),key=`public.${getTableConfig(model).name}`;for(const uniqueType of [undefined,'distinct']){const columns=inputs.columns.map(c=>c.name==='admission_id'?{...c,uniqueType}:c),actual=actualMetadata(),table=actual[key];assert.ok(table);table.uniqueConstraints=ordinaryUniqueMetadata(columns,inputs.extras);equalTargets(actual);}const columns=inputs.columns.map(c=>c.name==='admission_id'?{...c,uniqueType:'not distinct'}:c),actual=actualMetadata(),table=actual[key];assert.ok(table);table.uniqueConstraints=ordinaryUniqueMetadata(columns,inputs.extras);expect(()=>equalTargets(actual)).toThrow();}
 });
 test('missing names and unknown inline unique semantics are refused rather than normalized away',()=>{
  for(const model of models){const inputs=uniqueInputs(model);for(const change of [(c:InlineUniqueColumn)=>({...c,uniqueName:undefined}),(c:InlineUniqueColumn)=>({...c,uniqueName:''}),(c:InlineUniqueColumn)=>({...c,uniqueType:'unknown-null-mode'})]){const columns=inputs.columns.map(c=>c.name==='admission_id'?change(c):c);expect(()=>ordinaryUniqueMetadata(columns,inputs.extras)).toThrow();}}
 });
 test('duplicate inline and extra-config names reject, while incorrect extra NULL semantics also rejects parent expectation',()=>{
  for(const model of models){const inputs=uniqueInputs(model),column=inputs.columns.find(c=>c.name==='admission_id');assert.ok(column?.uniqueName);expect(()=>ordinaryUniqueMetadata([...inputs.columns,column],inputs.extras)).toThrow();expect(()=>ordinaryUniqueMetadata(inputs.columns,[...inputs.extras,{name:column.uniqueName,columns:[column.name],nullsNotDistinct:false}])).toThrow();}
  const parent=uniqueInputs(approvalRequests);expect(parent.extras).toHaveLength(1);expect(()=>ordinaryUniqueMetadata(parent.columns,[...parent.extras,...parent.extras])).toThrow();const actual=metadata(approvalRequests);actual.uniqueConstraints=ordinaryUniqueMetadata(parent.columns,parent.extras.map(c=>({...c,nullsNotDistinct:true})));expect(()=>assert.deepEqual(normalize(actual),normalize(parentExpected()))).toThrow();
 });
});

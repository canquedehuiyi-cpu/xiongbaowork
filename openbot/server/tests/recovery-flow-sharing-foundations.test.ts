import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { flowShareImports, flowShareLinks } from "../src/db/schema/flow-sharing-foundations";
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

// Independent complete0121 table data; no expected structure is generated from the new schema.
// Whole583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules=[
  {
    "raw": "{\n  \"name\": \"flow_share_links\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"id\": {\n      \"name\": \"id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": true,\n      \"notNull\": true\n    },\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"flow_id\": {\n      \"name\": \"flow_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"token_hash\": {\n      \"name\": \"token_hash\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"creation_fingerprint\": {\n      \"name\": \"creation_fingerprint\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"package_snapshot\": {\n      \"name\": \"package_snapshot\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"digest\": {\n      \"name\": \"digest\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"expires_at\": {\n      \"name\": \"expires_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"max_uses\": {\n      \"name\": \"max_uses\",\n      \"type\": \"integer\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"uses\": {\n      \"name\": \"uses\",\n      \"type\": \"integer\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": 0\n    },\n    \"revoked_at\": {\n      \"name\": \"revoked_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {\n    \"flow_share_token_idx\": {\n      \"name\": \"flow_share_token_idx\",\n      \"columns\": [\n        {\n          \"expression\": \"token_hash\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": true,\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    },\n    \"flow_shares_owner_idx\": {\n      \"name\": \"flow_shares_owner_idx\",\n      \"columns\": [\n        {\n          \"expression\": \"tenant_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"flow_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": false,\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    }\n  },\n  \"foreignKeys\": {\n    \"flow_share_links_flow_id_waker_flows_id_fk\": {\n      \"name\": \"flow_share_links_flow_id_waker_flows_id_fk\",\n      \"tableFrom\": \"flow_share_links\",\n      \"tableTo\": \"waker_flows\",\n      \"columnsFrom\": [\n        \"flow_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"no action\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {},\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"share_select\": {\n      \"name\": \"share_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_share_links\\\".\\\"tenant_id\\\"=current_setting('app.tenant_id',true) OR \\\"flow_share_links\\\".\\\"token_hash\\\"=current_setting('app.flow_share_token',true)\"\n    },\n    \"share_insert\": {\n      \"name\": \"share_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"\\\"flow_share_links\\\".\\\"tenant_id\\\"=current_setting('app.tenant_id',true)\"\n    },\n    \"share_update\": {\n      \"name\": \"share_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_share_links\\\".\\\"tenant_id\\\"=current_setting('app.tenant_id',true) OR \\\"flow_share_links\\\".\\\"token_hash\\\"=current_setting('app.flow_share_token',true)\",\n      \"withCheck\": \"\\\"flow_share_links\\\".\\\"tenant_id\\\"=current_setting('app.tenant_id',true) OR \\\"flow_share_links\\\".\\\"token_hash\\\"=current_setting('app.flow_share_token',true)\"\n    },\n    \"share_delete\": {\n      \"name\": \"share_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_share_links\\\".\\\"tenant_id\\\"=current_setting('app.tenant_id',true)\"\n    }\n  },\n  \"checkConstraints\": {\n    \"flow_share_max_uses_check\": {\n      \"name\": \"flow_share_max_uses_check\",\n      \"value\": \"\\\"flow_share_links\\\".\\\"max_uses\\\" IS NULL OR \\\"flow_share_links\\\".\\\"max_uses\\\">0\"\n    },\n    \"flow_share_uses_check\": {\n      \"name\": \"flow_share_uses_check\",\n      \"value\": \"\\\"flow_share_links\\\".\\\"uses\\\">=0 AND (\\\"flow_share_links\\\".\\\"max_uses\\\" IS NULL OR \\\"flow_share_links\\\".\\\"uses\\\"<=\\\"flow_share_links\\\".\\\"max_uses\\\")\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "3b3fb65f55dd7245337f654e6502e8843d57993197406d047b8cec9e39b9dafe"
  },
  {
    "raw": "{\n  \"name\": \"flow_share_imports\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"id\": {\n      \"name\": \"id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": true,\n      \"notNull\": true,\n      \"default\": \"gen_random_uuid()\"\n    },\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"request_id\": {\n      \"name\": \"request_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"fingerprint\": {\n      \"name\": \"fingerprint\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"flow_id\": {\n      \"name\": \"flow_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"result\": {\n      \"name\": \"result\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {\n    \"flow_import_request_idx\": {\n      \"name\": \"flow_import_request_idx\",\n      \"columns\": [\n        {\n          \"expression\": \"tenant_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"request_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": true,\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    }\n  },\n  \"foreignKeys\": {\n    \"flow_share_imports_flow_id_waker_flows_id_fk\": {\n      \"name\": \"flow_share_imports_flow_id_waker_flows_id_fk\",\n      \"tableFrom\": \"flow_share_imports\",\n      \"tableTo\": \"waker_flows\",\n      \"columnsFrom\": [\n        \"flow_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"no action\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {},\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"tenant_scope_select\": {\n      \"name\": \"tenant_scope_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_share_imports\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\"\n    },\n    \"tenant_scope_insert\": {\n      \"name\": \"tenant_scope_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"\\\"flow_share_imports\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\"\n    },\n    \"tenant_scope_update\": {\n      \"name\": \"tenant_scope_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_share_imports\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\",\n      \"withCheck\": \"\\\"flow_share_imports\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\"\n    },\n    \"tenant_scope_delete\": {\n      \"name\": \"tenant_scope_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_share_imports\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\"\n    }\n  },\n  \"checkConstraints\": {},\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "2970ff590d0eae5eb625a0b565f9a0f66dc9ab9b1586159f03528f704d21bf21"
  }
];
const expected:Record<string,Table>=Object.fromEntries(capsules.map(({raw,sha256})=>{assert.equal(createHash("sha256").update(raw).digest("hex"),sha256);const t=JSON.parse(raw) as Table;return [`public.${t.name}`,t];}));
const server=join(import.meta.dir,".."),overlay=join(server,"recovery/recovery-20261018-v1");
const migration=readFileSync(join(overlay,"sql/0096_recovery_flow_sharing_foundations.sql"),"utf8");
const previousRaw=readFileSync(join(overlay,"meta/0095_snapshot.json"));
assert.equal(previousRaw.length,454058);
assert.equal(createHash("sha256").update(previousRaw).digest("hex"),"77ed1fad2c312ed16635d95a6fb40fe4e230b96f53c007c7b71a881dcd57cc4b");
const previous=JSON.parse(previousRaw.toString("utf8")) as Snapshot;
const next=JSON.parse(readFileSync(join(overlay,"meta/0096_snapshot.json"),"utf8")) as Snapshot;
const journal=JSON.parse(readFileSync(join(overlay,"meta/_journal.json"),"utf8")) as Journal;
/** Every non-whitespace character must be a supported SQL token. Comments other than the exact
 * Drizzle separator, dollar quoting, parameters and executable bodies are intentionally unsupported. */
function tokenize(source: string): string[] {
  const input = source.replaceAll("--> statement-breakpoint", " ");
  const pattern =
    /\s+|"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*|\d+|::|->>|->|>=|<=|<>|[().,;=+><~]/y;
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
} {
  const out: Record<string, Table> = {};
  const forced: string[] = [];
  const tokens = tokenize(source);
  assert.equal(tokens.at(-1), ";");
  for (const statement of parts(tokens, ";")) {
    const c = new Cursor(statement);
    if (c.peek() === "ALTER") {
      c.take("ALTER");
      c.take("TABLE");
      const name = c.table();
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
        c.take("NO");
        c.take("ACTION");
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
          onDelete: "no action",
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
  return { tables: out, forced };
}
const dialect = new PgDialect();
function render(sql: SQL): string {
  const query = dialect.sqlToQuery(sql);
  assert.equal(query.params.length, 0, "DDL expressions must be literal SQL");
  return query.sql;
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
      else {
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
  for (const constraint of config.uniqueConstraints) {
    const name = constraint.getName();
    assert.ok(name, "unique constraint name must be available");
    put(result.uniqueConstraints, name, {
      name,
      columns: constraint.columns.map((column) => column.name),
      nullsNotDistinct: constraint.nullsNotDistinct,
    });
  }
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






function checkSQL(source:string):void {const parsed=parseSQL(source);equalTargets(parsed.tables);assert.deepEqual(parsed.forced,[]);}
function checkSnapshot(s:Snapshot):void {
 assert.equal(previous.id,'51e51994-ec8a-4bc7-8ded-22894ca7d326');assert.equal(Object.keys(previous.tables).length,127);
 assert.equal(s.id,'ab7da0cb-1f23-4350-a61b-b5699869cb3d');assert.equal(s.prevId,previous.id);
 const restored=structuredClone(s),added:Record<string,Table>={};
 for(const key of Object.keys(s.tables))if(!(key in previous.tables)){const t=s.tables[key];assert.ok(t);added[key]=t;delete restored.tables[key];}
 assert.deepEqual(added,expected);restored.id=previous.id;restored.prevId=previous.prevId;
 assert.deepEqual(restored,previous,'all127 predecessor tables/toplevel including parent unique and domain unchanged');assert.equal(Object.keys(s.tables).length,129);
}
function checkJournal(j:Journal):void {
 const original=JSON.parse(readFileSync(join(server,'drizzle/meta/_journal.json'),'utf8')) as Journal;assert.equal(j.version,original.version);assert.equal(j.dialect,original.dialect);assert.ok(j.entries.length>=97,'stage prefix recognition only; unknown suffix has no release/execution authority');assert.deepEqual(j.entries.slice(0,81),original.entries);
 assert.equal(createHash('sha256').update(JSON.stringify(j.entries.slice(0,96))).digest('hex'),'e99ff88ab0796a2c9a648b27ea5186108f19f3292a716f038b82065a11bfcde6');
 const entry=j.entries[96],prev=j.entries[95];assert.ok(entry&&prev);assert.deepEqual(entry,{idx:96,version:'7',when:1792370439103,tag:'0096_recovery_flow_sharing_foundations',breakpoints:true});assert.ok(entry.when>prev.when&&entry.when<=Date.now());
}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
const actualMetadata=()=>Object.fromEntries([flowShareLinks,flowShareImports].map(model=>{const t=metadata(model);return [`public.${t.name}`,t];}));
function rejectSQL(before:string,after:string):void {assert.ok(migration.includes(before),'mutation must match original');const changed=migration.replace(before,after);assert.notEqual(changed,migration);expect(()=>checkSQL(changed)).toThrow();}
function changePolicy(table:string,name:string,change:(statement:string)=>string):string {
 const list=migration.split('--> statement-breakpoint'),marker=`CREATE POLICY "${name}" ON "public"."${table}"`;
 const hits=list.map((s,i)=>s.includes(marker)?i:-1).filter(i=>i>=0);assert.equal(hits.length,1);const at=hits[0];assert.ok(at!==undefined);const before=list[at];assert.ok(before);const after=change(before);assert.notEqual(after,before);list[at]=after;return list.join('--> statement-breakpoint');
}
// Verify exactly one semantic policy mutation, retaining every other table/policy and all other fields.
function rejectPolicy(table:string,name:string,field:'using'|'withCheck',change:(statement:string)=>string):void {
 const changed=changePolicy(table,name,change),before=parseSQL(migration).tables,after=parseSQL(changed).tables,key=`public.${table}`;
 const oldTable=before[key],newTable=after[key];assert.ok(oldTable&&newTable);const old=oldTable.policies[name],value=newTable.policies[name];assert.ok(old&&value);assert.notEqual(value[field],old[field]);
 const restored=structuredClone(after),restoredTable=restored[key];assert.ok(restoredTable);restoredTable.policies[name]=structuredClone(old);assert.deepEqual(restored,before,'only selected policy field may change');
 for(const f of ['name','as','for','to','using','withCheck'] as const)if(f!==field)assert.deepEqual(value[f],old[f]);expect(()=>checkSQL(changed)).toThrow();
}
const shareTenant='"flow_share_links"."tenant_id"=current_setting(\'app.tenant_id\',true)';
const shareToken='"flow_share_links"."token_hash"=current_setting(\'app.flow_share_token\',true)';
const shareEither=`${shareTenant} OR ${shareToken}`;
describe('recovery Flow sharing independent historical structure',()=>{
 test('two full independent target capsules retain fixed raw identities',()=>{expect(capsules).toHaveLength(2);for(const c of capsules)expect(createHash('sha256').update(c.raw).digest('hex')).toBe(c.sha256);});
 test('all17 statements fully consume and match independent columns/indexes/FKs/checks/policies/RLS',()=>{expect(migration.split('--> statement-breakpoint')).toHaveLength(17);checkSQL(migration);});
 test('actual Drizzle metadata matches all19columns3indexes2FK2checks8policies2ENABLE',()=>equalTargets(actualMetadata()));
 test('both custom JSONB driver and bound SQL params preserve object identity without double encoding',()=>{
  const values=[{version:1,flow:{fixture:true},members:[1,true,null]},{result:{fixture:true},optional:null}];const columns=[flowShareLinks.packageSnapshot,flowShareImports.result];
  for(let i=0;i<columns.length;i++){const column=columns[i],value=values[i];assert.ok(column&&value);expect(column.mapToDriverValue(value)).toBe(value);expect(column.mapFromDriverValue(value)).toBe(value);const query=dialect.sqlToQuery(sql`select ${sql.param(value,column)}::jsonb`);expect(query.params).toHaveLength(1);expect(query.params[0]).toBe(value);expect(typeof query.params[0]).toBe('object');expect(column.getSQLType()).toBe('jsonb');expect(column.hasDefault).toBe(false);}
  expect(flowShareLinks.packageSnapshot.notNull).toBe(true);expect(flowShareImports.result.notNull).toBe(false);
 });
 test('id defaults numeric zero nullable fields and no invented digest/token/JSON shape constraints are preserved',()=>{
  expect(flowShareLinks.id.hasDefault).toBe(false);expect(flowShareImports.id.hasDefault).toBe(true);expect(flowShareLinks.uses.default).toBe(0);expect(flowShareLinks.expiresAt.notNull).toBe(true);expect(flowShareLinks.expiresAt.hasDefault).toBe(false);
  for(const c of [flowShareLinks.maxUses,flowShareLinks.revokedAt,flowShareImports.flowId,flowShareImports.result]){expect(c.notNull).toBe(false);expect(c.hasDefault).toBe(false);}
  expect(getTableConfig(flowShareLinks).checks).toHaveLength(2);expect(getTableConfig(flowShareImports).checks).toHaveLength(0);
 });
 test('inverse both tables restores entire127 predecessor and all top-level structures',()=>checkSnapshot(next));
 test('journal0..95 and exact96 entry survive legitimate prefix successor without suffix release',()=>{checkJournal(journal);const j=structuredClone(journal);j.entries.push({idx:97,version:'7',when:Date.now(),tag:'unknown-prefix-fixture',breakpoints:true});checkJournal(j);expect(j.entries.length).toBe(journal.entries.length+1);});
 test('original163 and stages81..95 remain byte-identical on complete integration',()=>{
  const dir=join(server,'drizzle'),files=filesUnder(dir).sort();expect(files).toHaveLength(163);const rows=files.map(p=>{const b=readFileSync(p);return `${relative(dir,p)}\0${b.length}\0${createHash('sha256').update(b).digest('hex')}\n`;});expect(createHash('sha256').update(rows.join('')).digest('hex')).toBe('9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d');
  for(const input of [
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
  }
]){const b=readFileSync(join(server,input.path));expect(b.length).toBe(input.bytes);expect(createHash('sha256').update(b).digest('hex')).toBe(input.sha256);}
 });
 test('SQL default/type/null/check mutations reject genuine changes including full NULL guard/operator semantics',()=>{
  for(const [a,b] of [['"id" uuid NOT NULL PRIMARY KEY','"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY'],['"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY','"id" uuid NOT NULL PRIMARY KEY'],['"uses" integer DEFAULT 0 NOT NULL','"uses" integer DEFAULT \'0\' NOT NULL'],['"max_uses" integer,','"max_uses" integer NOT NULL,'],['"expires_at" timestamp with time zone NOT NULL','"expires_at" timestamp with time zone'],['"result" jsonb,','"result" jsonb NOT NULL,'],['"package_snapshot" jsonb NOT NULL','"package_snapshot" jsonb DEFAULT \'{}\'::jsonb NOT NULL'],['"result" jsonb,','"result" text,'],['"flow_share_links"."max_uses" IS NULL OR "flow_share_links"."max_uses">0','"flow_share_links"."max_uses">0'],['"flow_share_links"."uses">=0','"flow_share_links"."uses">0'],['"flow_share_links"."uses"<=','"flow_share_links"."uses"<']])rejectSQL(a,b);
 });
 test('SQL indexes preserve global token unique and tenant-request uniqueness plus ordinary owner scope and FK actions',()=>{
  for(const [a,b] of [['CREATE UNIQUE INDEX "flow_share_token_idx"','CREATE INDEX "flow_share_token_idx"'],['("token_hash" ASC NULLS LAST)','("tenant_id" ASC NULLS LAST, "token_hash" ASC NULLS LAST)'],['CREATE INDEX "flow_shares_owner_idx"','CREATE UNIQUE INDEX "flow_shares_owner_idx"'],['("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST)','("flow_id" ASC NULLS LAST)'],['CREATE UNIQUE INDEX "flow_import_request_idx"','CREATE INDEX "flow_import_request_idx"'],['("tenant_id" ASC NULLS LAST, "request_id" ASC NULLS LAST)','("request_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST)'],[' ASC NULLS LAST',' DESC NULLS LAST'],['NULLS LAST','NULLS FIRST'],['USING btree','USING hash'],['CREATE INDEX "flow_shares_owner_idx"','CREATE INDEX CONCURRENTLY "flow_shares_owner_idx"'],['("token_hash" ASC NULLS LAST);','("token_hash" ASC NULLS LAST) WHERE true;'],['ON DELETE NO ACTION','ON DELETE CASCADE'],['ON UPDATE NO ACTION','ON UPDATE CASCADE'],['REFERENCES "public"."waker_flows" ("id")','REFERENCES "public"."waker_flows" ("tenant_id")']])rejectSQL(a,b);
 });
 test('links UPDATE WITH CHECK token branch missing/tenant-only and added owner/system branches are rejected semantically',()=>{
  rejectPolicy('flow_share_links','share_update','withCheck',s=>s.replace(` WITH CHECK (${shareEither})`,''));
  rejectPolicy('flow_share_links','share_update','withCheck',s=>s.replace(`WITH CHECK (${shareEither})`,`WITH CHECK (${shareTenant})`));
  for(const extra of [' OR "flow_share_links"."tenant_id"=\'system\'',' OR "flow_share_links"."tenant_id"=current_setting(\'app.owner_id\',true)'])rejectPolicy('flow_share_links','share_update','withCheck',s=>s.replace(`WITH CHECK (${shareEither})`,`WITH CHECK (${shareEither}${extra})`));
 });
 test('links SELECT/UPDATE USING retain token branch while INSERT and DELETE stay tenant-only',()=>{
  for(const name of ['share_select','share_update'])rejectPolicy('flow_share_links',name,'using',s=>s.replace(`USING (${shareEither})`,`USING (${shareTenant})`));
  rejectPolicy('flow_share_links','share_insert','withCheck',s=>s.replace(`WITH CHECK (${shareTenant})`,`WITH CHECK (${shareEither})`));
  rejectPolicy('flow_share_links','share_delete','using',s=>s.replace(`USING (${shareTenant})`,`USING (${shareEither})`));
 });
 test('imports INSERT and UPDATE WITH CHECK are separately uniquely mutated with all other7 policies unchanged',()=>{
  const predicate='"flow_share_imports"."tenant_id" = current_setting(\'app.tenant_id\', true)';
  for(const name of ['tenant_scope_insert','tenant_scope_update'])rejectPolicy('flow_share_imports',name,'withCheck',s=>s.replace(`WITH CHECK (${predicate})`,'WITH CHECK (true)'));
  rejectPolicy('flow_share_imports','tenant_scope_update','using',s=>s.replace(`USING (${predicate})`,'USING (true)'));
 });
 test('RLS/policy role/mode/extra effects and unconsumed SQL reject without granting authority',()=>{
  for(const [a,b] of [['ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY'],['AS PERMISSIVE','AS RESTRICTIVE'],['TO public','TO owner']])rejectSQL(a,b);
  for(const extra of ['UPDATE "public"."flow_share_links" SET "uses"=0;','GRANT ALL ON "public"."flow_share_links" TO public;','SELECT 1;','CREATE TABLE "public"."extra" ("id" uuid NOT NULL PRIMARY KEY);'])expect(()=>checkSQL(migration+extra)).toThrow();expect(()=>checkSQL(migration+migration)).toThrow();expect(()=>checkSQL(migration+'$bad$')).toThrow();
 });
 test('full metadata rejects altered nullable/default/check/index/FK/policies and RLS',()=>{
  const edits:((tables:Record<string,Table>)=>void)[]=[
   ts=>{const t=ts['public.flow_share_links'];assert.ok(t);const c=t.columns.id;assert.ok(c);c.default='gen_random_uuid()';},
   ts=>{const t=ts['public.flow_share_imports'];assert.ok(t);const c=t.columns.result;assert.ok(c);c.notNull=true;},
   ts=>{const t=ts['public.flow_share_links'];assert.ok(t);t.checkConstraints={};},
   ts=>{const t=ts['public.flow_share_links'];assert.ok(t);const i=t.indexes.flow_share_token_idx;assert.ok(i);i.isUnique=false;},
   ts=>{const t=ts['public.flow_share_imports'];assert.ok(t);t.foreignKeys={};},
   ts=>{const t=ts['public.flow_share_links'];assert.ok(t);const p=t.policies.share_update;assert.ok(p);delete p.withCheck;},
   ts=>{const t=ts['public.flow_share_imports'];assert.ok(t);t.isRLSEnabled=false;},
  ];for(const edit of edits){const actual=actualMetadata();edit(actual);expect(()=>equalTargets(actual)).toThrow();}
 });
 test('snapshot/journal reject old127 parent/domain drift and any lineage/prefix mutation',()=>{
  const edits:((s:Snapshot)=>void)[]=[s=>{delete s.tables['public.flow_share_links'];},s=>{s.id=previous.id;},s=>{s.prevId='wrong';},s=>{s.extraTop=true;},s=>{const t=s.tables['public.threads'];assert.ok(t);t.uniqueConstraints={};},s=>{const t=s.tables['public.approval_direct_execution_domains'];assert.ok(t);t.columns={};},s=>{const t=s.tables['public.automations'];assert.ok(t);t.columns={};}];
  for(const edit of edits){const s=structuredClone(next);edit(s);expect(()=>checkSnapshot(s)).toThrow();}
  for(let idx=0;idx<=96;idx++){const j=structuredClone(journal),e=j.entries[idx];assert.ok(e);e.tag='forged';expect(()=>checkJournal(j)).toThrow();}const j=structuredClone(journal),entry=j.entries[96];assert.ok(entry);entry.when++;expect(()=>checkJournal(j)).toThrow();
 });
});

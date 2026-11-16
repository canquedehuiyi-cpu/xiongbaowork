import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { flowOfficialBindings, flowOfficialSourceHeads } from "../src/db/schema/flow-official-bindings";
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

// Complete independent0121 capsules, whole583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f. Not implementation-generated expectations.
const capsules=[
  {
    "raw": "{\n  \"name\": \"flow_official_source_heads\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"source_id\": {\n      \"name\": \"source_id\",\n      \"type\": \"text\",\n      \"primaryKey\": true,\n      \"notNull\": true\n    },\n    \"source_version\": {\n      \"name\": \"source_version\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"source_digest\": {\n      \"name\": \"source_digest\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {},\n  \"compositePrimaryKeys\": {},\n  \"uniqueConstraints\": {},\n  \"policies\": {},\n  \"checkConstraints\": {\n    \"flow_official_source_heads_digest_check\": {\n      \"name\": \"flow_official_source_heads_digest_check\",\n      \"value\": \"\\\"flow_official_source_heads\\\".\\\"source_digest\\\" ~ '^[a-f0-9]{64}$'\"\n    }\n  },\n  \"isRLSEnabled\": false\n}\n",
    "sha256": "f93d987139a3b9fc89642f92ca898a54f0acc52e21974bb13fa5c8403adf74d5"
  },
  {
    "raw": "{\n  \"name\": \"flow_official_bindings\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"flow_id\": {\n      \"name\": \"flow_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": true,\n      \"notNull\": true\n    },\n    \"source_id\": {\n      \"name\": \"source_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"source_version\": {\n      \"name\": \"source_version\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"source_digest\": {\n      \"name\": \"source_digest\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"bindings\": {\n      \"name\": \"bindings\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {\n    \"flow_official_bindings_owner_flow_idx\": {\n      \"name\": \"flow_official_bindings_owner_flow_idx\",\n      \"columns\": [\n        {\n          \"expression\": \"tenant_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"flow_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": true,\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    }\n  },\n  \"foreignKeys\": {\n    \"flow_official_bindings_flow_id_waker_flows_id_fk\": {\n      \"name\": \"flow_official_bindings_flow_id_waker_flows_id_fk\",\n      \"tableFrom\": \"flow_official_bindings\",\n      \"tableTo\": \"waker_flows\",\n      \"columnsFrom\": [\n        \"flow_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"no action\",\n      \"onUpdate\": \"no action\"\n    },\n    \"flow_official_bindings_source_id_flow_official_source_heads_source_id_fk\": {\n      \"name\": \"flow_official_bindings_source_id_flow_official_source_heads_source_id_fk\",\n      \"tableFrom\": \"flow_official_bindings\",\n      \"tableTo\": \"flow_official_source_heads\",\n      \"columnsFrom\": [\n        \"source_id\"\n      ],\n      \"columnsTo\": [\n        \"source_id\"\n      ],\n      \"onDelete\": \"no action\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {},\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"tenant_scope_select\": {\n      \"name\": \"tenant_scope_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_official_bindings\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\"\n    },\n    \"tenant_scope_insert\": {\n      \"name\": \"tenant_scope_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"\\\"flow_official_bindings\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = \\\"flow_official_bindings\\\".\\\"flow_id\\\" AND owned_flow.tenant_id = current_setting('app.tenant_id', true))\"\n    },\n    \"tenant_scope_update\": {\n      \"name\": \"tenant_scope_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_official_bindings\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\",\n      \"withCheck\": \"\\\"flow_official_bindings\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND EXISTS (SELECT 1 FROM public.waker_flows AS owned_flow WHERE owned_flow.id = \\\"flow_official_bindings\\\".\\\"flow_id\\\" AND owned_flow.tenant_id = current_setting('app.tenant_id', true))\"\n    },\n    \"tenant_scope_delete\": {\n      \"name\": \"tenant_scope_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"flow_official_bindings\\\".\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\"\n    }\n  },\n  \"checkConstraints\": {\n    \"flow_official_bindings_digest_check\": {\n      \"name\": \"flow_official_bindings_digest_check\",\n      \"value\": \"\\\"flow_official_bindings\\\".\\\"source_digest\\\" ~ '^[a-f0-9]{64}$'\"\n    },\n    \"flow_official_bindings_object_check\": {\n      \"name\": \"flow_official_bindings_object_check\",\n      \"value\": \"jsonb_typeof(\\\"flow_official_bindings\\\".\\\"bindings\\\") = 'object'\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "eabc98173bec8ca94bb323527812debb200f341043906790f65a25f433b923e2"
  }
];
const expected:Record<string,Table>=Object.fromEntries(capsules.map(({raw,sha256})=>{assert.equal(createHash("sha256").update(raw).digest("hex"),sha256);const t=JSON.parse(raw) as Table;return [`public.${t.name}`,t];}));
const server=join(import.meta.dir,".."),overlay=join(server,"recovery/recovery-20261018-v1");
const migration=readFileSync(join(overlay,"sql/0089_recovery_flow_official_bindings.sql"),"utf8");
const previous=JSON.parse(readFileSync(join(overlay,"meta/0088_snapshot.json"),"utf8")) as Snapshot;
const next=JSON.parse(readFileSync(join(overlay,"meta/0089_snapshot.json"),"utf8")) as Snapshot;
const journal=JSON.parse(readFileSync(join(overlay,"meta/_journal.json"),"utf8")) as Journal;
const tables=[flowOfficialSourceHeads,flowOfficialBindings];
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


function checkSQL(source:string):void {const parsed=parseSQL(source);assert.deepEqual(Object.keys(parsed.tables),['public.flow_official_source_heads','public.flow_official_bindings']);equalTargets(parsed.tables);assert.deepEqual(parsed.forced,[]);}
function checkSnapshot(s:Snapshot):void {
 assert.equal(previous.id,'6eb714c8-c85d-48b3-aff1-4023751ec7a0');assert.equal(s.prevId,previous.id);assert.equal(s.id,'a12f8503-a583-42fa-922b-619e2c5b15af');assert.notEqual(s.id,previous.id);
 const restored=structuredClone(s),added:Record<string,Table>={};for(const key of Object.keys(s.tables))if(!(key in previous.tables)){const t=s.tables[key];assert.ok(t);added[key]=t;delete restored.tables[key];}assert.deepEqual(added,expected);restored.id=previous.id;restored.prevId=previous.prevId;assert.deepEqual(restored,previous);assert.equal(Object.keys(s.tables).length,120);
}
function checkJournal(j:Journal):void {
 const historical=JSON.parse(readFileSync(join(server,'drizzle/meta/_journal.json'),'utf8')) as Journal;assert.equal(j.version,historical.version);assert.equal(j.dialect,historical.dialect);assert.ok(j.entries.length>=90,'complete stage prefix, not permission for unknown suffix execution');assert.deepEqual(j.entries.slice(0,81),historical.entries);assert.equal(createHash('sha256').update(JSON.stringify(j.entries.slice(0,89))).digest('hex'),'224c8998708f3a72c5a50e27dee1306f568939b64245ebc288c090929a32fe74');
 const entry=j.entries[89];assert.ok(entry);assert.deepEqual(entry,{idx:89,version:'7',when:1792352647000,tag:'0089_recovery_flow_official_bindings',breakpoints:true});const predecessor=j.entries[88];assert.ok(predecessor);assert.ok(entry.when>predecessor.when&&entry.when<=Date.now());
}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
const actualMetadata=()=>Object.fromEntries(tables.map(table=>{const m=metadata(table);return [`public.${m.name}`,m];}));
function rejectSQL(before:string,after:string):void {assert.ok(migration.includes(before),'negative fixture must hit originalSQL');const changed=migration.replace(before,after);assert.notEqual(changed,migration);expect(()=>checkSQL(changed)).toThrow();}
// Target a complete independently identified policy statement, not the first shared WITH CHECK substring.
function changePolicy(source:string,name:string,change:(statement:string)=>string):string {
 const statements=source.split('--> statement-breakpoint');const marker=`CREATE POLICY "${name}" ON "public"."flow_official_bindings"`;const hits=statements.map((s,i)=>s.includes(marker)?i:-1).filter(i=>i>=0);assert.equal(hits.length,1);const at=hits[0];assert.ok(at!==undefined);const statement=statements[at];assert.ok(statement);const changed=change(statement);assert.notEqual(changed,statement);statements[at]=changed;return statements.join('--> statement-breakpoint');
}
describe('recovery official source heads and Flow bindings historical structure',()=>{
 test('complete independent capsules retain approved rawSHA identities',()=>{for(const c of capsules)expect(createHash('sha256').update(c.raw).digest('hex')).toBe(c.sha256);});
 test('all10 SQL statements fully consume and preserve complete independent table definitions',()=>checkSQL(migration));
 test('actual Drizzle metadata preserves head RLSfalse and binding policies globalPK/defaults',()=>equalTargets(actualMetadata()));
 test('inverse two tables restores all118 predecessor tables and every top-level object',()=>checkSnapshot(next));
 test('Root exact89 identity keeps0..88 prefix and accepts later prefix without execution authority',()=>{checkJournal(journal);const j=structuredClone(journal);j.entries.push({idx:90,version:'7',when:Date.now(),tag:'unapproved-prefix-fixture',breakpoints:true});checkJournal(j);expect(j.entries.length).toBe(journal.entries.length+1);});
 test('original163 plus approved81..88 input SQL and snapshots retain exact bytesSHA',()=>{
  const dir=join(server,'drizzle'),files=filesUnder(dir).sort();expect(files).toHaveLength(163);const rows=files.map(p=>{const b=readFileSync(p);return `${relative(dir,p)}\0${b.length}\0${createHash('sha256').update(b).digest('hex')}\n`;});expect(createHash('sha256').update(rows.join('')).digest('hex')).toBe('9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d');for(const input of [
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
  }
]){const b=readFileSync(join(server,input.path));expect(b.length).toBe(input.bytes);expect(createHash('sha256').update(b).digest('hex')).toBe(input.sha256);}
 });
 test('custom JSON object driver and absent defaults preserve unencoded caller object without PG claim',()=>{
  const value={unknown:{keep:[1,null]},bindings:{tool:'fixture'}};expect(flowOfficialBindings.bindings.mapToDriverValue(value)).toBe(value);expect(flowOfficialBindings.bindings.notNull).toBe(true);expect(flowOfficialBindings.bindings.hasDefault).toBe(false);expect(flowOfficialSourceHeads.sourceId.hasDefault).toBe(false);expect(flowOfficialSourceHeads.sourceVersion.hasDefault).toBe(false);expect(flowOfficialSourceHeads.sourceDigest.hasDefault).toBe(false);expect(flowOfficialBindings.flowId.hasDefault).toBe(false);expect(getTableConfig(flowOfficialSourceHeads).enableRLS).toBe(false);expect(getTableConfig(flowOfficialSourceHeads).policies).toHaveLength(0);
 });
 test('SQL rejects head invented tenancy RLS defaults and globalFlowPK or precise index drift',()=>{
  for(const [a,b] of [
   ['"source_id" text NOT NULL PRIMARY KEY','"source_id" text DEFAULT \'invented\' NOT NULL PRIMARY KEY'],['"source_version" text NOT NULL','"source_version" text'],['"source_digest" text NOT NULL','"source_digest" text DEFAULT \'\' NOT NULL'],['"flow_id" uuid NOT NULL PRIMARY KEY','"flow_id" uuid NOT NULL'],['"bindings" jsonb NOT NULL','"bindings" jsonb DEFAULT \'{}\' NOT NULL'],
   ['CREATE UNIQUE INDEX','CREATE INDEX'],[' ASC NULLS LAST',' DESC NULLS LAST'],['NULLS LAST','NULLS FIRST'],['USING btree','USING hash'],['("tenant_id" ASC NULLS LAST, "flow_id" ASC NULLS LAST)','("flow_id" ASC NULLS LAST, "tenant_id" ASC NULLS LAST)'],['"source_version" text NOT NULL,','"source_version" text NOT NULL, "tenant_id" text,'],
  ])rejectSQL(a,b);
  expect(()=>checkSQL(migration+'ALTER TABLE "public"."flow_official_source_heads" ENABLE ROW LEVEL SECURITY;')).toThrow();
 });
 test('SQL rejects altered digest/object checks FK identity actions and added constraints or grants',()=>{
  for(const [a,b] of [["'^[a-f0-9]{64}$'","'^[A-Fa-f0-9]{64}$'"],["= 'object'","= 'string'"],['REFERENCES "public"."waker_flows"','REFERENCES "public"."flow_source_runs"'],['REFERENCES "public"."flow_official_source_heads" ("source_id")','REFERENCES "public"."flow_official_source_heads" ("source_version")'],['ON DELETE NO ACTION','ON DELETE CASCADE'],['ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY']])rejectSQL(a,b);
  for(const extra of ['UPDATE "public"."flow_official_source_heads" SET "source_version"=\'new\';','GRANT ALL ON "public"."flow_official_source_heads" TO public;','ALTER TABLE "public"."flow_official_bindings" ADD CONSTRAINT "invented" CHECK (true);','SELECT 1;'])expect(()=>checkSQL(migration+extra)).toThrow();expect(()=>checkSQL(migration+migration)).toThrow();
 });
 test('INSERT WITHCHECK and UPDATE WITHCHECK are separate true negatives preserving other statement',()=>{
  const tenant='"flow_official_bindings"."tenant_id" = current_setting(\'app.tenant_id\', true)';const mutation=(s:string)=>s.replace(`WITH CHECK (${tenant} AND EXISTS`,'WITH CHECK (true AND EXISTS');
  const insertChanged=changePolicy(migration,'tenant_scope_insert',mutation);const updateChanged=changePolicy(migration,'tenant_scope_update',mutation);
  const original=parseSQL(migration).tables['public.flow_official_bindings'];assert.ok(original);const insert=parseSQL(insertChanged).tables['public.flow_official_bindings'];const update=parseSQL(updateChanged).tables['public.flow_official_bindings'];assert.ok(insert&&update);
  expect(insert.policies.tenant_scope_update).toEqual(original.policies.tenant_scope_update);expect(update.policies.tenant_scope_insert).toEqual(original.policies.tenant_scope_insert);expect(()=>checkSQL(insertChanged)).toThrow();expect(()=>checkSQL(updateChanged)).toThrow();
  for(const name of ['tenant_scope_insert','tenant_scope_update']){const changed=changePolicy(migration,name,s=>s.replace('owned_flow.id = "flow_official_bindings"."flow_id"','true'));expect(()=>checkSQL(changed)).toThrow();const scope=changePolicy(migration,name,s=>s.replace("owned_flow.tenant_id = current_setting('app.tenant_id', true)",'true'));expect(()=>checkSQL(scope)).toThrow();}
  const changed=changePolicy(migration,'tenant_scope_update',s=>s.replace(`USING (${tenant})`,'USING (true)'));expect(()=>checkSQL(changed)).toThrow();
 });
 test('metadata snapshot lineage and prefix tampering reject while old keys remain strict',()=>{
  for(const mutate of [(t:Table)=>{t.policies={};},(t:Table)=>{t.foreignKeys={};},(t:Table)=>{t.indexes={};},(t:Table)=>{t.checkConstraints={};},(t:Table)=>{const col=t.columns.flow_id;assert.ok(col);col.primaryKey=false;}]){const actual=actualMetadata();const t=actual['public.flow_official_bindings'];assert.ok(t);mutate(t);expect(()=>equalTargets(actual)).toThrow();}
  const mutators:((s:Snapshot)=>void)[]=[s=>{delete s.tables['public.flow_official_source_heads'];},s=>{s.prevId='wrong';},s=>{s.id=previous.id;},s=>{const t=s.tables['public.flow_official_source_heads'];assert.ok(t);t.isRLSEnabled=true;},s=>{const t=s.tables['public.waker_flows'];assert.ok(t);t.checkConstraints={};},s=>{const t=s.tables['public.flow_run_events'];assert.ok(t);t.indexes={};}];for(const mutate of mutators){const s=structuredClone(next);mutate(s);expect(()=>checkSnapshot(s)).toThrow();}
  for(const idx of [0,81,82,83,84,85,86,87,88,89]){const j=structuredClone(journal);const entry=j.entries[idx];assert.ok(entry);entry.tag='forged';expect(()=>checkJournal(j)).toThrow();}const j=structuredClone(journal);const entry=j.entries[89];assert.ok(entry);entry.when++;expect(()=>checkJournal(j)).toThrow();
 });
});

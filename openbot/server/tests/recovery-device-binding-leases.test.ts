import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { employeeDeviceBindings, runnerDeviceConnectionLeases } from "../src/db/schema/device-binding-leases";
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

// Independent complete0121 raw tables, never generated from this schema implementation.
// Whole583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules=[
  {
    "raw": "{\n  \"name\": \"employee_device_bindings\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"agent_id\": {\n      \"name\": \"agent_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"registration_id\": {\n      \"name\": \"registration_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"revision\": {\n      \"name\": \"revision\",\n      \"type\": \"bigint\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {},\n  \"compositePrimaryKeys\": {\n    \"employee_device_bindings_tenant_id_agent_id_pk\": {\n      \"name\": \"employee_device_bindings_tenant_id_agent_id_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"agent_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"employee_device_bindings_owner_select\": {\n      \"name\": \"employee_device_bindings_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    },\n    \"employee_device_bindings_owner_insert\": {\n      \"name\": \"employee_device_bindings_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    },\n    \"employee_device_bindings_owner_update\": {\n      \"name\": \"employee_device_bindings_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true)\",\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    },\n    \"employee_device_bindings_owner_delete\": {\n      \"name\": \"employee_device_bindings_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    }\n  },\n  \"checkConstraints\": {\n    \"employee_device_binding_tenant\": {\n      \"name\": \"employee_device_binding_tenant\",\n      \"value\": \"\\\"employee_device_bindings\\\".\\\"tenant_id\\\" NOT IN ('system','platform')\"\n    },\n    \"employee_device_binding_revision\": {\n      \"name\": \"employee_device_binding_revision\",\n      \"value\": \"\\\"employee_device_bindings\\\".\\\"revision\\\" BETWEEN 1 AND 9007199254740991\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "dfea06b0e6840b102a22263d1efc4300b73ee8b1e6d5519f8e26117f960bcc8f"
  },
  {
    "raw": "{\n  \"name\": \"runner_device_connection_leases\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"registration_id\": {\n      \"name\": \"registration_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"device_id\": {\n      \"name\": \"device_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"session_id\": {\n      \"name\": \"session_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"credential_version\": {\n      \"name\": \"credential_version\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"owner_replica_id\": {\n      \"name\": \"owner_replica_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"epoch\": {\n      \"name\": \"epoch\",\n      \"type\": \"bigint\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"state\": {\n      \"name\": \"state\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"expires_at\": {\n      \"name\": \"expires_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"closed_at\": {\n      \"name\": \"closed_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"clock_timestamp()\"\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {},\n  \"compositePrimaryKeys\": {\n    \"runner_device_connection_leases_pk\": {\n      \"name\": \"runner_device_connection_leases_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"registration_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"runner_device_connection_leases_owner_select\": {\n      \"name\": \"runner_device_connection_leases_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id',true)\"\n    },\n    \"runner_device_connection_leases_owner_insert\": {\n      \"name\": \"runner_device_connection_leases_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id',true)\"\n    },\n    \"runner_device_connection_leases_owner_update\": {\n      \"name\": \"runner_device_connection_leases_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id',true)\",\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id',true)\"\n    },\n    \"runner_device_connection_leases_owner_delete\": {\n      \"name\": \"runner_device_connection_leases_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id',true)\"\n    }\n  },\n  \"checkConstraints\": {\n    \"runner_device_connection_leases_epoch_safe\": {\n      \"name\": \"runner_device_connection_leases_epoch_safe\",\n      \"value\": \"\\\"runner_device_connection_leases\\\".\\\"epoch\\\" >= 1 AND \\\"runner_device_connection_leases\\\".\\\"epoch\\\" <= 9007199254740991\"\n    },\n    \"runner_device_connection_leases_state\": {\n      \"name\": \"runner_device_connection_leases_state\",\n      \"value\": \"\\\"runner_device_connection_leases\\\".\\\"state\\\" IN ('connected','disconnected')\"\n    },\n    \"runner_device_connection_leases_credential\": {\n      \"name\": \"runner_device_connection_leases_credential\",\n      \"value\": \"\\\"runner_device_connection_leases\\\".\\\"credential_version\\\" ~ '^[a-f0-9]{64}$'\"\n    },\n    \"runner_device_connection_leases_identity\": {\n      \"name\": \"runner_device_connection_leases_identity\",\n      \"value\": \"\\\"runner_device_connection_leases\\\".\\\"tenant_id\\\" <> '' AND \\\"runner_device_connection_leases\\\".\\\"device_id\\\" <> '' AND \\\"runner_device_connection_leases\\\".\\\"session_id\\\" <> ''\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "93c23d68e5cc63a5ef9f16b20e27080b1a7678f47d522bc3c5b397e5ad6ace39"
  }
];
const expected:Record<string,Table>=Object.fromEntries(capsules.map(({raw,sha256})=>{assert.equal(createHash("sha256").update(raw).digest("hex"),sha256);const t=JSON.parse(raw) as Table;return [`public.${t.name}`,t];}));
const server=join(import.meta.dir,".."),overlay=join(server,"recovery/recovery-20261018-v1");
const migration=readFileSync(join(overlay,"sql/0098_recovery_device_binding_leases.sql"),"utf8");
const previousRaw=readFileSync(join(overlay,"meta/0097_snapshot.json"));assert.equal(previousRaw.length,471291);assert.equal(createHash("sha256").update(previousRaw).digest("hex"),"0bc645a65fc289437489a3e000596616f3694bc6325a4be7a10f59597e941a37");
const previous=JSON.parse(previousRaw.toString("utf8")) as Snapshot;
const next=JSON.parse(readFileSync(join(overlay,"meta/0098_snapshot.json"),"utf8")) as Snapshot;
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
 assert.equal(previous.id,'d61a0c87-429e-4fd0-8e3b-862dcb65302a');assert.equal(Object.keys(previous.tables).length,131);assert.equal(s.id,'961a5fed-fc46-4864-bd32-2e6760e0d52e');assert.equal(s.prevId,previous.id);
 const restored=structuredClone(s),added:Record<string,Table>={};for(const key of Object.keys(s.tables))if(!(key in previous.tables)){const t=s.tables[key];assert.ok(t);added[key]=t;delete restored.tables[key];}assert.deepEqual(added,expected);restored.id=previous.id;restored.prevId=previous.prevId;assert.deepEqual(restored,previous,'all131 predecessor tables/tops, parent unique and domain stay exact');assert.equal(Object.keys(s.tables).length,133);
}
function checkJournal(j:Journal):void {
 const original=JSON.parse(readFileSync(join(server,'drizzle/meta/_journal.json'),'utf8')) as Journal;assert.equal(j.version,original.version);assert.equal(j.dialect,original.dialect);assert.ok(j.entries.length>=99,'prefix recognition only, no suffix release/execution authority');assert.deepEqual(j.entries.slice(0,81),original.entries);assert.equal(createHash('sha256').update(JSON.stringify(j.entries.slice(0,98))).digest('hex'),'3ae5aa2f0aa537b4b97868eb31ae535b36f6978674cb6d3e7bc6ab76a93f44bc');const entry=j.entries[98],prev=j.entries[97];assert.ok(entry&&prev);assert.deepEqual(entry,{idx:98,version:'7',when:1792374590000,tag:'0098_recovery_device_binding_leases',breakpoints:true});assert.ok(entry.when>prev.when&&entry.when<=Date.now());
}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
const actualMetadata=()=>Object.fromEntries([employeeDeviceBindings,runnerDeviceConnectionLeases].map(model=>{const t=metadata(model);return [`public.${t.name}`,t];}));
function rejectSQL(before:string,after:string):void {assert.ok(migration.includes(before),'mutation must match original');const changed=migration.replace(before,after);assert.notEqual(changed,migration);expect(()=>checkSQL(changed)).toThrow();}
function changePolicy(table:string,name:string,change:(statement:string)=>string):string {
 const list=migration.split('--> statement-breakpoint'),marker=`CREATE POLICY "${name}" ON "public"."${table}"`,hits=list.map((s,i)=>s.includes(marker)?i:-1).filter(i=>i>=0);assert.equal(hits.length,1);const at=hits[0];assert.ok(at!==undefined);const before=list[at];assert.ok(before);const after=change(before);assert.notEqual(after,before);list[at]=after;return list.join('--> statement-breakpoint');
}
function rejectPolicy(table:string,name:string,field:'using'|'withCheck',change:(statement:string)=>string):void {
 const changed=changePolicy(table,name,change),before=parseSQL(migration).tables,after=parseSQL(changed).tables,key=`public.${table}`,oldTable=before[key],newTable=after[key];assert.ok(oldTable&&newTable);const old=oldTable.policies[name],value=newTable.policies[name];assert.ok(old&&value);assert.notEqual(value[field],old[field]);const restored=structuredClone(after),restoredTable=restored[key];assert.ok(restoredTable);restoredTable.policies[name]=structuredClone(old);assert.deepEqual(restored,before);for(const f of ['name','as','for','to','using','withCheck'] as const)if(f!==field)assert.deepEqual(value[f],old[f]);expect(()=>checkSQL(changed)).toThrow();
}
describe('recovery device binding leases exact historical structure and Root bigint mode',()=>{
 test('independent full two raw capsules retain fixed identities',()=>{expect(capsules).toHaveLength(2);for(const c of capsules)expect(createHash('sha256').update(c.raw).digest('hex')).toBe(c.sha256);});
 test('all12 SQL statements fully consume and equal all independent target structure',()=>{expect(migration.split('--> statement-breakpoint')).toHaveLength(12);checkSQL(migration);});
 test('real Drizzle16columns2compositePK6CHECK8policy2ENABLE deep-equal oracles',()=>equalTargets(actualMetadata()));
 test('Root frozen bigint mode maps decimal-string endpoints exactly without narrowing to number',()=>{
  for(const column of [employeeDeviceBindings.revision,runnerDeviceConnectionLeases.epoch]){expect(column.dataType).toBe('bigint');expect(column.columnType).toBe('PgBigInt64');expect(column.getSQLType()).toBe('bigint');expect(column.notNull).toBe(true);expect(column.hasDefault).toBe(false);expect(column.mapFromDriverValue('1')).toBe(1n);expect(column.mapFromDriverValue('9007199254740991')).toBe(9007199254740991n);}
 });
 test('mapper accepts negative and oversized integers; CHECK is not mapper validation',()=>{
  for(const column of [employeeDeviceBindings.revision,runnerDeviceConnectionLeases.epoch]){expect(column.mapFromDriverValue('-1')).toBe(-1n);expect(column.mapFromDriverValue('9007199254740992')).toBe(9007199254740992n);}
  // These successful conversions are intentional SDK facts, not legal persisted values or PG evidence.
 });
 test('actual mapper and sql.param retain original bigint parameters without Number or JSON conversion',()=>{
  for(const column of [employeeDeviceBindings.revision,runnerDeviceConnectionLeases.epoch])for(const value of [1n,9007199254740991n,-1n,9007199254740992n]){expect(column.mapToDriverValue(value)).toBe(value);const query=dialect.sqlToQuery(sql`select ${sql.param(value,column)}::bigint`);expect(query.params).toHaveLength(1);expect(query.params[0]).toBe(value);expect(typeof query.params[0]).toBe('bigint');}
  // Encoder-bound parameter identity does not prove Bun wire/DTO behavior or execution acceptance.
 });
 test('binding tenant has no default while lease tenant has GUC and clocks remain distinct',()=>{
  expect(employeeDeviceBindings.tenantId.hasDefault).toBe(false);expect(employeeDeviceBindings.tenantId.notNull).toBe(true);expect(runnerDeviceConnectionLeases.tenantId.hasDefault).toBe(true);expect(employeeDeviceBindings.registrationId.notNull).toBe(false);expect(employeeDeviceBindings.registrationId.hasDefault).toBe(false);expect(runnerDeviceConnectionLeases.closedAt.notNull).toBe(false);expect(runnerDeviceConnectionLeases.closedAt.hasDefault).toBe(false);
  const b=actualMetadata()['public.employee_device_bindings'],l=actualMetadata()['public.runner_device_connection_leases'];assert.ok(b&&l);expect(b.columns.updated_at?.default).toBe('now()');expect(l.columns.updated_at?.default).toBe('clock_timestamp()');
  for(const model of [employeeDeviceBindings,runnerDeviceConnectionLeases]){const c=getTableConfig(model);expect(c.foreignKeys).toHaveLength(0);expect(c.indexes).toHaveLength(0);expect(c.uniqueConstraints).toHaveLength(0);expect(c.columns.some(x=>x.primary)).toBe(false);expect(c.enableRLS).toBe(true);expect(c.policies).toHaveLength(4);}
 });
 test('inverse tables restores entire131 old snapshot and all top-level data',()=>checkSnapshot(next));
 test('journal0..97 exact plus98 identity accepts successor prefix without execution authority',()=>{checkJournal(journal);const j=structuredClone(journal);j.entries.push({idx:99,version:'7',when:Date.now(),tag:'unknown-prefix-fixture',breakpoints:true});checkJournal(j);expect(j.entries.length).toBe(journal.entries.length+1);});
 test('original163 and every81..97 SQL/snapshot remain byte-identical on complete integration',()=>{
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
  }
]){const b=readFileSync(join(server,input.path));expect(b.length).toBe(input.bytes);expect(createHash('sha256').update(b).digest('hex')).toBe(input.sha256);}
 });
 test('complete SQL oracle rejects compositePK order/name, defaults/null/type and clock drift',()=>{
  for(const [a,b] of [['PRIMARY KEY ("tenant_id", "agent_id")','PRIMARY KEY ("agent_id", "tenant_id")'],['PRIMARY KEY ("tenant_id", "registration_id")','PRIMARY KEY ("registration_id", "tenant_id")'],['"employee_device_bindings_tenant_id_agent_id_pk"','"wrong_pk"'],['"tenant_id" text NOT NULL','"tenant_id" text DEFAULT current_setting(\'app.tenant_id\', true) NOT NULL'],['"tenant_id" text DEFAULT current_setting(\'app.tenant_id\', true) NOT NULL','"tenant_id" text NOT NULL'],['"registration_id" uuid,','"registration_id" uuid NOT NULL,'],['"revision" bigint NOT NULL','"revision" integer NOT NULL'],['"epoch" bigint NOT NULL','"epoch" bigint DEFAULT 1 NOT NULL'],['"closed_at" timestamp with time zone,','"closed_at" timestamp with time zone NOT NULL,'],['DEFAULT clock_timestamp()','DEFAULT now()']])rejectSQL(a,b);
 });
 test('CHECK token boundaries reject weakened/stronger expressions without pretending to execute SQL',()=>{
  for(const [a,b] of [['BETWEEN 1 AND 9007199254740991','BETWEEN 0 AND 9007199254740991'],['BETWEEN 1 AND 9007199254740991','BETWEEN 1 AND 9007199254740992'],['"epoch" >= 1','"epoch" > 1'],['"epoch" <= 9007199254740991','"epoch" < 9007199254740991'],["NOT IN ('system','platform')","NOT IN ('system','platform','')"],["IN ('connected','disconnected')","IN ('connected','disconnected','unknown')"],["'^[a-f0-9]{64}$'","'^[a-fA-F0-9]{64}$'"],['"session_id" <> \'\'','"session_id" = \'\'']])rejectSQL(a,b);
  const extra=migration.replace('"epoch" bigint NOT NULL','"epoch" bigint NOT NULL, CONSTRAINT "invented_tenant_exclusion" CHECK ("tenant_id" NOT IN (\'system\',\'platform\'))');assert.notEqual(extra,migration);expect(()=>checkSQL(extra)).toThrow();
 });
 test('each table INSERT and UPDATE WITH CHECK mutates exactly one field while all other policies survive',()=>{
  for(const table of ['employee_device_bindings','runner_device_connection_leases']){const predicate=table==='employee_device_bindings'?"tenant_id = current_setting('app.tenant_id', true)":"tenant_id = current_setting('app.tenant_id',true)";
   for(const command of ['insert','update'])rejectPolicy(table,`${table}_owner_${command}`,'withCheck',s=>s.replace(`WITH CHECK (${predicate})`,'WITH CHECK (true)'));
   rejectPolicy(table,`${table}_owner_update`,'using',s=>s.replace(`USING (${predicate})`,'USING (true)'));
   rejectPolicy(table,`${table}_owner_update`,'withCheck',s=>s.replace(` WITH CHECK (${predicate})`,''));
  }
 });
 test('policy mode/roles/FORCE and extra FK/index/grant/DML or unconsumed statements reject',()=>{
  for(const [a,b] of [['AS PERMISSIVE','AS RESTRICTIVE'],['TO public','TO owner'],['ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY']])rejectSQL(a,b);
  for(const extra of ['ALTER TABLE "public"."employee_device_bindings" ADD CONSTRAINT "invented_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registered_devices" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;','CREATE INDEX "invented" ON "public"."runner_device_connection_leases" USING btree ("device_id" ASC NULLS LAST);','UPDATE "public"."runner_device_connection_leases" SET "state"=\'connected\';','GRANT ALL ON "public"."employee_device_bindings" TO public;','SELECT 1;'])expect(()=>checkSQL(migration+extra)).toThrow();expect(()=>checkSQL(migration+migration)).toThrow();expect(()=>checkSQL(migration+'$bad$')).toThrow();
 });
 test('metadata oracle rejects genuine bigint SQLtype/nullable/check/PK/policy/RLS/default mutations',()=>{
  const edits:((ts:Record<string,Table>)=>void)[]=[ts=>{const t=ts['public.employee_device_bindings'];assert.ok(t);const c=t.columns.revision;assert.ok(c);c.type='integer';},ts=>{const t=ts['public.employee_device_bindings'];assert.ok(t);const c=t.columns.tenant_id;assert.ok(c);c.default="current_setting('app.tenant_id', true)";},ts=>{const t=ts['public.runner_device_connection_leases'];assert.ok(t);const c=t.columns.closed_at;assert.ok(c);c.notNull=true;},ts=>{const t=ts['public.employee_device_bindings'];assert.ok(t);t.checkConstraints={};},ts=>{const t=ts['public.runner_device_connection_leases'];assert.ok(t);t.compositePrimaryKeys={};},ts=>{const t=ts['public.employee_device_bindings'];assert.ok(t);const p=t.policies.employee_device_bindings_owner_update;assert.ok(p);delete p.withCheck;},ts=>{const t=ts['public.runner_device_connection_leases'];assert.ok(t);t.isRLSEnabled=false;}];for(const edit of edits){const actual=actualMetadata();edit(actual);expect(()=>equalTargets(actual)).toThrow();}
 });
 test('snapshot/journal reject old131 parent/domain drift and all incorrect lineage/prefix identities',()=>{
  const edits:((s:Snapshot)=>void)[]=[s=>{delete s.tables['public.employee_device_bindings'];},s=>{s.id=previous.id;},s=>{s.prevId='wrong';},s=>{s.extraTop=true;},s=>{const t=s.tables['public.threads'];assert.ok(t);t.uniqueConstraints={};},s=>{const t=s.tables['public.approval_direct_execution_domains'];assert.ok(t);t.columns={};},s=>{const t=s.tables['public.automation_firings'];assert.ok(t);t.columns={};}];for(const edit of edits){const s=structuredClone(next);edit(s);expect(()=>checkSnapshot(s)).toThrow();}for(let idx=0;idx<=98;idx++){const j=structuredClone(journal),e=j.entries[idx];assert.ok(e);e.tag='forged';expect(()=>checkJournal(j)).toThrow();}const j=structuredClone(journal),entry=j.entries[98];assert.ok(entry);entry.when++;expect(()=>checkJournal(j)).toThrow();
 });
});

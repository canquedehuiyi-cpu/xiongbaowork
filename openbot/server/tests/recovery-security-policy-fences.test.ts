import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { agents } from "../src/db/schema/core";
import { agentSecurityPolicies, securityEgressFences } from "../src/db/schema/security-policy-fences";
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

// Complete independent0121 raw oracle; not generated from this schema implementation.
// Whole583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules=[
  {
    "raw": "{\n  \"name\": \"agent_security_policies\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"agent_id\": {\n      \"name\": \"agent_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"revision\": {\n      \"name\": \"revision\",\n      \"type\": \"integer\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": 1\n    },\n    \"config\": {\n      \"name\": \"config\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {\n    \"agent_security_policies_agent_id_agents_id_fk\": {\n      \"name\": \"agent_security_policies_agent_id_agents_id_fk\",\n      \"tableFrom\": \"agent_security_policies\",\n      \"tableTo\": \"agents\",\n      \"columnsFrom\": [\n        \"agent_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {\n    \"agent_security_policies_tenant_id_agent_id_pk\": {\n      \"name\": \"agent_security_policies_tenant_id_agent_id_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"agent_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"agent_security_owner_select\": {\n      \"name\": \"agent_security_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\\n        AND EXISTS (SELECT 1 FROM \\\"agent_profiles\\\" p WHERE p.\\\"agent_id\\\" = \\\"agent_security_policies\\\".\\\"agent_id\\\"\\n          AND p.\\\"tenant_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"owner_user_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"deleted_at\\\" IS NULL)\"\n    },\n    \"agent_security_owner_insert\": {\n      \"name\": \"agent_security_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\\n        AND EXISTS (SELECT 1 FROM \\\"agent_profiles\\\" p WHERE p.\\\"agent_id\\\" = \\\"agent_security_policies\\\".\\\"agent_id\\\"\\n          AND p.\\\"tenant_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"owner_user_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"deleted_at\\\" IS NULL)\"\n    },\n    \"agent_security_owner_update\": {\n      \"name\": \"agent_security_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\\n        AND EXISTS (SELECT 1 FROM \\\"agent_profiles\\\" p WHERE p.\\\"agent_id\\\" = \\\"agent_security_policies\\\".\\\"agent_id\\\"\\n          AND p.\\\"tenant_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"owner_user_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"deleted_at\\\" IS NULL)\",\n      \"withCheck\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\\n        AND EXISTS (SELECT 1 FROM \\\"agent_profiles\\\" p WHERE p.\\\"agent_id\\\" = \\\"agent_security_policies\\\".\\\"agent_id\\\"\\n          AND p.\\\"tenant_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"owner_user_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"deleted_at\\\" IS NULL)\"\n    },\n    \"agent_security_owner_delete\": {\n      \"name\": \"agent_security_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true)\\n        AND EXISTS (SELECT 1 FROM \\\"agent_profiles\\\" p WHERE p.\\\"agent_id\\\" = \\\"agent_security_policies\\\".\\\"agent_id\\\"\\n          AND p.\\\"tenant_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"owner_user_id\\\" = \\\"agent_security_policies\\\".\\\"tenant_id\\\" AND p.\\\"deleted_at\\\" IS NULL)\"\n    }\n  },\n  \"checkConstraints\": {\n    \"agent_security_revision_positive\": {\n      \"name\": \"agent_security_revision_positive\",\n      \"value\": \"\\\"agent_security_policies\\\".\\\"revision\\\" > 0\"\n    },\n    \"agent_security_config_shape\": {\n      \"name\": \"agent_security_config_shape\",\n      \"value\": \"jsonb_typeof(\\\"agent_security_policies\\\".\\\"config\\\") = 'object' AND \\\"agent_security_policies\\\".\\\"config\\\" ?& ARRAY['enterpriseMode', 'dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes'] AND \\\"agent_security_policies\\\".\\\"config\\\"->'enterpriseMode' = 'false'::jsonb AND jsonb_typeof(\\\"agent_security_policies\\\".\\\"config\\\"->'dangerousCommandsEnabled') = 'boolean' AND jsonb_typeof(\\\"agent_security_policies\\\".\\\"config\\\"->'sensitivePathsEnabled') = 'boolean' AND jsonb_typeof(\\\"agent_security_policies\\\".\\\"config\\\"->'sensitivePaths') = 'array' AND jsonb_typeof(\\\"agent_security_policies\\\".\\\"config\\\"->'toolModes') = 'object'\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "e9d2a5d86ec1a546b1bb85719dad09d76646b221d2bd834999d0dd6be5e5841a"
  },
  {
    "raw": "{\n  \"name\": \"security_egress_fences\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"bot_id\": {\n      \"name\": \"bot_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"registration_id\": {\n      \"name\": \"registration_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"target\": {\n      \"name\": \"target\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"owner_epoch\": {\n      \"name\": \"owner_epoch\",\n      \"type\": \"bigint\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"revision\": {\n      \"name\": \"revision\",\n      \"type\": \"bigint\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"source_digest\": {\n      \"name\": \"source_digest\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"request_id\": {\n      \"name\": \"request_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {},\n  \"compositePrimaryKeys\": {\n    \"security_egress_fences_tenant_id_bot_id_registration_id_pk\": {\n      \"name\": \"security_egress_fences_tenant_id_bot_id_registration_id_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"bot_id\",\n        \"registration_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"security_egress_fences_tenant_select\": {\n      \"name\": \"security_egress_fences_tenant_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    },\n    \"security_egress_fences_tenant_insert\": {\n      \"name\": \"security_egress_fences_tenant_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    },\n    \"security_egress_fences_tenant_update\": {\n      \"name\": \"security_egress_fences_tenant_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true)\",\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    },\n    \"security_egress_fences_tenant_delete\": {\n      \"name\": \"security_egress_fences_tenant_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true)\"\n    }\n  },\n  \"checkConstraints\": {\n    \"security_egress_fence_epoch\": {\n      \"name\": \"security_egress_fence_epoch\",\n      \"value\": \"\\\"security_egress_fences\\\".\\\"owner_epoch\\\" BETWEEN 1 AND 9007199254740991\"\n    },\n    \"security_egress_fence_revision\": {\n      \"name\": \"security_egress_fence_revision\",\n      \"value\": \"\\\"security_egress_fences\\\".\\\"revision\\\" BETWEEN 0 AND 9007199254740991\"\n    },\n    \"security_egress_fence_tenant\": {\n      \"name\": \"security_egress_fence_tenant\",\n      \"value\": \"\\\"security_egress_fences\\\".\\\"tenant_id\\\" NOT IN ('system', 'platform')\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n",
    "sha256": "b1f592f01972d1f613addccdf09c899c5928249ad1a9343a2c42e494d883289a"
  }
];
const expected:Record<string,Table>=Object.fromEntries(capsules.map(({raw,sha256})=>{assert.equal(createHash("sha256").update(raw).digest("hex"),sha256);const t=JSON.parse(raw) as Table;return [`public.${t.name}`,t];}));
const expectedAgentId={"name": "id", "type": "text", "primaryKey": true, "notNull": true};
const expectedProfileColumns={
  "agent_id": {
    "name": "agent_id",
    "type": "text",
    "primaryKey": true,
    "notNull": true
  },
  "tenant_id": {
    "name": "tenant_id",
    "type": "text",
    "primaryKey": false,
    "notNull": true,
    "default": "current_setting('app.tenant_id', true)"
  },
  "owner_user_id": {
    "name": "owner_user_id",
    "type": "text",
    "primaryKey": false,
    "notNull": false
  },
  "deleted_at": {
    "name": "deleted_at",
    "type": "timestamp with time zone",
    "primaryKey": false,
    "notNull": false
  }
};
const server=join(import.meta.dir,".."),overlay=join(server,"recovery/recovery-20261018-v1");
const migration=readFileSync(join(overlay,"sql/0099_recovery_security_policy_fences.sql"),"utf8");
const previousRaw=readFileSync(join(overlay,"meta/0098_snapshot.json"));assert.equal(previousRaw.length,479137);assert.equal(createHash("sha256").update(previousRaw).digest("hex"),"58b5758a353915408091102051bdfed77b5bc168e4cd91ec0169bcaa7ba5eb26");
const previous=JSON.parse(previousRaw.toString("utf8")) as Snapshot;
const next=JSON.parse(readFileSync(join(overlay,"meta/0099_snapshot.json"),"utf8")) as Snapshot;
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
        const onDelete = c.peek() === "CASCADE"
          ? (c.take("CASCADE"), "cascade")
          : (c.take("NO"), c.take("ACTION"), "no action");
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
 assert.equal(previous.id,'961a5fed-fc46-4864-bd32-2e6760e0d52e');assert.equal(Object.keys(previous.tables).length,133);assert.equal(s.id,'a4e60222-17a1-46e6-85b5-39aec55e8114');assert.equal(s.prevId,previous.id);
 const restored=structuredClone(s),added:Record<string,Table>={};for(const key of Object.keys(s.tables))if(!(key in previous.tables)){const t=s.tables[key];assert.ok(t);added[key]=t;delete restored.tables[key];}assert.deepEqual(added,expected);restored.id=previous.id;restored.prevId=previous.prevId;assert.deepEqual(restored,previous,'old133/alltops including parentunique/domain unchanged');assert.equal(Object.keys(s.tables).length,135);
}
function checkJournal(j:Journal):void {
 const original=JSON.parse(readFileSync(join(server,'drizzle/meta/_journal.json'),'utf8')) as Journal;assert.equal(j.version,original.version);assert.equal(j.dialect,original.dialect);assert.ok(j.entries.length>=100,'prefix recognition, not suffix execution/release');assert.deepEqual(j.entries.slice(0,81),original.entries);assert.equal(createHash('sha256').update(JSON.stringify(j.entries.slice(0,99))).digest('hex'),'d5950cfb34caa60b34ce2c45d6ec9c5f5190c35c77f091d11ccea01d682a29a6');const entry=j.entries[99],prev=j.entries[98];assert.ok(entry&&prev);assert.deepEqual(entry,{idx:99,version:'7',when:1792377023000,tag:'0099_recovery_security_policy_fences',breakpoints:true});assert.ok(entry.when>prev.when&&entry.when<=Date.now());
}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
const actualMetadata=()=>Object.fromEntries([agentSecurityPolicies,securityEgressFences].map(model=>{const t=metadata(model);return [`public.${t.name}`,t];}));
function rejectSQL(before:string,after:string):void {assert.ok(migration.includes(before),'mutation must match actual original');const changed=migration.replace(before,after);assert.notEqual(changed,migration);expect(()=>checkSQL(changed)).toThrow();}
function changePolicy(table:string,name:string,change:(statement:string)=>string):string {
 const list=migration.split('--> statement-breakpoint'),marker=`CREATE POLICY "${name}" ON "public"."${table}"`,hits=list.map((s,i)=>s.includes(marker)?i:-1).filter(i=>i>=0);assert.equal(hits.length,1);const at=hits[0];assert.ok(at!==undefined);const before=list[at];assert.ok(before);const after=change(before);assert.notEqual(after,before);list[at]=after;return list.join('--> statement-breakpoint');
}
function rejectPolicy(table:string,name:string,field:'using'|'withCheck',change:(statement:string)=>string):void {
 const changed=changePolicy(table,name,change),before=parseSQL(migration).tables,after=parseSQL(changed).tables,key=`public.${table}`,oldTable=before[key],newTable=after[key];assert.ok(oldTable&&newTable);const old=oldTable.policies[name],value=newTable.policies[name];assert.ok(old&&value);assert.notEqual(value[field],old[field]);const restored=structuredClone(after),rt=restored[key];assert.ok(rt);rt.policies[name]=structuredClone(old);assert.deepEqual(restored,before,'all other tables/policies unchanged');for(const f of ['name','as','for','to','using','withCheck'] as const)if(f!==field)assert.deepEqual(value[f],old[f]);expect(()=>checkSQL(changed)).toThrow();
}
function policyExpression(table:string,name:string,field:'using'|'withCheck'):string {const t=expected[`public.${table}`];assert.ok(t);const p=t.policies[name];assert.ok(p);const value=p[field];assert.ok(value!==undefined);return value;}
describe('recovery security policy fences exact historical structures',()=>{
 test('two full independent oracle raws retain fixed identities',()=>{expect(capsules).toHaveLength(2);for(const c of capsules)expect(createHash('sha256').update(c.raw).digest('hex')).toBe(c.sha256);});
 test('all13 SQL statements fully consume including ?& ARRAY and every complete config CHECK',()=>{expect(migration.split('--> statement-breakpoint')).toHaveLength(13);checkSQL(migration);});
 test('real Drizzle13columns2PK1FK5CHECK8policy2RLS equal independent metadata',()=>equalTargets(actualMetadata()));
 test('existing agents text PK and policy agent_profiles columns match approved parent fragments',()=>{
  const parent=previous.tables['public.agents'],profile=previous.tables['public.agent_profiles'];assert.ok(parent&&profile);assert.deepEqual(parent.columns.id,expectedAgentId);for(const [k,v] of Object.entries(expectedProfileColumns))assert.deepEqual(profile.columns[k],v);expect(agents.id.primary).toBe(true);expect(agents.id.notNull).toBe(true);expect(agents.id.getSQLType()).toBe('text');const cfg=getTableConfig(agentSecurityPolicies);expect(cfg.foreignKeys).toHaveLength(1);const fk=cfg.foreignKeys[0];assert.ok(fk);const ref=fk.reference();expect(ref.foreignTable).toBe(agents);expect(ref.foreignColumns).toEqual([agents.id]);expect(ref.columns).toEqual([agentSecurityPolicies.agentId]);expect(fk.onDelete).toBe('cascade');expect(fk.onUpdate).toBe('no action');
 });
 test('both custom JSONB mapper and sql.param preserve object identity without double encoding',()=>{
  const values=[{enterpriseMode:false,dangerousCommandsEnabled:false,sensitivePathsEnabled:true,sensitivePaths:[],toolModes:{}},{fixture:{optional:null},items:[1,true]}],columns=[agentSecurityPolicies.config,securityEgressFences.target];for(let i=0;i<columns.length;i++){const column=columns[i],value=values[i];assert.ok(column&&value);expect(column.mapToDriverValue(value)).toBe(value);expect(column.mapFromDriverValue(value)).toBe(value);const query=dialect.sqlToQuery(sql`select ${sql.param(value,column)}::jsonb`);expect(query.params).toHaveLength(1);expect(query.params[0]).toBe(value);expect(typeof query.params[0]).toBe('object');expect(column.hasDefault).toBe(false);expect(column.notNull).toBe(true);}
 });
 test('fence bigint fields map endpoints and preserve bound bigint while agent revision stays integer number',()=>{
  expect(agentSecurityPolicies.revision.getSQLType()).toBe('integer');expect(agentSecurityPolicies.revision.dataType).toBe('number');expect(agentSecurityPolicies.revision.default).toBe(1);for(const column of [securityEgressFences.ownerEpoch,securityEgressFences.revision]){expect(column.columnType).toBe('PgBigInt64');expect(column.dataType).toBe('bigint');expect(column.getSQLType()).toBe('bigint');expect(column.hasDefault).toBe(false);for(const value of [0n,1n,9007199254740991n]){expect(column.mapFromDriverValue(value.toString())).toBe(value);expect(column.mapToDriverValue(value)).toBe(value);const query=dialect.sqlToQuery(sql`select ${sql.param(value,column)}::bigint`);expect(query.params[0]).toBe(value);expect(typeof query.params[0]).toBe('bigint');}}
 });
 test('negative/oversize bigint conversions succeed and are not database CHECK acceptance',()=>{
  for(const column of [securityEgressFences.ownerEpoch,securityEgressFences.revision]){expect(column.mapFromDriverValue('-1')).toBe(-1n);expect(column.mapFromDriverValue('9007199254740992')).toBe(9007199254740992n);} // Mapper has no range guard; SQL/PG remain unexecuted.
 });
 test('tenant/default/null/no-invented-fence constraints preserve exact historical fields',()=>{
  expect(agentSecurityPolicies.tenantId.hasDefault).toBe(true);expect(securityEgressFences.tenantId.hasDefault).toBe(false);expect(securityEgressFences.requestId.notNull).toBe(false);expect(securityEgressFences.requestId.hasDefault).toBe(false);const fence=getTableConfig(securityEgressFences);expect(fence.columns.filter(c=>!c.notNull).map(c=>c.name)).toEqual(['request_id']);expect(fence.columns.every(c=>!c.hasDefault)).toBe(true);expect(fence.foreignKeys).toHaveLength(0);expect(fence.indexes).toHaveLength(0);expect(fence.checks).toHaveLength(3);expect(getTableConfig(agentSecurityPolicies).checks).toHaveLength(2);
 });
 test('inverse tables restores exact133 predecessor/toplevel domain and parentunique',()=>checkSnapshot(next));
 test('journal exact99 and all0..98 prefix recognize successor without release authority',()=>{checkJournal(journal);const j=structuredClone(journal);j.entries.push({idx:100,version:'7',when:Date.now(),tag:'unknown-prefix-fixture',breakpoints:true});checkJournal(j);expect(j.entries.length).toBe(journal.entries.length+1);});
 test('original163 and stages81..98 byte identities remain exact on full integration',()=>{
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
    "path": "recovery/recovery-20261018-v1/meta/0098_snapshot.json",
    "bytes": 479137,
    "sha256": "58b5758a353915408091102051bdfed77b5bc168e4cd91ec0169bcaa7ba5eb26"
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
  }
]){const b=readFileSync(join(server,input.path));expect(b.length).toBe(input.bytes);expect(createHash('sha256').update(b).digest('hex')).toBe(input.sha256);}
 });
 test('complete config object/fivekeys/enterprise JSONB false and all boolean-array-object conditions reject precise drift',()=>{
  const p='"agent_security_policies"."config"';const changes:[string,string][]=[[`jsonb_typeof(${p}) = 'object'`,`jsonb_typeof(${p}) = 'array'`],["ARRAY['enterpriseMode', 'dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes']","ARRAY['dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes']"],[`${p}->'enterpriseMode' = 'false'::jsonb`,`${p}->'enterpriseMode' = 'true'::jsonb`]];
  for(const [key,oldType,newType] of [['dangerousCommandsEnabled','boolean','string'],['sensitivePathsEnabled','boolean','string'],['sensitivePaths','array','object'],['toolModes','object','array']])changes.push([`jsonb_typeof(${p}->'${key}') = '${oldType}'`,`jsonb_typeof(${p}->'${key}') = '${newType}'`]);for(const [a,b] of changes)rejectSQL(a,b);
  rejectSQL("?& ARRAY['enterpriseMode', 'dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes']","?& ARRAY['enterpriseMode', 'dangerousCommandsEnabled', 'sensitivePathsEnabled', 'sensitivePaths', 'toolModes', 'invented']");
 });
 test('SQL rejects PK/default/type/null/range/FKaction and invented digest or target checks',()=>{
  for(const [a,b] of [['"revision" integer DEFAULT 1 NOT NULL','"revision" bigint DEFAULT 1 NOT NULL'],['"revision" integer DEFAULT 1 NOT NULL','"revision" integer DEFAULT \'1\' NOT NULL'],['"request_id" uuid','"request_id" uuid NOT NULL'],['"owner_epoch" bigint NOT NULL','"owner_epoch" bigint DEFAULT 1 NOT NULL'],['BETWEEN 1 AND 9007199254740991','BETWEEN 0 AND 9007199254740991'],['BETWEEN 0 AND 9007199254740991','BETWEEN 1 AND 9007199254740991'],['PRIMARY KEY ("tenant_id", "agent_id")','PRIMARY KEY ("agent_id", "tenant_id")'],['ON DELETE CASCADE','ON DELETE NO ACTION'],['ON UPDATE NO ACTION','ON UPDATE CASCADE'],['REFERENCES "public"."agents" ("id")','REFERENCES "public"."agents" ("name")']])rejectSQL(a,b);
  const extra=migration.replace('"source_digest" text NOT NULL','"source_digest" text NOT NULL, CONSTRAINT "invented_digest" CHECK ("source_digest" ~ \'^[a-f0-9]{64}$\')');assert.notEqual(extra,migration);expect(()=>checkSQL(extra)).toThrow();
 });
 test('unique INSERT/UPDATE WITHCHECK and UPDATE USING mutations retain all other policies and exact owner EXISTS',()=>{
  for(const [table,prefix] of [['agent_security_policies','agent_security_owner_'],['security_egress_fences','security_egress_fences_tenant_']]){
   for(const command of ['insert','update']){const name=prefix+command,value=policyExpression(table,name,'withCheck');rejectPolicy(table,name,'withCheck',s=>s.replace(`WITH CHECK (${value})`,'WITH CHECK (true)'));}
   const name=prefix+'update',using=policyExpression(table,name,'using'),check=policyExpression(table,name,'withCheck');rejectPolicy(table,name,'using',s=>s.replace(`USING (${using})`,'USING (true)'));rejectPolicy(table,name,'withCheck',s=>s.replace(` WITH CHECK (${check})`,''));
  }
  const table='agent_security_policies',name='agent_security_owner_update',value=policyExpression(table,name,'withCheck');for(const [a,b] of [['p."owner_user_id" = "agent_security_policies"."tenant_id"','true'],['p."deleted_at" IS NULL','true'],['p."tenant_id" = "agent_security_policies"."tenant_id"','true'],['p."agent_id" = "agent_security_policies"."agent_id"','true']]){assert.ok(value.includes(a));rejectPolicy(table,name,'withCheck',s=>s.replace(`WITH CHECK (${value})`,`WITH CHECK (${value.replace(a,b)})`));}
 });
 test('policy role/mode/FORCE and extra index/FK/DML/grants cannot bypass complete consumer',()=>{
  for(const [a,b] of [['TO public','TO owner'],['AS PERMISSIVE','AS RESTRICTIVE'],['ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY']])rejectSQL(a,b);for(const extra of ['CREATE INDEX "invented" ON "public"."security_egress_fences" USING btree ("bot_id" ASC NULLS LAST);','ALTER TABLE "public"."security_egress_fences" ADD CONSTRAINT "invented_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registered_devices" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;','UPDATE "public"."agent_security_policies" SET "revision"=1;','GRANT ALL ON "public"."security_egress_fences" TO public;','SELECT 1;'])expect(()=>checkSQL(migration+extra)).toThrow();expect(()=>checkSQL(migration+migration)).toThrow();expect(()=>checkSQL(migration+'$bad$')).toThrow();
 });
 test('actual metadata oracle rejects precise default/check/PK/FK/policy/RLS drift',()=>{
  const edits:((ts:Record<string,Table>)=>void)[]=[ts=>{const t=ts['public.agent_security_policies'];assert.ok(t);const c=t.columns.revision;assert.ok(c);c.type='bigint';},ts=>{const t=ts['public.agent_security_policies'];assert.ok(t);t.checkConstraints={};},ts=>{const t=ts['public.agent_security_policies'];assert.ok(t);t.foreignKeys={};},ts=>{const t=ts['public.security_egress_fences'];assert.ok(t);t.compositePrimaryKeys={};},ts=>{const t=ts['public.agent_security_policies'];assert.ok(t);const p=t.policies.agent_security_owner_update;assert.ok(p);delete p.withCheck;},ts=>{const t=ts['public.security_egress_fences'];assert.ok(t);t.isRLSEnabled=false;}];for(const edit of edits){const actual=actualMetadata();edit(actual);expect(()=>equalTargets(actual)).toThrow();}
 });
 test('snapshot/journal reject old133 parent/domain drift and wrong identities or stage prefix',()=>{
  const edits:((s:Snapshot)=>void)[]=[s=>{delete s.tables['public.agent_security_policies'];},s=>{s.id=previous.id;},s=>{s.prevId='wrong';},s=>{s.extraTop=true;},s=>{const t=s.tables['public.threads'];assert.ok(t);t.uniqueConstraints={};},s=>{const t=s.tables['public.approval_direct_execution_domains'];assert.ok(t);t.columns={};},s=>{const t=s.tables['public.employee_device_bindings'];assert.ok(t);t.columns={};}];for(const edit of edits){const s=structuredClone(next);edit(s);expect(()=>checkSnapshot(s)).toThrow();}for(let idx=0;idx<=99;idx++){const j=structuredClone(journal),e=j.entries[idx];assert.ok(e);e.tag='forged';expect(()=>checkJournal(j)).toThrow();}const j=structuredClone(journal),entry=j.entries[99];assert.ok(entry);entry.when++;expect(()=>checkJournal(j)).toThrow();
 });
});

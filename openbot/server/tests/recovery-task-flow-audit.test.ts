import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import {
  getTableConfig,
  isPgEnum,
  PgDialect,
  type PgTable,
} from "drizzle-orm/pg-core";
import { auditEvents } from "../src/db/schema/core";
import { tasks } from "../src/db/schema/tasks";
import { wakerFlows } from "../src/db/schema/wakerflows";

type Column = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number;
  typeSchema?: string;
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

/** Independent complete-table capsules from verified0121 583049B/SHA256
 * c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
 * Raw capsule SHAs match the earlier readonly L1-02 attachments, not this implementation.
 */
const capsules = [
  {
    sha256: "cd8508b92bee26e212eb5d1f6e8684fdb039676749598ae1fb9f68066adf5d12",
    raw: '{\n  "public.audit_events": {\n    "name": "audit_events",\n    "schema": "",\n    "columns": {\n      "id": {\n        "name": "id",\n        "type": "uuid",\n        "primaryKey": true,\n        "notNull": true,\n        "default": "gen_random_uuid()"\n      },\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "actor_user_id": {\n        "name": "actor_user_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "subject_tenant_id": {\n        "name": "subject_tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "initiator_kind": {\n        "name": "initiator_kind",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "\'person\'"\n      },\n      "initiator_id": {\n        "name": "initiator_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "event_type": {\n        "name": "event_type",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "target_type": {\n        "name": "target_type",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "target_id": {\n        "name": "target_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "payload": {\n        "name": "payload",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "created_at": {\n        "name": "created_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {\n      "audit_events_created_at_idx": {\n        "name": "audit_events_created_at_idx",\n        "columns": [\n          {\n            "expression": "created_at",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "audit_events_type_time_idx": {\n        "name": "audit_events_type_time_idx",\n        "columns": [\n          {\n            "expression": "event_type",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "created_at",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          },\n          {\n            "expression": "id",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "audit_events_actor_time_idx": {\n        "name": "audit_events_actor_time_idx",\n        "columns": [\n          {\n            "expression": "actor_user_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "created_at",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          },\n          {\n            "expression": "id",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "audit_events_subject_time_idx": {\n        "name": "audit_events_subject_time_idx",\n        "columns": [\n          {\n            "expression": "subject_tenant_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "created_at",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          },\n          {\n            "expression": "id",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "audit_events_target_time_idx": {\n        "name": "audit_events_target_time_idx",\n        "columns": [\n          {\n            "expression": "target_type",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "target_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "created_at",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          },\n          {\n            "expression": "id",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "audit_events_initiator_time_idx": {\n        "name": "audit_events_initiator_time_idx",\n        "columns": [\n          {\n            "expression": "initiator_kind",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "created_at",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          },\n          {\n            "expression": "id",\n            "isExpression": false,\n            "asc": false,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      }\n    },\n    "foreignKeys": {},\n    "compositePrimaryKeys": {},\n    "uniqueConstraints": {},\n    "policies": {},\n    "checkConstraints": {},\n    "isRLSEnabled": false\n  }\n}\n',
  },
  {
    sha256: "f8c11347da37a5fbc3b7f404131ada2980e633545175575a64eceeab3998bb03",
    raw: '{\n  "public.tasks": {\n    "name": "tasks",\n    "schema": "",\n    "columns": {\n      "id": {\n        "name": "id",\n        "type": "uuid",\n        "primaryKey": true,\n        "notNull": true,\n        "default": "gen_random_uuid()"\n      },\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "title": {\n        "name": "title",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "executor_agent_id": {\n        "name": "executor_agent_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "source": {\n        "name": "source",\n        "type": "task_source",\n        "typeSchema": "public",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "trigger_source": {\n        "name": "trigger_source",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "status": {\n        "name": "status",\n        "type": "task_status",\n        "typeSchema": "public",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "\'running\'"\n      },\n      "channel_ref": {\n        "name": "channel_ref",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "run_ref": {\n        "name": "run_ref",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "parent_task_id": {\n        "name": "parent_task_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "quota_units": {\n        "name": "quota_units",\n        "type": "integer",\n        "primaryKey": false,\n        "notNull": true,\n        "default": 1\n      },\n      "deliverable_ref": {\n        "name": "deliverable_ref",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "pending_approval_id": {\n        "name": "pending_approval_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "device_id": {\n        "name": "device_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "created_at": {\n        "name": "created_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      },\n      "updated_at": {\n        "name": "updated_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {\n      "tasks_tenant_status_updated_idx": {\n        "name": "tasks_tenant_status_updated_idx",\n        "columns": [\n          {\n            "expression": "tenant_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "status",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "updated_at",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "tasks_executor_idx": {\n        "name": "tasks_executor_idx",\n        "columns": [\n          {\n            "expression": "executor_agent_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "updated_at",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      },\n      "tasks_run_ref_idx": {\n        "name": "tasks_run_ref_idx",\n        "columns": [\n          {\n            "expression": "run_ref",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      }\n    },\n    "foreignKeys": {},\n    "compositePrimaryKeys": {},\n    "uniqueConstraints": {},\n    "policies": {},\n    "checkConstraints": {},\n    "isRLSEnabled": false\n  }\n}\n',
  },
  {
    sha256: "0ecf53c36e6ac323c751568b7413a1b0b0ecf9765d779127cbe20963154d06fe",
    raw: '{\n  "public.waker_flows": {\n    "name": "waker_flows",\n    "schema": "",\n    "columns": {\n      "id": {\n        "name": "id",\n        "type": "uuid",\n        "primaryKey": true,\n        "notNull": true,\n        "default": "gen_random_uuid()"\n      },\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "name": {\n        "name": "name",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "description": {\n        "name": "description",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "\'\'"\n      },\n      "idea": {\n        "name": "idea",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "\'\'"\n      },\n      "model_ref": {\n        "name": "model_ref",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "plan": {\n        "name": "plan",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "revision": {\n        "name": "revision",\n        "type": "integer",\n        "primaryKey": false,\n        "notNull": true,\n        "default": 0\n      },\n      "definition_mode": {\n        "name": "definition_mode",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "\'json-plan-v1\'"\n      },\n      "active_source_version_id": {\n        "name": "active_source_version_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "group_id": {\n        "name": "group_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "template_id": {\n        "name": "template_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "deleted_at": {\n        "name": "deleted_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "created_at": {\n        "name": "created_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      },\n      "updated_at": {\n        "name": "updated_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {\n      "waker_flows_tenant_idx": {\n        "name": "waker_flows_tenant_idx",\n        "columns": [\n          {\n            "expression": "tenant_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": false,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      }\n    },\n    "foreignKeys": {},\n    "compositePrimaryKeys": {},\n    "uniqueConstraints": {},\n    "policies": {},\n    "checkConstraints": {\n      "waker_flows_definition_mode_check": {\n        "name": "waker_flows_definition_mode_check",\n        "value": "(\\"waker_flows\\".\\"definition_mode\\" = \'json-plan-v1\' AND \\"waker_flows\\".\\"active_source_version_id\\" IS NULL) OR (\\"waker_flows\\".\\"definition_mode\\" = \'js-source-v1\' AND \\"waker_flows\\".\\"active_source_version_id\\" IS NOT NULL AND \\"waker_flows\\".\\"plan\\" IS NULL AND \\"waker_flows\\".\\"group_id\\" IS NULL AND \\"waker_flows\\".\\"template_id\\" IS NULL)"\n      }\n    },\n    "isRLSEnabled": false\n  }\n}\n',
  },
];
const expected = Object.assign(
  {},
  ...capsules.map(({ raw, sha256 }) => {
    assert.equal(createHash("sha256").update(raw).digest("hex"), sha256);
    return JSON.parse(raw) as Record<string, Table>;
  }),
) as Record<string, Table>;
const server = join(import.meta.dir, "..");
const overlay = join(server, "recovery/recovery-20261018-v1");
const migration = readFileSync(
  join(overlay, "sql/0083_recovery_task_flow_audit_contract.sql"),
  "utf8",
);
const previous = JSON.parse(
  readFileSync(join(overlay, "meta/0082_snapshot.json"), "utf8"),
) as Snapshot;
const next = JSON.parse(
  readFileSync(join(overlay, "meta/0083_snapshot.json"), "utf8"),
) as Snapshot;
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
/** Every non-whitespace character must be a supported SQL token. Comments other than the exact
 * Drizzle separator, dollar quoting, parameters and executable bodies are intentionally unsupported. */
function tokenize(source: string): string[] {
  const input = source.replaceAll("--> statement-breakpoint", " ");
  const pattern =
    /\s+|"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*|\d+|[().,;=+><]/y;
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
    if ("enum" in column && isPgEnum(column.enum))
      item.typeSchema = column.enum.schema ?? "public";
    if (column.default !== undefined) {
      const value: unknown = column.default;
      if (is(value, SQL)) item.default = render(value);
      else {
        assert.ok(typeof value === "number" || typeof value === "string");
        item.default =
          typeof value === "string" ? dialect.escapeString(value) : value;
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
  for (const check of Object.values(copy.checkConstraints))
    check.value = expression(check.value);
  for (const policy of Object.values(copy.policies)) {
    if (policy.using !== undefined) policy.using = expression(policy.using);
    if (policy.withCheck !== undefined)
      policy.withCheck = expression(policy.withCheck);
  }
  return copy;
}

type Delta = {
  columns: Record<string, Column>;
  checks: Record<string, { name: string; value: string }>;
  indexes: Record<string, Index>;
};
function targetDelta(): Delta {
  const out: Delta = { columns: {}, checks: {}, indexes: {} };
  for (const [key, target] of Object.entries(expected)) {
    const before = previous.tables[key];
    assert.ok(before);
    for (const [name, value] of Object.entries(target.columns))
      if (!(name in before.columns)) put(out.columns, `${key}.${name}`, value);
    for (const [name, value] of Object.entries(target.checkConstraints))
      if (!(name in before.checkConstraints))
        put(out.checks, `${key}.${name}`, value);
    for (const [name, value] of Object.entries(target.indexes))
      if (!(name in before.indexes)) put(out.indexes, `${key}.${name}`, value);
  }
  return out;
}
function normalizedDelta(delta: Delta): Delta {
  const out = structuredClone(delta);
  for (const column of Object.values(out.columns))
    if (typeof column.default === "string")
      column.default = expression(column.default);
  for (const check of Object.values(out.checks))
    check.value = expression(check.value);
  return out;
}
function parseSQL(source: string): Delta {
  const tokens = tokenize(source);
  assert.equal(tokens.at(-1), ";");
  const out: Delta = { columns: {}, checks: {}, indexes: {} };
  for (const statement of parts(tokens, ";")) {
    const c = new Cursor(statement);
    if (c.peek() === "ALTER") {
      c.take("ALTER");
      c.take("TABLE");
      const table = c.table();
      c.take("ADD");
      if (c.peek() === "COLUMN") {
        c.take("COLUMN");
        const name = c.id();
        const type = c.peek().toLowerCase();
        c.at++;
        assert.ok(type === "text" || type === "uuid");
        const column: Column = {
          name,
          type,
          primaryKey: false,
          notNull: false,
        };
        if (c.peek() === "DEFAULT") {
          c.take("DEFAULT");
          const value = c.tokens[c.at++];
          assert.ok(value && /^'(?:[^']|'')*'$/.test(value));
          column.default = value;
        }
        if (c.peek() === "NOT") {
          c.take("NOT");
          c.take("NULL");
          column.notNull = true;
        }
        c.finish();
        put(out.columns, `public.${table}.${name}`, column);
      } else {
        c.take("CONSTRAINT");
        const name = c.id();
        c.take("CHECK");
        const value = c.group().join(" ");
        c.finish();
        put(out.checks, `public.${table}.${name}`, { name, value });
      }
      continue;
    }
    c.take("CREATE");
    c.take("INDEX");
    const name = c.id();
    c.take("ON");
    const table = c.table();
    c.take("USING");
    c.take("BTREE");
    const columns = parts(c.group(), ",").map((part) => {
      const col = new Cursor(part);
      const value = col.id();
      const order = col.peek();
      assert.ok(order === "ASC" || order === "DESC");
      col.at++;
      col.take("NULLS");
      const nulls = col.peek().toLowerCase();
      assert.ok(nulls === "last" || nulls === "first");
      col.at++;
      col.finish();
      return {
        expression: value,
        isExpression: false,
        asc: order === "ASC",
        nulls,
      };
    });
    c.finish();
    put(out.indexes, `public.${table}.${name}`, {
      name,
      columns,
      isUnique: false,
      concurrently: false,
      method: "btree",
      with: {},
    });
  }
  return out;
}
function checkSQL(source: string): void {
  assert.deepEqual(
    normalizedDelta(parseSQL(source)),
    normalizedDelta(targetDelta()),
  );
}
function checkSnapshot(value: Snapshot): void {
  assert.equal(value.prevId, previous.id);
  assert.equal(previous.id, "7da35ba4-9411-43d2-a33e-7efe68ee446a");
  assert.match(
    value.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(value.id, previous.id);
  assert.notEqual(value.id, "0fac1c33-b397-46ee-a332-b0a9b06d126b");
  const restored = structuredClone(value);
  for (const [key, target] of Object.entries(expected)) {
    assert.deepEqual(
      value.tables[key],
      target,
      "complete verified target table",
    );
    const before = previous.tables[key];
    const after = restored.tables[key];
    assert.ok(before && after);
    for (const name of Object.keys(target.columns))
      if (!(name in before.columns)) delete after.columns[name];
    for (const name of Object.keys(target.checkConstraints))
      if (!(name in before.checkConstraints))
        delete after.checkConstraints[name];
    for (const name of Object.keys(target.indexes))
      if (!(name in before.indexes)) delete after.indexes[name];
  }
  restored.id = previous.id;
  restored.prevId = previous.prevId;
  assert.deepEqual(
    restored,
    previous,
    "all other103-table predecessor data, policies and old keys must survive",
  );
  assert.equal(Object.keys(value.tables).length, 103);
}
function checkJournal(value: Journal): void {
  const old = JSON.parse(
    readFileSync(join(server, "drizzle/meta/_journal.json"), "utf8"),
  ) as Journal;
  assert.deepEqual({ ...value, entries: value.entries.slice(0, 81) }, old);
  assert.ok(
    value.entries.length >= 84,
    "stage83 requires its full prefix; future stages do not rewrite it",
  );
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(value.entries.slice(0, 83)))
      .digest("hex"),
    "8a4859c1c0961f196f78fb203d96330a47a2b41243427319df1733092d4a2427",
  );
  const entry = value.entries[83];
  assert.ok(entry);
  assert.deepEqual(
    { ...entry, when: 0 },
    {
      idx: 83,
      version: "7",
      when: 0,
      tag: "0083_recovery_task_flow_audit_contract",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(entry.when) &&
      entry.when > 1792334435193 &&
      entry.when <= Date.now(),
  );
}
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink());
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("recovery task Flow audit exact structural candidate", () => {
  test("independent complete target capsules retain their recorded identities", () => {
    for (const capsule of capsules)
      expect(createHash("sha256").update(capsule.raw).digest("hex")).toBe(
        capsule.sha256,
      );
    expect(Object.keys(targetDelta().columns)).toHaveLength(3);
    expect(Object.keys(targetDelta().checks)).toHaveLength(1);
    expect(Object.keys(targetDelta().indexes)).toHaveLength(1);
  });
  test("SQL is fully consumed and matches exactly the3-column/check/index delta", () => {
    checkSQL(migration);
    const check =
      expected["public.waker_flows"]?.checkConstraints
        .waker_flows_definition_mode_check;
    assert.ok(check);
    const raw = migration.match(
      /ADD CONSTRAINT "waker_flows_definition_mode_check" CHECK \(([^\n]*)\);/,
    );
    expect(raw?.[1]).toBe(check.value);
  });
  test("actual Drizzle columns/defaults/check/FK/index/policies equal all3 complete target tables", () => {
    for (const table of [auditEvents, tasks, wakerFlows]) {
      const value = metadata(table);
      const target = expected[`public.${value.name}`];
      assert.ok(target);
      assert.deepEqual(normalize(value), normalize(target), value.name);
    }
    const definition = getTableConfig(wakerFlows).checks.find(
      (check) => check.name === "waker_flows_definition_mode_check",
    );
    assert.ok(definition);
    expect(render(definition.value)).toBe(
      expected["public.waker_flows"]?.checkConstraints
        .waker_flows_definition_mode_check?.value,
    );
  });
  test("inverse3 fields/index/check restores the exact103-table L102 predecessor", () =>
    checkSnapshot(next));
  test("journal retains0..82 and adds the new83 identity without pinning historical tests to current head", () =>
    checkJournal(journal));
  test("original163 and all approved81/82 SQL/snapshot bytes remain frozen", () => {
    const dir = join(server, "drizzle");
    const records = filesUnder(dir)
      .sort()
      .map((path) => {
        const b = readFileSync(path);
        return `${relative(dir, path)}\0${b.byteLength}\0${createHash("sha256").update(b).digest("hex")}\n`;
      });
    expect(records).toHaveLength(163);
    expect(createHash("sha256").update(records.join("")).digest("hex")).toBe(
      "9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d",
    );
    for (const [path, sha] of [
      [
        "sql/0081_recovery_subject_and_binding.sql",
        "0769123048b40af0f80aa8a3c843f67ab19fac5c44ccb9243bbc6819d689bb40",
      ],
      [
        "meta/0081_snapshot.json",
        "ef4b170efbc98717bce811b27d3f5d35c274146f5faec50bc787028acbfaa24c",
      ],
      [
        "sql/0082_recovery_role_foundations.sql",
        "683834fae02b1e3cf3be6ca85340098c2a1bd0cea6de65c7e14b80e3be7a93dc",
      ],
      [
        "meta/0082_snapshot.json",
        "2cc73e7181b11baa27dcad48ab412cf5d89c13d19d0f06a4640e6cdaa7a883e8",
      ],
    ]) {
      assert.ok(path);
      expect(
        createHash("sha256")
          .update(readFileSync(join(overlay, path)))
          .digest("hex"),
      ).toBe(sha);
    }
  });
  test("SQL rejects missing columns/check/index, nullable/default/FK changes and added data or permission writes", () => {
    for (const source of [
      migration.replace(/ALTER TABLE "public"\."tasks"[^;]*;/, ""),
      migration.replace(
        /ALTER TABLE "public"\."waker_flows" ADD COLUMN "definition_mode"[^;]*;/,
        "",
      ),
      migration.replace(
        /ALTER TABLE "public"\."waker_flows" ADD COLUMN "active_source_version_id"[^;]*;/,
        "",
      ),
      migration.replace(
        /ALTER TABLE "public"\."waker_flows" ADD CONSTRAINT[^;]*;/,
        "",
      ),
      migration.replace(/CREATE INDEX[^;]*;/, ""),
      migration.replace(
        "DEFAULT 'json-plan-v1' NOT NULL",
        "DEFAULT 'json-plan-v1'",
      ),
      migration.replace(
        '"trigger_source" text;',
        "\"trigger_source\" text DEFAULT 'guessed';",
      ),
      migration.replace(
        '"active_source_version_id" uuid;',
        '"active_source_version_id" uuid REFERENCES "public"."users"("id");',
      ),
      migration.replace("'js-source-v1'", "'legacy_unknown'"),
      migration + 'UPDATE "public"."waker_flows" SET "plan" = NULL;',
      migration + "GRANT ALL ON ALL TABLES IN SCHEMA public TO public;",
      migration +
        'ALTER TABLE "public"."role_templates" ADD COLUMN "unexpected" text;',
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("index direction, explicit NULLS LAST, uniqueness, method, predicate and concurrency are exact", () => {
    for (const source of [
      migration.replace('"subject_tenant_id" ASC', '"subject_tenant_id" DESC'),
      migration.replace('"created_at" DESC', '"created_at" ASC'),
      migration.replace('"id" DESC', '"id" ASC'),
      migration.replace(
        '"created_at" DESC NULLS LAST',
        '"created_at" DESC NULLS FIRST',
      ),
      migration.replace('"id" DESC NULLS LAST', '"id" DESC'),
      migration.replace("CREATE INDEX", "CREATE UNIQUE INDEX"),
      migration.replace("CREATE INDEX", "CREATE INDEX CONCURRENTLY"),
      migration.replace("USING btree", "USING hash"),
      migration.replace(
        '"id" DESC NULLS LAST);',
        '"id" DESC NULLS LAST) WHERE "subject_tenant_id" IS NOT NULL;',
      ),
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("snapshot rejects prior roles/key/policy drift, new FK or missing target fields/check/index", () => {
    const mutations: ((snapshot: Snapshot) => void)[] = [
      (s) => {
        const t = s.tables["public.tasks"];
        assert.ok(t);
        delete t.columns.trigger_source;
      },
      (s) => {
        const t = s.tables["public.waker_flows"];
        assert.ok(t);
        delete t.columns.definition_mode;
      },
      (s) => {
        const t = s.tables["public.waker_flows"];
        assert.ok(t);
        delete t.columns.active_source_version_id;
      },
      (s) => {
        const t = s.tables["public.waker_flows"];
        assert.ok(t);
        t.checkConstraints = {};
      },
      (s) => {
        const t = s.tables["public.audit_events"];
        assert.ok(t);
        delete t.indexes.audit_events_subject_time_idx;
      },
      (s) => {
        const t = s.tables["public.role_templates"];
        assert.ok(t);
        t.policies = {};
      },
      (s) => {
        const t = s.tables["public.role_write_receipts"];
        assert.ok(t);
        t.compositePrimaryKeys = {};
      },
      (s) => {
        const t = s.tables["public.audit_events"];
        assert.ok(t);
        delete t.columns.subject_tenant_id;
      },
      (s) => {
        const t = s.tables["public.tasks"];
        assert.ok(t);
        t.isRLSEnabled = true;
      },
      (s) => {
        s.prevId = "wrong-predecessor";
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(next);
      mutate(value);
      expect(() => checkSnapshot(value)).toThrow();
    }
    const wrong = structuredClone(journal);
    const entry = wrong.entries[82];
    assert.ok(entry);
    entry.tag = "forged82";
    expect(() => checkJournal(wrong)).toThrow();
  });
});

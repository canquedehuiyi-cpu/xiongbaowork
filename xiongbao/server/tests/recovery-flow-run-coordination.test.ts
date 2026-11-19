import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import {
  bigserial,
  getTableConfig,
  PgBigSerial64,
  PgDialect,
  type PgTable,
  pgTable,
} from "drizzle-orm/pg-core";
import {
  flowConfirmations,
  flowRunEvents,
  flowRunRetries,
} from "../src/db/schema/flow-run-coordination";

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

// Complete independently approved0121 table capsules; source583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules = [
  {
    raw: '{\n  "name": "flow_confirmations",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "flow_id": {\n      "name": "flow_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "node_id": {\n      "name": "node_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "question": {\n      "name": "question",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "inputs": {\n      "name": "inputs",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "status": {\n      "name": "status",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "\'pending\'"\n    },\n    "answer": {\n      "name": "answer",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "request_id": {\n      "name": "request_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    },\n    "updated_at": {\n      "name": "updated_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_confirmations_run_idx": {\n      "name": "flow_confirmations_run_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": false,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_confirmations_flow_id_waker_flows_id_fk": {\n      "name": "flow_confirmations_flow_id_waker_flows_id_fk",\n      "tableFrom": "flow_confirmations",\n      "tableTo": "waker_flows",\n      "columnsFrom": [\n        "flow_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_confirmations_run_id_group_task_runs_id_fk": {\n      "name": "flow_confirmations_run_id_group_task_runs_id_fk",\n      "tableFrom": "flow_confirmations",\n      "tableTo": "group_task_runs",\n      "columnsFrom": [\n        "run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_confirmations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_confirmations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_update": {\n      "name": "tenant_scope_update",\n      "as": "PERMISSIVE",\n      "for": "UPDATE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_confirmations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)",\n      "withCheck": "\\"flow_confirmations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_delete": {\n      "name": "tenant_scope_delete",\n      "as": "PERMISSIVE",\n      "for": "DELETE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_confirmations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {\n    "flow_confirmation_status_check": {\n      "name": "flow_confirmation_status_check",\n      "value": "\\"flow_confirmations\\".\\"status\\" IN (\'pending\',\'answered\',\'skipped\')"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "745b1ef4fd186226ff5ca5adb88ce3b0ba634839db81d349797df346f8e024b3",
  },
  {
    raw: '{\n  "name": "flow_run_events",\n  "schema": "",\n  "columns": {\n    "sequence": {\n      "name": "sequence",\n      "type": "bigserial",\n      "primaryKey": true,\n      "notNull": true\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "flow_id": {\n      "name": "flow_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "correlation_id": {\n      "name": "correlation_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "type": {\n      "name": "type",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "payload": {\n      "name": "payload",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_run_events_correlation_idx": {\n      "name": "flow_run_events_correlation_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "correlation_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_run_events_run_idx": {\n      "name": "flow_run_events_run_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "sequence",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": false,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_run_events_flow_id_waker_flows_id_fk": {\n      "name": "flow_run_events_flow_id_waker_flows_id_fk",\n      "tableFrom": "flow_run_events",\n      "tableTo": "waker_flows",\n      "columnsFrom": [\n        "flow_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_run_events_run_id_group_task_runs_id_fk": {\n      "name": "flow_run_events_run_id_group_task_runs_id_fk",\n      "tableFrom": "flow_run_events",\n      "tableTo": "group_task_runs",\n      "columnsFrom": [\n        "run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_run_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_run_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_update": {\n      "name": "tenant_scope_update",\n      "as": "PERMISSIVE",\n      "for": "UPDATE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_run_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)",\n      "withCheck": "\\"flow_run_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_delete": {\n      "name": "tenant_scope_delete",\n      "as": "PERMISSIVE",\n      "for": "DELETE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_run_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {},\n  "isRLSEnabled": true\n}\n',
    sha256: "1d786c835f2d45c631b800ac0bcbbaee5193e786917a8f849fffae49140eef91",
  },
  {
    raw: '{\n  "name": "flow_run_retries",\n  "schema": "",\n  "columns": {\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true,\n      "default": "gen_random_uuid()"\n    },\n    "request_id": {\n      "name": "request_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "flow_id": {\n      "name": "flow_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "source_run_id": {\n      "name": "source_run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "source_revision": {\n      "name": "source_revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "definition_revision": {\n      "name": "definition_revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "correlation_id": {\n      "name": "correlation_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "node_id": {\n      "name": "node_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "new_run_id": {\n      "name": "new_run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "status": {\n      "name": "status",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "\'prepared\'"\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_run_retries_request_idx": {\n      "name": "flow_run_retries_request_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "request_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_run_retries_source_idx": {\n      "name": "flow_run_retries_source_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "source_run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_run_retries_new_idx": {\n      "name": "flow_run_retries_new_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "new_run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_run_retries_flow_id_waker_flows_id_fk": {\n      "name": "flow_run_retries_flow_id_waker_flows_id_fk",\n      "tableFrom": "flow_run_retries",\n      "tableTo": "waker_flows",\n      "columnsFrom": [\n        "flow_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_run_retries_source_run_id_group_task_runs_id_fk": {\n      "name": "flow_run_retries_source_run_id_group_task_runs_id_fk",\n      "tableFrom": "flow_run_retries",\n      "tableTo": "group_task_runs",\n      "columnsFrom": [\n        "source_run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_run_retries_new_run_id_group_task_runs_id_fk": {\n      "name": "flow_run_retries_new_run_id_group_task_runs_id_fk",\n      "tableFrom": "flow_run_retries",\n      "tableTo": "group_task_runs",\n      "columnsFrom": [\n        "new_run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_run_retries\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_run_retries\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_update": {\n      "name": "tenant_scope_update",\n      "as": "PERMISSIVE",\n      "for": "UPDATE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_run_retries\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)",\n      "withCheck": "\\"flow_run_retries\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_delete": {\n      "name": "tenant_scope_delete",\n      "as": "PERMISSIVE",\n      "for": "DELETE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_run_retries\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {\n    "flow_run_retries_status_check": {\n      "name": "flow_run_retries_status_check",\n      "value": "\\"flow_run_retries\\".\\"status\\" IN (\'prepared\',\'ready\',\'unknown\',\'cancelled\')"\n    },\n    "flow_run_retries_revision_check": {\n      "name": "flow_run_retries_revision_check",\n      "value": "\\"flow_run_retries\\".\\"source_revision\\" >= 0 AND \\"flow_run_retries\\".\\"definition_revision\\" > 0"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "0eafbe9731da1955953a353d42a5ac911bc396e53d8542a57287756e544d3d5b",
  },
];
const expected: Record<string, Table> = Object.fromEntries(
  capsules.map(({ raw, sha256 }) => {
    assert.equal(createHash("sha256").update(raw).digest("hex"), sha256);
    const table = JSON.parse(raw) as Table;
    return [`public.${table.name}`, table];
  }),
);
const server = join(import.meta.dir, ".."),
  overlay = join(server, "recovery/recovery-20261018-v1");
const migration = readFileSync(
  join(overlay, "sql/0088_recovery_flow_run_coordination.sql"),
  "utf8",
);
const previous = JSON.parse(
  readFileSync(join(overlay, "meta/0087_snapshot.json"), "utf8"),
) as Snapshot;
const next = JSON.parse(
  readFileSync(join(overlay, "meta/0088_snapshot.json"), "utf8"),
) as Snapshot;
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
const tables = [flowConfirmations, flowRunEvents, flowRunRetries];
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
              "bigserial",
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
    if (config.name === "flow_run_events" && column.name === "sequence") {
      // Locked Drizzle0.45.2 implicit serial default only; never relax other column defaults.
      assert.ok(is(column, PgBigSerial64));
      assert.equal(column.getSQLType(), "bigserial");
      assert.equal(column.dataType, "bigint");
      assert.equal(column.hasDefault, true);
      assert.equal(column.default, undefined);
    } else assert.equal(column.hasDefault, column.default !== undefined);
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

function checkSQL(source: string): void {
  const parsed = parseSQL(source);
  equalTargets(parsed.tables);
  assert.deepEqual(parsed.forced, []);
}
function checkSnapshot(s: Snapshot): void {
  assert.equal(previous.id, "75ad5a74-3589-41b2-9c43-6cadb4c019ed");
  assert.equal(s.prevId, previous.id);
  assert.match(
    s.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  for (const id of [
    previous.id,
    "eb07617b-d7fc-4418-91c0-cb98dab42ad7",
    "0fac1c33-b397-46ee-a332-b0a9b06d126b",
  ])
    assert.notEqual(s.id, id);
  const restored = structuredClone(s),
    added: Record<string, Table> = {};
  for (const key of Object.keys(s.tables))
    if (!(key in previous.tables)) {
      const table = s.tables[key];
      assert.ok(table);
      added[key] = table;
      delete restored.tables[key];
    }
  assert.deepEqual(added, expected);
  restored.id = previous.id;
  restored.prevId = previous.prevId;
  assert.deepEqual(restored, previous);
  assert.equal(Object.keys(s.tables).length, 118);
}
function checkJournal(j: Journal): void {
  const historical = JSON.parse(
    readFileSync(join(server, "drizzle/meta/_journal.json"), "utf8"),
  ) as Journal;
  assert.equal(j.version, historical.version);
  assert.equal(j.dialect, historical.dialect);
  assert.ok(
    j.entries.length >= 89,
    "complete stage prefix only; unknown suffix has no execution permission",
  );
  assert.deepEqual(j.entries.slice(0, 81), historical.entries);
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(j.entries.slice(0, 88)))
      .digest("hex"),
    "654a06edb697c6a2f51022795df3d3d4adcefeda2df16294d947df4c79710785",
  );
  const entry = j.entries[88];
  assert.ok(entry);
  assert.deepEqual(
    { ...entry, when: 0 },
    {
      idx: 88,
      version: "7",
      when: 0,
      tag: "0088_recovery_flow_run_coordination",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(entry.when) &&
      entry.when > 1792347080676 &&
      entry.when <= Date.now(),
  );
}
function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink());
    const full = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}
const actualMetadata = () =>
  Object.fromEntries(
    tables.map((t) => {
      const m = metadata(t);
      return [`public.${m.name}`, m];
    }),
  );
function rejectSQL(before: string, after: string): void {
  assert.ok(
    migration.includes(before),
    "negative fixture must match actual SQL",
  );
  const mutated = migration.replace(before, after);
  assert.notEqual(mutated, migration);
  expect(() => checkSQL(mutated)).toThrow();
}
describe("recovery existing group Flow confirmation events retry coordination structure", () => {
  test("complete independent capsules retain exact approved SHA identities", () => {
    for (const c of capsules)
      expect(createHash("sha256").update(c.raw).digest("hex")).toBe(c.sha256);
  });
  test("all31 SQL statements fully consume and match complete independent targets", () =>
    checkSQL(migration));
  test("actual Drizzle all metadata including precise implicit bigserial default matches targets", () =>
    equalTargets(actualMetadata()));
  test("inverse three restores all115 predecessor tables and complete top-level objects", () =>
    checkSnapshot(next));
  test("journal exact0..87 and fresh88 stage prefix accepts successor without executing it", () => {
    checkJournal(journal);
    const j = structuredClone(journal);
    j.entries.push({
      idx: 89,
      tag: "unapproved-prefix-fixture",
      version: "7",
      when: Date.now(),
      breakpoints: true,
    });
    checkJournal(j);
    expect(j.entries.length).toBe(journal.entries.length + 1);
  });
  test("original163 and approved81..87 SQL snapshots retain exact input hashes", () => {
    const dir = join(server, "drizzle"),
      files = filesUnder(dir).sort();
    expect(files).toHaveLength(163);
    const records = files.map((p) => {
      const b = readFileSync(p);
      return `${relative(dir, p)}\0${b.length}\0${createHash("sha256").update(b).digest("hex")}\n`;
    });
    expect(createHash("sha256").update(records.join("")).digest("hex")).toBe(
      "9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d",
    );
    for (const input of [
      {
        path: "recovery/recovery-20261018-v1/meta/0081_snapshot.json",
        bytes: 292641,
        sha256:
          "ef4b170efbc98717bce811b27d3f5d35c274146f5faec50bc787028acbfaa24c",
      },
      {
        path: "recovery/recovery-20261018-v1/meta/0082_snapshot.json",
        bytes: 310313,
        sha256:
          "2cc73e7181b11baa27dcad48ab412cf5d89c13d19d0f06a4640e6cdaa7a883e8",
      },
      {
        path: "recovery/recovery-20261018-v1/meta/0083_snapshot.json",
        bytes: 312091,
        sha256:
          "159c6313247a705e2dd71efe46c90cc734ee9a8a0be3b66f4c114ef343335d61",
      },
      {
        path: "recovery/recovery-20261018-v1/meta/0084_recovery_flow_source_foundations_snapshot.json",
        bytes: 329146,
        sha256:
          "12a3221d57c57de1f3639d126ea90e0724e84e64fd2965e4fb62d197fced2a07",
      },
      {
        path: "recovery/recovery-20261018-v1/meta/0085_snapshot.json",
        bytes: 352947,
        sha256:
          "b02d8b70f513bcc764a2be96a4d88184d73392b14eb754a8067b9cd123a00eab",
      },
      {
        path: "recovery/recovery-20261018-v1/meta/0086_snapshot.json",
        bytes: 369468,
        sha256:
          "6beec7f83f05e43d212c44f990ba625c4714acb45fdac6b4082df3085e89541a",
      },
      {
        path: "recovery/recovery-20261018-v1/meta/0087_snapshot.json",
        bytes: 389321,
        sha256:
          "86cd06c067f98c93911bc639cb3df766c54cb4d7478f95c414bf29b34fafb3ef",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0081_recovery_subject_and_binding.sql",
        bytes: 172,
        sha256:
          "0769123048b40af0f80aa8a3c843f67ab19fac5c44ccb9243bbc6819d689bb40",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0082_recovery_role_foundations.sql",
        bytes: 9833,
        sha256:
          "683834fae02b1e3cf3be6ca85340098c2a1bd0cea6de65c7e14b80e3be7a93dc",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0083_recovery_task_flow_audit_contract.sql",
        bytes: 938,
        sha256:
          "ee97d7862077239462aec225a1b71bf2b87d06a9d858b48dcaa7746a2b0856ea",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0084_recovery_flow_source_foundations.sql",
        bytes: 8236,
        sha256:
          "96cb4c921ca065856d4f3d641440907528d9ddf78e483ff09ff100aa2835e541",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0085_recovery_flow_source_run_records.sql",
        bytes: 12015,
        sha256:
          "a94c4a80167f67e79fee01f71483b7964985da4957a0221280f79cebe279e4c2",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0086_recovery_flow_source_runtime_records.sql",
        bytes: 8857,
        sha256:
          "21d90fc2a2505943db1e1687109820527660b8ec7b87d2e8a6b303107fa723bd",
      },
      {
        path: "recovery/recovery-20261018-v1/sql/0087_recovery_flow_source_original_records.sql",
        bytes: 11428,
        sha256:
          "e5e5fb88be31f330280ea3e045d29da6d3315e0df2f82d854df16d399a8fd7f9",
      },
    ]) {
      const b = readFileSync(join(server, input.path));
      expect(b.length).toBe(input.bytes);
      expect(createHash("sha256").update(b).digest("hex")).toBe(input.sha256);
    }
  });
  test("bigserial64 driver retains int64 precision and has no invented explicit default or JSON DTO", () => {
    const col = flowRunEvents.sequence;
    expect(col.getSQLType()).toBe("bigserial");
    expect(col.columnType).toBe("PgBigSerial64");
    expect(col.dataType).toBe("bigint");
    expect(col.hasDefault).toBe(true);
    expect(col.default).toBeUndefined();
    expect(col.mapFromDriverValue("9007199254740993")).toBe(9007199254740993n);
    expect(col.mapFromDriverValue("9223372036854775807")).toBe(
      9223372036854775807n,
    );
    // Existing restored tree has no Flow event sequence DTO. JSON wiring remains a later explicit contract.
    expect(() =>
      JSON.stringify({ sequence: col.mapFromDriverValue("9007199254740993") }),
    ).toThrow();
    const lossy = pgTable("flow_run_events", {
      sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    });
    expect(() => metadata(lossy)).toThrow();
  });
  test("UUID defaults nullable fields JSON driver object identity and event no-CHECK remain exact", () => {
    expect(flowConfirmations.id.hasDefault).toBe(false);
    expect(flowRunRetries.id.hasDefault).toBe(true);
    expect(flowConfirmations.answer.notNull).toBe(false);
    expect(flowConfirmations.requestId.notNull).toBe(false);
    const value = { unknown: [1, null], question: { type: "fixture" } };
    for (const col of [
      flowConfirmations.question,
      flowConfirmations.inputs,
      flowRunEvents.payload,
    ])
      expect(col.mapToDriverValue(value)).toBe(value);
    expect(getTableConfig(flowRunEvents).checks).toHaveLength(0);
  });
  test("SQL rejects altered serial UUID defaults nullable JSON and status revision constraints", () => {
    for (const [a, b] of [
      ['"sequence" bigserial', '"sequence" integer'],
      ['"sequence" bigserial', '"sequence" bigint'],
      [
        '"sequence" bigserial NOT NULL PRIMARY KEY',
        '"sequence" bigserial DEFAULT 1 NOT NULL PRIMARY KEY',
      ],
      [
        '"id" uuid NOT NULL PRIMARY KEY',
        '"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY',
      ],
      [
        '"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY',
        '"id" uuid NOT NULL PRIMARY KEY',
      ],
      ['"answer" text,', '"answer" text NOT NULL,'],
      ['"request_id" uuid,', '"request_id" uuid NOT NULL,'],
      ['"question" jsonb NOT NULL', '"question" text NOT NULL'],
      ['"payload" jsonb NOT NULL', '"payload" jsonb'],
      ["DEFAULT 'pending'", "DEFAULT 'answered'"],
      ["DEFAULT 'prepared'", "DEFAULT 'ready'"],
      ["'pending','answered','skipped'", "'pending','answered'"],
      [
        "'prepared','ready','unknown','cancelled'",
        "'prepared','ready','cancelled'",
      ],
      ['"source_revision" >= 0', '"source_revision" > 0'],
      ['"definition_revision" > 0', '"definition_revision" >= 0'],
    ])
      rejectSQL(a, b);
  });
  test("SQL rejects ordinary versus unique index sort and exact FK target scope drift", () => {
    for (const [a, b] of [
      [
        'CREATE INDEX "flow_confirmations_run_idx"',
        'CREATE UNIQUE INDEX "flow_confirmations_run_idx"',
      ],
      [
        'CREATE INDEX "flow_run_events_run_idx"',
        'CREATE UNIQUE INDEX "flow_run_events_run_idx"',
      ],
      [
        'CREATE UNIQUE INDEX "flow_run_events_correlation_idx"',
        'CREATE INDEX "flow_run_events_correlation_idx"',
      ],
      [
        'CREATE UNIQUE INDEX "flow_run_retries_source_idx"',
        'CREATE INDEX "flow_run_retries_source_idx"',
      ],
      [
        'CREATE UNIQUE INDEX "flow_run_retries_new_idx"',
        'CREATE INDEX "flow_run_retries_new_idx"',
      ],
      [
        'CREATE UNIQUE INDEX "flow_run_retries_request_idx"',
        'CREATE INDEX "flow_run_retries_request_idx"',
      ],
      [" ASC NULLS LAST", " DESC NULLS LAST"],
      ["NULLS LAST", "NULLS FIRST"],
      ["USING btree", "USING hash"],
      [
        'REFERENCES "public"."group_task_runs"',
        'REFERENCES "public"."flow_source_runs"',
      ],
      ["ON DELETE NO ACTION", "ON DELETE CASCADE"],
      ['FOREIGN KEY ("new_run_id")', 'FOREIGN KEY ("source_run_id")'],
    ])
      rejectSQL(a, b);
  });
  test("SQL rejects weakened tenant policies missing UPDATE check and extra mutation grants force constraints", () => {
    rejectSQL(
      "AS PERMISSIVE FOR INSERT TO public",
      'AS PERMISSIVE FOR INSERT TO "other"',
    );
    rejectSQL("ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY");
    rejectSQL(
      'USING ("flow_confirmations"."tenant_id" = current_setting(\'app.tenant_id\', true))',
      "USING (true)",
    );
    rejectSQL(
      'WITH CHECK ("flow_confirmations"."tenant_id" = current_setting(\'app.tenant_id\', true))',
      "WITH CHECK (true)",
    );
    rejectSQL("FOR DELETE", "FOR UPDATE");
    for (const source of [
      migration + migration,
      migration + 'UPDATE "public"."group_task_runs" SET "revision"=0;',
      migration + 'GRANT ALL ON "public"."flow_run_events" TO public;',
      migration + "SELECT 1;",
      migration +
        'ALTER TABLE "public"."flow_run_events" ADD CONSTRAINT "invented" CHECK (true);',
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("metadata snapshot and journal reject extra missing key default oldtable lineage and prefix drift", () => {
    for (const change of [
      (t: Table) => {
        t.indexes = {};
      },
      (t: Table) => {
        t.foreignKeys = {};
      },
      (t: Table) => {
        t.policies = {};
      },
      (t: Table) => {
        t.isRLSEnabled = false;
      },
      (t: Table) => {
        const col = t.columns.id;
        assert.ok(col);
        col.default = "gen_random_uuid()";
      },
    ]) {
      const actual = actualMetadata();
      const t = actual["public.flow_confirmations"];
      assert.ok(t);
      change(t);
      expect(() => equalTargets(actual)).toThrow();
    }
    const mutations: ((s: Snapshot) => void)[] = [
      (s) => {
        delete s.tables["public.flow_run_retries"];
      },
      (s) => {
        s.prevId = "wrong";
      },
      (s) => {
        s.id = previous.id;
      },
      (s) => {
        const t = s.tables["public.flow_run_retries"];
        assert.ok(t);
        t.checkConstraints = {};
      },
      (s) => {
        const t = s.tables["public.flow_run_events"];
        assert.ok(t);
        t.policies = {};
      },
      (s) => {
        const t = s.tables["public.group_task_runs"];
        assert.ok(t);
        t.indexes = {};
      },
    ];
    for (const mutate of mutations) {
      const s = structuredClone(next);
      mutate(s);
      expect(() => checkSnapshot(s)).toThrow();
    }
    for (const idx of [0, 81, 82, 83, 84, 85, 86, 87, 88]) {
      const j = structuredClone(journal);
      const x = j.entries[idx];
      assert.ok(x);
      x.tag = "forged";
      expect(() => checkJournal(j)).toThrow();
    }
    const j = structuredClone(journal);
    const x = j.entries[88];
    assert.ok(x);
    x.when = 1792347080676;
    expect(() => checkJournal(j)).toThrow();
  });
});

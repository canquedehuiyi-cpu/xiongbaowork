import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
  flowSourceInvocations,
  flowSourceRuntimeEvents,
  flowSourceStopOperations,
} from "../src/db/schema/flow-source-runtime-records";

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

// Complete independent0121 capsules: 583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules = [
  {
    raw: '{\n  "name": "flow_source_invocations",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "identity": {\n      "name": "identity",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "args": {\n      "name": "args",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "dispatch_key": {\n      "name": "dispatch_key",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "state": {\n      "name": "state",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "\'reserved\'"\n    },\n    "receipt": {\n      "name": "receipt",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "late_receipt": {\n      "name": "late_receipt",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    },\n    "updated_at": {\n      "name": "updated_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_invocations_key_idx": {\n      "name": "flow_source_invocations_key_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_source_invocations_dispatch_idx": {\n      "name": "flow_source_invocations_dispatch_idx",\n      "columns": [\n        {\n          "expression": "dispatch_key",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_source_invocations_correlation_idx": {\n      "name": "flow_source_invocations_correlation_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "(\\"identity\\"->\'original\'->>\'correlationId\')",\n          "asc": true,\n          "isExpression": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_invocations_run_id_flow_source_runs_id_fk": {\n      "name": "flow_source_invocations_run_id_flow_source_runs_id_fk",\n      "tableFrom": "flow_source_invocations",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_invocations_run_owner_fk": {\n      "name": "flow_source_invocations_run_owner_fk",\n      "tableFrom": "flow_source_invocations",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "tenant_id",\n        "run_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.id = \\"flow_source_invocations\\".\\"run_id\\" AND r.tenant_id = current_setting(\'app.tenant_id\', true) AND r.admission_open AND r.state = \'running\' AND r.owner_epoch = (\\"flow_source_invocations\\".\\"identity\\"->>\'ownerEpoch\')::integer AND r.revision = (\\"flow_source_invocations\\".\\"identity\\"->>\'runRevision\')::integer AND r.source_digest = \\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'scriptDigest\')"\n    },\n    "tenant_scope_update": {\n      "name": "tenant_scope_update",\n      "as": "PERMISSIVE",\n      "for": "UPDATE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)",\n      "withCheck": "\\"flow_source_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_invocations_state_check": {\n      "name": "flow_source_invocations_state_check",\n      "value": "\\"flow_source_invocations\\".\\"state\\" IN (\'reserved\',\'not-dispatched\',\'dispatched\',\'completed\',\'failed-known\',\'unknown\')"\n    },\n    "flow_source_invocations_correlation_check": {\n      "name": "flow_source_invocations_correlation_check",\n      "value": "COALESCE(\\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'version\' = \'original-ordinal-v1\' AND \\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'runtimeCallOrdinal\' ~ \'^[1-9][0-9]*$\' AND \\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'dynamicIndex\' ~ \'^(0|[1-9][0-9]*)$\' AND \\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'correlationId\' = concat(\\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'scriptDigest\', \':\', \\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'runtimeCallOrdinal\', \':\', \\"flow_source_invocations\\".\\"identity\\"->\'original\'->>\'dynamicIndex\'), false)"\n    },\n    "flow_source_invocations_identity_check": {\n      "name": "flow_source_invocations_identity_check",\n      "value": "COALESCE(\\"flow_source_invocations\\".\\"identity\\"->>\'tenantId\' = \\"flow_source_invocations\\".\\"tenant_id\\" AND \\"flow_source_invocations\\".\\"identity\\"->>\'runId\' = \\"flow_source_invocations\\".\\"run_id\\"::text AND \\"flow_source_invocations\\".\\"identity\\"->>\'invocationId\' = \\"flow_source_invocations\\".\\"id\\"::text AND jsonb_typeof(\\"flow_source_invocations\\".\\"identity\\"->\'ownerEpoch\') = \'number\' AND jsonb_typeof(\\"flow_source_invocations\\".\\"identity\\"->\'runRevision\') = \'number\' AND \\"flow_source_invocations\\".\\"identity\\"->>\'primitive\' IN (\'worker\',\'action\',\'askUser\',\'workflow\'), false)"\n    },\n    "flow_source_invocations_receipt_check": {\n      "name": "flow_source_invocations_receipt_check",\n      "value": "COALESCE((\\"flow_source_invocations\\".\\"receipt\\" IS NULL OR (\\"flow_source_invocations\\".\\"receipt\\"->\'identity\' = \\"flow_source_invocations\\".\\"identity\\" AND \\"flow_source_invocations\\".\\"receipt\\"->>\'dispatchKey\' = \\"flow_source_invocations\\".\\"dispatch_key\\"::text AND \\"flow_source_invocations\\".\\"receipt\\"->>\'authority\' = \'governed-host\' AND \\"flow_source_invocations\\".\\"receipt\\"->>\'state\' = \\"flow_source_invocations\\".\\"state\\")) AND (\\"flow_source_invocations\\".\\"late_receipt\\" IS NULL OR (\\"flow_source_invocations\\".\\"state\\" = \'unknown\' AND \\"flow_source_invocations\\".\\"late_receipt\\"->\'identity\' = \\"flow_source_invocations\\".\\"identity\\" AND \\"flow_source_invocations\\".\\"late_receipt\\"->>\'dispatchKey\' = \\"flow_source_invocations\\".\\"dispatch_key\\"::text AND \\"flow_source_invocations\\".\\"late_receipt\\"->>\'authority\' = \'governed-host\')), false)"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "8a1d5caeb423fb9c187a115069d4366c4c844b832a5b0b310c46e762a15c4368",
  },
  {
    raw: '{\n  "name": "flow_source_runtime_events",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true,\n      "default": "gen_random_uuid()"\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "sequence": {\n      "name": "sequence",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "type": {\n      "name": "type",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "payload": {\n      "name": "payload",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_runtime_events_sequence_idx": {\n      "name": "flow_source_runtime_events_sequence_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "sequence",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_runtime_events_run_id_flow_source_runs_id_fk": {\n      "name": "flow_source_runtime_events_run_id_flow_source_runs_id_fk",\n      "tableFrom": "flow_source_runtime_events",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_runtime_events_run_owner_fk": {\n      "name": "flow_source_runtime_events_run_owner_fk",\n      "tableFrom": "flow_source_runtime_events",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "tenant_id",\n        "run_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_runtime_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_runtime_events\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_runtime_events_sequence_check": {\n      "name": "flow_source_runtime_events_sequence_check",\n      "value": "\\"flow_source_runtime_events\\".\\"sequence\\" > 0 AND \\"flow_source_runtime_events\\".\\"type\\" IN (\'phase\',\'log\')"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "e21f45e66b293c195cc5710d0bfcc61a0b1967302754602d7b1c8bf8ecf6f336",
  },
  {
    raw: '{\n  "name": "flow_source_stop_operations",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true,\n      "default": "gen_random_uuid()"\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "operation_id": {\n      "name": "operation_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "receipt": {\n      "name": "receipt",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_stop_operations_id_idx": {\n      "name": "flow_source_stop_operations_id_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "operation_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_stop_operations_run_id_flow_source_runs_id_fk": {\n      "name": "flow_source_stop_operations_run_id_flow_source_runs_id_fk",\n      "tableFrom": "flow_source_stop_operations",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "run_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_stop_operations_run_owner_fk": {\n      "name": "flow_source_stop_operations_run_owner_fk",\n      "tableFrom": "flow_source_stop_operations",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "tenant_id",\n        "run_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_stop_operations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_stop_operations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {},\n  "isRLSEnabled": true\n}\n',
    sha256: "b86b0dffed9fb218ec1dde71f40bd908d6d37ff4056786e092503d053c9ec631",
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
  join(overlay, "sql/0086_recovery_flow_source_runtime_records.sql"),
  "utf8",
);
const previous = JSON.parse(
  readFileSync(join(overlay, "meta/0085_snapshot.json"), "utf8"),
) as Snapshot;
const next = JSON.parse(
  readFileSync(join(overlay, "meta/0086_snapshot.json"), "utf8"),
) as Snapshot;
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
const tables = [
  flowSourceInvocations,
  flowSourceRuntimeEvents,
  flowSourceStopOperations,
];
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

function checkSQL(source: string): void {
  const parsed = parseSQL(source);
  equalTargets(parsed.tables);
  assert.deepEqual(parsed.forced, []);
}
function checkSnapshot(s: Snapshot): void {
  assert.equal(previous.id, "879bfd47-bf7f-47df-84c9-5f36a15529c0");
  assert.equal(s.prevId, previous.id);
  assert.match(
    s.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  for (const id of [
    previous.id,
    "d67073aa-de8d-4145-b2b3-fffa138fb49a",
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
  assert.equal(Object.keys(s.tables).length, 112);
}
function checkJournal(j: Journal): void {
  const historical = JSON.parse(
    readFileSync(join(server, "drizzle/meta/_journal.json"), "utf8"),
  ) as Journal;
  assert.equal(j.version, historical.version);
  assert.equal(j.dialect, historical.dialect);
  assert.ok(
    j.entries.length >= 87,
    "this stage prefix, not unknown suffix execution permission",
  );
  assert.deepEqual(j.entries.slice(0, 81), historical.entries);
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(j.entries.slice(0, 86)))
      .digest("hex"),
    "4040760724f7ede730e4df6b35f00b30bebd05970fa0bcb7953b056c89e50226",
  );
  const entry = j.entries[86];
  assert.ok(entry);
  assert.deepEqual(
    { ...entry, when: 0 },
    {
      idx: 86,
      version: "7",
      when: 0,
      tag: "0086_recovery_flow_source_runtime_records",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(entry.when) &&
      entry.when > 1792342279749 &&
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
    tables.map((table) => {
      const m = metadata(table);
      return [`public.${m.name}`, m];
    }),
  );
describe("recovery Flow invocation event stop historical runtime records", () => {
  test("independent complete capsules retain delivered SHA identities", () => {
    for (const c of capsules)
      expect(createHash("sha256").update(c.raw).digest("hex")).toBe(c.sha256);
  });
  test("all24 SQL statements and actual expression index tokens equal independent targets", () =>
    checkSQL(migration));
  test("Drizzle full metadata includes raw JSON expression isExpression and global dispatch unique", () =>
    equalTargets(actualMetadata()));
  test("inverse new3 preserves all109 predecessor tables and top-level values", () =>
    checkSnapshot(next));
  test("journal keeps0..85 exact and fresh86 prefix without suffix authority", () =>
    checkJournal(journal));
  test("original163 and approved81..85 SQL/snapshot input hashes remain unchanged", () => {
    const root = join(server, "drizzle"),
      files = filesUnder(root).sort();
    expect(files).toHaveLength(163);
    const rows = files.map((file) => {
      const b = readFileSync(file);
      return `${relative(root, file)}\0${b.length}\0${createHash("sha256").update(b).digest("hex")}\n`;
    });
    expect(createHash("sha256").update(rows.join("")).digest("hex")).toBe(
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
    ]) {
      const data = readFileSync(join(server, input.path));
      expect(data.length).toBe(input.bytes);
      expect(createHash("sha256").update(data).digest("hex")).toBe(
        input.sha256,
      );
    }
  });
  test("id defaults nullable receipts and object driver identity preserve historical semantics", () => {
    expect(flowSourceInvocations.id.hasDefault).toBe(false);
    expect(flowSourceRuntimeEvents.id.hasDefault).toBe(true);
    expect(flowSourceStopOperations.id.hasDefault).toBe(true);
    expect(flowSourceInvocations.receipt.notNull).toBe(false);
    expect(flowSourceInvocations.lateReceipt.notNull).toBe(false);
    const value = {
      unknown: [null, 1],
      original: { correlationId: "fixture-only" },
    };
    for (const column of [
      flowSourceInvocations.args,
      flowSourceInvocations.identity,
      flowSourceInvocations.receipt,
      flowSourceInvocations.lateReceipt,
      flowSourceRuntimeEvents.payload,
      flowSourceStopOperations.receipt,
    ])
      expect(column.mapToDriverValue(value)).toBe(value);
    expect(getTableConfig(flowSourceStopOperations).checks).toHaveLength(0);
  });
  test("SQL rejects expression-as-column missing parentheses/operator and altered global uniqueness/sort/FK", () => {
    for (const source of [
      migration.replace(
        "(\"identity\"->'original'->>'correlationId')",
        '"identity"',
      ),
      migration.replace(
        "(\"identity\"->'original'->>'correlationId')",
        "\"identity\"->'original'->>'correlationId'",
      ),
      migration.replace(
        "(\"identity\"->'original'->>'correlationId')",
        "(\"identity\"->'original'->'correlationId')",
      ),
      migration.replace(
        '("dispatch_key" ASC NULLS LAST)',
        '("tenant_id" ASC NULLS LAST, "dispatch_key" ASC NULLS LAST)',
      ),
      migration.replace("CREATE UNIQUE INDEX", "CREATE INDEX"),
      migration.replace("NULLS LAST", "NULLS FIRST"),
      migration.replace(" ASC NULLS LAST", " DESC NULLS LAST"),
      migration.replace("USING btree", "USING hash"),
      migration.replace("ON DELETE NO ACTION", "ON DELETE CASCADE"),
      migration.replace(
        'FOREIGN KEY ("tenant_id", "run_id")',
        'FOREIGN KEY ("run_id")',
      ),
      migration.replace(
        '"id" uuid NOT NULL PRIMARY KEY',
        '"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY',
      ),
      migration.replace('"receipt" jsonb,', '"receipt" jsonb NOT NULL,'),
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("SQL rejects correlation receipt late-state primitive and full admission policy weakening", () => {
    for (const source of [
      migration.replace("'^[1-9][0-9]*$'", "'^[0-9]*$'"),
      migration.replace("'original-ordinal-v1'", "'other'"),
      migration.replace("concat(", "coalesce("),
      migration.replace(", false)", ", true)"),
      migration.replace("'governed-host'", "'caller'"),
      migration.replace("\"state\" = 'unknown'", "\"state\" = 'completed'"),
      migration.replace("'workflow'", "'execute-anything'"),
      migration.replace("AND r.admission_open", "AND true"),
      migration.replace("r.state = 'running'", "r.state = 'stopped'"),
      migration.replace(
        'r.owner_epoch = ("flow_source_invocations"."identity"->>\'ownerEpoch\')::integer',
        "true",
      ),
      migration.replace(
        'r.revision = ("flow_source_invocations"."identity"->>\'runRevision\')::integer',
        "true",
      ),
      migration.replace(
        "r.source_digest = \"flow_source_invocations\".\"identity\"->'original'->>'scriptDigest'",
        "true",
      ),
      migration.replace("'phase','log'", "'phase','log','extra'"),
      migration.replace(
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
      ),
      `${migration}ALTER TABLE "public"."flow_source_stop_operations" ADD CONSTRAINT "invented" CHECK (true);`,
      `${migration}UPDATE "public"."flow_source_runs" SET "admission_open" = true;`,
      `${migration}GRANT ALL ON "public"."flow_source_invocations" TO public;`,
      `${migration}SELECT 1;`,
      migration + migration,
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("metadata rejects expression flag/operator/parentheses sort and dispatch scope drift", () => {
    const mutate: ((t: Table) => void)[] = [
      (t) => {
        const i = t.indexes.flow_source_invocations_correlation_idx;
        assert.ok(i);
        const c = i.columns[2];
        assert.ok(c);
        c.isExpression = false;
      },
      (t) => {
        const i = t.indexes.flow_source_invocations_correlation_idx;
        assert.ok(i);
        const c = i.columns[2];
        assert.ok(c);
        c.expression = c.expression.replace("->>", "->");
      },
      (t) => {
        const i = t.indexes.flow_source_invocations_correlation_idx;
        assert.ok(i);
        const c = i.columns[2];
        assert.ok(c);
        c.expression = c.expression.slice(1, -1);
      },
      (t) => {
        const i = t.indexes.flow_source_invocations_correlation_idx;
        assert.ok(i);
        const c = i.columns[2];
        assert.ok(c);
        c.asc = false;
      },
      (t) => {
        const i = t.indexes.flow_source_invocations_correlation_idx;
        assert.ok(i);
        const c = i.columns[2];
        assert.ok(c);
        c.nulls = "first";
      },
      (t) => {
        const i = t.indexes.flow_source_invocations_dispatch_idx;
        assert.ok(i);
        i.columns.unshift({
          expression: "tenant_id",
          isExpression: false,
          asc: true,
          nulls: "last",
        });
      },
    ];
    for (const change of mutate) {
      const actual = actualMetadata();
      const table = actual["public.flow_source_invocations"];
      assert.ok(table);
      change(table);
      expect(() => equalTargets(actual)).toThrow();
    }
  });
  test("snapshot journal reject missing old/new structure wrong predecessor and reused stage identity", () => {
    const mutate: ((s: Snapshot) => void)[] = [
      (s) => {
        delete s.tables["public.flow_source_invocations"];
      },
      (s) => {
        s.prevId = "wrong";
      },
      (s) => {
        s.id = previous.id;
      },
      (s) => {
        const t = s.tables["public.flow_source_invocations"];
        assert.ok(t);
        t.checkConstraints = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_invocations"];
        assert.ok(t);
        t.policies = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_runtime_events"];
        assert.ok(t);
        t.foreignKeys = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_runs"];
        assert.ok(t);
        t.indexes = {};
      },
    ];
    for (const change of mutate) {
      const snapshot = structuredClone(next);
      change(snapshot);
      expect(() => checkSnapshot(snapshot)).toThrow();
    }
    for (const idx of [0, 81, 82, 83, 84, 85, 86]) {
      const j = structuredClone(journal);
      const entry = j.entries[idx];
      assert.ok(entry);
      entry.tag = "forged";
      expect(() => checkJournal(j)).toThrow();
    }
    const j = structuredClone(journal);
    const entry = j.entries[86];
    assert.ok(entry);
    entry.when = 1792342279749;
    expect(() => checkJournal(j)).toThrow();
  });
});

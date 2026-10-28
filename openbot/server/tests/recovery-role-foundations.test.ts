import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
  employeeRoleSnapshots,
  roleGenerationRequests,
  roleTemplates,
  roleWriteReceipts,
} from "../src/db/schema/roles";

type Column = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number;
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

/** Exact UTF8 table capsules read from verified historical0121, not inferred from this implementation.
 * Whole0121: 583049B SHA256 c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
 * Each raw capsule and SHA below matches the independently delivered L1-02 readonly input.
 */
const capsules = [
  {
    sha256: "8bc1a003e62398ba1d4bdb2e019647d0908d0443c205018423affdcc94c86c9f",
    raw: '{\n  "public.role_templates": {\n    "name": "role_templates",\n    "schema": "",\n    "columns": {\n      "id": {\n        "name": "id",\n        "type": "uuid",\n        "primaryKey": true,\n        "notNull": true,\n        "default": "gen_random_uuid()"\n      },\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "owner_user_id": {\n        "name": "owner_user_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "name": {\n        "name": "name",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "profile": {\n        "name": "profile",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "version": {\n        "name": "version",\n        "type": "integer",\n        "primaryKey": false,\n        "notNull": true,\n        "default": 1\n      },\n      "updated_at": {\n        "name": "updated_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {\n      "role_templates_owner_name_idx": {\n        "name": "role_templates_owner_name_idx",\n        "columns": [\n          {\n            "expression": "tenant_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "owner_user_id",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          },\n          {\n            "expression": "name",\n            "isExpression": false,\n            "asc": true,\n            "nulls": "last"\n          }\n        ],\n        "isUnique": true,\n        "concurrently": false,\n        "method": "btree",\n        "with": {}\n      }\n    },\n    "foreignKeys": {\n      "role_templates_owner_user_id_users_id_fk": {\n        "name": "role_templates_owner_user_id_users_id_fk",\n        "tableFrom": "role_templates",\n        "tableTo": "users",\n        "columnsFrom": [\n          "owner_user_id"\n        ],\n        "columnsTo": [\n          "id"\n        ],\n        "onDelete": "cascade",\n        "onUpdate": "no action"\n      }\n    },\n    "compositePrimaryKeys": {},\n    "uniqueConstraints": {},\n    "policies": {\n      "role_owner_scope_select": {\n        "name": "role_owner_scope_select",\n        "as": "PERMISSIVE",\n        "for": "SELECT",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_insert": {\n        "name": "role_owner_scope_insert",\n        "as": "PERMISSIVE",\n        "for": "INSERT",\n        "to": [\n          "public"\n        ],\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_update": {\n        "name": "role_owner_scope_update",\n        "as": "PERMISSIVE",\n        "for": "UPDATE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')",\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_delete": {\n        "name": "role_owner_scope_delete",\n        "as": "PERMISSIVE",\n        "for": "DELETE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      }\n    },\n    "checkConstraints": {\n      "role_template_name_check": {\n        "name": "role_template_name_check",\n        "value": "char_length(\\"role_templates\\".\\"name\\") BETWEEN 1 AND 80"\n      },\n      "role_template_profile_check": {\n        "name": "role_template_profile_check",\n        "value": "jsonb_typeof(\\"role_templates\\".\\"profile\\") = \'object\'"\n      },\n      "role_template_version_check": {\n        "name": "role_template_version_check",\n        "value": "\\"role_templates\\".\\"version\\" > 0"\n      }\n    },\n    "isRLSEnabled": true\n  }\n}\n',
  },
  {
    sha256: "fcd1e3465ab806c626908d633906667171dedc02238d60c36afec70ea17832c2",
    raw: '{\n  "public.employee_role_snapshots": {\n    "name": "employee_role_snapshots",\n    "schema": "",\n    "columns": {\n      "agent_id": {\n        "name": "agent_id",\n        "type": "text",\n        "primaryKey": true,\n        "notNull": true\n      },\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "owner_user_id": {\n        "name": "owner_user_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "profile": {\n        "name": "profile",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "version": {\n        "name": "version",\n        "type": "integer",\n        "primaryKey": false,\n        "notNull": true,\n        "default": 1\n      },\n      "source_template_id": {\n        "name": "source_template_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "source_template_version": {\n        "name": "source_template_version",\n        "type": "integer",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "updated_at": {\n        "name": "updated_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {},\n    "foreignKeys": {\n      "employee_role_snapshots_agent_id_agents_id_fk": {\n        "name": "employee_role_snapshots_agent_id_agents_id_fk",\n        "tableFrom": "employee_role_snapshots",\n        "tableTo": "agents",\n        "columnsFrom": [\n          "agent_id"\n        ],\n        "columnsTo": [\n          "id"\n        ],\n        "onDelete": "cascade",\n        "onUpdate": "no action"\n      },\n      "employee_role_snapshots_owner_user_id_users_id_fk": {\n        "name": "employee_role_snapshots_owner_user_id_users_id_fk",\n        "tableFrom": "employee_role_snapshots",\n        "tableTo": "users",\n        "columnsFrom": [\n          "owner_user_id"\n        ],\n        "columnsTo": [\n          "id"\n        ],\n        "onDelete": "cascade",\n        "onUpdate": "no action"\n      }\n    },\n    "compositePrimaryKeys": {},\n    "uniqueConstraints": {},\n    "policies": {\n      "role_owner_scope_select": {\n        "name": "role_owner_scope_select",\n        "as": "PERMISSIVE",\n        "for": "SELECT",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_insert": {\n        "name": "role_owner_scope_insert",\n        "as": "PERMISSIVE",\n        "for": "INSERT",\n        "to": [\n          "public"\n        ],\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_update": {\n        "name": "role_owner_scope_update",\n        "as": "PERMISSIVE",\n        "for": "UPDATE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')",\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_delete": {\n        "name": "role_owner_scope_delete",\n        "as": "PERMISSIVE",\n        "for": "DELETE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      }\n    },\n    "checkConstraints": {\n      "employee_role_profile_check": {\n        "name": "employee_role_profile_check",\n        "value": "jsonb_typeof(\\"employee_role_snapshots\\".\\"profile\\") = \'object\'"\n      },\n      "employee_role_version_check": {\n        "name": "employee_role_version_check",\n        "value": "\\"employee_role_snapshots\\".\\"version\\" > 0"\n      },\n      "employee_role_source_check": {\n        "name": "employee_role_source_check",\n        "value": "(\\"employee_role_snapshots\\".\\"source_template_id\\" IS NULL) = (\\"employee_role_snapshots\\".\\"source_template_version\\" IS NULL)"\n      }\n    },\n    "isRLSEnabled": true\n  }\n}\n',
  },
  {
    sha256: "2aa9c590b12b2896c5984d440f2e0c38175a4861fbaad935e1dc7569b9362b37",
    raw: '{\n  "public.role_generation_requests": {\n    "name": "role_generation_requests",\n    "schema": "",\n    "columns": {\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "owner_user_id": {\n        "name": "owner_user_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "request_id": {\n        "name": "request_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "fingerprint": {\n        "name": "fingerprint",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "model_ref": {\n        "name": "model_ref",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "state": {\n        "name": "state",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "profile": {\n        "name": "profile",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "error": {\n        "name": "error",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "lease_expires_at": {\n        "name": "lease_expires_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now() + interval \'60 seconds\'"\n      },\n      "dispatch_started_at": {\n        "name": "dispatch_started_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": false\n      },\n      "updated_at": {\n        "name": "updated_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {},\n    "foreignKeys": {\n      "role_generation_requests_owner_user_id_users_id_fk": {\n        "name": "role_generation_requests_owner_user_id_users_id_fk",\n        "tableFrom": "role_generation_requests",\n        "tableTo": "users",\n        "columnsFrom": [\n          "owner_user_id"\n        ],\n        "columnsTo": [\n          "id"\n        ],\n        "onDelete": "cascade",\n        "onUpdate": "no action"\n      }\n    },\n    "compositePrimaryKeys": {\n      "role_generation_requests_tenant_id_owner_user_id_request_id_pk": {\n        "name": "role_generation_requests_tenant_id_owner_user_id_request_id_pk",\n        "columns": [\n          "tenant_id",\n          "owner_user_id",\n          "request_id"\n        ]\n      }\n    },\n    "uniqueConstraints": {},\n    "policies": {\n      "role_owner_scope_select": {\n        "name": "role_owner_scope_select",\n        "as": "PERMISSIVE",\n        "for": "SELECT",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_insert": {\n        "name": "role_owner_scope_insert",\n        "as": "PERMISSIVE",\n        "for": "INSERT",\n        "to": [\n          "public"\n        ],\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_update": {\n        "name": "role_owner_scope_update",\n        "as": "PERMISSIVE",\n        "for": "UPDATE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')",\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_delete": {\n        "name": "role_owner_scope_delete",\n        "as": "PERMISSIVE",\n        "for": "DELETE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      }\n    },\n    "checkConstraints": {\n      "role_generation_state_check": {\n        "name": "role_generation_state_check",\n        "value": "\\"role_generation_requests\\".\\"state\\" IN (\'pending\', \'completed\', \'failed\', \'unknown\')"\n      },\n      "role_generation_profile_check": {\n        "name": "role_generation_profile_check",\n        "value": "(\\"role_generation_requests\\".\\"state\\" = \'completed\') = (\\"role_generation_requests\\".\\"profile\\" IS NOT NULL)"\n      }\n    },\n    "isRLSEnabled": true\n  }\n}\n',
  },
  {
    sha256: "59f40a8f280ef4a3789198c793d72d144df6e2253d44662493983e1ec3b278cb",
    raw: '{\n  "public.role_write_receipts": {\n    "name": "role_write_receipts",\n    "schema": "",\n    "columns": {\n      "tenant_id": {\n        "name": "tenant_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "current_setting(\'app.tenant_id\', true)"\n      },\n      "owner_user_id": {\n        "name": "owner_user_id",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "request_id": {\n        "name": "request_id",\n        "type": "uuid",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "fingerprint": {\n        "name": "fingerprint",\n        "type": "text",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "result": {\n        "name": "result",\n        "type": "jsonb",\n        "primaryKey": false,\n        "notNull": true\n      },\n      "updated_at": {\n        "name": "updated_at",\n        "type": "timestamp with time zone",\n        "primaryKey": false,\n        "notNull": true,\n        "default": "now()"\n      }\n    },\n    "indexes": {},\n    "foreignKeys": {\n      "role_write_receipts_owner_user_id_users_id_fk": {\n        "name": "role_write_receipts_owner_user_id_users_id_fk",\n        "tableFrom": "role_write_receipts",\n        "tableTo": "users",\n        "columnsFrom": [\n          "owner_user_id"\n        ],\n        "columnsTo": [\n          "id"\n        ],\n        "onDelete": "cascade",\n        "onUpdate": "no action"\n      }\n    },\n    "compositePrimaryKeys": {\n      "role_write_receipts_tenant_id_owner_user_id_request_id_pk": {\n        "name": "role_write_receipts_tenant_id_owner_user_id_request_id_pk",\n        "columns": [\n          "tenant_id",\n          "owner_user_id",\n          "request_id"\n        ]\n      }\n    },\n    "uniqueConstraints": {},\n    "policies": {\n      "role_owner_scope_select": {\n        "name": "role_owner_scope_select",\n        "as": "PERMISSIVE",\n        "for": "SELECT",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_insert": {\n        "name": "role_owner_scope_insert",\n        "as": "PERMISSIVE",\n        "for": "INSERT",\n        "to": [\n          "public"\n        ],\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_update": {\n        "name": "role_owner_scope_update",\n        "as": "PERMISSIVE",\n        "for": "UPDATE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')",\n        "withCheck": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      },\n      "role_owner_scope_delete": {\n        "name": "role_owner_scope_delete",\n        "as": "PERMISSIVE",\n        "for": "DELETE",\n        "to": [\n          "public"\n        ],\n        "using": "\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND \\"owner_user_id\\" = \\"tenant_id\\" AND \\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n      }\n    },\n    "checkConstraints": {\n      "role_receipt_result_check": {\n        "name": "role_receipt_result_check",\n        "value": "jsonb_typeof(\\"role_write_receipts\\".\\"result\\") = \'object\'"\n      }\n    },\n    "isRLSEnabled": true\n  }\n}\n',
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
  join(overlay, "sql/0082_recovery_role_foundations.sql"),
  "utf8",
);
const previous = JSON.parse(
  readFileSync(join(overlay, "meta/0081_snapshot.json"), "utf8"),
) as Snapshot;
const next = JSON.parse(
  readFileSync(join(overlay, "meta/0082_snapshot.json"), "utf8"),
) as Snapshot;
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
const tables = [
  roleTemplates,
  employeeRoleSnapshots,
  roleGenerationRequests,
  roleWriteReceipts,
];

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
            ["text", "uuid", "integer", "jsonb", "timestamp"].includes(type),
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
            item.default = /^\d+$/.test(value) ? Number(value) : value;
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
    c.take("UNIQUE");
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
      const value = col.id();
      col.take("ASC");
      col.take("NULLS");
      col.take("LAST");
      col.finish();
      return {
        expression: value,
        isExpression: false,
        asc: true,
        nulls: "last",
      };
    });
    c.finish();
    put(table.indexes, name, {
      name,
      columns,
      isUnique: true,
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
        assert.ok(typeof value === "number" || typeof value === "string");
        item.default = value;
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
function equalTargets(actual: Record<string, Table>): void {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [key, table] of Object.entries(expected))
    assert.deepEqual(normalize(actual[key] as Table), normalize(table), key);
}
function checkSQL(source: string): void {
  const parsed = parseSQL(source);
  equalTargets(parsed.tables);
  assert.deepEqual(
    parsed.forced.sort(),
    Object.values(expected)
      .map((table) => table.name)
      .sort(),
    "explicit FORCE required for all four tables, beyond historical snapshot",
  );
}
function checkSnapshot(snapshot: Snapshot): void {
  assert.equal(snapshot.prevId, previous.id);
  assert.equal(previous.id, "450062e8-5d38-40ea-b753-611cb01bbd84");
  assert.match(
    snapshot.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(snapshot.id, previous.id);
  assert.notEqual(snapshot.id, "0fac1c33-b397-46ee-a332-b0a9b06d126b");
  const restored = structuredClone(snapshot);
  const added: Record<string, Table> = {};
  for (const key of Object.keys(snapshot.tables))
    if (!(key in previous.tables)) {
      const value = snapshot.tables[key];
      assert.ok(value);
      added[key] = value;
      delete restored.tables[key];
    }
  // Snapshot values must be exactly the independently archived contract, not only SQL-equivalent text.
  assert.deepEqual(added, expected);
  restored.id = previous.id;
  restored.prevId = previous.prevId;
  assert.deepEqual(restored, previous);
  assert.equal(Object.keys(snapshot.tables).length, 103);
}
function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink());
    const full = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}
function checkJournal(value: Journal): void {
  const old = JSON.parse(
    readFileSync(join(server, "drizzle/meta/_journal.json"), "utf8"),
  ) as Journal;
  assert.equal(value.version, old.version);
  assert.equal(value.dialect, old.dialect);
  assert.deepEqual(value.entries.slice(0, 81), old.entries);
  // Prefix evidence does not authorize execution of any later suffix.
  assert.ok(value.entries.length >= 83, "complete 0..82 prefix is required");
  assert.deepEqual(
    value.entries[81],
    JSON.parse(
      '{"idx":81,"version":"7","when":1792332786923,"tag":"0081_recovery_subject_and_binding","breakpoints":true}',
    ),
  );
  const last = value.entries[82];
  assert.ok(last);
  assert.equal(last.when, 1792334435193);
  assert.deepEqual(
    { ...last, when: 0 },
    {
      idx: 82,
      version: "7",
      when: 0,
      tag: "0082_recovery_role_foundations",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(last.when) &&
      last.when > 1792332786923 &&
      last.when <= Date.now(),
  );
}

describe("recovery role foundations from verified0121 table capsules", () => {
  test("complete historical capsules retain independently recorded byte identities", () => {
    for (const capsule of capsules)
      expect(createHash("sha256").update(capsule.raw).digest("hex")).toBe(
        capsule.sha256,
      );
    expect(Object.keys(expected)).toHaveLength(4);
  });
  test("SQL parses to the entire target structure and additionally FORCEs all four RLS tables", () =>
    checkSQL(migration));
  test("actual Drizzle metadata agrees with every target column/default/PK/FK/index/check/policy", () => {
    equalTargets(
      Object.fromEntries(
        tables.map((table) => {
          const value = metadata(table);
          return [`public.${value.name}`, value];
        }),
      ),
    );
  });
  test("snapshot adds exactly four complete target tables and preserves the entire99-table predecessor", () =>
    checkSnapshot(next));
  test("journal preserves exact 0..82 stage identities while permitting later entries", () =>
    checkJournal(journal));
  test("approved idx83 append preserves the 0..82 prefix without suffix release authority", () => {
    const stage = structuredClone(journal);
    stage.entries = stage.entries.slice(0, 83);
    expect(() => checkJournal(stage)).not.toThrow();
    const successors = journal.entries.slice(83, 84);
    expect(successors.map((entry) => entry.tag)).toEqual([
      "0083_recovery_task_flow_audit_contract",
    ]);
    stage.entries.push(...successors);
    expect(() => checkJournal(stage)).not.toThrow();
  });
  test("missing prefix, old prefix drift and altered idx82 identity remain refused", () => {
    const missing = structuredClone(journal);
    missing.entries = missing.entries.slice(0, 82);
    expect(() => checkJournal(missing)).toThrow();
    const old = structuredClone(journal);
    const first = old.entries[0];
    assert.ok(first);
    first.tag = "forged";
    expect(() => checkJournal(old)).toThrow();
    for (const mutation of [
      { idx: 81 },
      { tag: "forged" },
      { when: 1792334435194 },
      { version: "8" },
      { breakpoints: false },
    ]) {
      const changed = structuredClone(journal);
      Object.assign(changed.entries[82] ?? {}, mutation);
      expect(() => checkJournal(changed)).toThrow();
    }
  });
  test("all163 original inputs and both approved81 input files retain exact bytes", () => {
    const root = join(server, "drizzle");
    const records = filesUnder(root)
      .sort()
      .map((file) => {
        const b = readFileSync(file);
        return `${relative(root, file)}\0${b.byteLength}\0${createHash("sha256").update(b).digest("hex")}\n`;
      });
    expect(records).toHaveLength(163);
    expect(createHash("sha256").update(records.join("")).digest("hex")).toBe(
      "9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d",
    );
    expect(
      createHash("sha256")
        .update(readFileSync(join(overlay, "meta/0081_snapshot.json")))
        .digest("hex"),
    ).toBe("ef4b170efbc98717bce811b27d3f5d35c274146f5faec50bc787028acbfaa24c");
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            join(overlay, "sql/0081_recovery_subject_and_binding.sql"),
          ),
        )
        .digest("hex"),
    ).toBe("0769123048b40af0f80aa8a3c843f67ab19fac5c44ccb9243bbc6819d689bb40");
  });
  test("SQL rejects missing table, extra column, wrong check/FK/unique/owner policy and absent FORCE", () => {
    const mutations = [
      migration.replace(
        /CREATE TABLE "public"\."role_templates"[\s\S]*?\n\);/,
        "",
      ),
      migration.replace(
        '"profile" jsonb NOT NULL,',
        '"extra" text, "profile" jsonb NOT NULL,',
      ),
      migration.replace(" BETWEEN 1 AND 80", " BETWEEN 1 AND 800"),
      migration.replace(
        'REFERENCES "public"."users"',
        'REFERENCES "public"."agents"',
      ),
      migration.replace("CREATE UNIQUE INDEX", "CREATE INDEX"),
      migration.replaceAll(
        '"owner_user_id" = "tenant_id"',
        "\"owner_user_id\" = 'system'",
      ),
      migration.replace(
        "FORCE ROW LEVEL SECURITY",
        "ENABLE ROW LEVEL SECURITY",
      ),
      migration + "GRANT ALL ON ALL TABLES IN SCHEMA public TO public;",
      migration + 'UPDATE "public"."users" SET "id" = \'guessed\';',
    ];
    for (const mutation of mutations)
      expect(() => checkSQL(mutation)).toThrow();
  });
  test("snapshot tampering cannot hide missing/extra columns, checks, constraints or owner policies", () => {
    const mutations: ((snapshot: Snapshot) => void)[] = [
      (s) => {
        delete s.tables["public.role_templates"];
      },
      (s) => {
        const t = s.tables["public.role_templates"];
        assert.ok(t);
        t.columns.extra = {
          name: "extra",
          type: "text",
          primaryKey: false,
          notNull: false,
        };
      },
      (s) => {
        const t = s.tables["public.role_templates"];
        assert.ok(t);
        t.checkConstraints = {};
      },
      (s) => {
        const t = s.tables["public.employee_role_snapshots"];
        assert.ok(t);
        t.foreignKeys = {};
      },
      (s) => {
        const t = s.tables["public.role_templates"];
        assert.ok(t);
        t.indexes = {};
      },
      (s) => {
        const t = s.tables["public.role_templates"];
        assert.ok(t);
        t.policies = {};
      },
      (s) => {
        const t = s.tables["public.audit_events"];
        assert.ok(t);
        delete t.columns.subject_tenant_id;
      },
      (s) => {
        s.prevId = "wrong-lineage";
      },
    ];
    for (const mutate of mutations) {
      const snapshot = structuredClone(next);
      mutate(snapshot);
      expect(() => checkSnapshot(snapshot)).toThrow();
    }
    const old = structuredClone(journal);
    const entry = old.entries[81];
    assert.ok(entry);
    entry.tag = "historical81";
    expect(() => checkJournal(old)).toThrow();
  });
  test("custom JSONB parameters retain objects and nullability without double serialization", () => {
    const value = {
      unknownFutureField: ["x", null],
      nested: { owner: "fixture" },
    };
    for (const column of [
      roleTemplates.profile,
      employeeRoleSnapshots.profile,
      roleGenerationRequests.profile,
      roleWriteReceipts.result,
    ])
      expect(column.mapToDriverValue(value)).toBe(value);
    const optional: typeof roleGenerationRequests.$inferSelect.profile = null;
    expect(optional).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
  flowSourceInlineInvocations,
  flowSourceOriginalActivations,
  flowSourceOriginalProjectionObservations,
} from "../src/db/schema/flow-source-original-records";

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

// Independent complete0121 capsules from583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f. Not generated from schema or new migration.
const capsules = [
  {
    raw: '{\n  "name": "flow_source_inline_invocations",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "parent_invocation_id": {\n      "name": "parent_invocation_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "identity": {\n      "name": "identity",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "args": {\n      "name": "args",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "dispatch_key": {\n      "name": "dispatch_key",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "state": {\n      "name": "state",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "\'reserved\'"\n    },\n    "receipt": {\n      "name": "receipt",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "late_receipt": {\n      "name": "late_receipt",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    },\n    "updated_at": {\n      "name": "updated_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_inline_dispatch_idx": {\n      "name": "flow_source_inline_dispatch_idx",\n      "columns": [\n        {\n          "expression": "dispatch_key",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_source_inline_ordinal_idx": {\n      "name": "flow_source_inline_ordinal_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "run_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "parent_invocation_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "(\\"identity\\"->>\'childOrdinal\')",\n          "asc": true,\n          "isExpression": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_inline_parent_owner_fk": {\n      "name": "flow_source_inline_parent_owner_fk",\n      "tableFrom": "flow_source_inline_invocations",\n      "tableTo": "flow_source_invocations",\n      "columnsFrom": [\n        "tenant_id",\n        "run_id",\n        "parent_invocation_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "run_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_inline_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_inline_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r JOIN public.flow_source_invocations p ON p.run_id = r.id AND p.tenant_id = r.tenant_id WHERE r.id = \\"flow_source_inline_invocations\\".\\"run_id\\" AND r.tenant_id = current_setting(\'app.tenant_id\', true) AND r.admission_open AND r.state = \'running\' AND r.owner_epoch = (\\"flow_source_inline_invocations\\".\\"identity\\"->>\'ownerEpoch\')::integer AND r.revision = (\\"flow_source_inline_invocations\\".\\"identity\\"->>\'runRevision\')::integer AND r.version_id::text = \\"flow_source_inline_invocations\\".\\"identity\\"->>\'versionId\' AND r.flow_id::text = \\"flow_source_inline_invocations\\".\\"identity\\"->>\'flowId\' AND r.task_id::text = \\"flow_source_inline_invocations\\".\\"identity\\"->>\'taskId\' AND r.agent_id = \\"flow_source_inline_invocations\\".\\"identity\\"->>\'agentId\' AND r.thread_id = \\"flow_source_inline_invocations\\".\\"identity\\"->>\'threadId\' AND r.source_digest = \\"flow_source_inline_invocations\\".\\"identity\\"->>\'sourceDigest\' AND p.id = \\"flow_source_inline_invocations\\".\\"parent_invocation_id\\" AND p.state = \'dispatched\' AND p.identity->>\'primitive\' = \'action\')"\n    },\n    "tenant_scope_update": {\n      "name": "tenant_scope_update",\n      "as": "PERMISSIVE",\n      "for": "UPDATE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_inline_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)",\n      "withCheck": "\\"flow_source_inline_invocations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_inline_state_check": {\n      "name": "flow_source_inline_state_check",\n      "value": "\\"flow_source_inline_invocations\\".\\"state\\" IN (\'reserved\',\'not-dispatched\',\'dispatched\',\'completed\',\'failed-known\',\'unknown\')"\n    },\n    "flow_source_inline_identity_check": {\n      "name": "flow_source_inline_identity_check",\n      "value": "COALESCE(\\"flow_source_inline_invocations\\".\\"identity\\"->>\'tenantId\' = \\"flow_source_inline_invocations\\".\\"tenant_id\\" AND \\"flow_source_inline_invocations\\".\\"identity\\"->>\'runId\' = \\"flow_source_inline_invocations\\".\\"run_id\\"::text AND \\"flow_source_inline_invocations\\".\\"identity\\"->>\'parentInvocationId\' = \\"flow_source_inline_invocations\\".\\"parent_invocation_id\\"::text AND \\"flow_source_inline_invocations\\".\\"identity\\"->>\'invocationId\' = \\"flow_source_inline_invocations\\".\\"id\\"::text AND \\"flow_source_inline_invocations\\".\\"identity\\"->>\'childOrdinal\' ~ \'^[1-9][0-9]*$\' AND \\"flow_source_inline_invocations\\".\\"identity\\"->>\'ownerEpoch\' ~ \'^[1-9][0-9]*$\' AND \\"flow_source_inline_invocations\\".\\"identity\\"->>\'runRevision\' ~ \'^[1-9][0-9]*$\', false)"\n    },\n    "flow_source_inline_receipt_check": {\n      "name": "flow_source_inline_receipt_check",\n      "value": "COALESCE((\\"flow_source_inline_invocations\\".\\"receipt\\" IS NULL OR (\\"flow_source_inline_invocations\\".\\"receipt\\"->\'identity\' = \\"flow_source_inline_invocations\\".\\"identity\\" AND \\"flow_source_inline_invocations\\".\\"receipt\\"->>\'dispatchKey\' = \\"flow_source_inline_invocations\\".\\"dispatch_key\\"::text AND \\"flow_source_inline_invocations\\".\\"receipt\\"->>\'authority\' = \'governed-inline-host\' AND \\"flow_source_inline_invocations\\".\\"receipt\\"->>\'state\' = \\"flow_source_inline_invocations\\".\\"state\\")) AND (\\"flow_source_inline_invocations\\".\\"late_receipt\\" IS NULL OR (\\"flow_source_inline_invocations\\".\\"state\\" = \'unknown\' AND \\"flow_source_inline_invocations\\".\\"late_receipt\\"->\'identity\' = \\"flow_source_inline_invocations\\".\\"identity\\" AND \\"flow_source_inline_invocations\\".\\"late_receipt\\"->>\'dispatchKey\' = \\"flow_source_inline_invocations\\".\\"dispatch_key\\"::text AND \\"flow_source_inline_invocations\\".\\"late_receipt\\"->>\'authority\' = \'governed-inline-host\')), false)"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "443961ec2e1d9f2226855fc2095064d3ed50d271b70712ac5e7a14e2b08fa8df",
  },
  {
    raw: '{\n  "name": "flow_source_original_activations",\n  "schema": "",\n  "columns": {\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "operation_id": {\n      "name": "operation_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "input_text": {\n      "name": "input_text",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "flow_id": {\n      "name": "flow_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "task_id": {\n      "name": "task_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "thread_id": {\n      "name": "thread_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "agent_id": {\n      "name": "agent_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "version_id": {\n      "name": "version_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "source_digest": {\n      "name": "source_digest",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "definition_revision": {\n      "name": "definition_revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "handle_id": {\n      "name": "handle_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "execution_epoch": {\n      "name": "execution_epoch",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "activation_owner_epoch": {\n      "name": "activation_owner_epoch",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "activation_run_revision": {\n      "name": "activation_run_revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "receipt_text": {\n      "name": "receipt_text",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "receipt_digest": {\n      "name": "receipt_digest",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "owner_record_ref": {\n      "name": "owner_record_ref",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_original_activation_operation_idx": {\n      "name": "flow_source_original_activation_operation_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "operation_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_original_activation_run_fk": {\n      "name": "flow_source_original_activation_run_fk",\n      "tableFrom": "flow_source_original_activations",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "tenant_id",\n        "run_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_original_activation_origin_fk": {\n      "name": "flow_source_original_activation_origin_fk",\n      "tableFrom": "flow_source_original_activations",\n      "tableTo": "flow_source_public_operations",\n      "columnsFrom": [\n        "tenant_id",\n        "operation_id",\n        "fingerprint"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "operation_id",\n        "fingerprint"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {\n    "flow_source_original_activation_pk": {\n      "name": "flow_source_original_activation_pk",\n      "columns": [\n        "tenant_id",\n        "run_id"\n      ]\n    }\n  },\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_original_activations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_original_activations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.tenant_id = current_setting(\'app.tenant_id\', true) AND r.id = \\"flow_source_original_activations\\".\\"run_id\\" AND r.flow_id = \\"flow_source_original_activations\\".\\"flow_id\\" AND r.task_id = \\"flow_source_original_activations\\".\\"task_id\\" AND r.thread_id = \\"flow_source_original_activations\\".\\"thread_id\\" AND r.agent_id = \\"flow_source_original_activations\\".\\"agent_id\\" AND r.version_id = \\"flow_source_original_activations\\".\\"version_id\\" AND r.source_digest = \\"flow_source_original_activations\\".\\"source_digest\\" AND r.definition_revision = \\"flow_source_original_activations\\".\\"definition_revision\\" AND r.public_operation_id = \\"flow_source_original_activations\\".\\"operation_id\\" AND r.public_operation_fingerprint = \\"flow_source_original_activations\\".\\"fingerprint\\" AND r.handle_id = \\"flow_source_original_activations\\".\\"handle_id\\" AND r.state = \'running\' AND r.admission_open AND r.execution_epoch = \\"flow_source_original_activations\\".\\"execution_epoch\\" AND r.owner_epoch = \\"flow_source_original_activations\\".\\"activation_owner_epoch\\" AND r.revision = \\"flow_source_original_activations\\".\\"activation_run_revision\\")"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_original_activation_epoch_check": {\n      "name": "flow_source_original_activation_epoch_check",\n      "value": "\\"flow_source_original_activations\\".\\"execution_epoch\\" > 0 AND \\"flow_source_original_activations\\".\\"activation_owner_epoch\\" = \\"flow_source_original_activations\\".\\"execution_epoch\\" AND \\"flow_source_original_activations\\".\\"activation_run_revision\\" > 0 AND \\"flow_source_original_activations\\".\\"definition_revision\\" >= 0"\n    },\n    "flow_source_original_activation_text_check": {\n      "name": "flow_source_original_activation_text_check",\n      "value": "\\"flow_source_original_activations\\".\\"receipt_digest\\" = encode(sha256(convert_to(\\"flow_source_original_activations\\".\\"receipt_text\\", \'UTF8\')), \'hex\') AND \\"flow_source_original_activations\\".\\"fingerprint\\" = encode(sha256(convert_to(\\"flow_source_original_activations\\".\\"input_text\\", \'UTF8\')), \'hex\')"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "ec561c70989b95105cc91ac36880daf475262ae4e6e742f2b684a5c2ad69d720",
  },
  {
    raw: '{\n  "name": "flow_source_original_projection_observations",\n  "schema": "",\n  "columns": {\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "state": {\n      "name": "state",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "observation_text": {\n      "name": "observation_text",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {},\n  "foreignKeys": {\n    "flow_source_original_projection_run_fk": {\n      "name": "flow_source_original_projection_run_fk",\n      "tableFrom": "flow_source_original_projection_observations",\n      "tableTo": "flow_source_runs",\n      "columnsFrom": [\n        "tenant_id",\n        "run_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {\n    "flow_source_original_projection_pk": {\n      "name": "flow_source_original_projection_pk",\n      "columns": [\n        "tenant_id",\n        "run_id",\n        "state"\n      ]\n    }\n  },\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_original_projection_observations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_original_projection_observations\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND EXISTS (SELECT 1 FROM public.flow_source_runs r WHERE r.tenant_id = current_setting(\'app.tenant_id\', true) AND r.id = \\"flow_source_original_projection_observations\\".\\"run_id\\")"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_original_projection_state_check": {\n      "name": "flow_source_original_projection_state_check",\n      "value": "\\"flow_source_original_projection_observations\\".\\"state\\" IN (\'projected\', \'unknown\')"\n    },\n    "flow_source_original_projection_digest_check": {\n      "name": "flow_source_original_projection_digest_check",\n      "value": "\\"flow_source_original_projection_observations\\".\\"fingerprint\\" = encode(sha256(convert_to(\\"flow_source_original_projection_observations\\".\\"observation_text\\", \'UTF8\')), \'hex\')"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "0e5084d3919e0329c702e624cee5890ae58a71f90897a6dc49670771d61930a4",
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
  join(overlay, "sql/0087_recovery_flow_source_original_records.sql"),
  "utf8",
);
const previous = JSON.parse(
  readFileSync(join(overlay, "meta/0086_snapshot.json"), "utf8"),
) as Snapshot;
const next = JSON.parse(
  readFileSync(join(overlay, "meta/0087_snapshot.json"), "utf8"),
) as Snapshot;
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
const tables = [
  flowSourceInlineInvocations,
  flowSourceOriginalActivations,
  flowSourceOriginalProjectionObservations,
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
  assert.equal(previous.id, "eb07617b-d7fc-4418-91c0-cb98dab42ad7");
  assert.equal(s.prevId, previous.id);
  assert.match(
    s.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  for (const id of [
    previous.id,
    "879bfd47-bf7f-47df-84c9-5f36a15529c0",
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
  assert.equal(Object.keys(s.tables).length, 115);
}
function checkJournal(j: Journal): void {
  const historical = JSON.parse(
    readFileSync(join(server, "drizzle/meta/_journal.json"), "utf8"),
  ) as Journal;
  assert.equal(j.version, historical.version);
  assert.equal(j.dialect, historical.dialect);
  assert.ok(
    j.entries.length >= 88,
    "complete stage prefix only; does not authorize unknown suffix execution",
  );
  assert.deepEqual(j.entries.slice(0, 81), historical.entries);
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(j.entries.slice(0, 87)))
      .digest("hex"),
    "c1510744dce8f6a1961f9ad85397f6c0fd792a99452b6e4306c47b7da212e8c3",
  );
  const entry = j.entries[87];
  assert.ok(entry);
  assert.deepEqual(
    { ...entry, when: 0 },
    {
      idx: 87,
      version: "7",
      when: 0,
      tag: "0087_recovery_flow_source_original_records",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(entry.when) &&
      entry.when > 1792344488506 &&
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
function rejectSQL(old: string, replacement: string): void {
  assert.ok(migration.includes(old), "negative fixture must alter actual SQL");
  const mutated = migration.replace(old, replacement);
  assert.notEqual(mutated, migration);
  expect(() => checkSQL(mutated)).toThrow();
}
describe("recovery inline invocation original activation and projection structure", () => {
  test("independent complete capsules keep exact delivered SHA identities", () => {
    for (const c of capsules)
      expect(createHash("sha256").update(c.raw).digest("hex")).toBe(c.sha256);
  });
  test("all20 statements fully parse and equal independent complete table objects", () =>
    checkSQL(migration));
  test("actual Drizzle metadata equals every column key index expression check policy and RLS", () =>
    equalTargets(actualMetadata()));
  test("inverse three tables preserves all112 old tables and every other top-level value", () =>
    checkSnapshot(next));
  test("journal0..86 exact and fresh87 supports later prefix without suffix execution authority", () => {
    checkJournal(journal);
    const j = structuredClone(journal);
    j.entries.push({
      idx: 88,
      tag: "unapproved-positive-prefix-fixture",
      version: "7",
      when: Date.now(),
      breakpoints: true,
    });
    checkJournal(j);
    expect(j.entries.length).toBe(journal.entries.length + 1);
  });
  test("original163 and approved81..86 exact SQL/snapshot bytes unchanged", () => {
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
        path: "recovery/recovery-20261018-v1/meta/0086_snapshot.json",
        bytes: 369468,
        sha256:
          "6beec7f83f05e43d212c44f990ba625c4714acb45fdac6b4082df3085e89541a",
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
    ]) {
      const data = readFileSync(join(server, input.path));
      expect(data.length).toBe(input.bytes);
      expect(createHash("sha256").update(data).digest("hex")).toBe(
        input.sha256,
      );
    }
  });
  test("no id default nullable receipts and custom JSON object driver identity retained", () => {
    expect(flowSourceInlineInvocations.id.hasDefault).toBe(false);
    expect(flowSourceInlineInvocations.receipt.notNull).toBe(false);
    expect(flowSourceInlineInvocations.lateReceipt.notNull).toBe(false);
    const value = { unknown: [null, 1], identity: { childOrdinal: 1 } };
    for (const column of [
      flowSourceInlineInvocations.args,
      flowSourceInlineInvocations.identity,
      flowSourceInlineInvocations.receipt,
      flowSourceInlineInvocations.lateReceipt,
    ])
      expect(column.mapToDriverValue(value)).toBe(value);
    expect(
      getTableConfig(flowSourceOriginalProjectionObservations).indexes,
    ).toHaveLength(0);
  });
  test("SQL rejects wrong expression global unique sorting PK FK extra column and nullability", () => {
    for (const [from, to] of [
      ["(\"identity\"->>'childOrdinal')", '"identity"'],
      ["(\"identity\"->>'childOrdinal')", "\"identity\"->>'childOrdinal'"],
      ["(\"identity\"->>'childOrdinal')", "(\"identity\"->'childOrdinal')"],
      [
        '("dispatch_key" ASC NULLS LAST)',
        '("tenant_id" ASC NULLS LAST, "dispatch_key" ASC NULLS LAST)',
      ],
      ["CREATE UNIQUE INDEX", "CREATE INDEX"],
      ["NULLS LAST", "NULLS FIRST"],
      [" ASC NULLS LAST", " DESC NULLS LAST"],
      ["USING btree", "USING hash"],
      ['PRIMARY KEY ("tenant_id", "run_id")', 'PRIMARY KEY ("run_id")'],
      [
        'PRIMARY KEY ("tenant_id", "run_id", "state")',
        'PRIMARY KEY ("tenant_id", "run_id")',
      ],
      ["ON DELETE NO ACTION", "ON DELETE CASCADE"],
      [
        'FOREIGN KEY ("tenant_id", "run_id", "parent_invocation_id")',
        'FOREIGN KEY ("parent_invocation_id")',
      ],
      [
        '"id" uuid NOT NULL PRIMARY KEY',
        '"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY',
      ],
      ['"receipt" jsonb,', '"receipt" jsonb NOT NULL,'],
      ['"late_receipt" jsonb,', '"late_receipt" jsonb NOT NULL,'],
      [
        '"fingerprint" text NOT NULL,',
        '"fingerprint" text NOT NULL, "invented" text,',
      ],
    ])
      rejectSQL(from, to);
  });
  test("SQL rejects COALESCE receipt unknown authority identity ordinal UTF8 digest and revision drift", () => {
    for (const [from, to] of [
      [", false)", ", true)"],
      ["'governed-inline-host'", "'caller'"],
      ["\"state\" = 'unknown'", "\"state\" = 'completed'"],
      ["'^[1-9][0-9]*$'", "'^[0-9]*$'"],
      [
        '"flow_source_inline_invocations"."identity"->>\'parentInvocationId\' = "flow_source_inline_invocations"."parent_invocation_id"::text',
        "true",
      ],
      ['"definition_revision" >= 0', '"definition_revision" > 0'],
      ["'UTF8'", "'LATIN1'"],
      ["sha256(", "md5("],
      ["'hex'", "'base64'"],
      ["'projected', 'unknown'", "'projected', 'unknown', 'completed'"],
    ])
      rejectSQL(from, to);
  });
  test("SQL rejects parent/run admission policy weakening and all unassigned statements", () => {
    for (const [from, to] of [
      ["p.state = 'dispatched'", "p.state = 'reserved'"],
      [
        "p.identity->>'primitive' = 'action'",
        "p.identity->>'primitive' = 'worker'",
      ],
      ["AND r.admission_open", "AND true"],
      ["r.state = 'running'", "r.state = 'stopped'"],
      [
        'r.owner_epoch = ("flow_source_inline_invocations"."identity"->>\'ownerEpoch\')::integer',
        "true",
      ],
      [
        'r.revision = ("flow_source_inline_invocations"."identity"->>\'runRevision\')::integer',
        "true",
      ],
      [
        'r.source_digest = "flow_source_inline_invocations"."identity"->>\'sourceDigest\'',
        "true",
      ],
      [
        'r.version_id::text = "flow_source_inline_invocations"."identity"->>\'versionId\'',
        "true",
      ],
      [
        'r.flow_id::text = "flow_source_inline_invocations"."identity"->>\'flowId\'',
        "true",
      ],
      [
        'r.task_id::text = "flow_source_inline_invocations"."identity"->>\'taskId\'',
        "true",
      ],
      [
        'r.agent_id = "flow_source_inline_invocations"."identity"->>\'agentId\'',
        "true",
      ],
      [
        'r.thread_id = "flow_source_inline_invocations"."identity"->>\'threadId\'',
        "true",
      ],
      [
        'r.public_operation_id = "flow_source_original_activations"."operation_id"',
        "true",
      ],
      [
        'r.public_operation_fingerprint = "flow_source_original_activations"."fingerprint"',
        "true",
      ],
      ['r.handle_id = "flow_source_original_activations"."handle_id"', "true"],
      [
        'r.execution_epoch = "flow_source_original_activations"."execution_epoch"',
        "true",
      ],
      [
        'r.owner_epoch = "flow_source_original_activations"."activation_owner_epoch"',
        "true",
      ],
      [
        'r.revision = "flow_source_original_activations"."activation_run_revision"',
        "true",
      ],
      ["ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY"],
    ])
      rejectSQL(from, to);
    for (const extra of [
      'UPDATE "public"."flow_source_runs" SET "admission_open" = true;',
      'GRANT ALL ON "public"."flow_source_inline_invocations" TO public;',
      "SELECT 1;",
      'CREATE INDEX "extra" ON "public"."flow_source_original_projection_observations" USING btree ("run_id" ASC NULLS LAST);',
    ])
      expect(() => checkSQL(migration + extra)).toThrow();
    expect(() => checkSQL(migration + migration)).toThrow();
  });
  test("actual metadata negative controls reject expression flag key check policy and RLS tampering", () => {
    const mutate: ((t: Table) => void)[] = [
      (t) => {
        const c = t.indexes.flow_source_inline_ordinal_idx?.columns[3];
        assert.ok(c);
        c.isExpression = false;
      },
      (t) => {
        const c = t.indexes.flow_source_inline_ordinal_idx?.columns[3];
        assert.ok(c);
        c.expression = c.expression.replace("->>", "->");
      },
      (t) => {
        const c = t.indexes.flow_source_inline_ordinal_idx?.columns[3];
        assert.ok(c);
        c.expression = c.expression.slice(1, -1);
      },
      (t) => {
        const c = t.indexes.flow_source_inline_ordinal_idx?.columns[3];
        assert.ok(c);
        c.asc = false;
      },
      (t) => {
        const i = t.indexes.flow_source_inline_dispatch_idx;
        assert.ok(i);
        i.columns.unshift({
          expression: "tenant_id",
          isExpression: false,
          asc: true,
          nulls: "last",
        });
      },
      (t) => {
        t.foreignKeys = {};
      },
      (t) => {
        t.checkConstraints = {};
      },
      (t) => {
        t.policies = {};
      },
      (t) => {
        t.isRLSEnabled = false;
      },
    ];
    for (const change of mutate) {
      const actual = actualMetadata();
      const t = actual["public.flow_source_inline_invocations"];
      assert.ok(t);
      change(t);
      expect(() => equalTargets(actual)).toThrow();
    }
  });
  test("snapshot journal reject missing old/new table/key drift prefix tamper stale time and reused identity", () => {
    const mutate: ((s: Snapshot) => void)[] = [
      (s) => {
        delete s.tables["public.flow_source_original_activations"];
      },
      (s) => {
        s.prevId = "wrong";
      },
      (s) => {
        s.id = previous.id;
      },
      (s) => {
        const t = s.tables["public.flow_source_original_activations"];
        assert.ok(t);
        t.compositePrimaryKeys = {};
      },
      (s) => {
        const t =
          s.tables["public.flow_source_original_projection_observations"];
        assert.ok(t);
        t.checkConstraints = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_inline_invocations"];
        assert.ok(t);
        t.policies = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_runs"];
        assert.ok(t);
        t.indexes = {};
      },
    ];
    for (const change of mutate) {
      const s = structuredClone(next);
      change(s);
      expect(() => checkSnapshot(s)).toThrow();
    }
    for (const idx of [0, 81, 82, 83, 84, 85, 86, 87]) {
      const j = structuredClone(journal);
      const entry = j.entries[idx];
      assert.ok(entry);
      entry.tag = "forged";
      expect(() => checkJournal(j)).toThrow();
    }
    const j = structuredClone(journal);
    const entry = j.entries[87];
    assert.ok(entry);
    entry.when = 1792344488506;
    expect(() => checkJournal(j)).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
  flowSourceCandidates,
  flowSourceResourceSnapshots,
  flowSourceRuns,
} from "../src/db/schema/flow-source-run-records";

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

// Independently delivered complete0121 capsules, not regenerated from this implementation.
// Whole0121: 583049B SHA c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules = [
  {
    raw: '{\n  "name": "flow_source_candidates",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true,\n      "default": "gen_random_uuid()"\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "flow_id": {\n      "name": "flow_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "operation_id": {\n      "name": "operation_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "generation_fingerprint": {\n      "name": "generation_fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "base": {\n      "name": "base",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "status": {\n      "name": "status",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "raw_source": {\n      "name": "raw_source",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "source_digest": {\n      "name": "source_digest",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "source_bytes": {\n      "name": "source_bytes",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "compiler": {\n      "name": "compiler",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "artifact": {\n      "name": "artifact",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "diagnostics": {\n      "name": "diagnostics",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_candidates_operation_idx": {\n      "name": "flow_source_candidates_operation_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "operation_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_source_candidates_flow_idx": {\n      "name": "flow_source_candidates_flow_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "flow_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": false,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_candidates_flow_id_waker_flows_id_fk": {\n      "name": "flow_source_candidates_flow_id_waker_flows_id_fk",\n      "tableFrom": "flow_source_candidates",\n      "tableTo": "waker_flows",\n      "columnsFrom": [\n        "flow_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_candidates_generation_owner_fk": {\n      "name": "flow_source_candidates_generation_owner_fk",\n      "tableFrom": "flow_source_candidates",\n      "tableTo": "flow_source_public_operations",\n      "columnsFrom": [\n        "tenant_id",\n        "operation_id",\n        "generation_fingerprint"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "operation_id",\n        "fingerprint"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_candidates\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_candidates\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND EXISTS (SELECT 1 FROM public.waker_flows f WHERE f.id = \\"flow_source_candidates\\".\\"flow_id\\" AND f.tenant_id = current_setting(\'app.tenant_id\', true))"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_candidates_generation_fingerprint_check": {\n      "name": "flow_source_candidates_generation_fingerprint_check",\n      "value": "\\"flow_source_candidates\\".\\"generation_fingerprint\\" IS NULL OR \\"flow_source_candidates\\".\\"generation_fingerprint\\" ~ \'^[a-f0-9]{64}$\'"\n    },\n    "flow_source_candidates_bytes_check": {\n      "name": "flow_source_candidates_bytes_check",\n      "value": "\\"flow_source_candidates\\".\\"source_bytes\\" = octet_length(\\"flow_source_candidates\\".\\"raw_source\\") AND \\"flow_source_candidates\\".\\"source_bytes\\" BETWEEN 1 AND 102400"\n    },\n    "flow_source_candidates_digest_check": {\n      "name": "flow_source_candidates_digest_check",\n      "value": "\\"flow_source_candidates\\".\\"source_digest\\" = encode(sha256(convert_to(\\"flow_source_candidates\\".\\"raw_source\\", \'UTF8\')), \'hex\')"\n    },\n    "flow_source_candidates_status_check": {\n      "name": "flow_source_candidates_status_check",\n      "value": "COALESCE((\\"flow_source_candidates\\".\\"status\\" = \'invalid\' AND \\"flow_source_candidates\\".\\"artifact\\" IS NULL) OR (\\"flow_source_candidates\\".\\"status\\" = \'prepared\' AND \\"flow_source_candidates\\".\\"artifact\\" IS NOT NULL AND jsonb_typeof(\\"flow_source_candidates\\".\\"artifact\\") = \'object\' AND \\"flow_source_candidates\\".\\"artifact\\"->\'runtimeReady\' = \'false\'::jsonb AND \\"flow_source_candidates\\".\\"artifact\\"->\'source\'->>\'sha256\' = \\"flow_source_candidates\\".\\"source_digest\\" AND \\"flow_source_candidates\\".\\"artifact\\"->\'source\'->>\'codec\' = \'utf8-raw-v1\' AND \\"flow_source_candidates\\".\\"artifact\\"->\'source\'->\'bytes\' = to_jsonb(\\"flow_source_candidates\\".\\"source_bytes\\") AND \\"flow_source_candidates\\".\\"artifact\\"->\'compiler\' = \\"flow_source_candidates\\".\\"compiler\\"), false)"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "d6490d474787bf7d744be415d85d84343c216300e2bfd3c3b570a1a25455143f",
  },
  {
    raw: '{\n  "name": "flow_source_resource_snapshots",\n  "schema": "",\n  "columns": {\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "run_id": {\n      "name": "run_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "task_id": {\n      "name": "task_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "operation_id": {\n      "name": "operation_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "fingerprint": {\n      "name": "fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "snapshot_text": {\n      "name": "snapshot_text",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "snapshot_digest": {\n      "name": "snapshot_digest",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {},\n  "foreignKeys": {\n    "flow_source_resource_snapshots_task_id_tasks_id_fk": {\n      "name": "flow_source_resource_snapshots_task_id_tasks_id_fk",\n      "tableFrom": "flow_source_resource_snapshots",\n      "tableTo": "tasks",\n      "columnsFrom": [\n        "task_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "source_resource_snapshot_original_start_fk": {\n      "name": "source_resource_snapshot_original_start_fk",\n      "tableFrom": "flow_source_resource_snapshots",\n      "tableTo": "flow_source_public_operations",\n      "columnsFrom": [\n        "tenant_id",\n        "operation_id",\n        "fingerprint"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "operation_id",\n        "fingerprint"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {\n    "flow_source_resource_snapshots_pkey": {\n      "name": "flow_source_resource_snapshots_pkey",\n      "columns": [\n        "tenant_id",\n        "run_id"\n      ]\n    }\n  },\n  "uniqueConstraints": {\n    "source_resource_snapshot_owner_operation_key": {\n      "name": "source_resource_snapshot_owner_operation_key",\n      "nullsNotDistinct": false,\n      "columns": [\n        "tenant_id",\n        "operation_id"\n      ]\n    }\n  },\n  "policies": {\n    "source_resource_select": {\n      "name": "source_resource_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_resource_snapshots\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "source_resource_insert": {\n      "name": "source_resource_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_resource_snapshots\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)\\n        AND EXISTS (SELECT 1 FROM public.tasks task WHERE task.id = \\"flow_source_resource_snapshots\\".\\"task_id\\"\\n          AND task.tenant_id = \\"flow_source_resource_snapshots\\".\\"tenant_id\\" AND task.run_ref = \\"flow_source_resource_snapshots\\".\\"run_id\\"::text AND task.status = \'running\')\\n        AND EXISTS (SELECT 1 FROM public.flow_source_public_operations op\\n          WHERE op.tenant_id = \\"flow_source_resource_snapshots\\".\\"tenant_id\\" AND op.operation_id = \\"flow_source_resource_snapshots\\".\\"operation_id\\"\\n          AND op.fingerprint = \\"flow_source_resource_snapshots\\".\\"fingerprint\\" AND op.kind = \'start\' AND op.state = \'dispatched\')"\n    }\n  },\n  "checkConstraints": {\n    "source_resource_snapshot_tenant_check": {\n      "name": "source_resource_snapshot_tenant_check",\n      "value": "\\"flow_source_resource_snapshots\\".\\"tenant_id\\" NOT IN (\'system\', \'platform\')"\n    },\n    "source_resource_snapshot_text_bytes_check": {\n      "name": "source_resource_snapshot_text_bytes_check",\n      "value": "octet_length(\\"flow_source_resource_snapshots\\".\\"snapshot_text\\") BETWEEN 1 AND 65536"\n    },\n    "source_resource_snapshot_digest_check": {\n      "name": "source_resource_snapshot_digest_check",\n      "value": "\\"flow_source_resource_snapshots\\".\\"snapshot_digest\\" = encode(sha256(convert_to(\\"flow_source_resource_snapshots\\".\\"snapshot_text\\", \'UTF8\')), \'hex\')"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "0904ec596bdc39f983d74c58d0b9d5ea726f2b183fb2565b0179774d79771349",
  },
  {
    raw: '{\n  "name": "flow_source_runs",\n  "schema": "",\n  "columns": {\n    "id": {\n      "name": "id",\n      "type": "uuid",\n      "primaryKey": true,\n      "notNull": true\n    },\n    "tenant_id": {\n      "name": "tenant_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "current_setting(\'app.tenant_id\', true)"\n    },\n    "flow_id": {\n      "name": "flow_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "version_id": {\n      "name": "version_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "task_id": {\n      "name": "task_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "agent_id": {\n      "name": "agent_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "thread_id": {\n      "name": "thread_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "source_digest": {\n      "name": "source_digest",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "definition_revision": {\n      "name": "definition_revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "public_operation_id": {\n      "name": "public_operation_id",\n      "type": "uuid",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "public_operation_fingerprint": {\n      "name": "public_operation_fingerprint",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "state": {\n      "name": "state",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "\'prepared\'"\n    },\n    "revision": {\n      "name": "revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true,\n      "default": 1\n    },\n    "view_revision": {\n      "name": "view_revision",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true,\n      "default": 1\n    },\n    "execution_epoch": {\n      "name": "execution_epoch",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true,\n      "default": 1\n    },\n    "owner_epoch": {\n      "name": "owner_epoch",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true,\n      "default": 1\n    },\n    "admission_open": {\n      "name": "admission_open",\n      "type": "boolean",\n      "primaryKey": false,\n      "notNull": true,\n      "default": false\n    },\n    "handle_id": {\n      "name": "handle_id",\n      "type": "text",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "event_sequence": {\n      "name": "event_sequence",\n      "type": "integer",\n      "primaryKey": false,\n      "notNull": true,\n      "default": 0\n    },\n    "input_value": {\n      "name": "input_value",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "lease_expires_at": {\n      "name": "lease_expires_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true\n    },\n    "final_value": {\n      "name": "final_value",\n      "type": "jsonb",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "failure": {\n      "name": "failure",\n      "type": "bytea",\n      "primaryKey": false,\n      "notNull": false\n    },\n    "created_at": {\n      "name": "created_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    },\n    "updated_at": {\n      "name": "updated_at",\n      "type": "timestamp with time zone",\n      "primaryKey": false,\n      "notNull": true,\n      "default": "now()"\n    }\n  },\n  "indexes": {\n    "flow_source_runs_owner_idx": {\n      "name": "flow_source_runs_owner_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_source_runs_public_operation_idx": {\n      "name": "flow_source_runs_public_operation_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "public_operation_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": true,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    },\n    "flow_source_runs_lease_idx": {\n      "name": "flow_source_runs_lease_idx",\n      "columns": [\n        {\n          "expression": "tenant_id",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "state",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        },\n        {\n          "expression": "lease_expires_at",\n          "isExpression": false,\n          "asc": true,\n          "nulls": "last"\n        }\n      ],\n      "isUnique": false,\n      "concurrently": false,\n      "method": "btree",\n      "with": {}\n    }\n  },\n  "foreignKeys": {\n    "flow_source_runs_flow_id_waker_flows_id_fk": {\n      "name": "flow_source_runs_flow_id_waker_flows_id_fk",\n      "tableFrom": "flow_source_runs",\n      "tableTo": "waker_flows",\n      "columnsFrom": [\n        "flow_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_runs_version_id_flow_source_versions_id_fk": {\n      "name": "flow_source_runs_version_id_flow_source_versions_id_fk",\n      "tableFrom": "flow_source_runs",\n      "tableTo": "flow_source_versions",\n      "columnsFrom": [\n        "version_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_runs_task_id_tasks_id_fk": {\n      "name": "flow_source_runs_task_id_tasks_id_fk",\n      "tableFrom": "flow_source_runs",\n      "tableTo": "tasks",\n      "columnsFrom": [\n        "task_id"\n      ],\n      "columnsTo": [\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_runs_public_origin_fk": {\n      "name": "flow_source_runs_public_origin_fk",\n      "tableFrom": "flow_source_runs",\n      "tableTo": "flow_source_public_operations",\n      "columnsFrom": [\n        "tenant_id",\n        "public_operation_id",\n        "public_operation_fingerprint"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "operation_id",\n        "fingerprint"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    },\n    "flow_source_runs_version_owner_fk": {\n      "name": "flow_source_runs_version_owner_fk",\n      "tableFrom": "flow_source_runs",\n      "tableTo": "flow_source_versions",\n      "columnsFrom": [\n        "tenant_id",\n        "flow_id",\n        "version_id"\n      ],\n      "columnsTo": [\n        "tenant_id",\n        "flow_id",\n        "id"\n      ],\n      "onDelete": "no action",\n      "onUpdate": "no action"\n    }\n  },\n  "compositePrimaryKeys": {},\n  "uniqueConstraints": {},\n  "policies": {\n    "tenant_scope_select": {\n      "name": "tenant_scope_select",\n      "as": "PERMISSIVE",\n      "for": "SELECT",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_runs\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    },\n    "tenant_scope_insert": {\n      "name": "tenant_scope_insert",\n      "as": "PERMISSIVE",\n      "for": "INSERT",\n      "to": [\n        "public"\n      ],\n      "withCheck": "\\"flow_source_runs\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true) AND EXISTS (SELECT 1 FROM public.tasks card WHERE card.id = \\"flow_source_runs\\".\\"task_id\\" AND card.tenant_id = current_setting(\'app.tenant_id\', true) AND card.run_ref = \\"flow_source_runs\\".\\"id\\"::text AND card.executor_agent_id = \\"flow_source_runs\\".\\"agent_id\\") AND EXISTS (SELECT 1 FROM public.flow_source_versions v WHERE v.id = \\"flow_source_runs\\".\\"version_id\\" AND v.flow_id = \\"flow_source_runs\\".\\"flow_id\\" AND v.tenant_id = current_setting(\'app.tenant_id\', true) AND v.source_digest = \\"flow_source_runs\\".\\"source_digest\\")"\n    },\n    "tenant_scope_update": {\n      "name": "tenant_scope_update",\n      "as": "PERMISSIVE",\n      "for": "UPDATE",\n      "to": [\n        "public"\n      ],\n      "using": "\\"flow_source_runs\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)",\n      "withCheck": "\\"flow_source_runs\\".\\"tenant_id\\" = current_setting(\'app.tenant_id\', true)"\n    }\n  },\n  "checkConstraints": {\n    "flow_source_runs_public_origin_check": {\n      "name": "flow_source_runs_public_origin_check",\n      "value": "(\\"flow_source_runs\\".\\"public_operation_id\\" IS NULL AND \\"flow_source_runs\\".\\"public_operation_fingerprint\\" IS NULL) OR (\\"flow_source_runs\\".\\"public_operation_id\\" IS NOT NULL AND \\"flow_source_runs\\".\\"public_operation_fingerprint\\" IS NOT NULL AND \\"flow_source_runs\\".\\"public_operation_fingerprint\\" ~ \'^[a-f0-9]{64}$\')"\n    },\n    "flow_source_runs_epoch_check": {\n      "name": "flow_source_runs_epoch_check",\n      "value": "\\"flow_source_runs\\".\\"revision\\" > 0 AND \\"flow_source_runs\\".\\"execution_epoch\\" > 0 AND \\"flow_source_runs\\".\\"owner_epoch\\" >= \\"flow_source_runs\\".\\"execution_epoch\\""\n    },\n    "flow_source_runs_view_revision_check": {\n      "name": "flow_source_runs_view_revision_check",\n      "value": "\\"flow_source_runs\\".\\"view_revision\\" > 0"\n    },\n    "flow_source_runs_definition_revision_check": {\n      "name": "flow_source_runs_definition_revision_check",\n      "value": "\\"flow_source_runs\\".\\"definition_revision\\" >= 0"\n    },\n    "flow_source_runs_admission_check": {\n      "name": "flow_source_runs_admission_check",\n      "value": "NOT \\"flow_source_runs\\".\\"admission_open\\" OR (\\"flow_source_runs\\".\\"state\\" = \'running\' AND \\"flow_source_runs\\".\\"handle_id\\" IS NOT NULL AND \\"flow_source_runs\\".\\"owner_epoch\\" = \\"flow_source_runs\\".\\"execution_epoch\\")"\n    },\n    "flow_source_runs_state_check": {\n      "name": "flow_source_runs_state_check",\n      "value": "\\"flow_source_runs\\".\\"state\\" IN (\'prepared\',\'running\',\'waiting\',\'stopping\',\'stopped\',\'completed\',\'failed\')"\n    }\n  },\n  "isRLSEnabled": true\n}\n',
    sha256: "c7b19e3c0bb6d8f5bf07bdc4ddae8106eac7c8b0bd89a2928e8f9e964a0c7ec8",
  },
];
const expected: Record<string, Table> = Object.fromEntries(
  capsules.map(({ raw, sha256 }) => {
    assert.equal(createHash("sha256").update(raw).digest("hex"), sha256);
    const table = JSON.parse(raw) as Table;
    return [`public.${table.name}`, table];
  }),
);
const server = join(import.meta.dir, "..");
const overlay = join(server, "recovery/recovery-20261018-v1");
const migration = readFileSync(
  join(overlay, "sql/0085_recovery_flow_source_run_records.sql"),
  "utf8",
);
const previous = JSON.parse(
  readFileSync(
    join(overlay, "meta/0084_recovery_flow_source_foundations_snapshot.json"),
    "utf8",
  ),
) as Snapshot;
const next = JSON.parse(
  readFileSync(join(overlay, "meta/0085_snapshot.json"), "utf8"),
) as Snapshot;
const journal = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
const tables = [
  flowSourceCandidates,
  flowSourceResourceSnapshots,
  flowSourceRuns,
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
  assert.deepEqual(parsed.forced, [], "historical target provides ENABLE only");
}
function checkSnapshot(snapshot: Snapshot): void {
  assert.equal(previous.id, "d67073aa-de8d-4145-b2b3-fffa138fb49a");
  assert.equal(snapshot.prevId, previous.id);
  assert.match(
    snapshot.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  for (const id of [
    previous.id,
    "230cf737-0589-4db5-8f72-0244b51d97a7",
    "0fac1c33-b397-46ee-a332-b0a9b06d126b",
  ])
    assert.notEqual(snapshot.id, id);
  const restored = structuredClone(snapshot);
  const added: Record<string, Table> = {};
  for (const key of Object.keys(snapshot.tables))
    if (!(key in previous.tables)) {
      const table = snapshot.tables[key];
      assert.ok(table);
      added[key] = table;
      delete restored.tables[key];
    }
  assert.deepEqual(added, expected);
  restored.id = previous.id;
  restored.prevId = previous.prevId;
  assert.deepEqual(restored, previous);
  assert.equal(Object.keys(snapshot.tables).length, 109);
}
function checkJournal(value: Journal): void {
  const original = JSON.parse(
    readFileSync(join(server, "drizzle/meta/_journal.json"), "utf8"),
  ) as Journal;
  assert.equal(value.version, original.version);
  assert.equal(value.dialect, original.dialect);
  assert.ok(
    value.entries.length >= 86,
    "complete stage prefix, not suffix release authority",
  );
  assert.deepEqual(value.entries.slice(0, 81), original.entries);
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(value.entries.slice(0, 85)))
      .digest("hex"),
    "64a268ab23846d3efb09570259ac5241dda40792d51a9e72014f1977a588bfbd",
  );
  const entry = value.entries[85];
  assert.ok(entry);
  assert.deepEqual(
    { ...entry, when: 0 },
    {
      idx: 85,
      version: "7",
      when: 0,
      tag: "0085_recovery_flow_source_run_records",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(entry.when) &&
      entry.when > 1792338964021 &&
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
describe("recovery Flow candidates resource snapshots and run facts structural candidate", () => {
  test("independent complete capsules retain delivered bytes/SHA identities", () => {
    for (const c of capsules)
      expect(createHash("sha256").update(c.raw).digest("hex")).toBe(c.sha256);
  });
  test("all SQL tokens and27 statements equal independent full target structures", () =>
    checkSQL(migration));
  test("Drizzle complete defaults/null/PK/unique/FK/check/policy/RLS match all three capsules", () =>
    equalTargets(
      Object.fromEntries(
        tables.map((table) => {
          const m = metadata(table);
          return [`public.${m.name}`, m];
        }),
      ),
    ));
  test("inverse three new tables preserves106 old tables and every other top-level value", () =>
    checkSnapshot(next));
  test("complete0..84 prefix and fresh85 identity are retained without suffix execution authority", () =>
    checkJournal(journal));
  test("original163 and all approved81..84 SQL/snapshot bytes remain exact", () => {
    const root = join(server, "drizzle");
    const files = filesUnder(root).sort();
    expect(files).toHaveLength(163);
    const records = files.map((file) => {
      const b = readFileSync(file);
      return `${relative(root, file)}\0${b.length}\0${createHash("sha256").update(b).digest("hex")}\n`;
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
    ]) {
      const data = readFileSync(join(server, input.path));
      expect(data.length).toBe(input.bytes);
      expect(createHash("sha256").update(data).digest("hex")).toBe(
        input.sha256,
      );
    }
  });
  test("nullable defaults and bytea reflect exact historical contract without generated run ids", () => {
    expect(flowSourceRuns.id.hasDefault).toBe(false);
    expect(flowSourceRuns.leaseExpiresAt.hasDefault).toBe(false);
    expect(flowSourceRuns.definitionRevision.notNull).toBe(false);
    expect(flowSourceRuns.admissionOpen.default).toBe(false);
    expect(flowSourceRuns.failure.getSQLType()).toBe("bytea");
    const bytes = Buffer.from([0, 255, 128]);
    expect(flowSourceRuns.failure.mapToDriverValue(bytes)).toBe(bytes);
    const object = { unknown: [null, 1], runtimeReady: false };
    for (const column of [
      flowSourceCandidates.base,
      flowSourceCandidates.compiler,
      flowSourceCandidates.artifact,
      flowSourceCandidates.diagnostics,
      flowSourceRuns.inputValue,
      flowSourceRuns.finalValue,
    ])
      expect(column.mapToDriverValue(object)).toBe(object);
  });
  test("SQL refuses boolean/default/null/type and unique/PK drift without adding resource run FK", () => {
    for (const source of [
      migration.replace(
        '"id" uuid NOT NULL PRIMARY KEY',
        '"id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY',
      ),
      migration.replace(
        '"lease_expires_at" timestamp with time zone NOT NULL',
        '"lease_expires_at" timestamp with time zone DEFAULT now() NOT NULL',
      ),
      migration.replace(
        '"definition_revision" integer,',
        '"definition_revision" integer NOT NULL,',
      ),
      migration.replace(
        '"admission_open" boolean DEFAULT false',
        '"admission_open" boolean DEFAULT true',
      ),
      migration.replace('"failure" bytea', '"failure" text'),
      migration.replace(
        'CONSTRAINT "source_resource_snapshot_owner_operation_key" UNIQUE (',
        'CONSTRAINT "source_resource_snapshot_owner_operation_key" UNIQUE NULLS NOT DISTINCT (',
      ),
      migration.replace(
        'PRIMARY KEY ("tenant_id", "run_id")',
        'PRIMARY KEY ("run_id")',
      ),
      migration.replace(
        'CREATE UNIQUE INDEX "flow_source_runs_public_operation_idx"',
        'CREATE INDEX "flow_source_runs_public_operation_idx"',
      ),
      migration.replace("NULLS LAST", "NULLS FIRST"),
      migration.replace("USING btree", "USING hash"),
      migration +
        'ALTER TABLE "public"."flow_source_resource_snapshots" ADD CONSTRAINT "invented" FOREIGN KEY ("run_id") REFERENCES "public"."flow_source_runs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;',
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("SQL refuses FK target/key loss, generation regex, UTF8/digest/NULL/admission/policy weakening and DML", () => {
    for (const source of [
      migration.replace("ON DELETE NO ACTION", "ON DELETE CASCADE"),
      migration.replace(
        '("tenant_id", "operation_id", "generation_fingerprint")',
        '("operation_id")',
      ),
      migration.replace(
        'REFERENCES "public"."flow_source_versions" ("tenant_id", "flow_id", "id")',
        'REFERENCES "public"."flow_source_versions" ("id")',
      ),
      migration.replace("'^[a-f0-9]{64}$'", "'^[a-f0-9]*$'"),
      migration.replace("octet_length", "char_length"),
      migration.replace("'UTF8'", "'LATIN1'"),
      migration.replace(", false)", ", true)"),
      migration.replace(
        '"definition_revision" >= 0',
        '"definition_revision" > 0',
      ),
      migration.replace(
        '"owner_epoch" >= "flow_source_runs"."execution_epoch"',
        '"owner_epoch" > "flow_source_runs"."execution_epoch"',
      ),
      migration.replace("task.status = 'running'", "task.status = 'stopped'"),
      migration.replace("op.state = 'dispatched'", "op.state = 'completed'"),
      migration.replace(
        'card.executor_agent_id = "flow_source_runs"."agent_id"',
        "true",
      ),
      migration.replace(
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
      ),
      migration + 'UPDATE "public"."waker_flows" SET "plan" = NULL;',
      migration + 'GRANT ALL ON "public"."flow_source_runs" TO public;',
      migration + "SELECT 1;",
      migration + migration,
    ])
      expect(() => checkSQL(source)).toThrow();
  });
  test("snapshot and journal reject missing/extra structures, old drift and reused stage identities", () => {
    const mutations: ((s: Snapshot) => void)[] = [
      (s) => {
        delete s.tables["public.flow_source_candidates"];
      },
      (s) => {
        s.prevId = "wrong";
      },
      (s) => {
        s.id = previous.id;
      },
      (s) => {
        const t = s.tables["public.flow_source_resource_snapshots"];
        assert.ok(t);
        t.uniqueConstraints = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_resource_snapshots"];
        assert.ok(t);
        t.compositePrimaryKeys = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_runs"];
        assert.ok(t);
        t.foreignKeys = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_candidates"];
        assert.ok(t);
        t.checkConstraints = {};
      },
      (s) => {
        const t = s.tables["public.flow_source_runs"];
        assert.ok(t);
        t.policies = {};
      },
      (s) => {
        const t = s.tables["public.waker_flows"];
        assert.ok(t);
        t.indexes = {};
      },
    ];
    for (const mutate of mutations) {
      const snapshot = structuredClone(next);
      mutate(snapshot);
      expect(() => checkSnapshot(snapshot)).toThrow();
    }
    for (const idx of [0, 81, 82, 83, 84, 85]) {
      const changed = structuredClone(journal);
      const entry = changed.entries[idx];
      assert.ok(entry);
      entry.tag = "forged";
      expect(() => checkJournal(changed)).toThrow();
    }
    const old = structuredClone(journal);
    const last = old.entries[85];
    assert.ok(last);
    last.when = 1792338964021;
    expect(() => checkJournal(old)).toThrow();
  });
});

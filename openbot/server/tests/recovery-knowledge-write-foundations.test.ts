import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { users, agents } from "../src/db/schema/core";
import { knowledgeNotebooks } from "../src/db/schema/knowledge-foundations";
import { knowledgeBindings, knowledgeReceipts, knowledgeWriteExecutions, knowledgeWriteClaims } from "../src/db/schema/knowledge-write-foundations";
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
  where?: string;
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

// Complete independent historical0121 objects; original ORM正文 unavailable.
// Whole583049/c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f.
const capsules = [
{ raw: "{\n  \"name\": \"knowledge_bindings\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"owner_user_id\": {\n      \"name\": \"owner_user_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"agent_id\": {\n      \"name\": \"agent_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"notebook_id\": {\n      \"name\": \"notebook_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"access_mode\": {\n      \"name\": \"access_mode\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {\n    \"knowledge_bindings_notebook_idx\": {\n      \"name\": \"knowledge_bindings_notebook_idx\",\n      \"columns\": [\n        {\n          \"expression\": \"tenant_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"owner_user_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"notebook_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": false,\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    }\n  },\n  \"foreignKeys\": {\n    \"knowledge_bindings_owner_user_id_users_id_fk\": {\n      \"name\": \"knowledge_bindings_owner_user_id_users_id_fk\",\n      \"tableFrom\": \"knowledge_bindings\",\n      \"tableTo\": \"users\",\n      \"columnsFrom\": [\n        \"owner_user_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    },\n    \"knowledge_bindings_agent_id_agents_id_fk\": {\n      \"name\": \"knowledge_bindings_agent_id_agents_id_fk\",\n      \"tableFrom\": \"knowledge_bindings\",\n      \"tableTo\": \"agents\",\n      \"columnsFrom\": [\n        \"agent_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    },\n    \"knowledge_bindings_notebook_id_knowledge_notebooks_id_fk\": {\n      \"name\": \"knowledge_bindings_notebook_id_knowledge_notebooks_id_fk\",\n      \"tableFrom\": \"knowledge_bindings\",\n      \"tableTo\": \"knowledge_notebooks\",\n      \"columnsFrom\": [\n        \"notebook_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {\n    \"knowledge_bindings_tenant_id_owner_user_id_agent_id_notebook_id_pk\": {\n      \"name\": \"knowledge_bindings_tenant_id_owner_user_id_agent_id_notebook_id_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"owner_user_id\",\n        \"agent_id\",\n        \"notebook_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"knowledge_binding_owner_select\": {\n      \"name\": \"knowledge_binding_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\"\"\n    },\n    \"knowledge_binding_owner_insert\": {\n      \"name\": \"knowledge_binding_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_bindings.agent_id AND a.tenant_id = knowledge_bindings.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL)\"\n    },\n    \"knowledge_binding_owner_update\": {\n      \"name\": \"knowledge_binding_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\"\",\n      \"withCheck\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\" AND EXISTS (SELECT 1 FROM knowledge_notebooks n WHERE n.id = knowledge_bindings.notebook_id AND n.tenant_id = knowledge_bindings.tenant_id AND n.owner_user_id = knowledge_bindings.owner_user_id AND n.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM agents a JOIN agent_profiles p ON p.agent_id = a.id WHERE a.id = knowledge_bindings.agent_id AND a.tenant_id = knowledge_bindings.tenant_id AND p.tenant_id = a.tenant_id AND p.owner_user_id = knowledge_bindings.owner_user_id AND p.deleted_at IS NULL)\"\n    },\n    \"knowledge_binding_owner_delete\": {\n      \"name\": \"knowledge_binding_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\"\"\n    }\n  },\n  \"checkConstraints\": {\n    \"knowledge_binding_mode_check\": {\n      \"name\": \"knowledge_binding_mode_check\",\n      \"value\": \"\\\"knowledge_bindings\\\".\\\"access_mode\\\" IN ('read_only', 'read_write')\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n", sha256: "8baf8918f7086235845cb270d1b9a49c3644f0d6736ad05ed43174a9701544e2" },
{ raw: "{\n  \"name\": \"knowledge_receipts\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"owner_user_id\": {\n      \"name\": \"owner_user_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"logical_operation_id\": {\n      \"name\": \"logical_operation_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"request_hash\": {\n      \"name\": \"request_hash\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"receipt\": {\n      \"name\": \"receipt\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {\n    \"knowledge_receipts_owner_user_id_users_id_fk\": {\n      \"name\": \"knowledge_receipts_owner_user_id_users_id_fk\",\n      \"tableFrom\": \"knowledge_receipts\",\n      \"tableTo\": \"users\",\n      \"columnsFrom\": [\n        \"owner_user_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {\n    \"knowledge_receipts_tenant_id_owner_user_id_logical_operation_id_pk\": {\n      \"name\": \"knowledge_receipts_tenant_id_owner_user_id_logical_operation_id_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"owner_user_id\",\n        \"logical_operation_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"knowledge_receipt_owner_select\": {\n      \"name\": \"knowledge_receipt_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\"\"\n    },\n    \"knowledge_receipt_owner_insert\": {\n      \"name\": \"knowledge_receipt_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\" AND true\"\n    },\n    \"knowledge_receipt_owner_update\": {\n      \"name\": \"knowledge_receipt_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\"\",\n      \"withCheck\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\" AND true\"\n    },\n    \"knowledge_receipt_owner_delete\": {\n      \"name\": \"knowledge_receipt_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"\\\"tenant_id\\\" = current_setting('app.tenant_id', true) AND \\\"owner_user_id\\\" = \\\"tenant_id\\\"\"\n    }\n  },\n  \"checkConstraints\": {},\n  \"isRLSEnabled\": true\n}\n", sha256: "3debd1bd8988a8c8c78d39f1de393d711939e99d288560dbae99162ef8085040" },
{ raw: "{\n  \"name\": \"knowledge_write_executions\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"owner_user_id\": {\n      \"name\": \"owner_user_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"agent_id\": {\n      \"name\": \"agent_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"run_id\": {\n      \"name\": \"run_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"thread_id\": {\n      \"name\": \"thread_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"epoch\": {\n      \"name\": \"epoch\",\n      \"type\": \"integer\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": 1\n    },\n    \"state\": {\n      \"name\": \"state\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"'active'\"\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    },\n    \"stopped_at\": {\n      \"name\": \"stopped_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    }\n  },\n  \"indexes\": {},\n  \"foreignKeys\": {\n    \"knowledge_write_executions_owner_user_id_users_id_fk\": {\n      \"name\": \"knowledge_write_executions_owner_user_id_users_id_fk\",\n      \"tableFrom\": \"knowledge_write_executions\",\n      \"tableTo\": \"users\",\n      \"columnsFrom\": [\n        \"owner_user_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    },\n    \"knowledge_write_executions_agent_id_agents_id_fk\": {\n      \"name\": \"knowledge_write_executions_agent_id_agents_id_fk\",\n      \"tableFrom\": \"knowledge_write_executions\",\n      \"tableTo\": \"agents\",\n      \"columnsFrom\": [\n        \"agent_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {\n    \"knowledge_write_executions_tenant_id_agent_id_run_id_thread_id_pk\": {\n      \"name\": \"knowledge_write_executions_tenant_id_agent_id_run_id_thread_id_pk\",\n      \"columns\": [\n        \"tenant_id\",\n        \"agent_id\",\n        \"run_id\",\n        \"thread_id\"\n      ]\n    }\n  },\n  \"uniqueConstraints\": {},\n  \"policies\": {\n    \"knowledge_write_execution_owner_select\": {\n      \"name\": \"knowledge_write_execution_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    },\n    \"knowledge_write_execution_owner_insert\": {\n      \"name\": \"knowledge_write_execution_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    },\n    \"knowledge_write_execution_owner_update\": {\n      \"name\": \"knowledge_write_execution_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\",\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    },\n    \"knowledge_write_execution_owner_delete\": {\n      \"name\": \"knowledge_write_execution_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    }\n  },\n  \"checkConstraints\": {\n    \"knowledge_execution_owner\": {\n      \"name\": \"knowledge_execution_owner\",\n      \"value\": \"\\\"knowledge_write_executions\\\".\\\"owner_user_id\\\" = \\\"knowledge_write_executions\\\".\\\"tenant_id\\\" AND \\\"knowledge_write_executions\\\".\\\"tenant_id\\\" NOT IN ('system', 'platform')\"\n    },\n    \"knowledge_execution_epoch\": {\n      \"name\": \"knowledge_execution_epoch\",\n      \"value\": \"\\\"knowledge_write_executions\\\".\\\"epoch\\\" >= 1\"\n    },\n    \"knowledge_execution_state\": {\n      \"name\": \"knowledge_execution_state\",\n      \"value\": \"\\\"knowledge_write_executions\\\".\\\"state\\\" IN ('active', 'stopped')\"\n    },\n    \"knowledge_execution_stopped_at\": {\n      \"name\": \"knowledge_execution_stopped_at\",\n      \"value\": \"(\\\"knowledge_write_executions\\\".\\\"state\\\" = 'active' AND \\\"knowledge_write_executions\\\".\\\"stopped_at\\\" IS NULL) OR (\\\"knowledge_write_executions\\\".\\\"state\\\" = 'stopped' AND \\\"knowledge_write_executions\\\".\\\"stopped_at\\\" IS NOT NULL AND \\\"knowledge_write_executions\\\".\\\"epoch\\\" >= 2)\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n", sha256: "f476f6e7fe883a122cea8559d40edd6e383e458d092093325732fc34116258ab" },
{ raw: "{\n  \"name\": \"knowledge_write_claims\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"claim_id\": {\n      \"name\": \"claim_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": true,\n      \"notNull\": true\n    },\n    \"operation_id\": {\n      \"name\": \"operation_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"owner_user_id\": {\n      \"name\": \"owner_user_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"agent_id\": {\n      \"name\": \"agent_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"run_id\": {\n      \"name\": \"run_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"thread_id\": {\n      \"name\": \"thread_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"tool_call_id\": {\n      \"name\": \"tool_call_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"epoch\": {\n      \"name\": \"epoch\",\n      \"type\": \"integer\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"request_hash\": {\n      \"name\": \"request_hash\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"sdk_hash\": {\n      \"name\": \"sdk_hash\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"target_hash\": {\n      \"name\": \"target_hash\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"action_digest\": {\n      \"name\": \"action_digest\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"original_args\": {\n      \"name\": \"original_args\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"action\": {\n      \"name\": \"action\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"receipt_identity\": {\n      \"name\": \"receipt_identity\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"approval_identity\": {\n      \"name\": \"approval_identity\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"attempt_id\": {\n      \"name\": \"attempt_id\",\n      \"type\": \"uuid\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"outcome\": {\n      \"name\": \"outcome\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"state\": {\n      \"name\": \"state\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"'reserved'\"\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {\n    \"knowledge_claim_unresolved_target\": {\n      \"name\": \"knowledge_claim_unresolved_target\",\n      \"columns\": [\n        {\n          \"expression\": \"tenant_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"target_hash\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": true,\n      \"where\": \"\\\"knowledge_write_claims\\\".\\\"state\\\" IN ('reserved', 'pending', 'ready', 'unknown')\",\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    }\n  },\n  \"foreignKeys\": {\n    \"knowledge_write_claims_owner_user_id_users_id_fk\": {\n      \"name\": \"knowledge_write_claims_owner_user_id_users_id_fk\",\n      \"tableFrom\": \"knowledge_write_claims\",\n      \"tableTo\": \"users\",\n      \"columnsFrom\": [\n        \"owner_user_id\"\n      ],\n      \"columnsTo\": [\n        \"id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    },\n    \"knowledge_claim_execution_fk\": {\n      \"name\": \"knowledge_claim_execution_fk\",\n      \"tableFrom\": \"knowledge_write_claims\",\n      \"tableTo\": \"knowledge_write_executions\",\n      \"columnsFrom\": [\n        \"tenant_id\",\n        \"agent_id\",\n        \"run_id\",\n        \"thread_id\"\n      ],\n      \"columnsTo\": [\n        \"tenant_id\",\n        \"agent_id\",\n        \"run_id\",\n        \"thread_id\"\n      ],\n      \"onDelete\": \"cascade\",\n      \"onUpdate\": \"no action\"\n    }\n  },\n  \"compositePrimaryKeys\": {},\n  \"uniqueConstraints\": {\n    \"knowledge_claim_operation_unique\": {\n      \"name\": \"knowledge_claim_operation_unique\",\n      \"nullsNotDistinct\": false,\n      \"columns\": [\n        \"operation_id\"\n      ]\n    },\n    \"knowledge_claim_sdk_unique\": {\n      \"name\": \"knowledge_claim_sdk_unique\",\n      \"nullsNotDistinct\": false,\n      \"columns\": [\n        \"tenant_id\",\n        \"agent_id\",\n        \"run_id\",\n        \"thread_id\",\n        \"tool_call_id\"\n      ]\n    }\n  },\n  \"policies\": {\n    \"knowledge_write_claim_owner_select\": {\n      \"name\": \"knowledge_write_claim_owner_select\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"SELECT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    },\n    \"knowledge_write_claim_owner_insert\": {\n      \"name\": \"knowledge_write_claim_owner_insert\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"INSERT\",\n      \"to\": [\n        \"public\"\n      ],\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    },\n    \"knowledge_write_claim_owner_update\": {\n      \"name\": \"knowledge_write_claim_owner_update\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"UPDATE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\",\n      \"withCheck\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    },\n    \"knowledge_write_claim_owner_delete\": {\n      \"name\": \"knowledge_write_claim_owner_delete\",\n      \"as\": \"PERMISSIVE\",\n      \"for\": \"DELETE\",\n      \"to\": [\n        \"public\"\n      ],\n      \"using\": \"tenant_id = current_setting('app.tenant_id', true) AND owner_user_id = tenant_id\"\n    }\n  },\n  \"checkConstraints\": {\n    \"knowledge_claim_owner\": {\n      \"name\": \"knowledge_claim_owner\",\n      \"value\": \"\\\"knowledge_write_claims\\\".\\\"owner_user_id\\\" = \\\"knowledge_write_claims\\\".\\\"tenant_id\\\" AND \\\"knowledge_write_claims\\\".\\\"tenant_id\\\" NOT IN ('system', 'platform')\"\n    },\n    \"knowledge_claim_epoch\": {\n      \"name\": \"knowledge_claim_epoch\",\n      \"value\": \"\\\"knowledge_write_claims\\\".\\\"epoch\\\" >= 1\"\n    },\n    \"knowledge_claim_hashes\": {\n      \"name\": \"knowledge_claim_hashes\",\n      \"value\": \"\\\"knowledge_write_claims\\\".\\\"request_hash\\\" ~ '^[a-f0-9]{64}$' AND \\\"knowledge_write_claims\\\".\\\"sdk_hash\\\" ~ '^[a-f0-9]{64}$' AND \\\"knowledge_write_claims\\\".\\\"target_hash\\\" ~ '^[a-f0-9]{64}$' AND \\\"knowledge_write_claims\\\".\\\"action_digest\\\" ~ '^[a-f0-9]{64}$'\"\n    },\n    \"knowledge_claim_state\": {\n      \"name\": \"knowledge_claim_state\",\n      \"value\": \"\\\"knowledge_write_claims\\\".\\\"state\\\" IN ('reserved', 'pending', 'ready', 'unknown', 'applied', 'denied', 'handled')\"\n    },\n    \"knowledge_claim_json\": {\n      \"name\": \"knowledge_claim_json\",\n      \"value\": \"jsonb_typeof(\\\"knowledge_write_claims\\\".\\\"original_args\\\") = 'object' AND jsonb_typeof(\\\"knowledge_write_claims\\\".\\\"action\\\") = 'object'\"\n    }\n  },\n  \"isRLSEnabled\": true\n}\n", sha256: "907dd587ec830950364b2443101e532434700cdbf4581bc1c6df0caa0a0887f5" }
];
const expected: Record<string, Table> = Object.fromEntries(capsules.map(({raw, sha256}) => { assert.equal(createHash("sha256").update(raw).digest("hex"), sha256); const table = JSON.parse(raw) as Table; return [`public.${table.name}`, table]; }));
const server = join(import.meta.dir, ".."), overlay = join(server, "recovery/recovery-20261018-v1");
const migration = readFileSync(join(overlay, "sql/0105_knowledge_write_foundations_closed.sql"), "utf8");
const previousRaw = readFileSync(join(overlay, "meta/0104_snapshot.json"));
const previous = JSON.parse(previousRaw.toString("utf8")) as Snapshot;
const next = JSON.parse(readFileSync(join(overlay, "meta/0105_snapshot.json"), "utf8")) as Snapshot;
const journal = JSON.parse(readFileSync(join(overlay, "meta/_journal.json"), "utf8")) as Journal;
const parentJournalRaw = "{\n  \"version\": \"7\",\n  \"dialect\": \"postgresql\",\n  \"entries\": [\n    {\n      \"idx\": 0,\n      \"version\": \"7\",\n      \"when\": 1786891733850,\n      \"tag\": \"0000_schema\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 1,\n      \"version\": \"7\",\n      \"when\": 1787198911059,\n      \"tag\": \"0001_swift_morph\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 2,\n      \"version\": \"7\",\n      \"when\": 1787275307382,\n      \"tag\": \"0002_sign_in\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 3,\n      \"version\": \"7\",\n      \"when\": 1787275307621,\n      \"tag\": \"0003_backfill_account_issuer\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 4,\n      \"version\": \"7\",\n      \"when\": 1787324562029,\n      \"tag\": \"0004_identity_provider_outlives_its_registrar\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 5,\n      \"version\": \"7\",\n      \"when\": 1787324600000,\n      \"tag\": \"0005_computer_snapshot\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 6,\n      \"version\": \"7\",\n      \"when\": 1787330336906,\n      \"tag\": \"0006_audit_read_indexes\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 7,\n      \"version\": \"7\",\n      \"when\": 1787330552602,\n      \"tag\": \"0007_audit_retention_window\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 8,\n      \"version\": \"7\",\n      \"when\": 1787339895173,\n      \"tag\": \"0008_whole_retro_girl\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 9,\n      \"version\": \"7\",\n      \"when\": 1787342459868,\n      \"tag\": \"0009_lumpy_sunfire\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 10,\n      \"version\": \"7\",\n      \"when\": 1787357412066,\n      \"tag\": \"0010_drop_the_document_index\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 11,\n      \"version\": \"7\",\n      \"when\": 1787358347113,\n      \"tag\": \"0011_drop_the_old_connector_tables\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 12,\n      \"version\": \"7\",\n      \"when\": 1787359000000,\n      \"tag\": \"0012_truncate_is_not_a_way_around_append_only\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 13,\n      \"version\": \"7\",\n      \"when\": 1787380044372,\n      \"tag\": \"0013_skill_tools\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 14,\n      \"version\": \"7\",\n      \"when\": 1787380104372,\n      \"tag\": \"0014_snapshot_session\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 15,\n      \"version\": \"7\",\n      \"when\": 1787525879804,\n      \"tag\": \"0015_credentials_one_live_key\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 16,\n      \"version\": \"7\",\n      \"when\": 1787581516968,\n      \"tag\": \"0016_pin_and_soft_delete_channels\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 17,\n      \"version\": \"7\",\n      \"when\": 1787684818682,\n      \"tag\": \"0017_durable_work\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 18,\n      \"version\": \"7\",\n      \"when\": 1787688017645,\n      \"tag\": \"0018_page_frames\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 19,\n      \"version\": \"7\",\n      \"when\": 1787744867526,\n      \"tag\": \"0019_channel_read_marker\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 20,\n      \"version\": \"7\",\n      \"when\": 1787761381038,\n      \"tag\": \"0020_attention_resolutions\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 21,\n      \"version\": \"7\",\n      \"when\": 1787767359748,\n      \"tag\": \"0021_routines\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 22,\n      \"version\": \"7\",\n      \"when\": 1787841150017,\n      \"tag\": \"0022_drop_attention_resolutions\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 23,\n      \"version\": \"7\",\n      \"when\": 1787841174859,\n      \"tag\": \"0023_routines_owner_index\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 24,\n      \"version\": \"7\",\n      \"when\": 1787926466892,\n      \"tag\": \"0024_onboarding\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 25,\n      \"version\": \"7\",\n      \"when\": 1787926472382,\n      \"tag\": \"0025_backfill_existing_users_have_onboarded\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 26,\n      \"version\": \"7\",\n      \"when\": 1788271863590,\n      \"tag\": \"0026_channel_summary\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 27,\n      \"version\": \"7\",\n      \"when\": 1788543624826,\n      \"tag\": \"0027_user_instructions\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 28,\n      \"version\": \"7\",\n      \"when\": 1788548093782,\n      \"tag\": \"0028_audit_initiator\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 29,\n      \"version\": \"7\",\n      \"when\": 1788911713422,\n      \"tag\": \"0029_mastra_agent_type\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 30,\n      \"version\": \"7\",\n      \"when\": 1788989179914,\n      \"tag\": \"0030_daffy_nighthawk\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 31,\n      \"version\": \"7\",\n      \"when\": 1788990260165,\n      \"tag\": \"0031_hesitant_squadron_sinister\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 32,\n      \"version\": \"7\",\n      \"when\": 1789059537115,\n      \"tag\": \"0032_rainy_lake\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 33,\n      \"version\": \"7\",\n      \"when\": 1789066859018,\n      \"tag\": \"0033_attachments_uploaded_by_index\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 34,\n      \"version\": \"7\",\n      \"when\": 1789162066485,\n      \"tag\": \"0034_last_signed_in_at\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 35,\n      \"version\": \"7\",\n      \"when\": 1789162076466,\n      \"tag\": \"0035_backfill_last_signed_in_at\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 36,\n      \"version\": \"7\",\n      \"when\": 1789182921776,\n      \"tag\": \"0036_routine_sweeps\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 37,\n      \"version\": \"7\",\n      \"when\": 1789389068825,\n      \"tag\": \"0037_composio\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 38,\n      \"version\": \"7\",\n      \"when\": 1789389080686,\n      \"tag\": \"0038_composio_schemes\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 39,\n      \"version\": \"7\",\n      \"when\": 1789389088622,\n      \"tag\": \"0039_composio_probe_action\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 40,\n      \"version\": \"7\",\n      \"when\": 1789495814957,\n      \"tag\": \"0040_drop_orphaned_skill_grants\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 41,\n      \"version\": \"7\",\n      \"when\": 1789540094910,\n      \"tag\": \"0041_drop_orphaned_mcp_grants\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 42,\n      \"version\": \"7\",\n      \"when\": 1789569523560,\n      \"tag\": \"0042_user_preferences\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 43,\n      \"version\": \"7\",\n      \"when\": 1789579982431,\n      \"tag\": \"0043_plugin_logos\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 44,\n      \"version\": \"7\",\n      \"when\": 1790035200000,\n      \"tag\": \"0044_voice_sessions\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 45,\n      \"version\": \"7\",\n      \"when\": 1790164423415,\n      \"tag\": \"0045_channel_activity_source\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 46,\n      \"version\": \"7\",\n      \"when\": 1790447917102,\n      \"tag\": \"0046_automatic_learning\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 47,\n      \"version\": \"7\",\n      \"when\": 1790572443740,\n      \"tag\": \"0047_agent_pinning\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 48,\n      \"version\": \"7\",\n      \"when\": 1790730431917,\n      \"tag\": \"0048_coworker_parity\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 49,\n      \"version\": \"7\",\n      \"when\": 1790733068188,\n      \"tag\": \"0049_coworker_parity_lanes\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 50,\n      \"version\": \"7\",\n      \"when\": 1790872515140,\n      \"tag\": \"0050_review_fixes\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 51,\n      \"version\": \"7\",\n      \"when\": 1790939356628,\n      \"tag\": \"0051_routine_enabled_at\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 52,\n      \"version\": \"7\",\n      \"when\": 1791226846287,\n      \"tag\": \"0052_adorable_hannibal_king\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 53,\n      \"version\": \"7\",\n      \"when\": 1791226846568,\n      \"tag\": \"0053_tenant_rls\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 54,\n      \"version\": \"7\",\n      \"when\": 1791228105477,\n      \"tag\": \"0054_app_role\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 55,\n      \"version\": \"7\",\n      \"when\": 1791229400344,\n      \"tag\": \"0055_tidy_starhawk\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 56,\n      \"version\": \"7\",\n      \"when\": 1791229452847,\n      \"tag\": \"0056_tenant_rls_replay\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 57,\n      \"version\": \"7\",\n      \"when\": 1791233513285,\n      \"tag\": \"0057_milky_victor_mancha\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 58,\n      \"version\": \"7\",\n      \"when\": 1791233723173,\n      \"tag\": \"0058_burly_winter_soldier\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 59,\n      \"version\": \"7\",\n      \"when\": 1791239335242,\n      \"tag\": \"0059_platform_scope\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 60,\n      \"version\": \"7\",\n      \"when\": 1791239793247,\n      \"tag\": \"0060_platform_write\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 61,\n      \"version\": \"7\",\n      \"when\": 1791240919637,\n      \"tag\": \"0061_happy_sleepwalker\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 62,\n      \"version\": \"7\",\n      \"when\": 1791241676411,\n      \"tag\": \"0062_package_tenant_exempt\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 63,\n      \"version\": \"7\",\n      \"when\": 1791243570296,\n      \"tag\": \"0063_certain_betty_ross\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 64,\n      \"version\": \"7\",\n      \"when\": 1791244927031,\n      \"tag\": \"0064_late_gamora\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 65,\n      \"version\": \"7\",\n      \"when\": 1791246141495,\n      \"tag\": \"0065_talented_slipstream\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 66,\n      \"version\": \"7\",\n      \"when\": 1791254016344,\n      \"tag\": \"0066_common_magneto\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 67,\n      \"version\": \"7\",\n      \"when\": 1791258631439,\n      \"tag\": \"0067_perpetual_warstar\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 68,\n      \"version\": \"7\",\n      \"when\": 1791271447074,\n      \"tag\": \"0068_seed_plan_catalogue\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 69,\n      \"version\": \"7\",\n      \"when\": 1791278517294,\n      \"tag\": \"0069_smiling_boomer\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 70,\n      \"version\": \"7\",\n      \"when\": 1791281586374,\n      \"tag\": \"0070_waker_groups\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 71,\n      \"version\": \"7\",\n      \"when\": 1791281646374,\n      \"tag\": \"0071_rls_write_scope\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 72,\n      \"version\": \"7\",\n      \"when\": 1791301891979,\n      \"tag\": \"0072_rls_command_scopes\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 73,\n      \"version\": \"7\",\n      \"when\": 1791382710878,\n      \"tag\": \"0073_mcp_catalogue_key\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 74,\n      \"version\": \"7\",\n      \"when\": 1791408170267,\n      \"tag\": \"0074_skill_package_id\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 75,\n      \"version\": \"7\",\n      \"when\": 1791411170966,\n      \"tag\": \"0075_group_task_pipeline\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 76,\n      \"version\": \"7\",\n      \"when\": 1791412786724,\n      \"tag\": \"0076_run_outlives_template\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 77,\n      \"version\": \"7\",\n      \"when\": 1791448383393,\n      \"tag\": \"0077_task_executor_optional\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 78,\n      \"version\": \"7\",\n      \"when\": 1791463239711,\n      \"tag\": \"0078_drop_learning\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 79,\n      \"version\": \"7\",\n      \"when\": 1791628464023,\n      \"tag\": \"0079_pipeline_driver_claim\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 80,\n      \"version\": \"7\",\n      \"when\": 1791629841965,\n      \"tag\": \"0080_wakerflow_quota_contracts\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 81,\n      \"version\": \"7\",\n      \"when\": 1792332786923,\n      \"tag\": \"0081_recovery_subject_and_binding\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 82,\n      \"version\": \"7\",\n      \"when\": 1792334435193,\n      \"tag\": \"0082_recovery_role_foundations\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 83,\n      \"version\": \"7\",\n      \"when\": 1792335857617,\n      \"tag\": \"0083_recovery_task_flow_audit_contract\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 84,\n      \"version\": \"7\",\n      \"when\": 1792338964021,\n      \"tag\": \"0084_recovery_flow_source_foundations\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 85,\n      \"version\": \"7\",\n      \"when\": 1792342279749,\n      \"tag\": \"0085_recovery_flow_source_run_records\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 86,\n      \"version\": \"7\",\n      \"when\": 1792344488506,\n      \"tag\": \"0086_recovery_flow_source_runtime_records\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 87,\n      \"version\": \"7\",\n      \"when\": 1792347080676,\n      \"tag\": \"0087_recovery_flow_source_original_records\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 88,\n      \"version\": \"7\",\n      \"when\": 1792349468270,\n      \"tag\": \"0088_recovery_flow_run_coordination\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 89,\n      \"version\": \"7\",\n      \"when\": 1792352647000,\n      \"tag\": \"0089_recovery_flow_official_bindings\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 90,\n      \"version\": \"7\",\n      \"when\": 1792356154000,\n      \"tag\": \"0090_recovery_group_pipeline_start_receipts\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 91,\n      \"version\": \"7\",\n      \"when\": 1792358130166,\n      \"tag\": \"0091_recovery_flow_customization_foundations\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 92,\n      \"version\": \"7\",\n      \"when\": 1792360807185,\n      \"tag\": \"0092_threads_domain_parent_key\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 93,\n      \"version\": \"7\",\n      \"when\": 1792364117308,\n      \"tag\": \"0093_recovery_flow_customization_turns\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 94,\n      \"version\": \"7\",\n      \"when\": 1792365686153,\n      \"tag\": \"0094_approval_direct_execution_domains\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 95,\n      \"version\": \"7\",\n      \"when\": 1792368019711,\n      \"tag\": \"0095_recovery_automation_foundations\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 96,\n      \"version\": \"7\",\n      \"when\": 1792370439103,\n      \"tag\": \"0096_recovery_flow_sharing_foundations\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 97,\n      \"version\": \"7\",\n      \"when\": 1792372800000,\n      \"tag\": \"0097_recovery_automation_run_records\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 98,\n      \"version\": \"7\",\n      \"when\": 1792374590000,\n      \"tag\": \"0098_recovery_device_binding_leases\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 99,\n      \"version\": \"7\",\n      \"when\": 1792377023000,\n      \"tag\": \"0099_recovery_security_policy_fences\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 100,\n      \"version\": \"7\",\n      \"when\": 1792380312000,\n      \"tag\": \"0100_recovery_outbox_knowledge_heads\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 101,\n      \"version\": \"7\",\n      \"when\": 1792382901000,\n      \"tag\": \"0101_ap2_parent_schema_reconcile_closed\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 102,\n      \"version\": \"7\",\n      \"when\": 1792386460367,\n      \"tag\": \"0102_approval_exact_input_objects_closed\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 103,\n      \"version\": \"7\",\n      \"when\": 1792396358000,\n      \"tag\": \"0103_knowledge_foundations_closed\",\n      \"breakpoints\": true\n    },\n    {\n      \"idx\": 104,\n      \"version\": \"7\",\n      \"when\": 1792405846000,\n      \"tag\": \"0104_resource_project_foundations_closed\",\n      \"breakpoints\": true\n    }\n  ]\n}\n";
const parentJournalSHA = "99f57ee4c97fbf7b335e9769c7bd18a66a733fdce703bef27dc43123e57d6ea0";
const frozenArtifacts = [
  {
    "path": "drizzle/0000_schema.sql",
    "bytes": 21603,
    "sha256": "43cc9bd9aca2deb09beb10c65f8cc22bfb5c7cbaf02449265c4bbffc9d9d1b5d"
  },
  {
    "path": "drizzle/0001_swift_morph.sql",
    "bytes": 184,
    "sha256": "1af5c2a0b92f1eba0752be2e415c7690984cf1e136ae60da3c7c60d60a2c5c4c"
  },
  {
    "path": "drizzle/0002_sign_in.sql",
    "bytes": 760,
    "sha256": "e46d617580ec69447aa392f5facd750727fc774bfc21c24df6aa47b6c7b64735"
  },
  {
    "path": "drizzle/0003_backfill_account_issuer.sql",
    "bytes": 1206,
    "sha256": "b4cb926b3ccb5a91fab72cd60e7b237931046ac8379814a887a0de875bb713d0"
  },
  {
    "path": "drizzle/0004_identity_provider_outlives_its_registrar.sql",
    "bytes": 282,
    "sha256": "bb31c5cabfa2c2850ca5cf8a06837e4e808f29702119b3275312d138ab1dd1a9"
  },
  {
    "path": "drizzle/0005_computer_snapshot.sql",
    "bytes": 223,
    "sha256": "9e84fc240ce491eb22a32cfa9d04fb0d5f9a3fef990ab9bc4e51e13d24a7489a"
  },
  {
    "path": "drizzle/0006_audit_read_indexes.sql",
    "bytes": 871,
    "sha256": "99dc49c66deb7ed76ef2fb1333e6e3d173e89ee47fa4133e77396e154e4bf6a5"
  },
  {
    "path": "drizzle/0007_audit_retention_window.sql",
    "bytes": 2015,
    "sha256": "82d6aa540927215ee18a0199af4363e1a0c355a1e9d18660595ad332c2dfeed1"
  },
  {
    "path": "drizzle/0008_whole_retro_girl.sql",
    "bytes": 1356,
    "sha256": "772b933c433bbcfdd4101c82e3dd016f0b0fd1a1e5dcf193ba03bd64c20dcc05"
  },
  {
    "path": "drizzle/0009_lumpy_sunfire.sql",
    "bytes": 1778,
    "sha256": "bcf262729d8fa2d1d496f23b6fc145a87b4bfce66b7651c33b3eacfedca71b1a"
  },
  {
    "path": "drizzle/0010_drop_the_document_index.sql",
    "bytes": 1900,
    "sha256": "9febcd2b631d15a7518c36b1b90c1bebe576178e3d688339a9e536c7c6916704"
  },
  {
    "path": "drizzle/0011_drop_the_old_connector_tables.sql",
    "bytes": 2178,
    "sha256": "61fdd31ecdc17049e98331af7f29b678cc8a728e513f827dc386594f90a9c0e5"
  },
  {
    "path": "drizzle/0012_truncate_is_not_a_way_around_append_only.sql",
    "bytes": 2749,
    "sha256": "2abf9b57cdbc0f26c85b3abcc7bf10d2458bfd63539bedbd403d0e6799075496"
  },
  {
    "path": "drizzle/0013_skill_tools.sql",
    "bytes": 534,
    "sha256": "3d7401f970b97d653226f3cd6f16af2de472f7ee776f679b38d6d0aacaa972c1"
  },
  {
    "path": "drizzle/0014_snapshot_session.sql",
    "bytes": 954,
    "sha256": "0e6346166d69dc4892f0c13749e29e6a95439d1c64f8e8c478269ee6134adaf6"
  },
  {
    "path": "drizzle/0015_credentials_one_live_key.sql",
    "bytes": 2352,
    "sha256": "53db3a32c7b41a0557afb467dbfbb087ec08e4112d03c5469fc5bd439aec6b2b"
  },
  {
    "path": "drizzle/0016_pin_and_soft_delete_channels.sql",
    "bytes": 179,
    "sha256": "3d046be6d20fd591e234fab4b9a8ce96ac24246e7013dc0cfc7a1eb6190070a4"
  },
  {
    "path": "drizzle/0017_durable_work.sql",
    "bytes": 644,
    "sha256": "14daa9ee4847ba00276a2e069e98e53470463bc7f823a6f5af1f123555166414"
  },
  {
    "path": "drizzle/0018_page_frames.sql",
    "bytes": 456,
    "sha256": "796931a11836c34583703a51b5124a909c17562a9830df13016279e6c356a0de"
  },
  {
    "path": "drizzle/0019_channel_read_marker.sql",
    "bytes": 85,
    "sha256": "760ef62ab8b5c7c9103ad2109f0eb481d80b9ce75d30ec0f5819011422ac2eab"
  },
  {
    "path": "drizzle/0020_attention_resolutions.sql",
    "bytes": 364,
    "sha256": "972945546eaadf59f6f1150c17621041abd7c46e6f77c18c807bda58a8b2a1be"
  },
  {
    "path": "drizzle/0021_routines.sql",
    "bytes": 1722,
    "sha256": "45096ab2bc77837119c6f36abaa809a740ba2fc709b2d70f79453cbe2a19271d"
  },
  {
    "path": "drizzle/0022_drop_attention_resolutions.sql",
    "bytes": 43,
    "sha256": "f10adcdb483846f920f1097754509301f68fcdbf39b45c95887fdb784ca845a7"
  },
  {
    "path": "drizzle/0023_routines_owner_index.sql",
    "bytes": 91,
    "sha256": "5c3d841d3a726b7388bd7f9bd00a6137661b0390fbf9d5bbff8ceb2b10c3824e"
  },
  {
    "path": "drizzle/0024_onboarding.sql",
    "bytes": 183,
    "sha256": "063f214433e198a79a36c03867687de9cce75f324f5fd5c75a3ab5f393b8fec7"
  },
  {
    "path": "drizzle/0025_backfill_existing_users_have_onboarded.sql",
    "bytes": 615,
    "sha256": "98e0a2f329ee8e8e574ff7bd5c028c4dd2c67b303e89bef6ac5ac06d4e5d10ae"
  },
  {
    "path": "drizzle/0026_channel_summary.sql",
    "bytes": 320,
    "sha256": "e8f283bfdec412700a829fbef724fd37627e74e73f225a19672a551284005740"
  },
  {
    "path": "drizzle/0027_user_instructions.sql",
    "bytes": 440,
    "sha256": "93f5aea4e4804e7677f679a80012b0e5fb6361df6abd27b114ca74bcfc609920"
  },
  {
    "path": "drizzle/0028_audit_initiator.sql",
    "bytes": 340,
    "sha256": "29161fcc577cd5648ea58591a41e1ac86122234411faf72e2744907149024170"
  },
  {
    "path": "drizzle/0029_mastra_agent_type.sql",
    "bytes": 575,
    "sha256": "b4eac065dcb94d0468ec070898e5ee082bff4a0f3f736576f582b0afcd4eb7da"
  },
  {
    "path": "drizzle/0030_daffy_nighthawk.sql",
    "bytes": 775,
    "sha256": "114a9216438199ab84efabfb4ef00e310cff1a7e16561c1faa8f050160f7396d"
  },
  {
    "path": "drizzle/0031_hesitant_squadron_sinister.sql",
    "bytes": 232,
    "sha256": "48bfef3a2bc3514561b2b061eeaededee50cc9340b64d4935a51834413d34f33"
  },
  {
    "path": "drizzle/0032_rainy_lake.sql",
    "bytes": 241,
    "sha256": "5e91e97882c2288335c75dac4aadde802fcc25accce87bc16fdae68725017429"
  },
  {
    "path": "drizzle/0033_attachments_uploaded_by_index.sql",
    "bytes": 88,
    "sha256": "507d804ef613a48fac5ad80c0b4834d300b582acaf7141e3e1ec9666ac60ab37"
  },
  {
    "path": "drizzle/0034_last_signed_in_at.sql",
    "bytes": 76,
    "sha256": "a5cdef00cd2ad6561747771d1ff76109d93851462594bb1cd7f74d1bd5d67b1c"
  },
  {
    "path": "drizzle/0035_backfill_last_signed_in_at.sql",
    "bytes": 236,
    "sha256": "9320107cfc3b26aaaafea0ef41d5462abac4830b62caac91e4ee371bb88691ee"
  },
  {
    "path": "drizzle/0036_routine_sweeps.sql",
    "bytes": 143,
    "sha256": "e304b5820b25c17b62b476c16043fd272da5d27dc4a7fad61ac090a8943e4c23"
  },
  {
    "path": "drizzle/0037_composio.sql",
    "bytes": 682,
    "sha256": "fdb4f11e3df723ef6b4e6fc965fecbde5ab773f735894f9cd41b9e3ec32a4c4d"
  },
  {
    "path": "drizzle/0038_composio_schemes.sql",
    "bytes": 522,
    "sha256": "d6e7e773b8c4905f1c5a820604dacaf2391ddb5be2415f0ba33bddcaa2fee79d"
  },
  {
    "path": "drizzle/0039_composio_probe_action.sql",
    "bytes": 66,
    "sha256": "9470a9843fb6549f239124364fe1252bc598e00fd1206f3b23e4a09b871b3db1"
  },
  {
    "path": "drizzle/0040_drop_orphaned_skill_grants.sql",
    "bytes": 139,
    "sha256": "58bdca801c50d5ed0813f27aec0f86a6d75f9660e6f4e6e6bb8c35a1790f5461"
  },
  {
    "path": "drizzle/0041_drop_orphaned_mcp_grants.sql",
    "bytes": 160,
    "sha256": "4ddd7cf4aba33feab9cd31b3745a92932d89dc07256e04bc5928f7e7eb5702fe"
  },
  {
    "path": "drizzle/0042_user_preferences.sql",
    "bytes": 80,
    "sha256": "f4ecdb1558c6b803a899530eac0425e1e7dfc5e83b144910d79a2a362ed3cfc1"
  },
  {
    "path": "drizzle/0043_plugin_logos.sql",
    "bytes": 49,
    "sha256": "5aba8e48317aa3436ef294bc41b0221432c6f8ad81e8280f73ae32b62c39f4a4"
  },
  {
    "path": "drizzle/0044_voice_sessions.sql",
    "bytes": 1264,
    "sha256": "6463fbeddeaaa5ab2184a09cf7b706db31702f94f699c83b4c7e838565843c04"
  },
  {
    "path": "drizzle/0045_channel_activity_source.sql",
    "bytes": 64,
    "sha256": "70eaf54c38fc1458e7ce22c1ab76d379e380343657e51ac6fdd6e014b5a19e21"
  },
  {
    "path": "drizzle/0046_automatic_learning.sql",
    "bytes": 492,
    "sha256": "1730fad1c8ec7ec4c370ae5e984dfb66cdf02f286c59498cb7315c8546ce3232"
  },
  {
    "path": "drizzle/0047_agent_pinning.sql",
    "bytes": 80,
    "sha256": "61f5afcd5e0a8caeedd3341656c7b8415648284d0ed4e74b403516a664c9b5b4"
  },
  {
    "path": "drizzle/0048_coworker_parity.sql",
    "bytes": 18282,
    "sha256": "4e18d0e292fa81f9d9aa34c9245555cdda709ded47a490113c42ef39e68d3cc2"
  },
  {
    "path": "drizzle/0049_coworker_parity_lanes.sql",
    "bytes": 25836,
    "sha256": "1648c1d6699922790d2cf5512bd8814e91523e45af119f3a71e34b0c1298de89"
  },
  {
    "path": "drizzle/0050_review_fixes.sql",
    "bytes": 281,
    "sha256": "bba7b02bffa02d2ad73fdad51852c8c1fc6e4c2f63f16130fa23ca44fa5619f1"
  },
  {
    "path": "drizzle/0051_routine_enabled_at.sql",
    "bytes": 95,
    "sha256": "c6aadc52be555e831550d0f396e94e83cdfe4c4f8cbdf1507ca944e018e8ae03"
  },
  {
    "path": "drizzle/0052_adorable_hannibal_king.sql",
    "bytes": 9458,
    "sha256": "891193dc07d5ba667c33a8e13867b2415907f412e00f045e0ca533fd7e7e88d7"
  },
  {
    "path": "drizzle/0053_tenant_rls.sql",
    "bytes": 1134,
    "sha256": "ee9b8215888e6d095fcfe25e96bc7bc68035c49fcf55e2d8e0ddfde831c84376"
  },
  {
    "path": "drizzle/0054_app_role.sql",
    "bytes": 1045,
    "sha256": "c2a850f80abe6dd1bc51cb6b8d2af81be6a8303763e4afaa334f4d3f283e8e77"
  },
  {
    "path": "drizzle/0055_tidy_starhawk.sql",
    "bytes": 1739,
    "sha256": "140be36e8a40f0620de536665fbeef393a073e667a356a377af763b7720da9b3"
  },
  {
    "path": "drizzle/0056_tenant_rls_replay.sql",
    "bytes": 1090,
    "sha256": "b9bd5056eb4044ce3ba6e98fc1842117216a0973ba7891ef4591e80e942ff0fe"
  },
  {
    "path": "drizzle/0057_milky_victor_mancha.sql",
    "bytes": 875,
    "sha256": "6279af53ba85aab4c917ff72be45863e329a9ce91bfa85430765c375b2f339a6"
  },
  {
    "path": "drizzle/0058_burly_winter_soldier.sql",
    "bytes": 1019,
    "sha256": "4e4974313d0f0ffefd17f3facbec700df527910bc59d14e94e1e1d70c69beec4"
  },
  {
    "path": "drizzle/0059_platform_scope.sql",
    "bytes": 1140,
    "sha256": "4c70ed30c88a04606987e94e79264664ca2d64c6bd9f983d8eab69f3ad2b0e8a"
  },
  {
    "path": "drizzle/0060_platform_write.sql",
    "bytes": 1251,
    "sha256": "eee6260ae0a209c4dc7960b4c4289edf29947e564fea02d64b343e6b2f742367"
  },
  {
    "path": "drizzle/0061_happy_sleepwalker.sql",
    "bytes": 2027,
    "sha256": "cbd6142f2609dc382dc02646cd14a45dff3b09e4750ed6cb4177373cf3bfadbe"
  },
  {
    "path": "drizzle/0062_package_tenant_exempt.sql",
    "bytes": 437,
    "sha256": "3f49616bb0bed41f636f78ad4ad13792960e44c95829994d0e5efae5dbe2365f"
  },
  {
    "path": "drizzle/0063_certain_betty_ross.sql",
    "bytes": 2785,
    "sha256": "f30d135d2301521bf504f9fd97499115a460e61132b12a7da4579357f3524b96"
  },
  {
    "path": "drizzle/0064_late_gamora.sql",
    "bytes": 282,
    "sha256": "7d08e521e580db3dbfaa2deb8f708ef432b2b60ad5da979cc27b322cda02598e"
  },
  {
    "path": "drizzle/0065_talented_slipstream.sql",
    "bytes": 243,
    "sha256": "822d2e685fd0a69cd8625e727944ab88f969c086e4ac9fb8bd4d516294cc2db6"
  },
  {
    "path": "drizzle/0066_common_magneto.sql",
    "bytes": 1708,
    "sha256": "005a7a5ab9a309a5d41a9d5af373d6de234d0a25110387c38536caed3a8422e7"
  },
  {
    "path": "drizzle/0067_perpetual_warstar.sql",
    "bytes": 2333,
    "sha256": "8a4433dd4c32f789f0431cbf356587a7ecbf74d783d93fd8c36b62f167e4d37d"
  },
  {
    "path": "drizzle/0068_seed_plan_catalogue.sql",
    "bytes": 772,
    "sha256": "8f37ddf19f8beaf41431e73dd461b871c2ecb3b32314b21ec4917d5e7a63502f"
  },
  {
    "path": "drizzle/0069_smiling_boomer.sql",
    "bytes": 48,
    "sha256": "68a04c037e2d219d3a2bed353f73413986aa51cb868fde21f1490d6adecb48cf"
  },
  {
    "path": "drizzle/0070_waker_groups.sql",
    "bytes": 3211,
    "sha256": "1cacacad2b4e598664e9d82e414c34100f00fbc0b6023f12ca275328e9af233c"
  },
  {
    "path": "drizzle/0071_rls_write_scope.sql",
    "bytes": 737,
    "sha256": "dc2ca146b77a9a7a325d3cd0a2428cd7261af23f17abd750d0a36481ab36e459"
  },
  {
    "path": "drizzle/0072_rls_command_scopes.sql",
    "bytes": 4728,
    "sha256": "bf68c4d20aa378a393c353407a461f680100c02dd6666fd2ab469dd136b98a5f"
  },
  {
    "path": "drizzle/0073_mcp_catalogue_key.sql",
    "bytes": 788,
    "sha256": "5f1bc58dc252c7514b425e65b7e56167115e07f01775c4658bcda6374a452e3d"
  },
  {
    "path": "drizzle/0074_skill_package_id.sql",
    "bytes": 1529,
    "sha256": "fab4671fde26dbfa7205483044f8421ee101e5f92ed5d91f5760f5a8d6ff7263"
  },
  {
    "path": "drizzle/0075_group_task_pipeline.sql",
    "bytes": 4968,
    "sha256": "e11f53d29ef07df950d9a4d3a195c0cc411b35afd3561803e8bab5fac647cdf2"
  },
  {
    "path": "drizzle/0076_run_outlives_template.sql",
    "bytes": 443,
    "sha256": "71003c35fde0b366c34246afd570a95020727a9e58d8f41b47c407491e95b238"
  },
  {
    "path": "drizzle/0077_task_executor_optional.sql",
    "bytes": 67,
    "sha256": "61d0fb4bdb232d1e50d6b956373ff450faccb2389ac5ce3701edf6049997cef6"
  },
  {
    "path": "drizzle/0078_drop_learning.sql",
    "bytes": 110,
    "sha256": "27a4990727d33a0db3af6614ffa55cd54a1f616ecc1325dfe3a3b556b3027535"
  },
  {
    "path": "drizzle/0079_pipeline_driver_claim.sql",
    "bytes": 168,
    "sha256": "9674393637edba7d138413e82b05cbaa6e0a491e7e261ef0234c11e7ab86e5cd"
  },
  {
    "path": "drizzle/0080_wakerflow_quota_contracts.sql",
    "bytes": 4120,
    "sha256": "e09fd8b085d9cb396f50076fbbc9bc6eefd10293595790670dbe33b944774b71"
  },
  {
    "path": "drizzle/meta/0000_snapshot.json",
    "bytes": 67945,
    "sha256": "659ab60b0c8d1c7b1a900298bc6e4e27ef4c6d8f16b518d143ee0d0742c004a6"
  },
  {
    "path": "drizzle/meta/0001_snapshot.json",
    "bytes": 68313,
    "sha256": "0592e0d99a8acf392592d2012313562f247d73e4b1fac07d1f9cf1c52824f7bc"
  },
  {
    "path": "drizzle/meta/0002_snapshot.json",
    "bytes": 71256,
    "sha256": "c4f0f6dc767d98c2c1e5fe2e2bb89b8d18a47322e0defe0da4d435159cc6e2a6"
  },
  {
    "path": "drizzle/meta/0003_snapshot.json",
    "bytes": 71256,
    "sha256": "6436fbb7d1f25f596f8a16d5341725853f8d9dde81d189cda376a1d423b54211"
  },
  {
    "path": "drizzle/meta/0004_snapshot.json",
    "bytes": 71257,
    "sha256": "3cd45e44813cec2d3e43a859adb9d07d367cc6673d4103d67379a050d74d6940"
  },
  {
    "path": "drizzle/meta/0005_snapshot.json",
    "bytes": 74426,
    "sha256": "0f97c88bb75fff1856f1e7f70d4eb89563875dadcd32118949c3b22f1f9bd536"
  },
  {
    "path": "drizzle/meta/0006_snapshot.json",
    "bytes": 74735,
    "sha256": "2b1460fcec0bfd3433ce3ed115432b97ba5683a5f91d6a81a18080987d535a3b"
  },
  {
    "path": "drizzle/meta/0007_snapshot.json",
    "bytes": 74735,
    "sha256": "a19b6d3af79df80b75195c0a72f2acceefc0571986c9430c27f36e158491b68a"
  },
  {
    "path": "drizzle/meta/0008_snapshot.json",
    "bytes": 77830,
    "sha256": "1c8655de8400ca19e90213d19ad11d79c4260190345c3f5f6ce2420d16baf040"
  },
  {
    "path": "drizzle/meta/0009_snapshot.json",
    "bytes": 78186,
    "sha256": "59b95ff9f744d37c4ec2472ba3e932afae66c5545cebc45cc442c9b5b33711d6"
  },
  {
    "path": "drizzle/meta/0010_snapshot.json",
    "bytes": 69232,
    "sha256": "4154b1e215ed7e12f683624fc4a2e5fdc3e804a331cadb2302a5fd651d7b5853"
  },
  {
    "path": "drizzle/meta/0011_snapshot.json",
    "bytes": 61558,
    "sha256": "420fc2491af7488ae2d86e4a75f5d46eb73849ec5405d8e063ad4d307b5cf1da"
  },
  {
    "path": "drizzle/meta/0012_snapshot.json",
    "bytes": 61558,
    "sha256": "1976248aa2079cd117bd34cbf09a8b624930f358ee11d446852ba0b10f52824a"
  },
  {
    "path": "drizzle/meta/0013_snapshot.json",
    "bytes": 63364,
    "sha256": "b7fd0fde2d8be9266699c282afb9eeb2aa55065be42b273a0551f8ac4bf4bedb"
  },
  {
    "path": "drizzle/meta/0014_snapshot.json",
    "bytes": 63509,
    "sha256": "792bec181dddb81a9a55ba592e19483fa843f2d618963f48a6154cafb0c94b2f"
  },
  {
    "path": "drizzle/meta/0015_snapshot.json",
    "bytes": 64304,
    "sha256": "4f480464214ad79d3154a54c28203a745343ea4946dbed4ccc3684e17fc1ad93"
  },
  {
    "path": "drizzle/meta/0016_snapshot.json",
    "bytes": 64644,
    "sha256": "0d90a732b96447bdb814549caa2f295031bcc43549277e01be577e57d011f0e3"
  },
  {
    "path": "drizzle/meta/0017_snapshot.json",
    "bytes": 67514,
    "sha256": "649e942bbda8b43c2fb6cf34fe8a76879d536166eb18ea9b77f38dd9f87998d7"
  },
  {
    "path": "drizzle/meta/0018_snapshot.json",
    "bytes": 69387,
    "sha256": "537153963db8ad841ecebea518789bc797604a6b5736f4425b4c469bd01a4675"
  },
  {
    "path": "drizzle/meta/0019_snapshot.json",
    "bytes": 69562,
    "sha256": "ccdf5be4a74b43f80f5c4fc8c29f2bc7a0688eef28dfd46f66bf7e274bb32337"
  },
  {
    "path": "drizzle/meta/0020_snapshot.json",
    "bytes": 71001,
    "sha256": "e3f0bdd6fdcb69bafa63907ffc7f4af739a934699e950861d55daf096633ccc3"
  },
  {
    "path": "drizzle/meta/0021_snapshot.json",
    "bytes": 76836,
    "sha256": "e5af92674db1b255a7eab6ab098fdf829ab04a8f064dbf94f3913eb14a8db4db"
  },
  {
    "path": "drizzle/meta/0022_snapshot.json",
    "bytes": 75397,
    "sha256": "e98a53b60a95f33dfafa3ec24c6794ba41f75e9cddc09a9644b0825f1c2e9555"
  },
  {
    "path": "drizzle/meta/0023_snapshot.json",
    "bytes": 75963,
    "sha256": "ab089426e34ec6fa85d3cb199099f9f4578e8c1655fea200d8adab152af2fe9b"
  },
  {
    "path": "drizzle/meta/0024_snapshot.json",
    "bytes": 78514,
    "sha256": "ddeacce289e9c142dc7dece64cd6e3df289d2c8b2828354feca7092681875d58"
  },
  {
    "path": "drizzle/meta/0025_snapshot.json",
    "bytes": 78514,
    "sha256": "8428dd144a018225f077d93448c76c32ded5c5261f133bdee0786b8cae932384"
  },
  {
    "path": "drizzle/meta/0026_snapshot.json",
    "bytes": 79334,
    "sha256": "f904d9ae1c6be2432b5e16726c840ad446e9235756ff9277a93942ddf0e30812"
  },
  {
    "path": "drizzle/meta/0027_snapshot.json",
    "bytes": 80730,
    "sha256": "b3a92fc40f49145aa4ff4c48e0cfde88c03b877c787720e33ac8431d1d54c272"
  },
  {
    "path": "drizzle/meta/0028_snapshot.json",
    "bytes": 81825,
    "sha256": "1dc66ed4a1e857bee68ce60be46dc81a5709381c7cc0d2361ced078ea733a4a4"
  },
  {
    "path": "drizzle/meta/0029_snapshot.json",
    "bytes": 81850,
    "sha256": "a4d1c2e8638a7d46e94ec11acc18734fad5ac26ff7fd644e3fdcfb0806b8c342"
  },
  {
    "path": "drizzle/meta/0030_snapshot.json",
    "bytes": 84341,
    "sha256": "4d656694483e2a48409b4859f2a28dc3f01b0ffc0c6ccbfeec8341522176acb0"
  },
  {
    "path": "drizzle/meta/0031_snapshot.json",
    "bytes": 85217,
    "sha256": "c4c677eb8221eeed044b0810025fd0566d68e9ba2ffdbef7e585f87deb80677a"
  },
  {
    "path": "drizzle/meta/0032_snapshot.json",
    "bytes": 86182,
    "sha256": "a8e50e8d7f50fa417a80f52ae1178398a20168350a4ad8bf1ab9249fb327be60"
  },
  {
    "path": "drizzle/meta/0033_snapshot.json",
    "bytes": 86596,
    "sha256": "61d850dffc133bb0ab89351321ed540c6b11a6cbb786ba5d75a69baa3e2ef480"
  },
  {
    "path": "drizzle/meta/0034_snapshot.json",
    "bytes": 86780,
    "sha256": "9be1b22ca912f0f5fbf6fdd3ffe5695f4fadbfc2419f58a53b1cb50a84369396"
  },
  {
    "path": "drizzle/meta/0035_snapshot.json",
    "bytes": 86780,
    "sha256": "2d385e7a6d7542bbfe1123a1b2d6c504dbe16cdc196a1f614ef40308a9e9ceb6"
  },
  {
    "path": "drizzle/meta/0036_snapshot.json",
    "bytes": 87558,
    "sha256": "de1dc17de193ab84aae64d31001da6b51ef9e5ccad2f3917318e45043ea766bc"
  },
  {
    "path": "drizzle/meta/0037_snapshot.json",
    "bytes": 89673,
    "sha256": "e0c35b980bb744c2fb4812b2d9a4dba7fbe3afcf52d7b0a4ea3c124456f0db8e"
  },
  {
    "path": "drizzle/meta/0038_snapshot.json",
    "bytes": 90176,
    "sha256": "dd18952367237e451824587360e901142a8e484120fd5a075eb8974bb596d425"
  },
  {
    "path": "drizzle/meta/0039_snapshot.json",
    "bytes": 90331,
    "sha256": "b1ac3f0f4ee70b72ab88aaf619a92fee8d4d88d5972a353c7a87f6531061aa1f"
  },
  {
    "path": "drizzle/meta/0040_snapshot.json",
    "bytes": 90330,
    "sha256": "2d8b75691692dea1be7e314a48c11dbf2f3fd2fc60a84016e3f988da0af683d9"
  },
  {
    "path": "drizzle/meta/0041_snapshot.json",
    "bytes": 90330,
    "sha256": "2d2da1d1eeaea19c18c2fe763595cf426489f1ae88c4ebc477d25429c80f2d31"
  },
  {
    "path": "drizzle/meta/0042_snapshot.json",
    "bytes": 90520,
    "sha256": "098f7bbc33c82dc95ea96508d5c0658a2ef7644fbf488672259565986f3fa8b8"
  },
  {
    "path": "drizzle/meta/0043_snapshot.json",
    "bytes": 90659,
    "sha256": "4679a72fbc7be81ab75550665c863de0c7fc608583154d9f06437775a68e8318"
  },
  {
    "path": "drizzle/meta/0044_snapshot.json",
    "bytes": 94561,
    "sha256": "b0a1e65567549f00fc3cf39919bd416efe67bc33e569b82e1506a15f91603d41"
  },
  {
    "path": "drizzle/meta/0045_snapshot.json",
    "bytes": 94735,
    "sha256": "a8cebcf7f29ec80a728731039e6bc7a52547273399c3b53fb875b52d6f0222e3"
  },
  {
    "path": "drizzle/meta/0046_snapshot.json",
    "bytes": 96875,
    "sha256": "1636e1de237ae656ed313c7de94da4634aa2882e83319483dc2723fd8286bfe1"
  },
  {
    "path": "drizzle/meta/0047_snapshot.json",
    "bytes": 97044,
    "sha256": "b365c7ab5b63b1e7e72ff05cf770a5993d3ec4f931a103a6a423e2ea8d3f20b5"
  },
  {
    "path": "drizzle/meta/0048_snapshot.json",
    "bytes": 157499,
    "sha256": "072dfd4d4ed611e9337eeda1f25f8668bee0b93c88be99f9bba1208372dc1543"
  },
  {
    "path": "drizzle/meta/0049_snapshot.json",
    "bytes": 238537,
    "sha256": "b1661744f0c09f9ba7d953df926a76db39a8f4405c67e185db1efcf9c3bd9fbe"
  },
  {
    "path": "drizzle/meta/0050_snapshot.json",
    "bytes": 239379,
    "sha256": "279d08219bdfc0e9b6bdd01754f3c9fc1faa658ae09260bdcac8ef920577bc9b"
  },
  {
    "path": "drizzle/meta/0051_snapshot.json",
    "bytes": 239579,
    "sha256": "cdba942e596e1f1e57fa6112039cfda1f2842d8cfe792cbcf2f3afc8f58f29c8"
  },
  {
    "path": "drizzle/meta/0052_snapshot.json",
    "bytes": 256338,
    "sha256": "f2f25863bb178ab91d4f67be5f25ca951a70ed5746a2939d459612866b1d5739"
  },
  {
    "path": "drizzle/meta/0053_snapshot.json",
    "bytes": 256339,
    "sha256": "d07a1a76376523638364e25f7b6cd4a71007cb51f288ad272b7520ea8b57ca87"
  },
  {
    "path": "drizzle/meta/0054_snapshot.json",
    "bytes": 256339,
    "sha256": "fe46b32153cfee1b62f8c63e2f3b2be4fa91425a0ea972101e14435e72855d13"
  },
  {
    "path": "drizzle/meta/0055_snapshot.json",
    "bytes": 262955,
    "sha256": "072caca7069a23fbf267c86364d8e2f184ce43c843dc04430cd1354e2082eaae"
  },
  {
    "path": "drizzle/meta/0056_snapshot.json",
    "bytes": 262955,
    "sha256": "d08938ee31985ed08a98d05cd4a37ef09773629478035956445701acee4ae5ed"
  },
  {
    "path": "drizzle/meta/0057_snapshot.json",
    "bytes": 263166,
    "sha256": "12279aea9bd73a257d7c62dd5e206b2a3587b39c6f03a092f11e091a1c5231a4"
  },
  {
    "path": "drizzle/meta/0058_snapshot.json",
    "bytes": 263376,
    "sha256": "12db9720ad0e37b7e6059b26960eb7a3fbd71ffb7be233b468b9e52857ed51a9"
  },
  {
    "path": "drizzle/meta/0059_snapshot.json",
    "bytes": 263377,
    "sha256": "c83a4679029cfd8ac711b79beb63045bce62459ad5cb63e8bb93897a09760ca1"
  },
  {
    "path": "drizzle/meta/0060_snapshot.json",
    "bytes": 263377,
    "sha256": "0ed462cdb073d4e90d9f7cdfcf041e0f72d161f7b7f1187d0084999d1f05cd5f"
  },
  {
    "path": "drizzle/meta/0061_snapshot.json",
    "bytes": 268089,
    "sha256": "1838825437efd80068066f68914af6d8dcc24fc04ff5113d8bfd0321cf2b8e7a"
  },
  {
    "path": "drizzle/meta/0062_snapshot.json",
    "bytes": 268089,
    "sha256": "9fc90b7e892bba3f0f8839822d646fcd052cecdd987d7a864fd07e54ce413a71"
  },
  {
    "path": "drizzle/meta/0063_snapshot.json",
    "bytes": 272635,
    "sha256": "b53c5b66a1f4cf2d9d1e0b91965fc3bb00f0a066616da448b0686da4d370e9c0"
  },
  {
    "path": "drizzle/meta/0064_snapshot.json",
    "bytes": 273187,
    "sha256": "0e13d3e4791a6665c40bda94e9dfeb3406b18b8ee18fb6030828bc7308221c13"
  },
  {
    "path": "drizzle/meta/0065_snapshot.json",
    "bytes": 273196,
    "sha256": "224dbf204e5b5bd89cde878ffd42d524ef7e8547eafc9ddf1063973db36556df"
  },
  {
    "path": "drizzle/meta/0066_snapshot.json",
    "bytes": 275727,
    "sha256": "d7059619d6a743b5e1feb8dc1bff21344ddde7f588496a90dbbf70c22563a85b"
  },
  {
    "path": "drizzle/meta/0067_snapshot.json",
    "bytes": 280785,
    "sha256": "8441de588e1260e2f4955757ff66c76e4792a1f8e0e8f25cf2c96f6c90312f37"
  },
  {
    "path": "drizzle/meta/0068_snapshot.json",
    "bytes": 280786,
    "sha256": "b5f1e6b6195f9c0c91e1259d142f19fffba3263cab4baea0c5a77998c81bdacc"
  },
  {
    "path": "drizzle/meta/0069_snapshot.json",
    "bytes": 280934,
    "sha256": "dd81de8497b1dc8ca6d4dc2e98e56082db286170cd6838a69daf80b1742213c9"
  },
  {
    "path": "drizzle/meta/0070_snapshot.json",
    "bytes": 285331,
    "sha256": "674c73f9a1fd9aaf398b8eb1b7012ed52351f9c1d9e563b4ee8841dc41a1f4fd"
  },
  {
    "path": "drizzle/meta/0071_snapshot.json",
    "bytes": 285332,
    "sha256": "66c6d58eebc3ab6832ece000d6e2eefdd75dbb259ebbf45b0988bbbee779232f"
  },
  {
    "path": "drizzle/meta/0072_snapshot.json",
    "bytes": 285332,
    "sha256": "57625acf61030097687970fae5d54eb5469b92e608be307f20c35914deba0801"
  },
  {
    "path": "drizzle/meta/0073_snapshot.json",
    "bytes": 286083,
    "sha256": "e6c93d0c6d2d50b4df7d4c99c50038a6794294a9d5492849ae43513af2c2da2c"
  },
  {
    "path": "drizzle/meta/0074_snapshot.json",
    "bytes": 287027,
    "sha256": "85a531c599feda5cad5f4c29bdb56d5c9dfa0574def97be152875d528a5807ce"
  },
  {
    "path": "drizzle/meta/0075_snapshot.json",
    "bytes": 293915,
    "sha256": "69748cc40ac369f676d29575039af356efda3f2ecd08e90ba5a3d2bfbca7c4e4"
  },
  {
    "path": "drizzle/meta/0076_snapshot.json",
    "bytes": 293917,
    "sha256": "fd5dca8ce3cd2ea836cfe9c5c641a3ece335e34efd4d3c1277f8afed4fd48153"
  },
  {
    "path": "drizzle/meta/0077_snapshot.json",
    "bytes": 293918,
    "sha256": "531b3296305fc0f1fdfc07d9ceec792b20d98145d94bda9be6ec78050f088643"
  },
  {
    "path": "drizzle/meta/0078_snapshot.json",
    "bytes": 291567,
    "sha256": "5785476532bb79642b25d4d32a91305641b77bbccbce565799d112330f0409e2"
  },
  {
    "path": "drizzle/meta/0079_snapshot.json",
    "bytes": 291898,
    "sha256": "2035e6bc7b4990fd1607af1479110e479556be76aa830536fa4627d1958f9654"
  },
  {
    "path": "drizzle/meta/0080_snapshot.json",
    "bytes": 299339,
    "sha256": "0367f9b57ff86fd2dc420148f94ffea41e88c05b031bf240e6915c106dee88c5"
  },
  {
    "path": "drizzle/meta/_journal.json",
    "bytes": 11958,
    "sha256": "890bd2a5d5f0304e47703f4ce562fa6d098fa954a654153271404c8cae4b9fd4"
  },
  {
    "path": "recovery/recovery-20261018-v1/FLOW-ACTIVATION-CONTRACT.md",
    "bytes": 8178,
    "sha256": "7f53152fdd46e68c66f0ac92338156b11be785bd29e7847452e2a211658907c9"
  },
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
    "path": "recovery/recovery-20261018-v1/meta/0099_snapshot.json",
    "bytes": 488317,
    "sha256": "e08e4184dbf674fa4c88d6e55f270f2e371b1541a046ab8da29068084fd9ca0c"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0100_snapshot.json",
    "bytes": 498108,
    "sha256": "fd218591c0165512dbaf63a36fed8ddd775cc577d090083510329c6d6779fc93"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0101_snapshot.json",
    "bytes": 507555,
    "sha256": "1631a6306279b57d76ef47a95f6ca6f063d7ef62d333e06f7b979c22b4ee6cd2"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0102_snapshot.json",
    "bytes": 537031,
    "sha256": "443ee53d6f553e665e9c1b72f540c277ad4dfb025bd052f5a3e95985e3096ba9"
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
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0099_recovery_security_policy_fences.sql",
    "bytes": 5540,
    "sha256": "30f22f1ee9cf0bf2104d6ef5803a51de993ade44c034bc25cd9f72dc046015a2"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0100_recovery_outbox_knowledge_heads.sql",
    "bytes": 5279,
    "sha256": "2780c167f92272e521b0e1cb39d904f61a9f83b643da5c857760f5aa1c532c62"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0101_ap2_parent_schema_reconcile_closed.sql",
    "bytes": 3715,
    "sha256": "c3c3c4c601261fd774cc729e1e117019385b6855bbd9d0d697174709db626da0"
  },
  {
    "path": "recovery/recovery-20261018-v1/sql/0102_approval_exact_input_objects_closed.sql",
    "bytes": 12931,
    "sha256": "6394f3f2f598888826339bd4037f2c8c82fd69768008368892599c913b08c64d"
  }
];
const protectedArtifacts = [...frozenArtifacts, ...[
  {
    "path": "recovery/recovery-20261018-v1/sql/0103_knowledge_foundations_closed.sql",
    "bytes": 11367,
    "sha256": "d8c2845d3cd0a89e517b68200e78b143e569e840b67e9e4a3467bdc83fe697ed"
  },
  {
    "path": "recovery/recovery-20261018-v1/meta/0103_snapshot.json",
    "bytes": 558672,
    "sha256": "235b48c0acfc9bf76871bcf4e2b0d636d357bdbfb6c4e796caa4a1e9092f91df"
  }
]];
const protected212 = [...protectedArtifacts,
  { path: "recovery/recovery-20261018-v1/sql/0104_resource_project_foundations_closed.sql", bytes: 7125, sha256: "1b03ea36d08be34439aa25d9d89f9a3fb3a2a9d6f1cf29ab3d9aac1cfda06951" },
  { path: "recovery/recovery-20261018-v1/meta/0104_snapshot.json", bytes: 570806, sha256: "1430962f8cf028bf688f92747cbc46599f38068b46868f98dbcd3fa3db81f3ee" },
];
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
        const onUpdate = c.peek() === "CASCADE"
          ? (c.take("CASCADE"), "cascade")
          : (c.take("NO"), c.take("ACTION"), "no action");
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
          onUpdate,
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
    let where: string | undefined;
    if (c.peek() === "WHERE") {
      c.take("WHERE");
      assert.ok(c.at < c.tokens.length, "WHERE expression cannot be empty");
      where = c.tokens.slice(c.at).join(" ");
      c.at = c.tokens.length;
    }
    c.finish();
    put(table.indexes, name, {
      name,
      columns,
      isUnique,
      concurrently: false,
      method: "btree",
      with: {},
      ...(where === undefined ? {} : { where }),
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
      ...(cfg.where === undefined ? {} : { where: render(cfg.where) }),
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
  for (const index of Object.values(copy.indexes)) {
    if (index.where !== undefined) index.where = expression(index.where);
    for (const column of index.columns)
      if (column.isExpression) column.expression = expression(column.expression);
  }
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
  for (const [key, table] of Object.entries(expected)) {
    const found = actual[key]; assert.ok(found);
    assert.deepEqual(normalize(found), normalize(table), key);
  }
}

function checkSQL(source: string): void {
  const parsed = parseSQL(source); equalTargets(parsed.tables); assert.deepEqual(parsed.forced, []);
}
function checkSnapshot(value: Snapshot): void {
  assert.equal(createHash("sha256").update(previousRaw).digest("hex"), "1430962f8cf028bf688f92747cbc46599f38068b46868f98dbcd3fa3db81f3ee");
  assert.equal(previous.id, "7df643dd-5eb2-4f7e-a5a7-9caf19f375c5");
  assert.equal(Object.keys(previous.tables).length, 146);
  assert.equal(value.id, "eaa15046-f3b6-4e8b-9509-29279faf2fc7");
  assert.equal(value.prevId, previous.id);
  const restored = structuredClone(value), added: Record<string, Table> = {};
  for (const key of Object.keys(value.tables)) if (!Object.hasOwn(previous.tables, key)) {
    const table = value.tables[key]; assert.ok(table); added[key] = table; delete restored.tables[key];
  }
  assert.deepEqual(added, expected); restored.id = previous.id; restored.prevId = previous.prevId;
  assert.deepEqual(restored, previous, "all146 complete old objects and every unknown top field remain exact");
  assert.equal(Object.keys(value.tables).length, 150);
}
function checkJournal(value: Journal): void {
  assert.equal(createHash("sha256").update(parentJournalRaw).digest("hex"), parentJournalSHA);
  const parent = JSON.parse(parentJournalRaw) as Journal;
  assert.equal(parent.entries.length, 105); assert.equal(value.version, parent.version); assert.equal(value.dialect, parent.dialect);
  assert.ok(value.entries.length >= 106); assert.deepEqual(value.entries.slice(0, 105), parent.entries);
  assert.deepEqual(value.entries[105], {idx:105,version:"7",when:1792409657000,tag:"0105_knowledge_write_foundations_closed",breakpoints:true});
  const {entries:_old,...oldTops}=parent, {entries:_new,...newTops}=value; assert.deepEqual(newTops,oldTops);
}
const actualMetadata = (): Record<string, Table> => Object.fromEntries(
  [knowledgeBindings, knowledgeReceipts, knowledgeWriteExecutions, knowledgeWriteClaims].map(model => { const table = metadata(model); return [`public.${table.name}`,table]; }),
);
function replaceOnce(source: string, from: string, to: string): string {
  assert.notEqual(from, to); assert.equal(source.split(from).length, 2, "exactly one literal mutation target");
  const changed = source.replace(from, to); assert.notEqual(changed, source); return changed;
}
function rejectSQLFragment(from: string, to: string): void {
  checkSQL(migration);
  const changed = replaceOnce(migration, from, to); const parsed = parseSQL(changed); assert.notDeepEqual(parsed.tables, parseSQL(migration).tables); expect(() => checkSQL(changed)).toThrow();
}
function rejectTableFragment(table: string, from: string, to: string): void {
  checkSQL(migration);
  const statements=migration.split("--> statement-breakpoint");
  const hits=statements.flatMap((statement,index)=>statement.includes(`CREATE TABLE "public"."${table}" (`)?[index]:[]);
  assert.equal(hits.length,1);const at=hits[0];assert.ok(at!==undefined);const original=statements[at];assert.ok(original);
  statements[at]=replaceOnce(original,from,to);const changed=statements.join("--> statement-breakpoint");
  const parsed=parseSQL(changed);assert.notDeepEqual(parsed.tables,parseSQL(migration).tables);expect(()=>checkSQL(changed)).toThrow();
}
function mutateMetadata(edit: (tables: Record<string, Table>) => void): void {
  const original = actualMetadata(); equalTargets(original);
  const changed = structuredClone(original); edit(changed);
  assert.notDeepEqual(changed, original); expect(() => equalTargets(changed)).toThrow();
}
function requireTable(tables: Record<string, Table>, name: string): Table {
  const value = tables[`public.${name}`]; assert.ok(value); return value;
}
function policyValue(table: string, name: string, slot: "using" | "withCheck"): string {
  const value = requireTable(expected, table).policies[name]?.[slot]; assert.ok(value !== undefined); return value;
}
function rejectPolicySlot(table: string, name: string, slot: "using" | "withCheck", edit: (expression: string) => string): void {
  checkSQL(migration);
  const original = policyValue(table, name, slot), changedExpression = edit(original);
  assert.notEqual(changedExpression, original);
  const statements = migration.split("--> statement-breakpoint"), marker = `CREATE POLICY "${name}" ON "public"."${table}"`;
  const hits = statements.flatMap((statement, index) => statement.includes(marker) ? [index] : []);
  assert.equal(hits.length, 1); const at = hits[0]; assert.ok(at !== undefined);
  const statement = statements[at]; assert.ok(statement);
  const keyword = slot === "using" ? "USING" : "WITH CHECK";
  statements[at] = replaceOnce(statement, `${keyword} (${original})`, `${keyword} (${changedExpression})`);
  const changedSQL = statements.join("--> statement-breakpoint"); assert.notEqual(changedSQL, migration);
  const before = parseSQL(migration).tables, after = parseSQL(changedSQL).tables;
  const oldPolicy = requireTable(before, table).policies[name], newPolicy = requireTable(after, table).policies[name];
  assert.ok(oldPolicy && newPolicy); assert.notEqual(newPolicy[slot], oldPolicy[slot]);
  for (const field of ["name", "as", "for", "to", "using", "withCheck"] as const)
    if (field !== slot) assert.deepEqual(newPolicy[field], oldPolicy[field]);
  const restored = structuredClone(after); requireTable(restored, table).policies[name] = structuredClone(oldPolicy);
  assert.deepEqual(restored, before, "other fifteen policies, other slot, columns and tables all unchanged");
  expect(() => checkSQL(changedSQL)).toThrow();
}

describe("0105 historical knowledge write foundations, SOURCE only not authority", () => {
  test("four original0121 objects retain independent exact complete bytes and43 columns", () => {
    expect(capsules).toHaveLength(4);
    for (const c of capsules) expect(createHash("sha256").update(c.raw).digest("hex")).toBe(c.sha256);
    expect(Object.values(expected).reduce((n,t)=>n+Object.keys(t.columns).length,0)).toBe(43);
    expect(Object.values(expected).reduce((n,t)=>n+Object.keys(t.policies).length,0)).toBe(16);
  });
  test("all34 CREATE ALTER INDEX POLICY statements are consumed and match whole oracle", () => {
    expect(parts(tokenize(migration), ";")).toHaveLength(34); checkSQL(migration);
  });
  test("actual Drizzle metadata fully matches four objects including partial WHERE", () => {
    equalTargets(actualMetadata());
    const cfg = getTableConfig(knowledgeWriteClaims).indexes.find(i=>i.config.name==="knowledge_claim_unresolved_target");
    assert.ok(cfg?.config.where); assert.equal(expression(render(cfg.config.where)),expression(requireTable(expected,"knowledge_write_claims").indexes.knowledge_claim_unresolved_target?.where ?? ""));
  });
  test("43 column types nullability PK flags and every default are individually compared", () => {
    checkSQL(migration); equalTargets(actualMetadata());
    for (const [name,t] of Object.entries(expected)) for (const [column,c] of Object.entries(t.columns)) {
      for (const edit of [
        (v:Column)=>{v.notNull=!v.notNull;}, (v:Column)=>{v.primaryKey=!v.primaryKey;},
        (v:Column)=>{v.type=v.type==="text"?"uuid":"text";},
        (v:Column)=>{if (Object.hasOwn(v,"default")) delete v.default; else v.default="'invented'";},
      ]) mutateMetadata(all=>{const v=all[name]?.columns[column];assert.ok(v);edit(v);assert.notDeepEqual(v,c);});
    }
  });
  test("no UUID auto default no extra JSON receipt or hash shape constraints", () => {
    const receipts=requireTable(expected,"knowledge_receipts"),claims=requireTable(expected,"knowledge_write_claims");
    assert.deepEqual(receipts.checkConstraints,{}); assert.equal(receipts.columns.request_hash?.type,"text");
    assert.equal(claims.columns.receipt_identity?.notNull,false); assert.equal(claims.columns.outcome?.notNull,false);
    for(const t of Object.values(expected)) for(const c of Object.values(t.columns)) if(c.type==="uuid") assert.equal(Object.hasOwn(c,"default"),false);
    rejectTableFragment("knowledge_receipts",'"request_hash" text NOT NULL','"request_hash" text DEFAULT \'invented\' NOT NULL');
    mutateMetadata(all=>{requireTable(all,"knowledge_receipts").checkConstraints.invented={name:"invented",value:"jsonb_typeof(receipt) = 'object'"};});
  });
  test("all8 FK delete and update16 distinct valid actions consume before oracle rejects", () => {
    checkSQL(migration);
    for(const t of Object.values(expected)) for(const fk of Object.values(t.foreignKeys)) {
      const from=`ALTER TABLE "public"."${t.name}" ADD CONSTRAINT "${fk.name}" FOREIGN KEY (${fk.columnsFrom.map(c=>`"${c}"`).join(", ")}) REFERENCES "public"."${fk.tableTo}" (${fk.columnsTo.map(c=>`"${c}"`).join(", ")}) ON DELETE CASCADE ON UPDATE NO ACTION;`;
      for(const [before,after,slot] of [["ON DELETE CASCADE","ON DELETE NO ACTION","onDelete"],["ON UPDATE NO ACTION","ON UPDATE CASCADE","onUpdate"]] as const) {
        const changed=replaceOnce(migration,from,replaceOnce(from,before,after));
        const parsed=requireTable(parseSQL(changed).tables,t.name).foreignKeys[fk.name];assert.ok(parsed);
        assert.notEqual(parsed[slot],fk[slot]);const restored=structuredClone(parsed);restored[slot]=fk[slot];assert.deepEqual(restored,fk);
        expect(()=>checkSQL(changed)).toThrow();
      }
    }
  });
  test("all FK parents and composite execution PK close without extra unique or owner epoch", () => {
    const parents=[users,agents,knowledgeNotebooks,knowledgeWriteExecutions].map(model => {
      const config = getTableConfig(model);
      // Parent FK closure needs keys/types only, not unrelated JSON/array defaults.
      // Four target tables still pass through the unchanged full metadata() checks.
      return {
        name: config.name,
        columns: Object.fromEntries(config.columns.map(column => [column.name, {
          name: column.name,
          type: column.getSQLType(),
          primaryKey: column.primary,
        }] as const)),
        compositePrimaryKeys: config.primaryKeys.map(key => ({
          columns: key.columns.map(column => column.name),
        })),
      };
    });
    for(const t of Object.values(actualMetadata())) for(const fk of Object.values(t.foreignKeys)) {
      const p=parents.find(p=>p.name===fk.tableTo);assert.ok(p);
      const keys=[...Object.values(p.compositePrimaryKeys).map(p=>p.columns),...Object.values(p.columns).filter(c=>c.primaryKey).map(c=>[c.name])];
      assert.ok(keys.some(key=>JSON.stringify(key)===JSON.stringify(fk.columnsTo)));
      fk.columnsFrom.forEach((c,i)=>assert.equal(t.columns[c]?.type,p.columns[fk.columnsTo[i] ?? ""]?.type));
    }
    const execution=requireTable(expected,"knowledge_write_executions");assert.deepEqual(execution.uniqueConstraints,{});
    const fk=requireTable(expected,"knowledge_write_claims").foreignKeys.knowledge_claim_execution_fk;assert.ok(fk);
    assert.deepEqual(fk.columnsFrom,["tenant_id","agent_id","run_id","thread_id"]);assert.deepEqual(fk.columnsTo,fk.columnsFrom);
    mutateMetadata(all=>{const f=requireTable(all,"knowledge_write_claims").foreignKeys.knowledge_claim_execution_fk;assert.ok(f);f.columnsTo=[...f.columnsTo].reverse();});
  });
  test("all3 named composite PK order and one inline UUID PK are exact", () => {
    checkSQL(migration);
    for(const t of Object.values(expected)) for(const pk of Object.values(t.compositePrimaryKeys)) {
      const from=`CONSTRAINT "${pk.name}" PRIMARY KEY (${pk.columns.map(c=>`"${c}"`).join(", ")})`;
      rejectSQLFragment(from,`CONSTRAINT "${pk.name}" PRIMARY KEY (${[...pk.columns].reverse().map(c=>`"${c}"`).join(", ")})`);
    }
    assert.equal(requireTable(expected,"knowledge_write_claims").columns.claim_id?.primaryKey,true);
    rejectSQLFragment('"claim_id" uuid NOT NULL PRIMARY KEY','"claim_id" uuid NOT NULL');
  });
  test("two ordinary UNIQUE not unique indexes retain full columns and false NULLS flag", () => {
    checkSQL(migration); const c=requireTable(expected,"knowledge_write_claims");
    expect(Object.keys(c.uniqueConstraints)).toEqual(["knowledge_claim_operation_unique","knowledge_claim_sdk_unique"]);
    for(const name of Object.keys(c.uniqueConstraints)) {
      mutateMetadata(all=>{const t=requireTable(all,"knowledge_write_claims");t.uniqueConstraints[name]={name,columns:[],nullsNotDistinct:true};});
      const needle=`CONSTRAINT "${name}" UNIQUE (`;rejectSQLFragment(needle,`CONSTRAINT "${name}" UNIQUE NULLS NOT DISTINCT (`);
    }
    assert.deepEqual(c.uniqueConstraints.knowledge_claim_operation_unique,{name:"knowledge_claim_operation_unique",nullsNotDistinct:false,columns:["operation_id"]});
    assert.deepEqual(c.uniqueConstraints.knowledge_claim_sdk_unique,{name:"knowledge_claim_sdk_unique",nullsNotDistinct:false,columns:["tenant_id","agent_id","run_id","thread_id","tool_call_id"]});
    mutateMetadata(all=>{delete requireTable(all,"knowledge_write_claims").uniqueConstraints.knowledge_claim_sdk_unique;});
  });
  test("partial WHERE four unresolved states individually lost added applied and removed all reject", () => {
    checkSQL(migration);
    const where=requireTable(expected,"knowledge_write_claims").indexes.knowledge_claim_unresolved_target?.where;assert.ok(where);
    for(const state of ["reserved","pending","ready","unknown"]) {
      const values=["reserved","pending","ready","unknown"].filter(v=>v!==state);
      rejectSQLFragment(`WHERE ${where}`,`WHERE "knowledge_write_claims"."state" IN (${values.map(v=>`'${v}'`).join(", ")})`);
    }
    rejectSQLFragment(`WHERE ${where}`,`WHERE ${where.replace("'unknown')","'unknown', 'applied')")}`);
    rejectSQLFragment(` WHERE ${where}`,"");
    rejectSQLFragment(`WHERE ${where}`,`WHERE ${where.replace('"state"','"agent_id"')}`);
    mutateMetadata(all=>{const i=requireTable(all,"knowledge_write_claims").indexes.knowledge_claim_unresolved_target;assert.ok(i);delete i.where;});
  });
  test("partial unique tenant target scope and flags cannot drift or become full ordinary UNIQUE", () => {
    const from='CREATE UNIQUE INDEX "knowledge_claim_unresolved_target" ON "public"."knowledge_write_claims" USING btree ("tenant_id" ASC NULLS LAST, "target_hash" ASC NULLS LAST)';
    rejectSQLFragment(from,from.replace("CREATE UNIQUE INDEX","CREATE INDEX"));
    rejectSQLFragment(from,from.replace('"target_hash" ASC','"agent_id" ASC'));
    for(const table of ["knowledge_bindings","knowledge_write_claims"]) for(const name of Object.keys(requireTable(expected,table).indexes))
      for(const edit of [(i:Index)=>{i.isUnique=!i.isUnique;},(i:Index)=>{i.concurrently=true;},(i:Index)=>{i.method="hash";},(i:Index)=>{i.with={fillfactor:50};},(i:Index)=>{const c=i.columns.at(-1);assert.ok(c);c.expression="run_id";}])
        mutateMetadata(all=>{const i=requireTable(all,table).indexes[name];assert.ok(i);edit(i);});
  });
  test("10 complete CHECKs independently reject branch mutation after full SQL consumption", () => {
    checkSQL(migration);
    for(const t of Object.values(expected)) for(const c of Object.values(t.checkConstraints))
      rejectSQLFragment(`CONSTRAINT "${c.name}" CHECK (${c.value})`,`CONSTRAINT "${c.name}" CHECK ((${c.value}) AND false)`);
    const execution=requireTable(expected,"knowledge_write_executions");
    for(const [before,after] of [["'system', 'platform'","'system'"],[">= 2",">= 1"],["IS NOT NULL","IS NULL"],["'active', 'stopped'","'active'"]]) {
      const c=Object.values(execution.checkConstraints).find(c=>c.value.includes(before));assert.ok(c);
      rejectSQLFragment(`CHECK (${c.value})`,`CHECK (${replaceOnce(c.value,before,after)})`);
    }
    const c=requireTable(expected,"knowledge_write_claims").checkConstraints.knowledge_claim_json;assert.ok(c);
    rejectSQLFragment(`CHECK (${c.value})`,`CHECK (${replaceOnce(c.value," = 'object' AND"," = 'array' AND")})`);
    const h=requireTable(expected,"knowledge_write_claims").checkConstraints.knowledge_claim_hashes;assert.ok(h);
    rejectSQLFragment(`CHECK (${h.value})`,`CHECK (${h.value.replaceAll("{64}","{63}")})`);
  });
  test("all20 policy slots change only that exact slot other15 policies remain identical", () => {
    let count=0;
    for(const t of Object.values(expected)) for(const p of Object.values(t.policies)) for(const slot of ["using","withCheck"] as const)
      if(p[slot]!==undefined) {rejectPolicySlot(t.name,p.name,slot,value=>`(${value}) AND false`);count++;}
    expect(count).toBe(20);
  });
  test("binding write slots retain live notebook plus agent profile scope without affecting reads", () => {
    for(const name of ["knowledge_binding_owner_insert","knowledge_binding_owner_update"]) {
      for(const [from,to] of [
        ["n.tenant_id = knowledge_bindings.tenant_id","n.tenant_id <> knowledge_bindings.tenant_id"],
        ["n.owner_user_id = knowledge_bindings.owner_user_id","n.owner_user_id <> knowledge_bindings.owner_user_id"],
        ["n.deleted_at IS NULL","n.deleted_at IS NOT NULL"],
        ["a.tenant_id = knowledge_bindings.tenant_id","a.tenant_id <> knowledge_bindings.tenant_id"],
        ["p.tenant_id = a.tenant_id","p.tenant_id <> a.tenant_id"],
        ["p.owner_user_id = knowledge_bindings.owner_user_id","p.owner_user_id <> knowledge_bindings.owner_user_id"],
        ["p.deleted_at IS NULL","p.deleted_at IS NOT NULL"],
      ]) rejectPolicySlot("knowledge_bindings",name,"withCheck",value=>replaceOnce(value,from,to));
    }
    for(const name of ["knowledge_binding_owner_select","knowledge_binding_owner_delete","knowledge_binding_owner_update"])
      assert.equal(policyValue("knowledge_bindings",name,"using").includes("EXISTS"),false);
  });
  test("receipt AND true and quoted unquoted policy forms are retained and not system grants", () => {
    for(const name of ["knowledge_receipt_owner_insert","knowledge_receipt_owner_update"])
      rejectPolicySlot("knowledge_receipts",name,"withCheck",v=>replaceOnce(v," AND true"," AND false"));
    for(const t of Object.values(expected)) for(const p of Object.values(t.policies)) for(const slot of ["using","withCheck"] as const) {
      const v=p[slot];if(v===undefined)continue;
      rejectPolicySlot(t.name,p.name,slot,s=>replaceOnce(s,"current_setting('app.tenant_id', true)","'system'"));
    }
  });
  test("UPDATE slots cannot replace each other or lose a required slot", () => {
    for(const t of Object.values(expected)) {
      const p=Object.values(t.policies).find(p=>p.for==="UPDATE");assert.ok(p);
      mutateMetadata(all=>{const pp=requireTable(all,t.name).policies[p.name];assert.ok(pp);delete pp.using;});
      mutateMetadata(all=>{const pp=requireTable(all,t.name).policies[p.name];assert.ok(pp);delete pp.withCheck;});
    }
    mutateMetadata(all=>{const p=requireTable(all,"knowledge_bindings").policies.knowledge_binding_owner_update;assert.ok(p);[p.using,p.withCheck]=[p.withCheck,p.using];});
  });
  test("unknown tail statements expressions and FORCE never silently pass", () => {
    checkSQL(migration);
    for(const suffix of ['GRANT ALL ON SCHEMA public TO public;','SELECT 1;','ALTER TABLE "public"."knowledge_bindings" FORCE ROW LEVEL SECURITY;']) expect(()=>checkSQL(migration+suffix)).toThrow();
    expect(()=>checkSQL(migration.replace('WHERE "knowledge_write_claims"."state" IN', 'WHERE GARBAGE "knowledge_write_claims"."state" IN'))).toThrow();
  });
  test("snapshot150 inverse146 keeps entire previous objects and unknown tops types arrays", () => {
    checkSnapshot(next);
    for(const edit of [(s:Snapshot)=>{s.prevId="wrong";},(s:Snapshot)=>{s.extra=[];},(s:Snapshot)=>{const t=s.tables["public.resource_projects"];assert.ok(t);t.columns={};},(s:Snapshot)=>{delete s.tables["public.knowledge_write_claims"];},(s:Snapshot)=>{const t=s.tables["public.knowledge_write_claims"];assert.ok(t);t.indexes={};}]) {
      const changed=structuredClone(next);edit(changed);assert.notDeepEqual(changed,next);expect(()=>checkSnapshot(changed)).toThrow();
    }
  });
  test("journal0..104 full prefix and exact105 suffix are data not activation", () => {
    checkJournal(journal);
    for(let index=0;index<=105;index++){const changed=structuredClone(journal);const r=changed.entries[index];assert.ok(r);r.tag="forged";expect(()=>checkJournal(changed)).toThrow();}
    const changed=structuredClone(journal);changed.entries.splice(80,1);expect(()=>checkJournal(changed)).toThrow();
  });
  test("literal210 prefix plus104 SQL then snapshot forms exact212 protected full hash loop", () => {
    expect(frozenArtifacts).toHaveLength(208);expect(protectedArtifacts).toHaveLength(210);
    expect(protected212.slice(0,210)).toEqual(protectedArtifacts);expect(protected212).toHaveLength(212);
    expect(new Set(protected212.map(f=>f.path)).size).toBe(212);
    expect(protected212.slice(210).map(f=>f.path)).toEqual(["recovery/recovery-20261018-v1/sql/0104_resource_project_foundations_closed.sql","recovery/recovery-20261018-v1/meta/0104_snapshot.json"]);
    expect(protected212.filter(f=>f.path.startsWith("drizzle/"))).toHaveLength(163);
    const r=protected212.filter(f=>f.path.startsWith("recovery/recovery-20261018-v1/"));
    expect(r.filter(f=>f.path.endsWith(".sql"))).toHaveLength(24);expect(r.filter(f=>f.path.endsWith("_snapshot.json"))).toHaveLength(24);
    expect(r.filter(f=>f.path.endsWith("FLOW-ACTIVATION-CONTRACT.md"))).toEqual([{path:"recovery/recovery-20261018-v1/FLOW-ACTIVATION-CONTRACT.md",bytes:8178,sha256:"7f53152fdd46e68c66f0ac92338156b11be785bd29e7847452e2a211658907c9"}]);
    for(const f of protected212){const b=readFileSync(join(server,f.path));expect(b.length).toBe(f.bytes);expect(createHash("sha256").update(b).digest("hex")).toBe(f.sha256);}
  });
  test("old103104 tests source and original163 migration identities remain exact", () => {
    for(const f of [
      {path:"tests/recovery-knowledge-foundations.test.ts",bytes:95182,sha256:"8246be120f1ca64ec954512887140da90b785eb777082aaabbd10348ed7282cb"},
      {path:"tests/recovery-resource-project-foundations.test.ts",bytes:111726,sha256:"018f89eb541d2820fe6db0dcb327051b29407f7e2f77ecda637781d6b6645e81"},
      {path:"src/db/schema/knowledge-foundations.ts",bytes:12034,sha256:"c3b435ec2ea1784af2408e8ee4fe982e88813b47707ce0aedbc196d57f00b845"},
      {path:"src/db/schema/resource-project-foundations.ts",bytes:7601,sha256:"67a6aa010626fd0f9b46e602359fad7e50421002d975c18752621b14946e9732"},
    ]) {const b=readFileSync(join(server,f.path));expect(b.length).toBe(f.bytes);expect(createHash("sha256").update(b).digest("hex")).toBe(f.sha256);}
    const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const p=join(dir,entry.name);return entry.isDirectory()?walk(p):[p];});
    const dir=join(server,"drizzle"),files=walk(dir).sort();expect(files).toHaveLength(163);
    const lines=files.map(p=>{const b=readFileSync(p);return `${relative(dir,p)}\0${b.length}\0${createHash("sha256").update(b).digest("hex")}\n`;});
    expect(createHash("sha256").update(lines.join("")).digest("hex")).toBe("9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d");
  });
});

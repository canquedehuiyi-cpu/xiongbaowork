import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { approvalExactInputCaptures, approvalExactInputObjects } from "../src/db/schema/approval-exact-input-objects";
import { approvalContinuations, approvalContinuationSteps, approvalRequests } from "../src/db/schema/approvals";
import { approvalDirectExecutionDomains } from "../src/db/schema/approval-direct-execution-domains";
import { threads } from "../src/db/schema/threads";
import { users, agents } from "../src/db/schema/core";
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


// Root hand-frozen contract, sealed before authoring SQL/schema. Not inferred from the after snapshot.
const matrixRaw = "{\n  \"authority\": \"Root AP4_EXACT_OBJECT_SCHEMA_CLOSED_V1_SOURCE_ONLY; independently transcribed before source\",\n  \"generation\": {\n    \"idx\": 102,\n    \"tag\": \"0102_approval_exact_input_objects_closed\",\n    \"id\": \"66afc67c-2ebd-4e41-8ca0-3cbe849a0102\",\n    \"prevId\": \"5ae0628f-dd5e-42e2-8373-74c4312817aa\",\n    \"when\": 1792386460367\n  },\n  \"sharedScope\": [\n    \"approval_id\",\n    \"tenant_id\",\n    \"owner_user_id\",\n    \"actor_user_id\",\n    \"domain_id\",\n    \"thread_id\",\n    \"agent_id\",\n    \"approval_run_id\",\n    \"source_actual_run_id\",\n    \"tool_call_id\",\n    \"action_digest\",\n    \"source_binding_version\",\n    \"codec_version\"\n  ],\n  \"budgetTextScope\": [\n    \"approval_id\",\n    \"tenant_id\",\n    \"owner_user_id\",\n    \"actor_user_id\",\n    \"thread_id\",\n    \"agent_id\",\n    \"approval_run_id\",\n    \"source_actual_run_id\",\n    \"tool_call_id\",\n    \"action_digest\",\n    \"source_binding_version\",\n    \"codec_version\"\n  ],\n  \"targets\": {\n    \"public.approval_exact_input_captures\": {\n      \"name\": \"approval_exact_input_captures\",\n      \"schema\": \"\",\n      \"columns\": {\n        \"id\": {\n          \"name\": \"id\",\n          \"type\": \"uuid\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"codec_version\": {\n          \"name\": \"codec_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"stage\": {\n          \"name\": \"stage\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"approval_id\": {\n          \"name\": \"approval_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"tenant_id\": {\n          \"name\": \"tenant_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"owner_user_id\": {\n          \"name\": \"owner_user_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"actor_user_id\": {\n          \"name\": \"actor_user_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"domain_id\": {\n          \"name\": \"domain_id\",\n          \"type\": \"uuid\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"thread_id\": {\n          \"name\": \"thread_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"agent_id\": {\n          \"name\": \"agent_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"approval_run_id\": {\n          \"name\": \"approval_run_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"source_actual_run_id\": {\n          \"name\": \"source_actual_run_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"tool_call_id\": {\n          \"name\": \"tool_call_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"action_digest\": {\n          \"name\": \"action_digest\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"source_binding\": {\n          \"name\": \"source_binding\",\n          \"type\": \"jsonb\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"source_binding_version\": {\n          \"name\": \"source_binding_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"plaintext_sha256\": {\n          \"name\": \"plaintext_sha256\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"key_version\": {\n          \"name\": \"key_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"envelope_wire_version\": {\n          \"name\": \"envelope_wire_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"envelope_bytes\": {\n          \"name\": \"envelope_bytes\",\n          \"type\": \"bytea\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"created_at\": {\n          \"name\": \"created_at\",\n          \"type\": \"timestamp with time zone\",\n          \"primaryKey\": false,\n          \"notNull\": true,\n          \"default\": \"clock_timestamp()\"\n        }\n      },\n      \"indexes\": {\n        \"apx_capture_domain_idx\": {\n          \"name\": \"apx_capture_domain_idx\",\n          \"columns\": [\n            {\n              \"expression\": \"domain_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"tenant_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"owner_user_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"thread_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"agent_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            }\n          ],\n          \"isUnique\": false,\n          \"concurrently\": false,\n          \"method\": \"btree\",\n          \"with\": {}\n        }\n      },\n      \"foreignKeys\": {\n        \"apx_capture_approval_fk\": {\n          \"name\": \"apx_capture_approval_fk\",\n          \"tableFrom\": \"approval_exact_input_captures\",\n          \"tableTo\": \"approval_requests\",\n          \"columnsFrom\": [\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\"\n          ],\n          \"columnsTo\": [\n            \"id\",\n            \"tenant_id\",\n            \"owner_user_id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_capture_domain_fk\": {\n          \"name\": \"apx_capture_domain_fk\",\n          \"tableFrom\": \"approval_exact_input_captures\",\n          \"tableTo\": \"approval_direct_execution_domains\",\n          \"columnsFrom\": [\n            \"domain_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"thread_id\",\n            \"agent_id\"\n          ],\n          \"columnsTo\": [\n            \"domain_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"thread_id\",\n            \"agent_id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_capture_thread_fk\": {\n          \"name\": \"apx_capture_thread_fk\",\n          \"tableFrom\": \"approval_exact_input_captures\",\n          \"tableTo\": \"threads\",\n          \"columnsFrom\": [\n            \"thread_id\",\n            \"tenant_id\",\n            \"agent_id\"\n          ],\n          \"columnsTo\": [\n            \"id\",\n            \"tenant_id\",\n            \"agent_id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_capture_owner_fk\": {\n          \"name\": \"apx_capture_owner_fk\",\n          \"tableFrom\": \"approval_exact_input_captures\",\n          \"tableTo\": \"users\",\n          \"columnsFrom\": [\n            \"owner_user_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_capture_actor_fk\": {\n          \"name\": \"apx_capture_actor_fk\",\n          \"tableFrom\": \"approval_exact_input_captures\",\n          \"tableTo\": \"users\",\n          \"columnsFrom\": [\n            \"actor_user_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_capture_agent_fk\": {\n          \"name\": \"apx_capture_agent_fk\",\n          \"tableFrom\": \"approval_exact_input_captures\",\n          \"tableTo\": \"agents\",\n          \"columnsFrom\": [\n            \"agent_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        }\n      },\n      \"compositePrimaryKeys\": {\n        \"apx_capture_pk\": {\n          \"name\": \"apx_capture_pk\",\n          \"columns\": [\n            \"id\"\n          ]\n        }\n      },\n      \"uniqueConstraints\": {\n        \"apx_capture_approval_scope_uq\": {\n          \"name\": \"apx_capture_approval_scope_uq\",\n          \"columns\": [\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\"\n          ],\n          \"nullsNotDistinct\": false\n        },\n        \"apx_capture_scope_hash_uq\": {\n          \"name\": \"apx_capture_scope_hash_uq\",\n          \"columns\": [\n            \"id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"plaintext_sha256\"\n          ],\n          \"nullsNotDistinct\": false\n        },\n        \"apx_capture_shared_scope_uq\": {\n          \"name\": \"apx_capture_shared_scope_uq\",\n          \"columns\": [\n            \"id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"actor_user_id\",\n            \"domain_id\",\n            \"thread_id\",\n            \"agent_id\",\n            \"approval_run_id\",\n            \"source_actual_run_id\",\n            \"tool_call_id\",\n            \"action_digest\",\n            \"source_binding_version\",\n            \"codec_version\",\n            \"plaintext_sha256\"\n          ],\n          \"nullsNotDistinct\": false\n        }\n      },\n      \"policies\": {},\n      \"checkConstraints\": {\n        \"apx_capture_codec_ck\": {\n          \"name\": \"apx_capture_codec_ck\",\n          \"value\": \"\\\"codec_version\\\" = 'OPENBOT_EXACT_INPUT_JSON_V1'\"\n        },\n        \"apx_capture_stage_ck\": {\n          \"name\": \"apx_capture_stage_ck\",\n          \"value\": \"\\\"stage\\\" = 'capture'\"\n        },\n        \"apx_capture_sha_ck\": {\n          \"name\": \"apx_capture_sha_ck\",\n          \"value\": \"\\\"plaintext_sha256\\\" ~ '^[a-f0-9]{64}$'\"\n        },\n        \"apx_capture_binding_object_ck\": {\n          \"name\": \"apx_capture_binding_object_ck\",\n          \"value\": \"jsonb_typeof(\\\"source_binding\\\") = 'object'\"\n        },\n        \"apx_capture_binding_version_ck\": {\n          \"name\": \"apx_capture_binding_version_ck\",\n          \"value\": \"\\\"source_binding_version\\\" = 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'\"\n        },\n        \"apx_capture_wire_version_ck\": {\n          \"name\": \"apx_capture_wire_version_ck\",\n          \"value\": \"\\\"envelope_wire_version\\\" = 'OPENBOT_APPROVAL_EXACT_WIRE_V1'\"\n        },\n        \"apx_capture_wire_size_ck\": {\n          \"name\": \"apx_capture_wire_size_ck\",\n          \"value\": \"octet_length(\\\"envelope_bytes\\\") BETWEEN 64 AND 1048639\"\n        },\n        \"apx_capture_scope_budget_ck\": {\n          \"name\": \"apx_capture_scope_budget_ck\",\n          \"value\": \"octet_length(\\\"approval_id\\\") + octet_length(\\\"tenant_id\\\") + octet_length(\\\"owner_user_id\\\") + octet_length(\\\"actor_user_id\\\") + octet_length(\\\"thread_id\\\") + octet_length(\\\"agent_id\\\") + octet_length(\\\"approval_run_id\\\") + octet_length(\\\"source_actual_run_id\\\") + octet_length(\\\"tool_call_id\\\") + octet_length(\\\"action_digest\\\") + octet_length(\\\"source_binding_version\\\") + octet_length(\\\"codec_version\\\") <= 1536\"\n        },\n        \"apx_capture_scope_nonempty_ck\": {\n          \"name\": \"apx_capture_scope_nonempty_ck\",\n          \"value\": \"octet_length(\\\"approval_id\\\") > 0 AND octet_length(\\\"tenant_id\\\") > 0 AND octet_length(\\\"owner_user_id\\\") > 0 AND octet_length(\\\"actor_user_id\\\") > 0 AND octet_length(\\\"thread_id\\\") > 0 AND octet_length(\\\"agent_id\\\") > 0 AND octet_length(\\\"approval_run_id\\\") > 0 AND octet_length(\\\"source_actual_run_id\\\") > 0 AND octet_length(\\\"tool_call_id\\\") > 0 AND octet_length(\\\"action_digest\\\") > 0 AND octet_length(\\\"source_binding_version\\\") > 0 AND octet_length(\\\"codec_version\\\") > 0\"\n        },\n        \"apx_capture_key_version_ck\": {\n          \"name\": \"apx_capture_key_version_ck\",\n          \"value\": \"octet_length(\\\"key_version\\\") > 0\"\n        }\n      },\n      \"isRLSEnabled\": true\n    },\n    \"public.approval_exact_input_objects\": {\n      \"name\": \"approval_exact_input_objects\",\n      \"schema\": \"\",\n      \"columns\": {\n        \"id\": {\n          \"name\": \"id\",\n          \"type\": \"uuid\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"codec_version\": {\n          \"name\": \"codec_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"stage\": {\n          \"name\": \"stage\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"approval_id\": {\n          \"name\": \"approval_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"tenant_id\": {\n          \"name\": \"tenant_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"owner_user_id\": {\n          \"name\": \"owner_user_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"actor_user_id\": {\n          \"name\": \"actor_user_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"domain_id\": {\n          \"name\": \"domain_id\",\n          \"type\": \"uuid\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"thread_id\": {\n          \"name\": \"thread_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"agent_id\": {\n          \"name\": \"agent_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"approval_run_id\": {\n          \"name\": \"approval_run_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"source_actual_run_id\": {\n          \"name\": \"source_actual_run_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"tool_call_id\": {\n          \"name\": \"tool_call_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"action_digest\": {\n          \"name\": \"action_digest\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"source_binding\": {\n          \"name\": \"source_binding\",\n          \"type\": \"jsonb\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"source_binding_version\": {\n          \"name\": \"source_binding_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"plaintext_sha256\": {\n          \"name\": \"plaintext_sha256\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"key_version\": {\n          \"name\": \"key_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"envelope_wire_version\": {\n          \"name\": \"envelope_wire_version\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"envelope_bytes\": {\n          \"name\": \"envelope_bytes\",\n          \"type\": \"bytea\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"created_at\": {\n          \"name\": \"created_at\",\n          \"type\": \"timestamp with time zone\",\n          \"primaryKey\": false,\n          \"notNull\": true,\n          \"default\": \"clock_timestamp()\"\n        },\n        \"capture_id\": {\n          \"name\": \"capture_id\",\n          \"type\": \"uuid\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"capture_sha256\": {\n          \"name\": \"capture_sha256\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"saved_result_digest\": {\n          \"name\": \"saved_result_digest\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"admission_id\": {\n          \"name\": \"admission_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"input_digest\": {\n          \"name\": \"input_digest\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"plan_identity\": {\n          \"name\": \"plan_identity\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"plan_run_id\": {\n          \"name\": \"plan_run_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"target_run_id\": {\n          \"name\": \"target_run_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        }\n      },\n      \"indexes\": {\n        \"apx_prepared_capture_idx\": {\n          \"name\": \"apx_prepared_capture_idx\",\n          \"columns\": [\n            {\n              \"expression\": \"capture_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"approval_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"tenant_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"owner_user_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"actor_user_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"domain_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"thread_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"agent_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"approval_run_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"source_actual_run_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"tool_call_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"action_digest\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"source_binding_version\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"codec_version\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"capture_sha256\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            }\n          ],\n          \"isUnique\": false,\n          \"concurrently\": false,\n          \"method\": \"btree\",\n          \"with\": {}\n        },\n        \"apx_prepared_domain_idx\": {\n          \"name\": \"apx_prepared_domain_idx\",\n          \"columns\": [\n            {\n              \"expression\": \"domain_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"tenant_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"owner_user_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"thread_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"agent_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            }\n          ],\n          \"isUnique\": false,\n          \"concurrently\": false,\n          \"method\": \"btree\",\n          \"with\": {}\n        }\n      },\n      \"foreignKeys\": {\n        \"apx_prepared_approval_fk\": {\n          \"name\": \"apx_prepared_approval_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"approval_requests\",\n          \"columnsFrom\": [\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\"\n          ],\n          \"columnsTo\": [\n            \"id\",\n            \"tenant_id\",\n            \"owner_user_id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_prepared_domain_fk\": {\n          \"name\": \"apx_prepared_domain_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"approval_direct_execution_domains\",\n          \"columnsFrom\": [\n            \"domain_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"thread_id\",\n            \"agent_id\"\n          ],\n          \"columnsTo\": [\n            \"domain_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"thread_id\",\n            \"agent_id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_prepared_thread_fk\": {\n          \"name\": \"apx_prepared_thread_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"threads\",\n          \"columnsFrom\": [\n            \"thread_id\",\n            \"tenant_id\",\n            \"agent_id\"\n          ],\n          \"columnsTo\": [\n            \"id\",\n            \"tenant_id\",\n            \"agent_id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_prepared_owner_fk\": {\n          \"name\": \"apx_prepared_owner_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"users\",\n          \"columnsFrom\": [\n            \"owner_user_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_prepared_actor_fk\": {\n          \"name\": \"apx_prepared_actor_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"users\",\n          \"columnsFrom\": [\n            \"actor_user_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_prepared_agent_fk\": {\n          \"name\": \"apx_prepared_agent_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"agents\",\n          \"columnsFrom\": [\n            \"agent_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_prepared_capture_scope_fk\": {\n          \"name\": \"apx_prepared_capture_scope_fk\",\n          \"tableFrom\": \"approval_exact_input_objects\",\n          \"tableTo\": \"approval_exact_input_captures\",\n          \"columnsFrom\": [\n            \"capture_id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"actor_user_id\",\n            \"domain_id\",\n            \"thread_id\",\n            \"agent_id\",\n            \"approval_run_id\",\n            \"source_actual_run_id\",\n            \"tool_call_id\",\n            \"action_digest\",\n            \"source_binding_version\",\n            \"codec_version\",\n            \"capture_sha256\"\n          ],\n          \"columnsTo\": [\n            \"id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"actor_user_id\",\n            \"domain_id\",\n            \"thread_id\",\n            \"agent_id\",\n            \"approval_run_id\",\n            \"source_actual_run_id\",\n            \"tool_call_id\",\n            \"action_digest\",\n            \"source_binding_version\",\n            \"codec_version\",\n            \"plaintext_sha256\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        }\n      },\n      \"compositePrimaryKeys\": {\n        \"apx_prepared_pk\": {\n          \"name\": \"apx_prepared_pk\",\n          \"columns\": [\n            \"id\"\n          ]\n        }\n      },\n      \"uniqueConstraints\": {\n        \"apx_prepared_approval_scope_uq\": {\n          \"name\": \"apx_prepared_approval_scope_uq\",\n          \"columns\": [\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\"\n          ],\n          \"nullsNotDistinct\": false\n        },\n        \"apx_prepared_scope_hash_uq\": {\n          \"name\": \"apx_prepared_scope_hash_uq\",\n          \"columns\": [\n            \"id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"plaintext_sha256\"\n          ],\n          \"nullsNotDistinct\": false\n        }\n      },\n      \"policies\": {},\n      \"checkConstraints\": {\n        \"apx_prepared_codec_ck\": {\n          \"name\": \"apx_prepared_codec_ck\",\n          \"value\": \"\\\"codec_version\\\" = 'OPENBOT_EXACT_INPUT_JSON_V1'\"\n        },\n        \"apx_prepared_stage_ck\": {\n          \"name\": \"apx_prepared_stage_ck\",\n          \"value\": \"\\\"stage\\\" = 'prepared'\"\n        },\n        \"apx_prepared_sha_ck\": {\n          \"name\": \"apx_prepared_sha_ck\",\n          \"value\": \"\\\"plaintext_sha256\\\" ~ '^[a-f0-9]{64}$'\"\n        },\n        \"apx_prepared_binding_object_ck\": {\n          \"name\": \"apx_prepared_binding_object_ck\",\n          \"value\": \"jsonb_typeof(\\\"source_binding\\\") = 'object'\"\n        },\n        \"apx_prepared_binding_version_ck\": {\n          \"name\": \"apx_prepared_binding_version_ck\",\n          \"value\": \"\\\"source_binding_version\\\" = 'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'\"\n        },\n        \"apx_prepared_wire_version_ck\": {\n          \"name\": \"apx_prepared_wire_version_ck\",\n          \"value\": \"\\\"envelope_wire_version\\\" = 'OPENBOT_APPROVAL_EXACT_WIRE_V1'\"\n        },\n        \"apx_prepared_wire_size_ck\": {\n          \"name\": \"apx_prepared_wire_size_ck\",\n          \"value\": \"octet_length(\\\"envelope_bytes\\\") BETWEEN 64 AND 1048639\"\n        },\n        \"apx_prepared_scope_budget_ck\": {\n          \"name\": \"apx_prepared_scope_budget_ck\",\n          \"value\": \"octet_length(\\\"approval_id\\\") + octet_length(\\\"tenant_id\\\") + octet_length(\\\"owner_user_id\\\") + octet_length(\\\"actor_user_id\\\") + octet_length(\\\"thread_id\\\") + octet_length(\\\"agent_id\\\") + octet_length(\\\"approval_run_id\\\") + octet_length(\\\"source_actual_run_id\\\") + octet_length(\\\"tool_call_id\\\") + octet_length(\\\"action_digest\\\") + octet_length(\\\"source_binding_version\\\") + octet_length(\\\"codec_version\\\") <= 1536\"\n        },\n        \"apx_prepared_scope_nonempty_ck\": {\n          \"name\": \"apx_prepared_scope_nonempty_ck\",\n          \"value\": \"octet_length(\\\"approval_id\\\") > 0 AND octet_length(\\\"tenant_id\\\") > 0 AND octet_length(\\\"owner_user_id\\\") > 0 AND octet_length(\\\"actor_user_id\\\") > 0 AND octet_length(\\\"thread_id\\\") > 0 AND octet_length(\\\"agent_id\\\") > 0 AND octet_length(\\\"approval_run_id\\\") > 0 AND octet_length(\\\"source_actual_run_id\\\") > 0 AND octet_length(\\\"tool_call_id\\\") > 0 AND octet_length(\\\"action_digest\\\") > 0 AND octet_length(\\\"source_binding_version\\\") > 0 AND octet_length(\\\"codec_version\\\") > 0\"\n        },\n        \"apx_prepared_key_version_ck\": {\n          \"name\": \"apx_prepared_key_version_ck\",\n          \"value\": \"octet_length(\\\"key_version\\\") > 0\"\n        },\n        \"apx_prepared_capture_sha_ck\": {\n          \"name\": \"apx_prepared_capture_sha_ck\",\n          \"value\": \"\\\"capture_sha256\\\" ~ '^[a-f0-9]{64}$'\"\n        }\n      },\n      \"isRLSEnabled\": true\n    },\n    \"public.approval_continuations\": {\n      \"name\": \"approval_continuations\",\n      \"schema\": \"\",\n      \"columns\": {\n        \"approval_id\": {\n          \"name\": \"approval_id\",\n          \"type\": \"text\",\n          \"primaryKey\": true,\n          \"notNull\": true\n        },\n        \"tenant_id\": {\n          \"name\": \"tenant_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true,\n          \"default\": \"current_setting('app.tenant_id', true)\"\n        },\n        \"owner_user_id\": {\n          \"name\": \"owner_user_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"input_digest\": {\n          \"name\": \"input_digest\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"admission_id\": {\n          \"name\": \"admission_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"branch_kind\": {\n          \"name\": \"branch_kind\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"branch_target_id\": {\n          \"name\": \"branch_target_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"origin\": {\n          \"name\": \"origin\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"state\": {\n          \"name\": \"state\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": true\n        },\n        \"fence\": {\n          \"name\": \"fence\",\n          \"type\": \"bigint\",\n          \"primaryKey\": false,\n          \"notNull\": true,\n          \"default\": 0\n        },\n        \"claim_owner\": {\n          \"name\": \"claim_owner\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"lease_until\": {\n          \"name\": \"lease_until\",\n          \"type\": \"timestamp with time zone\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"intent_id\": {\n          \"name\": \"intent_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"intent_fence\": {\n          \"name\": \"intent_fence\",\n          \"type\": \"bigint\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"proof_id\": {\n          \"name\": \"proof_id\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"receipt\": {\n          \"name\": \"receipt\",\n          \"type\": \"jsonb\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"last_reason\": {\n          \"name\": \"last_reason\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"completed_at\": {\n          \"name\": \"completed_at\",\n          \"type\": \"timestamp with time zone\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"exact_object_id\": {\n          \"name\": \"exact_object_id\",\n          \"type\": \"uuid\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        },\n        \"exact_plaintext_sha256\": {\n          \"name\": \"exact_plaintext_sha256\",\n          \"type\": \"text\",\n          \"primaryKey\": false,\n          \"notNull\": false\n        }\n      },\n      \"indexes\": {\n        \"approval_continuations_owner_idx\": {\n          \"name\": \"approval_continuations_owner_idx\",\n          \"columns\": [\n            {\n              \"expression\": \"tenant_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"owner_user_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"state\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            }\n          ],\n          \"isUnique\": false,\n          \"concurrently\": false,\n          \"method\": \"btree\",\n          \"with\": {}\n        },\n        \"apx_ledger_prepared_idx\": {\n          \"name\": \"apx_ledger_prepared_idx\",\n          \"columns\": [\n            {\n              \"expression\": \"exact_object_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"approval_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"tenant_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"owner_user_id\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            },\n            {\n              \"expression\": \"exact_plaintext_sha256\",\n              \"isExpression\": false,\n              \"asc\": true,\n              \"nulls\": \"last\"\n            }\n          ],\n          \"isUnique\": false,\n          \"concurrently\": false,\n          \"method\": \"btree\",\n          \"with\": {}\n        }\n      },\n      \"foreignKeys\": {\n        \"approval_continuations_approval_id_approval_requests_id_fk\": {\n          \"name\": \"approval_continuations_approval_id_approval_requests_id_fk\",\n          \"tableFrom\": \"approval_continuations\",\n          \"tableTo\": \"approval_requests\",\n          \"columnsFrom\": [\n            \"approval_id\"\n          ],\n          \"columnsTo\": [\n            \"id\"\n          ],\n          \"onDelete\": \"cascade\",\n          \"onUpdate\": \"no action\"\n        },\n        \"apx_ledger_prepared_fk\": {\n          \"name\": \"apx_ledger_prepared_fk\",\n          \"tableFrom\": \"approval_continuations\",\n          \"tableTo\": \"approval_exact_input_objects\",\n          \"columnsFrom\": [\n            \"exact_object_id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"exact_plaintext_sha256\"\n          ],\n          \"columnsTo\": [\n            \"id\",\n            \"approval_id\",\n            \"tenant_id\",\n            \"owner_user_id\",\n            \"plaintext_sha256\"\n          ],\n          \"onDelete\": \"no action\",\n          \"onUpdate\": \"no action\"\n        }\n      },\n      \"compositePrimaryKeys\": {},\n      \"uniqueConstraints\": {\n        \"approval_continuations_admission_id_unique\": {\n          \"name\": \"approval_continuations_admission_id_unique\",\n          \"nullsNotDistinct\": false,\n          \"columns\": [\n            \"admission_id\"\n          ]\n        }\n      },\n      \"policies\": {},\n      \"checkConstraints\": {\n        \"approval_continuations_state_check\": {\n          \"name\": \"approval_continuations_state_check\",\n          \"value\": \"\\\"approval_continuations\\\".\\\"state\\\" in ('ready','claimed','dispatched','unknown','completed')\"\n        },\n        \"approval_continuations_origin_check\": {\n          \"name\": \"approval_continuations_origin_check\",\n          \"value\": \"\\\"approval_continuations\\\".\\\"origin\\\" in ('current','legacy_unknown')\"\n        },\n        \"approval_continuations_legacy_check\": {\n          \"name\": \"approval_continuations_legacy_check\",\n          \"value\": \"\\\"approval_continuations\\\".\\\"origin\\\" <> 'legacy_unknown' or \\\"approval_continuations\\\".\\\"state\\\" not in ('ready','claimed','dispatched')\"\n        },\n        \"approval_continuations_receipt_check\": {\n          \"name\": \"approval_continuations_receipt_check\",\n          \"value\": \"(\\\"approval_continuations\\\".\\\"state\\\" = 'completed') = (\\\"approval_continuations\\\".\\\"receipt\\\" is not null and \\\"approval_continuations\\\".\\\"completed_at\\\" is not null)\"\n        },\n        \"approval_continuations_fence_check\": {\n          \"name\": \"approval_continuations_fence_check\",\n          \"value\": \"\\\"approval_continuations\\\".\\\"fence\\\" >= 0\"\n        },\n        \"apx_ledger_ref_pair_ck\": {\n          \"name\": \"apx_ledger_ref_pair_ck\",\n          \"value\": \"(\\\"exact_object_id\\\" IS NULL) = (\\\"exact_plaintext_sha256\\\" IS NULL)\"\n        },\n        \"apx_ledger_ref_sha_ck\": {\n          \"name\": \"apx_ledger_ref_sha_ck\",\n          \"value\": \"\\\"exact_plaintext_sha256\\\" IS NULL OR \\\"exact_plaintext_sha256\\\" ~ '^[a-f0-9]{64}$'\"\n        }\n      },\n      \"isRLSEnabled\": true\n    }\n  },\n  \"forced\": [\n    \"approval_exact_input_captures\",\n    \"approval_exact_input_objects\"\n  ],\n  \"headerOracle\": {\n    \"version\": \"OPENBOT_APPROVAL_EXACT_HEADER_V1\",\n    \"captureExactKeys\": [\n      \"headerVersion\",\n      \"codecVersion\",\n      \"stage\",\n      \"objectId\",\n      \"approvalId\",\n      \"tenantId\",\n      \"ownerUserId\",\n      \"actorUserId\",\n      \"domainId\",\n      \"threadId\",\n      \"agentId\",\n      \"approvalRunId\",\n      \"sourceActualRunId\",\n      \"toolCallId\",\n      \"actionDigest\",\n      \"sourceBindingVersion\",\n      \"sourceBinding\",\n      \"plaintextSha256\",\n      \"keyVersion\",\n      \"envelopeWireVersion\"\n    ],\n    \"preparedExactKeys\": [\n      \"headerVersion\",\n      \"codecVersion\",\n      \"stage\",\n      \"objectId\",\n      \"approvalId\",\n      \"tenantId\",\n      \"ownerUserId\",\n      \"actorUserId\",\n      \"domainId\",\n      \"threadId\",\n      \"agentId\",\n      \"approvalRunId\",\n      \"sourceActualRunId\",\n      \"toolCallId\",\n      \"actionDigest\",\n      \"sourceBindingVersion\",\n      \"sourceBinding\",\n      \"plaintextSha256\",\n      \"keyVersion\",\n      \"envelopeWireVersion\",\n      \"captureId\",\n      \"captureSha256\",\n      \"savedResultDigest\",\n      \"admissionId\",\n      \"inputDigest\",\n      \"planIdentity\",\n      \"planRunId\",\n      \"targetRunId\"\n    ],\n    \"canonicalUtf8Max\": 32768,\n    \"noOwnShaEnvelopeCreatedAt\": true\n  },\n  \"wireOracle\": {\n    \"version\": \"OPENBOT_APPROVAL_EXACT_WIRE_V1\",\n    \"asciiVersionBytes\": 30,\n    \"nulBytes\": 1,\n    \"nonceBytes\": 12,\n    \"lengthBytes\": 4,\n    \"prefixBytes\": 47,\n    \"ciphertextAndTagMin\": 17,\n    \"ciphertextAndTagMax\": 1048592,\n    \"totalMin\": 64,\n    \"totalMax\": 1048639,\n    \"internalVersion\": \"OPENBOT_APPROVAL_EXACT_AEAD_V1\",\n    \"algorithm\": \"AES-256-GCM\",\n    \"implementation\": \"NOT_IN_THIS_PACKAGE\"\n  },\n  \"unimplemented\": [\n    \"producer/materializer/keyprovider/registry/runauthority\",\n    \"cross-object sourceBinding/config/tool/transform full equality\",\n    \"decodedPrepared.inputDigest===immutablePlan.inputDigest===ledger.input_digest\",\n    \"one physical transaction prepared+ledger/full mismatch rollback\",\n    \"writer permissions/privileged appendonly/retention maintenance\",\n    \"PG catalog/NO ACTION cascade behavior/wire/AEAD authentication\"\n  ],\n  \"boundaries\": {\n    \"ROOT_RELEASE\": null,\n    \"ready\": false,\n    \"AP_DISABLED\": true,\n    \"migration\": \"NOT_WIRED\",\n    \"service\": \"NOT_WIRED\",\n    \"PG\": \"PG_PENDING\",\n    \"projectExecution\": \"NOT_RUN_RESOURCE\",\n    \"historicalSource\": \"37/51,14remaining unchanged\"\n  }\n}\n";
type Contract = { targets: Record<string, Table>; sharedScope: string[]; budgetTextScope: string[]; forced: string[]; headerOracle: { version: string; captureExactKeys: string[]; preparedExactKeys: string[]; canonicalUtf8Max: number }; wireOracle: { version: string; asciiVersionBytes: number; prefixBytes: number; totalMin: number; totalMax: number } };
const contract = JSON.parse(matrixRaw) as Contract;
const expected = contract.targets;
const server = join(import.meta.dir, ".."), overlay = join(server, "recovery/recovery-20261018-v1");
const migration = readFileSync(join(overlay, "sql/0102_approval_exact_input_objects_closed.sql"), "utf8");
const previousRaw = readFileSync(join(overlay, "meta/0101_snapshot.json"));
const previous = JSON.parse(previousRaw.toString("utf8")) as Snapshot;
const next = JSON.parse(readFileSync(join(overlay, "meta/0102_snapshot.json"), "utf8")) as Snapshot;
const journal = JSON.parse(readFileSync(join(overlay, "meta/_journal.json"), "utf8")) as Journal;
const ledgerKey = "public.approval_continuations", captureKey = "public.approval_exact_input_captures", preparedKey = "public.approval_exact_input_objects";
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

// Restricted all-token consumer. Old ledger is a real predecessor snapshot context,
// not a fake SDK object. Only CREATE two objects and exact ADD operations are accepted.
function parseSQL(source: string): { tables: Record<string, Table>; forced: string[] } {
  const out: Record<string, Table> = { [ledgerKey]: structuredClone(previous.tables[ledgerKey] as Table) };
  const forced: string[] = [];
  function column(c: Cursor, table: Table): void {
    const name=c.id(); const token=c.peek(); c.at++;
    assert.ok(["UUID","TEXT","JSONB","BYTEA","TIMESTAMP"].includes(token));
    const value: Column={name,type:token.toLowerCase(),primaryKey:false,notNull:false};
    if(token==="TIMESTAMP"){c.take("WITH");c.take("TIME");c.take("ZONE");value.type="timestamp with time zone";}
    if(c.peek()==="DEFAULT"){c.take("DEFAULT");c.take("CLOCK_TIMESTAMP");c.take("(");c.take(")");value.default="clock_timestamp()";}
    if(c.peek()==="NOT"){c.take("NOT");c.take("NULL");value.notNull=true;}
    put(table.columns,name,value);
  }
  function constraint(c: Cursor, table: Table): void {
    c.take("CONSTRAINT");const name=c.id();
    assert.ok(Buffer.byteLength(name,"ascii")<=63 && /^apx_[a-z_]+$/.test(name));
    if(c.peek()==="PRIMARY"){c.take("PRIMARY");c.take("KEY");put(table.compositePrimaryKeys,name,{name,columns:c.ids()});}
    else if(c.peek()==="UNIQUE"){
      c.take("UNIQUE");let nullsNotDistinct=false;
      if(c.peek()==="NULLS"){c.take("NULLS");c.take("NOT");c.take("DISTINCT");nullsNotDistinct=true;}
      put(table.uniqueConstraints,name,{name,columns:c.ids(),nullsNotDistinct});
    } else if(c.peek()==="CHECK"){c.take("CHECK");put(table.checkConstraints,name,{name,value:c.group().join(" ")});}
    else {
      c.take("FOREIGN");c.take("KEY");const columnsFrom=c.ids();c.take("REFERENCES");const tableTo=c.table();const columnsTo=c.ids();
      c.take("ON");c.take("DELETE");c.take("NO");c.take("ACTION");c.take("ON");c.take("UPDATE");c.take("NO");c.take("ACTION");
      put(table.foreignKeys,name,{name,tableFrom:table.name,tableTo,columnsFrom,columnsTo,onDelete:"no action",onUpdate:"no action"});
    }
  }
  const tokens=tokenize(source);assert.equal(tokens.at(-1),";");
  for(const statement of parts(tokens,";")){
    const c=new Cursor(statement);
    if(c.peek()==="CREATE"){
      c.take("CREATE");
      if(c.peek()==="TABLE"){
        c.take("TABLE");const name=c.table();assert.ok(["approval_exact_input_captures","approval_exact_input_objects"].includes(name));
        const table:Table={name,schema:"",columns:{},indexes:{},foreignKeys:{},compositePrimaryKeys:{},uniqueConstraints:{},policies:{},checkConstraints:{},isRLSEnabled:false};
        for(const definition of parts(c.group(),",")){const d=new Cursor(definition);if(d.peek()==="CONSTRAINT")constraint(d,table);else column(d,table);d.finish();}
        c.finish();put(out,`public.${name}`,table);continue;
      }
      c.take("INDEX");const name=c.id();c.take("ON");const table=out[`public.${c.table()}`];assert.ok(table);
      c.take("USING");c.take("BTREE");const columns=parts(c.group(),",").map(part=>{const d=new Cursor(part);const expression=d.id();d.take("ASC");d.take("NULLS");d.take("LAST");d.finish();return {expression,isExpression:false,asc:true,nulls:"last"};});
      c.finish();put(table.indexes,name,{name,columns,isUnique:false,concurrently:false,method:"btree",with:{}});continue;
    }
    c.take("ALTER");c.take("TABLE");const name=c.table();const table=out[`public.${name}`];assert.ok(table);
    if(c.peek()==="ADD"){
      c.take("ADD");
      if(c.peek()==="COLUMN"){assert.equal(name,"approval_continuations");c.take("COLUMN");column(c,table);}
      else constraint(c,table);
    } else {
      assert.notEqual(name,"approval_continuations","old ledger RLS must not be altered");
      if(c.peek()==="ENABLE"){c.take("ENABLE");assert.equal(table.isRLSEnabled,false);table.isRLSEnabled=true;}
      else {c.take("FORCE");assert.ok(table.isRLSEnabled);assert.ok(!forced.includes(name));forced.push(name);}
      c.take("ROW");c.take("LEVEL");c.take("SECURITY");
    }
    c.finish();
  }
  return {tables:out,forced};
}
const dialect = new PgDialect();
function render(sql: SQL): string {
  const query = dialect.sqlToQuery(sql);
  assert.equal(query.params.length, 0, "DDL expressions must be literal SQL");
  return query.sql;
}
// Drizzle0.45.2 getTableConfig only returns extra-config UniqueConstraintBuilder
// in uniqueConstraints. Inline column.unique() remains in readonly column fields.
// Project only those real fields; these descriptors are not fake PgTable/config objects.
type InlineUniqueColumn = Pick<
  ReturnType<typeof getTableConfig>["columns"][number],
  "name" | "isUnique" | "uniqueName" | "uniqueType"
>;
type OrdinaryUniqueDescriptor = {
  name: string;
  columns: readonly string[];
  nullsNotDistinct: boolean | undefined;
};
function ordinaryUniqueMetadata(
  columns: readonly InlineUniqueColumn[],
  extras: readonly OrdinaryUniqueDescriptor[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const column of columns) {
    assert.equal(typeof column.isUnique, "boolean");
    if (!column.isUnique) continue;
    const name = column.uniqueName;
    assert.ok(typeof name === "string" && name.length > 0, "inline unique name required");
    assert.ok(
      column.uniqueType === undefined || column.uniqueType === "distinct" || column.uniqueType === "not distinct",
      "unknown inline unique NULL semantics",
    );
    put(result, name, {
      name,
      columns: [column.name],
      // Undefined is ordinary SQL DISTINCT, never NULLS NOT DISTINCT.
      nullsNotDistinct: column.uniqueType === "not distinct",
    });
  }
  for (const constraint of extras) {
    assert.ok(constraint.name.length > 0);
    assert.ok(constraint.columns.length > 0 && constraint.columns.every(name => name.length > 0));
    assert.ok(constraint.nullsNotDistinct === undefined || typeof constraint.nullsNotDistinct === "boolean");
    put(result, constraint.name, {
      name: constraint.name,
      columns: [...constraint.columns],
      nullsNotDistinct: constraint.nullsNotDistinct === true,
    });
  }
  return result;
}
function uniqueInputs(table: PgTable): {
  columns: InlineUniqueColumn[];
  extras: OrdinaryUniqueDescriptor[];
} {
  const config = getTableConfig(table);
  return {
    columns: config.columns.map(column => ({
      name: column.name,
      isUnique: column.isUnique,
      uniqueName: column.uniqueName,
      uniqueType: column.uniqueType,
    })),
    extras: config.uniqueConstraints.map(constraint => {
      const name = constraint.getName();
      assert.ok(name, "extra-config unique name required");
      return {
        name,
        columns: constraint.columns.map(column => column.name),
        nullsNotDistinct: constraint.nullsNotDistinct,
      };
    }),
  };
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
      else if (typeof value === "bigint") {
        // Exactly the existing default0n lease ABI, not a generic lossy coercion.
        assert.equal(value, 0n); item.default = 0;
      } else {
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
  const uniques = uniqueInputs(table);
  result.uniqueConstraints = ordinaryUniqueMetadata(uniques.columns, uniques.extras);
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

const MATRIX_SHA = "60f63878d854eb3fddd5f13166c26fd95f105ba83205ad2c34d837822b39d39e";
const JOURNAL_PREFIX_SHA = "d3fd26f790c8d107ee36c5159e76484f9e2bf7df55452f4b72b77ddfff4ac420";
const SOURCE_INVERSE_EDITS: readonly (readonly [string,string])[] = [["  check,\n  foreignKey,\n", "  check,\n"], ["  uniqueIndex,\n  uuid,\n  type PgTableExtraConfigValue,\n", "  uniqueIndex,\n"], ["import { approvalExactInputObjects } from \"./approval-exact-input-objects\";\n", ""], ["    exactObjectId: uuid(\"exact_object_id\"),\n    exactPlaintextSha256: text(\"exact_plaintext_sha256\"),\n", ""], ["  (table): PgTableExtraConfigValue[] => [", "  (table) => ["], ["    check(\"apx_ledger_ref_pair_ck\", sql`(\"exact_object_id\" IS NULL) = (\"exact_plaintext_sha256\" IS NULL)`),\n    check(\"apx_ledger_ref_sha_ck\", sql`\"exact_plaintext_sha256\" IS NULL OR \"exact_plaintext_sha256\" ~ '^[a-f0-9]{64}$'`),\n    foreignKey({ name: \"apx_ledger_prepared_fk\", columns: [table.exactObjectId, table.approvalId, table.tenantId, table.ownerId, table.exactPlaintextSha256], foreignColumns: [approvalExactInputObjects.id, approvalExactInputObjects.approvalId, approvalExactInputObjects.tenantId, approvalExactInputObjects.ownerUserId, approvalExactInputObjects.plaintextSha256] }).onDelete(\"no action\").onUpdate(\"no action\"),\n    index(\"apx_ledger_prepared_idx\").on(table.exactObjectId.asc().nullsLast(), table.approvalId.asc().nullsLast(), table.tenantId.asc().nullsLast(), table.ownerId.asc().nullsLast(), table.exactPlaintextSha256.asc().nullsLast()),\n", ""]];
const RECOVERY_INPUTS = [{"path": "openbot/server/recovery/recovery-20261018-v1/meta/0081_snapshot.json", "bytes": 292641, "sha256": "ef4b170efbc98717bce811b27d3f5d35c274146f5faec50bc787028acbfaa24c"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0082_snapshot.json", "bytes": 310313, "sha256": "2cc73e7181b11baa27dcad48ab412cf5d89c13d19d0f06a4640e6cdaa7a883e8"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0083_snapshot.json", "bytes": 312091, "sha256": "159c6313247a705e2dd71efe46c90cc734ee9a8a0be3b66f4c114ef343335d61"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0084_recovery_flow_source_foundations_snapshot.json", "bytes": 329146, "sha256": "12a3221d57c57de1f3639d126ea90e0724e84e64fd2965e4fb62d197fced2a07"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0085_snapshot.json", "bytes": 352947, "sha256": "b02d8b70f513bcc764a2be96a4d88184d73392b14eb754a8067b9cd123a00eab"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0086_snapshot.json", "bytes": 369468, "sha256": "6beec7f83f05e43d212c44f990ba625c4714acb45fdac6b4082df3085e89541a"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0087_snapshot.json", "bytes": 389321, "sha256": "86cd06c067f98c93911bc639cb3df766c54cb4d7478f95c414bf29b34fafb3ef"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0088_snapshot.json", "bytes": 406139, "sha256": "eb784f5a88fea45abc65672bf804d7a3ad20642fd81578ccecd236be77e92360"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0089_snapshot.json", "bytes": 423098, "sha256": "6e16372f22dba1583e1898f3c10e21a1ce7c76f6ddc16595f86a49806a0769cf"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0090_snapshot.json", "bytes": 427649, "sha256": "f49a5fdbd213a1273b898a925e486499a6b1357243bb74f0a4108bdcb5f6d44e"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0091_snapshot.json", "bytes": 436634, "sha256": "9d26860fe19084a4de2635a4e28865ff38258e4781eeb8cd1bf45fe1c872e0ef"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0092_snapshot.json", "bytes": 436885, "sha256": "b0bc37ce370b357d08a9f513dfad13d186c91c161c8b0abadf045b9912a22893"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0093_snapshot.json", "bytes": 442363, "sha256": "acaa87bf970da9ffd06198e59a365d10d2d9d3f03f56dbc07cfe393d76abc7eb"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0094_snapshot.json", "bytes": 449141, "sha256": "27e268245fa3f0ed13f13035c751ac27c006d274191c670f92183521863cdfd2"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0095_snapshot.json", "bytes": 454058, "sha256": "77ed1fad2c312ed16635d95a6fb40fe4e230b96f53c007c7b71a881dcd57cc4b"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0096_snapshot.json", "bytes": 463387, "sha256": "e28a48738b23d9f2ff41d1e0b515e189ecb5bd44db2befb652af1bdcb126963b"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0097_snapshot.json", "bytes": 471291, "sha256": "0bc645a65fc289437489a3e000596616f3694bc6325a4be7a10f59597e941a37"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0098_snapshot.json", "bytes": 479137, "sha256": "58b5758a353915408091102051bdfed77b5bc168e4cd91ec0169bcaa7ba5eb26"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0099_snapshot.json", "bytes": 488317, "sha256": "e08e4184dbf674fa4c88d6e55f270f2e371b1541a046ab8da29068084fd9ca0c"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0100_snapshot.json", "bytes": 498108, "sha256": "fd218591c0165512dbaf63a36fed8ddd775cc577d090083510329c6d6779fc93"}, {"path": "openbot/server/recovery/recovery-20261018-v1/meta/0101_snapshot.json", "bytes": 507555, "sha256": "1631a6306279b57d76ef47a95f6ca6f063d7ef62d333e06f7b979c22b4ee6cd2"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0081_recovery_subject_and_binding.sql", "bytes": 172, "sha256": "0769123048b40af0f80aa8a3c843f67ab19fac5c44ccb9243bbc6819d689bb40"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0082_recovery_role_foundations.sql", "bytes": 9833, "sha256": "683834fae02b1e3cf3be6ca85340098c2a1bd0cea6de65c7e14b80e3be7a93dc"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0083_recovery_task_flow_audit_contract.sql", "bytes": 938, "sha256": "ee97d7862077239462aec225a1b71bf2b87d06a9d858b48dcaa7746a2b0856ea"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0084_recovery_flow_source_foundations.sql", "bytes": 8236, "sha256": "96cb4c921ca065856d4f3d641440907528d9ddf78e483ff09ff100aa2835e541"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0085_recovery_flow_source_run_records.sql", "bytes": 12015, "sha256": "a94c4a80167f67e79fee01f71483b7964985da4957a0221280f79cebe279e4c2"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0086_recovery_flow_source_runtime_records.sql", "bytes": 8857, "sha256": "21d90fc2a2505943db1e1687109820527660b8ec7b87d2e8a6b303107fa723bd"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0087_recovery_flow_source_original_records.sql", "bytes": 11428, "sha256": "e5e5fb88be31f330280ea3e045d29da6d3315e0df2f82d854df16d399a8fd7f9"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0088_recovery_flow_run_coordination.sql", "bytes": 7714, "sha256": "a7623f0e399a806cbc195dd18f4e4ff2f64aa674a8fae25c4152c71e823c3786"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0089_recovery_flow_official_bindings.sql", "bytes": 3140, "sha256": "a1ffdceb492b8f3ba00b7fc78f994d608c016a7f171a3ba913a408c800112219"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0090_recovery_group_pipeline_start_receipts.sql", "bytes": 2093, "sha256": "8c9ae16ca677f0969d8035247443b8428afd02c4b936c96efd7b6d2e81fb0671"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0091_recovery_flow_customization_foundations.sql", "bytes": 4376, "sha256": "ecaf856fcc358e5e522a22b6e3f86e4aeb5aac64e1ddd48f273e65fdb3ef9a60"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0092_threads_domain_parent_key.sql", "bytes": 119, "sha256": "5dd8207d87d6f63823de57e60c639a5683341f8891dffa5398e72c6b221ed9dd"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0093_recovery_flow_customization_turns.sql", "bytes": 2476, "sha256": "ca2502c0d5975497998fbd90c2532da4c47dde49142bd63da13ff00314daf061"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0094_approval_direct_execution_domains.sql", "bytes": 2891, "sha256": "c0e601568100b1c92bb25f24524a48150629e750f135cfb28e41d5c391e37c82"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0095_recovery_automation_foundations.sql", "bytes": 1401, "sha256": "1414446cb8749a6a097f843bf9d2cc2e42da63ff0e2c96b613bd78de8db85b3e"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0096_recovery_flow_sharing_foundations.sql", "bytes": 4389, "sha256": "d8f0f5dd67ce26328745b6b6d94b6e958d3906c7cd8a308d4ecfbc168e067190"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0097_recovery_automation_run_records.sql", "bytes": 2530, "sha256": "cb2b14e26104fa172d06bac1561e12a78220458d51a038e67630fece6f9f3211"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0098_recovery_device_binding_leases.sql", "bytes": 4010, "sha256": "ce329e24edef4d46e3355b301b6c004ce0e24cccb68b1216fa0b0e4efff32fc7"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0099_recovery_security_policy_fences.sql", "bytes": 5540, "sha256": "30f22f1ee9cf0bf2104d6ef5803a51de993ade44c034bc25cd9f72dc046015a2"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0100_recovery_outbox_knowledge_heads.sql", "bytes": 5279, "sha256": "2780c167f92272e521b0e1cb39d904f61a9f83b643da5c857760f5aa1c532c62"}, {"path": "openbot/server/recovery/recovery-20261018-v1/sql/0101_ap2_parent_schema_reconcile_closed.sql", "bytes": 3715, "sha256": "c3c3c4c601261fd774cc729e1e117019385b6855bbd9d0d697174709db626da0"}];

function equalTargets(actual: Record<string,Table>):void {
  assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort());
  for(const [key,t] of Object.entries(expected))assert.deepEqual(normalize(actual[key] as Table),normalize(t),key);
}
function checkSQL(source:string):void {const parsed=parseSQL(source);equalTargets(parsed.tables);assert.deepEqual(parsed.forced,contract.forced);}
function rejectSQL(before:string,after:string):void {
  assert.ok(migration.includes(before),"mutation must hit real SQL");
  const mutated=migration.replace(before,after);assert.notEqual(mutated,migration);expect(()=>checkSQL(mutated)).toThrow();
}
function mutated(fn:(t:Record<string,Table>)=>void):void {const copy=structuredClone(expected);fn(copy);expect(()=>equalTargets(copy)).toThrow();}
function checkSnapshot(value:Snapshot):void {
  assert.equal(value.id,"66afc67c-2ebd-4e41-8ca0-3cbe849a0102");assert.equal(value.prevId,"5ae0628f-dd5e-42e2-8373-74c4312817aa");
  assert.equal(previous.id,value.prevId);assert.equal(Object.keys(previous.tables).length,139);assert.equal(Object.keys(value.tables).length,141);
  equalTargets(Object.fromEntries(Object.keys(expected).map(key=>[key,value.tables[key] as Table])));
  // Validation changes only these top-level copies; nested source data is read-only.
  const restored={...value,tables:{...value.tables}};delete restored.tables[captureKey];delete restored.tables[preparedKey];
  restored.tables[ledgerKey]=previous.tables[ledgerKey] as Table;restored.id=previous.id;restored.prevId=previous.prevId;
  assert.deepEqual(restored,previous,"all other139 structures/top-level values exact, only specified ledger delta");
}
function checkJournal(value:Journal):void {
  assert.ok(value.entries.length>=103,"known prefix only; suffix has NO execution authority");
  assert.equal(createHash("sha256").update(JSON.stringify(value.entries.slice(0,102))).digest("hex"),JOURNAL_PREFIX_SHA);
  assert.deepEqual(value.entries[102],{idx:102,version:"7",when:1792386460367,tag:"0102_approval_exact_input_objects_closed",breakpoints:true});
  const prev=value.entries[101];assert.ok(prev);assert.ok(1792386460367>prev.when&&1792386460367<=Date.now());
  const original=JSON.parse(readFileSync(join(server,"drizzle/meta/_journal.json"),"utf8")) as Journal;
  assert.equal(value.version,original.version);assert.equal(value.dialect,original.dialect);assert.deepEqual(value.entries.slice(0,81),original.entries);
}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
const actualMetadata=()=>Object.fromEntries([approvalExactInputCaptures,approvalExactInputObjects,approvalContinuations].map(table=>{const m=metadata(table);return [`public.${m.name}`,m];}));
describe("AP4 closed exact-input foundation; definitions are not runtime authority",()=>{
  test("independent Root matrix and raw predecessor identity",()=>{
    expect(createHash("sha256").update(matrixRaw).digest("hex")).toBe(MATRIX_SHA);
    expect(previousRaw.length).toBe(507555);expect(createHash("sha256").update(previousRaw).digest("hex")).toBe("1631a6306279b57d76ef47a95f6ca6f063d7ef62d333e06f7b979c22b4ee6cd2");
    expect(Object.keys(expected[captureKey]?.columns??{})).toHaveLength(21);expect(Object.keys(expected[preparedKey]?.columns??{})).toHaveLength(29);
  });
  test("all28 SQL statements fully consumed, no DML/policy/grant or unsupported suffix",()=>{expect(migration.split("--> statement-breakpoint")).toHaveLength(28);checkSQL(migration);for(const suffix of [' GRANT ALL ON TABLE "public"."approval_exact_input_captures" TO PUBLIC;',' SELECT 1;',' -- ignored',' ALTER TABLE "public"."approval_continuations" FORCE ROW LEVEL SECURITY;'])expect(()=>checkSQL(migration+suffix)).toThrow();});
  test("real Drizzle columns/defaults/PK/ordinary inline+extra uniques/indexes/FK/CHECK/RLS equal independent matrix",()=>equalTargets(actualMetadata()));
  test("actual parent keys are ordinary scoped uniques and text/uuid NN, not run registration",()=>{
    for(const [table,name,columns] of [[approvalRequests,"approval_requests_id_tenant_owner_unique",["id","tenant_id","owner_user_id"]],[threads,"threads_id_tenant_agent_unique",["id","tenant_id","agent_id"]],[approvalDirectExecutionDomains,"approval_direct_execution_domains_scope_binding_unique",["domain_id","tenant_id","owner_user_id","thread_id","agent_id"]]] as const){
      const found=getTableConfig(table).uniqueConstraints.find(c=>c.getName()===name);assert.ok(found);assert.deepEqual(found.columns.map(c=>c.name),columns);expect(found.nullsNotDistinct).toBe(false);for(const c of found.columns)expect(c.notNull).toBe(true);
    }
    expect(approvalDirectExecutionDomains.domainId.getSQLType()).toBe("uuid");for(const c of [users.id,agents.id]){expect(c.getSQLType()).toBe("text");expect(c.primary).toBe(true);expect(c.notNull).toBe(true);}
  });
  test("each shared scope position is mandatory and ordered in capture unique, prepared FK and matching15-column index",()=>{
    const uq=expected[captureKey]?.uniqueConstraints.apx_capture_shared_scope_uq as {columns:string[]};
    const ref=expected[preparedKey]?.foreignKeys.apx_prepared_capture_scope_fk;assert.ok(ref);assert.deepEqual(uq.columns,["id",...contract.sharedScope,"plaintext_sha256"]);assert.deepEqual(ref.columnsFrom,["capture_id",...contract.sharedScope,"capture_sha256"]);assert.deepEqual(ref.columnsTo,uq.columns);
    contract.sharedScope.forEach((column,i)=>{
      mutated(t=>{const f=t[preparedKey]?.foreignKeys.apx_prepared_capture_scope_fk;assert.ok(f);f.columnsFrom.splice(i+1,1);});
      mutated(t=>{const f=t[preparedKey]?.foreignKeys.apx_prepared_capture_scope_fk;assert.ok(f);[f.columnsFrom[0],f.columnsFrom[i+1]]=[f.columnsFrom[i+1] as string,f.columnsFrom[0] as string];});
      mutated(t=>{const f=t[preparedKey]?.foreignKeys.apx_prepared_capture_scope_fk;assert.ok(f);f.columnsTo[i+1]="id";});
      mutated(t=>{const a=t[preparedKey]?.indexes.apx_prepared_capture_idx.columns[i+1];assert.ok(a);a.expression=column+"_wrong";});
    });
  });
  test("C/P role differences are preserved; no target/plan/stage/keyVersion forced into common scope",()=>{
    for(const c of ["target_run_id","plan_run_id","stage","key_version","id"]){expect(contract.sharedScope).not.toContain(c);}
    for(const name of ["target_run_id","plan_run_id"]){expect(Object.hasOwn(expected[captureKey]?.columns??{},name)).toBe(false);expect(expected[preparedKey]?.columns[name]?.notNull).toBe(true);}
    for(const name of ["saved_result_digest","input_digest","action_digest"]){for(const t of Object.values(expected)){for(const ck of Object.values(t.checkConstraints))assert.ok(!ck.value.includes(`"${name}" ~`),"no invented hex encoding for opaque ABI");}}
  });
  test("twelve octet budget terms and every nonempty predicate reject omission, trim or widened bound",()=>{
    for(const name of ["apx_capture_","apx_prepared_"]){
      const t=name==="apx_capture_"?captureKey:preparedKey;
      for(const c of contract.budgetTextScope){
        const original=expected[t]?.checkConstraints[name+"scope_budget_ck"]?.value;assert.ok(original);
        const term=`octet_length("${c}")`;
        rejectSQL(`CONSTRAINT "${name}scope_budget_ck" CHECK (${original})`,`CONSTRAINT "${name}scope_budget_ck" CHECK (${original.replace(term,"0")})`);
        const nonempty=expected[t]?.checkConstraints[name+"scope_nonempty_ck"]?.value;assert.ok(nonempty);
        rejectSQL(`CONSTRAINT "${name}scope_nonempty_ck" CHECK (${nonempty})`,`CONSTRAINT "${name}scope_nonempty_ck" CHECK (${nonempty.replace(term+" > 0","1 = 1")})`);
      }
      mutated(tables=>{const c=tables[t]?.checkConstraints[name+"scope_budget_ck"];assert.ok(c);c.value=c.value.replace("<= 1536","<= 1537");});
      mutated(tables=>{const c=tables[t]?.checkConstraints[name+"scope_nonempty_ck"];assert.ok(c);c.value=c.value.replace('octet_length("approval_id")','octet_length(trim("approval_id"))');});
    }
  });
  test("all new column type/NN/default/PK shapes discriminate single corruptions, no generated id or tenant default",()=>{
    for(const key of [captureKey,preparedKey]){const t=expected[key];assert.ok(t);for(const name of Object.keys(t.columns)){
      mutated(tables=>{const c=tables[key]?.columns[name];assert.ok(c);c.notNull=false;});
      mutated(tables=>{const c=tables[key]?.columns[name];assert.ok(c);c.type="text_wrong";});
      mutated(tables=>{const c=tables[key]?.columns[name];assert.ok(c);c.default="gen_random_uuid()";});
    }
    mutated(tables=>{const t=tables[key];assert.ok(t);t.compositePrimaryKeys={};});}
    rejectSQL('"id" uuid NOT NULL','"id" uuid DEFAULT gen_random_uuid() NOT NULL');
    rejectSQL('"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL','"created_at" timestamp with time zone DEFAULT now() NOT NULL');
  });
  test("every check and both wire bounds, SHA/versions/stages/object shape are exact and independently removable",()=>{
    for(const key of [captureKey,preparedKey]){const t=expected[key];assert.ok(t);for(const name of Object.keys(t.checkConstraints)){
      mutated(tables=>{const table=tables[key];assert.ok(table);delete table.checkConstraints[name];});
      mutated(tables=>{const c=tables[key]?.checkConstraints[name];assert.ok(c);c.value="1 = 1";});
    }}
    rejectSQL('BETWEEN 64 AND 1048639','BETWEEN 63 AND 1048639');rejectSQL('BETWEEN 64 AND 1048639','BETWEEN 64 AND 1048640');
    rejectSQL("'OPENBOT_EXACT_INPUT_JSON_V1'","'OPENBOT_EXACT_INPUT_JSON_V2'");rejectSQL("'OPENBOT_APPROVAL_EXACT_SOURCE_BINDING_V1'","'other'");rejectSQL("'OPENBOT_APPROVAL_EXACT_WIRE_V1'","'legacy'");
  });
  test("all ordinary uniques, NO ACTION references, index order and null sorting are independently mandatory",()=>{
    for(const key of Object.keys(expected)){const t=expected[key];assert.ok(t);
      for(const name of Object.keys(t.uniqueConstraints))mutated(tables=>{const table=tables[key];assert.ok(table);delete table.uniqueConstraints[name];});
      for(const name of Object.keys(t.foreignKeys)){
        const original=t.foreignKeys[name];assert.ok(original);
        for(const action of ["onDelete","onUpdate"] as const){
          const before=original[action];
          const after=before==="cascade"?"no action":"cascade";
          expect(before).not.toBe(after);
          mutated(tables=>{const f=tables[key]?.foreignKeys[name];assert.ok(f);assert.equal(f[action],before);f[action]=after;});
        }
      }
      for(const name of Object.keys(t.indexes)){mutated(tables=>{const i=tables[key]?.indexes[name];assert.ok(i);i.isUnique=!i.isUnique;});mutated(tables=>{const i=tables[key]?.indexes[name]?.columns[0];assert.ok(i);i.asc=false;});mutated(tables=>{const i=tables[key]?.indexes[name]?.columns[0];assert.ok(i);i.nulls="first";});}
    }
    rejectSQL('ON DELETE NO ACTION','ON DELETE CASCADE');rejectSQL('ON UPDATE NO ACTION','ON UPDATE CASCADE');rejectSQL('ASC NULLS LAST','DESC NULLS LAST');rejectSQL('ASC NULLS LAST','ASC NULLS FIRST');
    rejectSQL('UNIQUE ("approval_id", "tenant_id", "owner_user_id")','UNIQUE NULLS NOT DISTINCT ("approval_id", "tenant_id", "owner_user_id")');
    rejectSQL('CREATE INDEX "apx_capture_domain_idx"','CREATE UNIQUE INDEX "apx_capture_domain_idx"');
  });
  test("closed ENABLE+FORCE has no policy, GRANT or writer; snapshot represents only supported ENABLE flag",()=>{
    for(const key of [captureKey,preparedKey]){expect(expected[key]?.policies).toEqual({});expect(expected[key]?.isRLSEnabled).toBe(true);}
    for(const name of ["approval_exact_input_captures","approval_exact_input_objects"]){rejectSQL(`ALTER TABLE "public"."${name}" FORCE ROW LEVEL SECURITY;`,"");rejectSQL(`ALTER TABLE "public"."${name}" ENABLE ROW LEVEL SECURITY;`,"");}
    mutated(t=>{const c=t[captureKey];assert.ok(c);c.isRLSEnabled=false;});
  });
  test("ledger refs are both nullable/no default, paired and lowerSHA; old opaque inputDigest and0n lease ABI survive",()=>{
    for(const c of [approvalContinuations.exactObjectId,approvalContinuations.exactPlaintextSha256]){expect(c.notNull).toBe(false);expect(c.hasDefault).toBe(false);}
    expect(approvalContinuations.fence.default).toBe(0n);expect(approvalContinuationSteps.fence.default).toBe(0n);
    expect(approvalContinuations.inputDigest.getSQLType()).toBe("text");expect(approvalContinuationSteps.inputDigest.getSQLType()).toBe("text");
    rejectSQL('CHECK (("exact_object_id" IS NULL) = ("exact_plaintext_sha256" IS NULL))','CHECK ("exact_object_id" IS NULL OR "exact_plaintext_sha256" IS NULL)');
    rejectSQL('"exact_plaintext_sha256" IS NULL OR "exact_plaintext_sha256" ~','"exact_plaintext_sha256" IS NOT NULL OR "exact_plaintext_sha256" ~');
    mutated(t=>{const c=t[ledgerKey]?.columns.exact_object_id;assert.ok(c);c.default="gen_random_uuid()";});
  });
  test("real customJSONB and bytea parameter mappings retain objects/Buffers without production wire or double encoding",()=>{
    for(const table of [approvalExactInputCaptures,approvalExactInputObjects]){
      const value={immutable:{configRef:{id:"configuration",version:1},toolSetRef:{id:"tools"},transformRef:{id:"transform"}},fullBinding:["private"]};
      // Repository custom jsonb passes the object to Bun SQL, which serializes it once.
      const encoded=table.sourceBinding.mapToDriverValue(value);assert.equal(typeof encoded,"object");assert.equal(encoded,value);assert.deepEqual(encoded,value);assert.deepEqual(table.sourceBinding.mapFromDriverValue(value),value);
      const query=dialect.sqlToQuery(sql`select ${sql.param(value,table.sourceBinding)}`);assert.equal(query.params.length,1);assert.deepEqual(JSON.parse(query.params[0] as string),value);
      const buffer=Buffer.from([0,255,1,0]);expect(table.envelopeBytes.mapToDriverValue(buffer)).toBe(buffer);expect(table.envelopeBytes.mapFromDriverValue(buffer)).toBe(buffer);expect(dialect.sqlToQuery(sql`select ${sql.param(buffer,table.envelopeBytes)}`).params[0]).toBe(buffer);
    }
  });
  test("snapshot validation does not mutate its input",()=>{
    const before=JSON.stringify(next);checkSnapshot(next);expect(JSON.stringify(next)).toBe(before);
  });
  test("snapshot inverse preserves all139 including AP2/domain/parent and every other top-level value",()=>{
    checkSnapshot(next);
    for(const key of Object.keys(previous.tables)){const t=next.tables[key];assert.ok(t);const tampered={...next,tables:{...next.tables,[key]:{...t,isRLSEnabled:!t.isRLSEnabled}}};expect(()=>checkSnapshot(tampered)).toThrow();}
    const bad=structuredClone(next);bad.prevId="wrong";expect(()=>checkSnapshot(bad)).toThrow();const top=structuredClone(next);top.extraAuthority=true;expect(()=>checkSnapshot(top)).toThrow();
  });
  test("full9393 source inverse preserves original AP logic, steps, action index and scoped parent unique",()=>{
    let source=readFileSync(join(server,"src/db/schema/approvals.ts"),"utf8");
    for(const [after,before] of SOURCE_INVERSE_EDITS){assert.equal(source.split(after).length,2,"each authorized source edit unique");source=source.replace(after,before);}
    expect(Buffer.byteLength(source)).toBe(9393);expect(createHash("sha256").update(source).digest("hex")).toBe("149e43894542c7ce97ab1e65641b64de07eebd627fe68921898032598f3b3798");
  });
  test("journal strict0..101 and own102, legal successor accepted without suffix execution permission",()=>{
    checkJournal(journal);const successor=structuredClone(journal);successor.entries.push({idx:103,version:"7",when:1792386460368,tag:"unknown_unapproved_successor",breakpoints:true});checkJournal(successor);
    for(const i of [0,80,81,100,101,102]){const bad=structuredClone(journal);const e=bad.entries[i];assert.ok(e);e.tag+="_tampered";expect(()=>checkJournal(bad)).toThrow();}
  });
  test("all163 original migration files and42 preceding recovery artifacts retain identities",()=>{
    const rows=filesUnder(join(server,"drizzle")).map(path=>{const raw=readFileSync(path);return {path:relative(join(server,"drizzle"),path),bytes:raw.length,sha:createHash("sha256").update(raw).digest("hex")};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    expect(rows).toHaveLength(163);expect(createHash("sha256").update(rows.map(x=>`${x.path}\0${x.bytes}\0${x.sha}\n`).join("")).digest("hex")).toBe("9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d");
    for(const record of RECOVERY_INPUTS){const raw=readFileSync(join(server,"..",record.path.replace(/^openbot\//,"")));expect(raw.length).toBe(record.bytes);expect(createHash("sha256").update(raw).digest("hex")).toBe(record.sha256);}
  });
  test("all new constraint/index names ASCII<=63 and globally distinct, leaving historical long FK unchanged",()=>{
    const names:string[]=[];for(const table of Object.values(expected))for(const key of ["compositePrimaryKeys","uniqueConstraints","foreignKeys","indexes","checkConstraints"] as const)for(const name of Object.keys(table[key]))if(name.startsWith("apx_")){assert.ok(/^apx_[a-z_]+$/.test(name));assert.ok(Buffer.byteLength(name,"ascii")<=63);names.push(name);}
    expect(new Set(names).size).toBe(names.length);
  });
  test("inline ordinary uniques are real column metadata, extras merged separately and duplicates/unknown semantics rejected",()=>{
    const inputs=uniqueInputs(approvalContinuations);expect(inputs.columns.filter(c=>c.isUnique).map(c=>c.name)).toEqual(["admission_id"]);
    const one=inputs.columns.find(c=>c.isUnique);assert.ok(one);const distinct=ordinaryUniqueMetadata([{...one,uniqueType:undefined}],[]);expect(distinct).toEqual(ordinaryUniqueMetadata([{...one,uniqueType:"distinct"}],[]));expect(distinct).not.toEqual(ordinaryUniqueMetadata([{...one,uniqueType:"not distinct"}],[]));
    expect(()=>ordinaryUniqueMetadata([{...one,uniqueName:undefined}],[])).toThrow();expect(()=>ordinaryUniqueMetadata([{...one,uniqueType:"unknown"}],[])).toThrow();expect(()=>ordinaryUniqueMetadata([one],[{name:one.uniqueName as string,columns:[one.name],nullsNotDistinct:false}])).toThrow();
  });
  test("shared header/wire oracle is contract data, not producer/AEAD/wire/runtime implementation",()=>{
    expect(contract.headerOracle.version).toBe("OPENBOT_APPROVAL_EXACT_HEADER_V1");expect(contract.headerOracle.captureExactKeys).toEqual(["headerVersion","codecVersion","stage","objectId","approvalId","tenantId","ownerUserId","actorUserId","domainId","threadId","agentId","approvalRunId","sourceActualRunId","toolCallId","actionDigest","sourceBindingVersion","sourceBinding","plaintextSha256","keyVersion","envelopeWireVersion"]);
    expect(contract.headerOracle.preparedExactKeys).toEqual([...contract.headerOracle.captureExactKeys,"captureId","captureSha256","savedResultDigest","admissionId","inputDigest","planIdentity","planRunId","targetRunId"]);expect(contract.headerOracle.canonicalUtf8Max).toBe(32768);
    expect(Buffer.byteLength(contract.wireOracle.version,"ascii")).toBe(30);expect(contract.wireOracle.prefixBytes).toBe(47);expect(contract.wireOracle.totalMin).toBe(64);expect(contract.wireOracle.totalMax).toBe(1048639);
    for(const key of [captureKey,preparedKey])for(const forbidden of ["nonce","plaintext","production_key"])expect(Object.hasOwn(expected[key]?.columns??{},forbidden)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql as sqlFragment } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { approvalDirectExecutionDomains } from "../src/db/schema/approval-direct-execution-domains";

// Independent Root-approved frozen storage contract. Definitions only; PG is not simulated.
const expected = {
  "schema": "public",
  "name": "approval_direct_execution_domains",
  "columns": [
    {
      "name": "domain_id",
      "type": "uuid",
      "nullable": false,
      "defaultSQL": "gen_random_uuid()",
      "origin": "22928 canonical table/columns/domain_id",
      "columnSQL": "domain_id uuid NOT NULL DEFAULT gen_random_uuid()"
    },
    {
      "name": "tenant_id",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/tenant_id",
      "columnSQL": "tenant_id text NOT NULL"
    },
    {
      "name": "owner_user_id",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/owner_user_id",
      "columnSQL": "owner_user_id text NOT NULL"
    },
    {
      "name": "thread_id",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/thread_id",
      "columnSQL": "thread_id text NOT NULL"
    },
    {
      "name": "source_run_id",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/source_run_id",
      "columnSQL": "source_run_id text NOT NULL"
    },
    {
      "name": "agent_id",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/agent_id",
      "columnSQL": "agent_id text NOT NULL"
    },
    {
      "name": "execution_kind",
      "type": "text",
      "nullable": false,
      "defaultSQL": "'direct_thread'",
      "origin": "22928 canonical table/columns/execution_kind",
      "columnSQL": "execution_kind text NOT NULL DEFAULT 'direct_thread'"
    },
    {
      "name": "backend",
      "type": "text",
      "nullable": false,
      "defaultSQL": "'local_postgres'",
      "origin": "22928 canonical table/columns/backend",
      "columnSQL": "backend text NOT NULL DEFAULT 'local_postgres'"
    },
    {
      "name": "release_id",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/release_id",
      "columnSQL": "release_id text NOT NULL"
    },
    {
      "name": "contract_version",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "Rootnewdesignfreeze2026-10-19T07:13Asia/Singapore",
      "acceptedValue": "ap-direct-domain-v2",
      "columnSQL": "contract_version text NOT NULL"
    },
    {
      "name": "state",
      "type": "text",
      "nullable": false,
      "defaultSQL": "'reserved'",
      "origin": "22928 canonical table/columns/state",
      "columnSQL": "state text NOT NULL DEFAULT 'reserved'"
    },
    {
      "name": "admission_fence",
      "type": "bigint",
      "nullable": false,
      "defaultSQL": "0",
      "origin": "22928 canonical table/columns/admission_fence",
      "columnSQL": "admission_fence bigint NOT NULL DEFAULT 0"
    },
    {
      "name": "created_at",
      "type": "timestamptz",
      "nullable": false,
      "defaultSQL": "clock_timestamp()",
      "origin": "22928 canonical table/columns/created_at",
      "columnSQL": "created_at timestamptz NOT NULL DEFAULT clock_timestamp()"
    },
    {
      "name": "admitted_at",
      "type": "timestamptz",
      "nullable": true,
      "defaultSQL": null,
      "origin": "22928 canonical table/columns/admitted_at",
      "columnSQL": "admitted_at timestamptz"
    },
    {
      "name": "creation_key",
      "type": "text",
      "nullable": false,
      "defaultSQL": null,
      "origin": "Rootnewdesignfreeze2026-10-19T07:13Asia/Singapore",
      "storage": "opaque original text; case-sensitive; no storage trim/normalization/UUID/HMAC/lengthcap",
      "columnSQL": "creation_key text NOT NULL"
    }
  ],
  "primaryKey": {
    "name": "approval_direct_execution_domains_pkey",
    "columns": [
      "domain_id"
    ],
    "kind": "PRIMARY KEY",
    "deferrable": false
  },
  "uniqueConstraints": [
    {
      "name": "approval_direct_execution_domains_thread_unique",
      "columns": [
        "thread_id"
      ],
      "kind": "UNIQUE",
      "deferrable": false,
      "partial": false,
      "expression": false
    },
    {
      "name": "approval_direct_execution_domains_scope_genesis_unique",
      "columns": [
        "tenant_id",
        "owner_user_id",
        "source_run_id"
      ],
      "kind": "UNIQUE",
      "deferrable": false,
      "partial": false,
      "expression": false
    },
    {
      "name": "approval_direct_execution_domains_scope_binding_unique",
      "columns": [
        "domain_id",
        "tenant_id",
        "owner_user_id",
        "thread_id",
        "agent_id"
      ],
      "kind": "UNIQUE",
      "deferrable": false,
      "partial": false,
      "expression": false
    },
    {
      "name": "approval_direct_execution_domains_creation_unique",
      "columns": [
        "tenant_id",
        "owner_user_id",
        "creation_key"
      ],
      "kind": "UNIQUE",
      "deferrable": false,
      "partial": false,
      "expression": false
    },
    {
      "name": "approval_direct_execution_domains_allocation_binding_unique",
      "columns": [
        "domain_id",
        "tenant_id",
        "owner_user_id",
        "thread_id",
        "agent_id",
        "source_run_id",
        "release_id",
        "backend"
      ],
      "kind": "UNIQUE",
      "deferrable": false,
      "partial": false,
      "expression": false
    }
  ],
  "foreignKeys": [
    {
      "name": "approval_direct_execution_domains_owner_fk",
      "columns": [
        "owner_user_id"
      ],
      "references": "public.users(id)",
      "onDelete": "NO ACTION",
      "onUpdate": "NO ACTION",
      "deferrable": false
    },
    {
      "name": "approval_direct_execution_domains_thread_binding_fk",
      "columns": [
        "thread_id",
        "tenant_id",
        "agent_id"
      ],
      "references": "public.threads(id,tenant_id,agent_id)",
      "referencedConstraint": "threads_id_tenant_agent_unique fromC1idx92 plainUNIQUE",
      "onDelete": "NO ACTION",
      "onUpdate": "NO ACTION",
      "deferrable": false
    }
  ],
  "checks": [
    {
      "name": "domain_nonblank_text_check",
      "predicate": "length(btrim(tenant_id))>0 AND length(btrim(owner_user_id))>0 AND length(btrim(thread_id))>0 AND length(btrim(source_run_id))>0 AND length(btrim(agent_id))>0 AND length(btrim(release_id))>0 AND length(btrim(contract_version))>0 AND length(btrim(creation_key))>0"
    },
    {
      "name": "domain_execution_kind_check",
      "predicate": "execution_kind='direct_thread'"
    },
    {
      "name": "domain_backend_check",
      "predicate": "backend='local_postgres'"
    },
    {
      "name": "domain_reserved_admitted_pair_check",
      "predicate": "(state='reserved' AND admission_fence=0 AND admitted_at IS NULL) OR (state='admitted' AND admission_fence=1 AND admitted_at IS NOT NULL)"
    },
    {
      "name": "domain_contract_version_check",
      "predicate": "contract_version='ap-direct-domain-v2'"
    }
  ],
  "additionalIndexes": [],
  "RLS": {
    "enabled": true,
    "forced": true,
    "policies": []
  },
  "grants": [],
  "writerFunctions": [],
  "createdRoles": [],
  "authorityWired": false,
  "tableOwner": "Actualmigrator ownership catalog not proven here; noTBDrole SQLreference/rolecreation inpackage",
  "superuser": "No claim FORCE constrains superusers/BYPASSRLS principals."
};
const base = new URL("../recovery/recovery-20261018-v1/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, base), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (text: string) => `"${text}"`;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const tableName = '"public"."approval_direct_execution_domains"';

// This intentionally accepts only the complete closed-foundation statement grammar.
// Any extra policy/grant/function/statement or altered token is rejected.
function assertClosedSQL(source: string) {
  const columns = expected.columns.map((column) =>
    `${quote(column.name)} ${column.type}${column.nullable ? "" : " NOT NULL"}${column.defaultSQL === null ? "" : ` DEFAULT ${column.defaultSQL}`}`,
  );
  const constraints = [
    `CONSTRAINT ${quote(expected.primaryKey.name)} PRIMARY KEY ("domain_id") NOT DEFERRABLE`,
    ...expected.uniqueConstraints.map((key) => `CONSTRAINT ${quote(key.name)} UNIQUE (${key.columns.map(quote).join(", ")}) NOT DEFERRABLE`),
    ...expected.foreignKeys.map((key, index) => {
      const target = index === 0 ? '"public"."users" ("id")' : '"public"."threads" ("id", "tenant_id", "agent_id")';
      return `CONSTRAINT ${quote(key.name)} FOREIGN KEY (${key.columns.map(quote).join(", ")}) REFERENCES ${target} ON DELETE NO ACTION ON UPDATE NO ACTION NOT DEFERRABLE`;
    }),
    ...expected.checks.map((check) => `CONSTRAINT ${quote(check.name)} CHECK (${check.predicate})`),
  ];
  const statements = source.split("--> statement-breakpoint").map(normalize);
  expect(statements).toEqual([
    normalize(`CREATE TABLE ${tableName} (${[...columns, ...constraints].join(", ")});`),
    `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;`,
  ]);
}

describe("idx94 closed domain foundation (no execution authority)", () => {
  const sql = read("sql/0094_approval_direct_execution_domains.sql");
  test("consumes all SQL with exact independent names, scope and closed RLS", () => assertClosedSQL(sql));
  for (const [name, mutate] of [
    ["old version", (text: string) => text.replace("ap-direct-domain-v2", "ap-direct-domain-v1")],
    ["missing NN", (text: string) => text.replace('"creation_key" text NOT NULL', '"creation_key" text')],
    ["wrong creation scope", (text: string) => text.replace('("tenant_id", "owner_user_id", "creation_key")', '("tenant_id", "agent_id", "creation_key")')],
    ["wrong FK parent", (text: string) => text.replace('REFERENCES "public"."threads"', 'REFERENCES "public"."users"')],
    ["missing FORCE", (text: string) => text.replace("FORCE ROW LEVEL SECURITY", "ENABLE ROW LEVEL SECURITY")],
    ["extra policy", (text: string) => `${text} CREATE POLICY unsafe ON approval_direct_execution_domains USING (true);`],
    ["extra grant", (text: string) => `${text} GRANT SELECT ON approval_direct_execution_domains TO PUBLIC;`],
    ["default version", (text: string) => text.replace('"contract_version" text NOT NULL', '\"contract_version\" text NOT NULL DEFAULT \'ap-direct-domain-v2\'')],
  ] as const) {
    test(`rejects ${name}`, () => expect(() => assertClosedSQL(mutate(sql))).toThrow());
  }
  test("SQL btrim boundary is U+0020 only; stored key is never transformed", () => {
    const eligible = (value: string) => value.replace(/^ +| +$/g, "").length > 0;
    expect(["", "   ", " Key ", "key", "Key", "\t", "\u00a0"].map(eligible)).toEqual([false, false, true, true, true, true, true]);
    expect(sql).not.toContain("COLLATE");
    expect(sql).not.toContain("4096");
    // Not a PG collation test or HTTP/JS.trim eligibility claim.
  });
  test("real Drizzle metadata retains 15 columns, exact defaults and all constraints", () => {
    const config = getTableConfig(approvalDirectExecutionDomains);
    const dialect = new PgDialect();
    expect(config.name).toBe(expected.name);
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toHaveLength(0);
    expect(config.indexes).toHaveLength(0);
    expect(config.columns.map((column) => ({ name: column.name, type: column.getSQLType(), notNull: column.notNull }))).toEqual(expected.columns.map((column) => ({name: column.name, type: column.type === "timestamptz" ? "timestamp with time zone" : column.type, notNull: !column.nullable})));
    for (const column of config.columns) {
      const reference = expected.columns.find((value) => value.name === column.name);
      expect(reference).toBeDefined();
      if (!reference) throw new Error("Unexpected column");
      expect(column.hasDefault).toBe(reference.defaultSQL !== null);
      if (reference.defaultSQL === null) expect(column.default).toBeUndefined();
      else expect(normalize(dialect.sqlToQuery(sqlFragment`${column.default}`).sql)).toBe(normalize(reference.defaultSQL));
    }
    expect(config.primaryKeys.map((key) => ({name: key.getName(), columns: key.columns.map((column) => column.name)}))).toEqual([{name: expected.primaryKey.name, columns: expected.primaryKey.columns}]);
    expect(config.uniqueConstraints.map((key) => ({name: key.getName(), columns: key.columns.map((column) => column.name), nullsNotDistinct: key.nullsNotDistinct}))).toEqual(expected.uniqueConstraints.map((key) => ({name:key.name, columns:key.columns, nullsNotDistinct:false})));
    expect(config.foreignKeys.map((key) => ({name:key.getName(), columns:key.reference().columns.map((column) => column.name), parent:key.reference().foreignColumns.map((column) => column.name), onDelete:key.onDelete,onUpdate:key.onUpdate}))).toEqual(expected.foreignKeys.map((key,index) => ({name:key.name,columns:key.columns,parent:index===0?["id"]:["id","tenant_id","agent_id"],onDelete:"no action",onUpdate:"no action"})));
    expect(config.checks.map((check) => ({name:check.name,predicate:dialect.sqlToQuery(check.value).sql}))).toEqual(expected.checks.map((check) => ({name:check.name,predicate:check.predicate})));
  });
  test("snapshot preserves all 124 old tables and every old top-level field", () => {
    const priorText = read("meta/0093_snapshot.json");
    expect(digest(priorText)).toBe("acaa87bf970da9ffd06198e59a365d10d2d9d3f03f56dbc07cfe393d76abc7eb");
    const prior = JSON.parse(priorText);
    const current = JSON.parse(read("meta/0094_snapshot.json"));
    expect(Object.keys(prior.tables)).toHaveLength(124);
    expect(Object.keys(current.tables)).toHaveLength(125);
    expect(current.id).toBe("e2ff2e2e-dd6a-4c01-9916-215faa353e00");
    expect(current.prevId).toBe(prior.id);
    const domain = current.tables["public.approval_direct_execution_domains"];
    expect(domain).toEqual({
  "name": "approval_direct_execution_domains",
  "schema": "",
  "columns": {
    "domain_id": {
      "name": "domain_id",
      "type": "uuid",
      "primaryKey": false,
      "notNull": true,
      "default": "gen_random_uuid()"
    },
    "tenant_id": {
      "name": "tenant_id",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "owner_user_id": {
      "name": "owner_user_id",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "thread_id": {
      "name": "thread_id",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "source_run_id": {
      "name": "source_run_id",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "agent_id": {
      "name": "agent_id",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "execution_kind": {
      "name": "execution_kind",
      "type": "text",
      "primaryKey": false,
      "notNull": true,
      "default": "'direct_thread'"
    },
    "backend": {
      "name": "backend",
      "type": "text",
      "primaryKey": false,
      "notNull": true,
      "default": "'local_postgres'"
    },
    "release_id": {
      "name": "release_id",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "contract_version": {
      "name": "contract_version",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    },
    "state": {
      "name": "state",
      "type": "text",
      "primaryKey": false,
      "notNull": true,
      "default": "'reserved'"
    },
    "admission_fence": {
      "name": "admission_fence",
      "type": "bigint",
      "primaryKey": false,
      "notNull": true,
      "default": 0
    },
    "created_at": {
      "name": "created_at",
      "type": "timestamp with time zone",
      "primaryKey": false,
      "notNull": true,
      "default": "clock_timestamp()"
    },
    "admitted_at": {
      "name": "admitted_at",
      "type": "timestamp with time zone",
      "primaryKey": false,
      "notNull": false
    },
    "creation_key": {
      "name": "creation_key",
      "type": "text",
      "primaryKey": false,
      "notNull": true
    }
  },
  "indexes": {},
  "foreignKeys": {
    "approval_direct_execution_domains_owner_fk": {
      "name": "approval_direct_execution_domains_owner_fk",
      "tableFrom": "approval_direct_execution_domains",
      "tableTo": "users",
      "columnsFrom": [
        "owner_user_id"
      ],
      "columnsTo": [
        "id"
      ],
      "onDelete": "no action",
      "onUpdate": "no action"
    },
    "approval_direct_execution_domains_thread_binding_fk": {
      "name": "approval_direct_execution_domains_thread_binding_fk",
      "tableFrom": "approval_direct_execution_domains",
      "tableTo": "threads",
      "columnsFrom": [
        "thread_id",
        "tenant_id",
        "agent_id"
      ],
      "columnsTo": [
        "id",
        "tenant_id",
        "agent_id"
      ],
      "onDelete": "no action",
      "onUpdate": "no action"
    }
  },
  "compositePrimaryKeys": {
    "approval_direct_execution_domains_pkey": {
      "name": "approval_direct_execution_domains_pkey",
      "columns": [
        "domain_id"
      ]
    }
  },
  "uniqueConstraints": {
    "approval_direct_execution_domains_thread_unique": {
      "name": "approval_direct_execution_domains_thread_unique",
      "nullsNotDistinct": false,
      "columns": [
        "thread_id"
      ]
    },
    "approval_direct_execution_domains_scope_genesis_unique": {
      "name": "approval_direct_execution_domains_scope_genesis_unique",
      "nullsNotDistinct": false,
      "columns": [
        "tenant_id",
        "owner_user_id",
        "source_run_id"
      ]
    },
    "approval_direct_execution_domains_scope_binding_unique": {
      "name": "approval_direct_execution_domains_scope_binding_unique",
      "nullsNotDistinct": false,
      "columns": [
        "domain_id",
        "tenant_id",
        "owner_user_id",
        "thread_id",
        "agent_id"
      ]
    },
    "approval_direct_execution_domains_creation_unique": {
      "name": "approval_direct_execution_domains_creation_unique",
      "nullsNotDistinct": false,
      "columns": [
        "tenant_id",
        "owner_user_id",
        "creation_key"
      ]
    },
    "approval_direct_execution_domains_allocation_binding_unique": {
      "name": "approval_direct_execution_domains_allocation_binding_unique",
      "nullsNotDistinct": false,
      "columns": [
        "domain_id",
        "tenant_id",
        "owner_user_id",
        "thread_id",
        "agent_id",
        "source_run_id",
        "release_id",
        "backend"
      ]
    }
  },
  "policies": {},
  "checkConstraints": {
    "domain_nonblank_text_check": {
      "name": "domain_nonblank_text_check",
      "value": "length(btrim(tenant_id))>0 AND length(btrim(owner_user_id))>0 AND length(btrim(thread_id))>0 AND length(btrim(source_run_id))>0 AND length(btrim(agent_id))>0 AND length(btrim(release_id))>0 AND length(btrim(contract_version))>0 AND length(btrim(creation_key))>0"
    },
    "domain_execution_kind_check": {
      "name": "domain_execution_kind_check",
      "value": "execution_kind='direct_thread'"
    },
    "domain_backend_check": {
      "name": "domain_backend_check",
      "value": "backend='local_postgres'"
    },
    "domain_reserved_admitted_pair_check": {
      "name": "domain_reserved_admitted_pair_check",
      "value": "(state='reserved' AND admission_fence=0 AND admitted_at IS NULL) OR (state='admitted' AND admission_fence=1 AND admitted_at IS NOT NULL)"
    },
    "domain_contract_version_check": {
      "name": "domain_contract_version_check",
      "value": "contract_version='ap-direct-domain-v2'"
    }
  },
  "isRLSEnabled": true
});
    delete current.tables["public.approval_direct_execution_domains"];
    current.id = prior.id; current.prevId = prior.prevId;
    expect(current).toEqual(prior);
    expect(prior.tables["public.threads"].uniqueConstraints.threads_id_tenant_agent_unique.columns).toEqual(["id","tenant_id","agent_id"]);
    expect(prior.tables["public.users"].columns.id).toMatchObject({type:"text",primaryKey:true,notNull:true});
  });
  test("journal prefix 0..93 is byte-derived unchanged; only fixed idx94 appended", () => {
    const journal = JSON.parse(read("meta/_journal.json"));
    expect(journal.entries.pop()).toEqual({idx:94,version:"7",when:1792365686153,tag:"0094_approval_direct_execution_domains",breakpoints:true});
    expect(journal).toEqual({
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1786891733850,
      "tag": "0000_schema",
      "breakpoints": true
    },
    {
      "idx": 1,
      "version": "7",
      "when": 1787198911059,
      "tag": "0001_swift_morph",
      "breakpoints": true
    },
    {
      "idx": 2,
      "version": "7",
      "when": 1787275307382,
      "tag": "0002_sign_in",
      "breakpoints": true
    },
    {
      "idx": 3,
      "version": "7",
      "when": 1787275307621,
      "tag": "0003_backfill_account_issuer",
      "breakpoints": true
    },
    {
      "idx": 4,
      "version": "7",
      "when": 1787324562029,
      "tag": "0004_identity_provider_outlives_its_registrar",
      "breakpoints": true
    },
    {
      "idx": 5,
      "version": "7",
      "when": 1787324600000,
      "tag": "0005_computer_snapshot",
      "breakpoints": true
    },
    {
      "idx": 6,
      "version": "7",
      "when": 1787330336906,
      "tag": "0006_audit_read_indexes",
      "breakpoints": true
    },
    {
      "idx": 7,
      "version": "7",
      "when": 1787330552602,
      "tag": "0007_audit_retention_window",
      "breakpoints": true
    },
    {
      "idx": 8,
      "version": "7",
      "when": 1787339895173,
      "tag": "0008_whole_retro_girl",
      "breakpoints": true
    },
    {
      "idx": 9,
      "version": "7",
      "when": 1787342459868,
      "tag": "0009_lumpy_sunfire",
      "breakpoints": true
    },
    {
      "idx": 10,
      "version": "7",
      "when": 1787357412066,
      "tag": "0010_drop_the_document_index",
      "breakpoints": true
    },
    {
      "idx": 11,
      "version": "7",
      "when": 1787358347113,
      "tag": "0011_drop_the_old_connector_tables",
      "breakpoints": true
    },
    {
      "idx": 12,
      "version": "7",
      "when": 1787359000000,
      "tag": "0012_truncate_is_not_a_way_around_append_only",
      "breakpoints": true
    },
    {
      "idx": 13,
      "version": "7",
      "when": 1787380044372,
      "tag": "0013_skill_tools",
      "breakpoints": true
    },
    {
      "idx": 14,
      "version": "7",
      "when": 1787380104372,
      "tag": "0014_snapshot_session",
      "breakpoints": true
    },
    {
      "idx": 15,
      "version": "7",
      "when": 1787525879804,
      "tag": "0015_credentials_one_live_key",
      "breakpoints": true
    },
    {
      "idx": 16,
      "version": "7",
      "when": 1787581516968,
      "tag": "0016_pin_and_soft_delete_channels",
      "breakpoints": true
    },
    {
      "idx": 17,
      "version": "7",
      "when": 1787684818682,
      "tag": "0017_durable_work",
      "breakpoints": true
    },
    {
      "idx": 18,
      "version": "7",
      "when": 1787688017645,
      "tag": "0018_page_frames",
      "breakpoints": true
    },
    {
      "idx": 19,
      "version": "7",
      "when": 1787744867526,
      "tag": "0019_channel_read_marker",
      "breakpoints": true
    },
    {
      "idx": 20,
      "version": "7",
      "when": 1787761381038,
      "tag": "0020_attention_resolutions",
      "breakpoints": true
    },
    {
      "idx": 21,
      "version": "7",
      "when": 1787767359748,
      "tag": "0021_routines",
      "breakpoints": true
    },
    {
      "idx": 22,
      "version": "7",
      "when": 1787841150017,
      "tag": "0022_drop_attention_resolutions",
      "breakpoints": true
    },
    {
      "idx": 23,
      "version": "7",
      "when": 1787841174859,
      "tag": "0023_routines_owner_index",
      "breakpoints": true
    },
    {
      "idx": 24,
      "version": "7",
      "when": 1787926466892,
      "tag": "0024_onboarding",
      "breakpoints": true
    },
    {
      "idx": 25,
      "version": "7",
      "when": 1787926472382,
      "tag": "0025_backfill_existing_users_have_onboarded",
      "breakpoints": true
    },
    {
      "idx": 26,
      "version": "7",
      "when": 1788271863590,
      "tag": "0026_channel_summary",
      "breakpoints": true
    },
    {
      "idx": 27,
      "version": "7",
      "when": 1788543624826,
      "tag": "0027_user_instructions",
      "breakpoints": true
    },
    {
      "idx": 28,
      "version": "7",
      "when": 1788548093782,
      "tag": "0028_audit_initiator",
      "breakpoints": true
    },
    {
      "idx": 29,
      "version": "7",
      "when": 1788911713422,
      "tag": "0029_mastra_agent_type",
      "breakpoints": true
    },
    {
      "idx": 30,
      "version": "7",
      "when": 1788989179914,
      "tag": "0030_daffy_nighthawk",
      "breakpoints": true
    },
    {
      "idx": 31,
      "version": "7",
      "when": 1788990260165,
      "tag": "0031_hesitant_squadron_sinister",
      "breakpoints": true
    },
    {
      "idx": 32,
      "version": "7",
      "when": 1789059537115,
      "tag": "0032_rainy_lake",
      "breakpoints": true
    },
    {
      "idx": 33,
      "version": "7",
      "when": 1789066859018,
      "tag": "0033_attachments_uploaded_by_index",
      "breakpoints": true
    },
    {
      "idx": 34,
      "version": "7",
      "when": 1789162066485,
      "tag": "0034_last_signed_in_at",
      "breakpoints": true
    },
    {
      "idx": 35,
      "version": "7",
      "when": 1789162076466,
      "tag": "0035_backfill_last_signed_in_at",
      "breakpoints": true
    },
    {
      "idx": 36,
      "version": "7",
      "when": 1789182921776,
      "tag": "0036_routine_sweeps",
      "breakpoints": true
    },
    {
      "idx": 37,
      "version": "7",
      "when": 1789389068825,
      "tag": "0037_composio",
      "breakpoints": true
    },
    {
      "idx": 38,
      "version": "7",
      "when": 1789389080686,
      "tag": "0038_composio_schemes",
      "breakpoints": true
    },
    {
      "idx": 39,
      "version": "7",
      "when": 1789389088622,
      "tag": "0039_composio_probe_action",
      "breakpoints": true
    },
    {
      "idx": 40,
      "version": "7",
      "when": 1789495814957,
      "tag": "0040_drop_orphaned_skill_grants",
      "breakpoints": true
    },
    {
      "idx": 41,
      "version": "7",
      "when": 1789540094910,
      "tag": "0041_drop_orphaned_mcp_grants",
      "breakpoints": true
    },
    {
      "idx": 42,
      "version": "7",
      "when": 1789569523560,
      "tag": "0042_user_preferences",
      "breakpoints": true
    },
    {
      "idx": 43,
      "version": "7",
      "when": 1789579982431,
      "tag": "0043_plugin_logos",
      "breakpoints": true
    },
    {
      "idx": 44,
      "version": "7",
      "when": 1790035200000,
      "tag": "0044_voice_sessions",
      "breakpoints": true
    },
    {
      "idx": 45,
      "version": "7",
      "when": 1790164423415,
      "tag": "0045_channel_activity_source",
      "breakpoints": true
    },
    {
      "idx": 46,
      "version": "7",
      "when": 1790447917102,
      "tag": "0046_automatic_learning",
      "breakpoints": true
    },
    {
      "idx": 47,
      "version": "7",
      "when": 1790572443740,
      "tag": "0047_agent_pinning",
      "breakpoints": true
    },
    {
      "idx": 48,
      "version": "7",
      "when": 1790730431917,
      "tag": "0048_coworker_parity",
      "breakpoints": true
    },
    {
      "idx": 49,
      "version": "7",
      "when": 1790733068188,
      "tag": "0049_coworker_parity_lanes",
      "breakpoints": true
    },
    {
      "idx": 50,
      "version": "7",
      "when": 1790872515140,
      "tag": "0050_review_fixes",
      "breakpoints": true
    },
    {
      "idx": 51,
      "version": "7",
      "when": 1790939356628,
      "tag": "0051_routine_enabled_at",
      "breakpoints": true
    },
    {
      "idx": 52,
      "version": "7",
      "when": 1791226846287,
      "tag": "0052_adorable_hannibal_king",
      "breakpoints": true
    },
    {
      "idx": 53,
      "version": "7",
      "when": 1791226846568,
      "tag": "0053_tenant_rls",
      "breakpoints": true
    },
    {
      "idx": 54,
      "version": "7",
      "when": 1791228105477,
      "tag": "0054_app_role",
      "breakpoints": true
    },
    {
      "idx": 55,
      "version": "7",
      "when": 1791229400344,
      "tag": "0055_tidy_starhawk",
      "breakpoints": true
    },
    {
      "idx": 56,
      "version": "7",
      "when": 1791229452847,
      "tag": "0056_tenant_rls_replay",
      "breakpoints": true
    },
    {
      "idx": 57,
      "version": "7",
      "when": 1791233513285,
      "tag": "0057_milky_victor_mancha",
      "breakpoints": true
    },
    {
      "idx": 58,
      "version": "7",
      "when": 1791233723173,
      "tag": "0058_burly_winter_soldier",
      "breakpoints": true
    },
    {
      "idx": 59,
      "version": "7",
      "when": 1791239335242,
      "tag": "0059_platform_scope",
      "breakpoints": true
    },
    {
      "idx": 60,
      "version": "7",
      "when": 1791239793247,
      "tag": "0060_platform_write",
      "breakpoints": true
    },
    {
      "idx": 61,
      "version": "7",
      "when": 1791240919637,
      "tag": "0061_happy_sleepwalker",
      "breakpoints": true
    },
    {
      "idx": 62,
      "version": "7",
      "when": 1791241676411,
      "tag": "0062_package_tenant_exempt",
      "breakpoints": true
    },
    {
      "idx": 63,
      "version": "7",
      "when": 1791243570296,
      "tag": "0063_certain_betty_ross",
      "breakpoints": true
    },
    {
      "idx": 64,
      "version": "7",
      "when": 1791244927031,
      "tag": "0064_late_gamora",
      "breakpoints": true
    },
    {
      "idx": 65,
      "version": "7",
      "when": 1791246141495,
      "tag": "0065_talented_slipstream",
      "breakpoints": true
    },
    {
      "idx": 66,
      "version": "7",
      "when": 1791254016344,
      "tag": "0066_common_magneto",
      "breakpoints": true
    },
    {
      "idx": 67,
      "version": "7",
      "when": 1791258631439,
      "tag": "0067_perpetual_warstar",
      "breakpoints": true
    },
    {
      "idx": 68,
      "version": "7",
      "when": 1791271447074,
      "tag": "0068_seed_plan_catalogue",
      "breakpoints": true
    },
    {
      "idx": 69,
      "version": "7",
      "when": 1791278517294,
      "tag": "0069_smiling_boomer",
      "breakpoints": true
    },
    {
      "idx": 70,
      "version": "7",
      "when": 1791281586374,
      "tag": "0070_waker_groups",
      "breakpoints": true
    },
    {
      "idx": 71,
      "version": "7",
      "when": 1791281646374,
      "tag": "0071_rls_write_scope",
      "breakpoints": true
    },
    {
      "idx": 72,
      "version": "7",
      "when": 1791301891979,
      "tag": "0072_rls_command_scopes",
      "breakpoints": true
    },
    {
      "idx": 73,
      "version": "7",
      "when": 1791382710878,
      "tag": "0073_mcp_catalogue_key",
      "breakpoints": true
    },
    {
      "idx": 74,
      "version": "7",
      "when": 1791408170267,
      "tag": "0074_skill_package_id",
      "breakpoints": true
    },
    {
      "idx": 75,
      "version": "7",
      "when": 1791411170966,
      "tag": "0075_group_task_pipeline",
      "breakpoints": true
    },
    {
      "idx": 76,
      "version": "7",
      "when": 1791412786724,
      "tag": "0076_run_outlives_template",
      "breakpoints": true
    },
    {
      "idx": 77,
      "version": "7",
      "when": 1791448383393,
      "tag": "0077_task_executor_optional",
      "breakpoints": true
    },
    {
      "idx": 78,
      "version": "7",
      "when": 1791463239711,
      "tag": "0078_drop_learning",
      "breakpoints": true
    },
    {
      "idx": 79,
      "version": "7",
      "when": 1791628464023,
      "tag": "0079_pipeline_driver_claim",
      "breakpoints": true
    },
    {
      "idx": 80,
      "version": "7",
      "when": 1791629841965,
      "tag": "0080_wakerflow_quota_contracts",
      "breakpoints": true
    },
    {
      "idx": 81,
      "version": "7",
      "when": 1792332786923,
      "tag": "0081_recovery_subject_and_binding",
      "breakpoints": true
    },
    {
      "idx": 82,
      "version": "7",
      "when": 1792334435193,
      "tag": "0082_recovery_role_foundations",
      "breakpoints": true
    },
    {
      "idx": 83,
      "version": "7",
      "when": 1792335857617,
      "tag": "0083_recovery_task_flow_audit_contract",
      "breakpoints": true
    },
    {
      "idx": 84,
      "version": "7",
      "when": 1792338964021,
      "tag": "0084_recovery_flow_source_foundations",
      "breakpoints": true
    },
    {
      "idx": 85,
      "version": "7",
      "when": 1792342279749,
      "tag": "0085_recovery_flow_source_run_records",
      "breakpoints": true
    },
    {
      "idx": 86,
      "version": "7",
      "when": 1792344488506,
      "tag": "0086_recovery_flow_source_runtime_records",
      "breakpoints": true
    },
    {
      "idx": 87,
      "version": "7",
      "when": 1792347080676,
      "tag": "0087_recovery_flow_source_original_records",
      "breakpoints": true
    },
    {
      "idx": 88,
      "version": "7",
      "when": 1792349468270,
      "tag": "0088_recovery_flow_run_coordination",
      "breakpoints": true
    },
    {
      "idx": 89,
      "version": "7",
      "when": 1792352647000,
      "tag": "0089_recovery_flow_official_bindings",
      "breakpoints": true
    },
    {
      "idx": 90,
      "version": "7",
      "when": 1792356154000,
      "tag": "0090_recovery_group_pipeline_start_receipts",
      "breakpoints": true
    },
    {
      "idx": 91,
      "version": "7",
      "when": 1792358130166,
      "tag": "0091_recovery_flow_customization_foundations",
      "breakpoints": true
    },
    {
      "idx": 92,
      "version": "7",
      "when": 1792360807185,
      "tag": "0092_threads_domain_parent_key",
      "breakpoints": true
    },
    {
      "idx": 93,
      "version": "7",
      "when": 1792364117308,
      "tag": "0093_recovery_flow_customization_turns",
      "breakpoints": true
    }
  ]
});
  });
});

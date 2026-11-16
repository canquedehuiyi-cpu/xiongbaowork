import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { threadRunEvents, threadRuns, threads } from "../src/db/schema/threads";
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

// Independent immutable old parent capsule, not an expectation generated from the new model.
const oldParentRaw="{\n  \"name\": \"threads\",\n  \"schema\": \"\",\n  \"columns\": {\n    \"id\": {\n      \"name\": \"id\",\n      \"type\": \"text\",\n      \"primaryKey\": true,\n      \"notNull\": true\n    },\n    \"tenant_id\": {\n      \"name\": \"tenant_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"current_setting('app.tenant_id', true)\"\n    },\n    \"agent_id\": {\n      \"name\": \"agent_id\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": true\n    },\n    \"name\": {\n      \"name\": \"name\",\n      \"type\": \"text\",\n      \"primaryKey\": false,\n      \"notNull\": false\n    },\n    \"messages_snapshot\": {\n      \"name\": \"messages_snapshot\",\n      \"type\": \"jsonb\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"'[]'::jsonb\"\n    },\n    \"created_at\": {\n      \"name\": \"created_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    },\n    \"updated_at\": {\n      \"name\": \"updated_at\",\n      \"type\": \"timestamp with time zone\",\n      \"primaryKey\": false,\n      \"notNull\": true,\n      \"default\": \"now()\"\n    }\n  },\n  \"indexes\": {\n    \"threads_tenant_created_idx\": {\n      \"name\": \"threads_tenant_created_idx\",\n      \"columns\": [\n        {\n          \"expression\": \"tenant_id\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        },\n        {\n          \"expression\": \"created_at\",\n          \"isExpression\": false,\n          \"asc\": true,\n          \"nulls\": \"last\"\n        }\n      ],\n      \"isUnique\": false,\n      \"concurrently\": false,\n      \"method\": \"btree\",\n      \"with\": {}\n    }\n  },\n  \"foreignKeys\": {},\n  \"compositePrimaryKeys\": {},\n  \"uniqueConstraints\": {},\n  \"policies\": {},\n  \"checkConstraints\": {},\n  \"isRLSEnabled\": false\n}\n";
const oldParentSHA="40e957b93e7dc3a9eef60fbb862900cdd45e15481e480975d3713eeb265d5503";
const oldParent=JSON.parse(oldParentRaw) as Table;
// Related old structures from Root-approved readonly input58758B SHA6eef1ba37d55b7decf0af2d93f55c6fa7a7d46490e8f86174bd534241971c831.
const relatedRaw="{\n  \"public.thread_runs\": {\n    \"name\": \"thread_runs\",\n    \"schema\": \"\",\n    \"columns\": {\n      \"id\": {\n        \"name\": \"id\",\n        \"type\": \"text\",\n        \"primaryKey\": true,\n        \"notNull\": true\n      },\n      \"tenant_id\": {\n        \"name\": \"tenant_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": \"current_setting('app.tenant_id', true)\"\n      },\n      \"thread_id\": {\n        \"name\": \"thread_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"agent_id\": {\n        \"name\": \"agent_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"parent_run_id\": {\n        \"name\": \"parent_run_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": false\n      },\n      \"event_count\": {\n        \"name\": \"event_count\",\n        \"type\": \"integer\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": 0\n      },\n      \"created_at\": {\n        \"name\": \"created_at\",\n        \"type\": \"timestamp with time zone\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": \"now()\"\n      }\n    },\n    \"indexes\": {\n      \"thread_runs_thread_idx\": {\n        \"name\": \"thread_runs_thread_idx\",\n        \"columns\": [\n          {\n            \"expression\": \"thread_id\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          },\n          {\n            \"expression\": \"created_at\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          }\n        ],\n        \"isUnique\": false,\n        \"concurrently\": false,\n        \"method\": \"btree\",\n        \"with\": {}\n      }\n    },\n    \"foreignKeys\": {\n      \"thread_runs_thread_id_threads_id_fk\": {\n        \"name\": \"thread_runs_thread_id_threads_id_fk\",\n        \"tableFrom\": \"thread_runs\",\n        \"tableTo\": \"threads\",\n        \"columnsFrom\": [\n          \"thread_id\"\n        ],\n        \"columnsTo\": [\n          \"id\"\n        ],\n        \"onDelete\": \"cascade\",\n        \"onUpdate\": \"no action\"\n      }\n    },\n    \"compositePrimaryKeys\": {},\n    \"uniqueConstraints\": {},\n    \"policies\": {},\n    \"checkConstraints\": {},\n    \"isRLSEnabled\": false\n  },\n  \"public.thread_run_events\": {\n    \"name\": \"thread_run_events\",\n    \"schema\": \"\",\n    \"columns\": {\n      \"tenant_id\": {\n        \"name\": \"tenant_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": \"current_setting('app.tenant_id', true)\"\n      },\n      \"thread_id\": {\n        \"name\": \"thread_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"run_id\": {\n        \"name\": \"run_id\",\n        \"type\": \"text\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"seq\": {\n        \"name\": \"seq\",\n        \"type\": \"integer\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"event\": {\n        \"name\": \"event\",\n        \"type\": \"jsonb\",\n        \"primaryKey\": false,\n        \"notNull\": true\n      },\n      \"created_at\": {\n        \"name\": \"created_at\",\n        \"type\": \"timestamp with time zone\",\n        \"primaryKey\": false,\n        \"notNull\": true,\n        \"default\": \"now()\"\n      }\n    },\n    \"indexes\": {\n      \"thread_run_events_thread_idx\": {\n        \"name\": \"thread_run_events_thread_idx\",\n        \"columns\": [\n          {\n            \"expression\": \"thread_id\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          },\n          {\n            \"expression\": \"seq\",\n            \"isExpression\": false,\n            \"asc\": true,\n            \"nulls\": \"last\"\n          }\n        ],\n        \"isUnique\": false,\n        \"concurrently\": false,\n        \"method\": \"btree\",\n        \"with\": {}\n      }\n    },\n    \"foreignKeys\": {\n      \"thread_run_events_thread_id_threads_id_fk\": {\n        \"name\": \"thread_run_events_thread_id_threads_id_fk\",\n        \"tableFrom\": \"thread_run_events\",\n        \"tableTo\": \"threads\",\n        \"columnsFrom\": [\n          \"thread_id\"\n        ],\n        \"columnsTo\": [\n          \"id\"\n        ],\n        \"onDelete\": \"cascade\",\n        \"onUpdate\": \"no action\"\n      }\n    },\n    \"compositePrimaryKeys\": {\n      \"thread_run_events_thread_id_run_id_seq_pk\": {\n        \"name\": \"thread_run_events_thread_id_run_id_seq_pk\",\n        \"columns\": [\n          \"thread_id\",\n          \"run_id\",\n          \"seq\"\n        ]\n      }\n    },\n    \"uniqueConstraints\": {},\n    \"policies\": {},\n    \"checkConstraints\": {},\n    \"isRLSEnabled\": false\n  }\n}\n";
const relatedSHA="ac1f7b60c3b0774ace075f63b1278d7d45c5037f14b16c04fcdb1ac4a4a2c7f3";
const oldRelated=JSON.parse(relatedRaw) as Record<string,Table>;
// Root NEW DESIGN, distinct from historical0121 recovery: ordinary nondeferrable UNIQUE.
const constraintName="threads_id_tenant_agent_unique";
const design={name:constraintName,nullsNotDistinct:false,columns:["id","tenant_id","agent_id"]};
const server=join(import.meta.dir,".."),overlay=join(server,"recovery/recovery-20261018-v1");
const migration=readFileSync(join(overlay,"sql/0092_threads_domain_parent_key.sql"),"utf8");
const previous=JSON.parse(readFileSync(join(overlay,"meta/0091_snapshot.json"),"utf8")) as Snapshot;
const next=JSON.parse(readFileSync(join(overlay,"meta/0092_snapshot.json"),"utf8")) as Snapshot;
const journal=JSON.parse(readFileSync(join(overlay,"meta/_journal.json"),"utf8")) as Journal;
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
      else if (column.getSQLType() === "jsonb") {
        const encoded: unknown = column.mapToDriverValue(value);
        assert.equal(typeof encoded, "string");
        assert.ok(typeof encoded === "string");
        item.default = `'${encoded.replaceAll("'", "''")}'::jsonb`;
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

function parseParentDDL(source:string):{table:string;constraint:typeof design;deferrable:false} {
 const tokens=tokenize(source);assert.equal(tokens.at(-1),';');const statements=parts(tokens,';');assert.equal(statements.length,1,'only one complete ALTER allowed');const items=statements[0];assert.ok(items);const c=new Cursor(items);c.take('ALTER');c.take('TABLE');const table=c.table();c.take('ADD');c.take('CONSTRAINT');const name=c.id();c.take('UNIQUE');const columns=c.ids();c.finish();return {table,constraint:{name,columns,nullsNotDistinct:false},deferrable:false};
}
function checkSQL(source:string):void {assert.deepEqual(parseParentDDL(source),{table:'threads',constraint:design,deferrable:false});}
function checkParent(after:Table):void {
 assert.deepEqual(after.uniqueConstraints,{[constraintName]:design});const restored=structuredClone(after);delete restored.uniqueConstraints[constraintName];assert.deepEqual(normalize(restored),normalize(oldParent),'all old7 columns/PK/default/index/RLS/policies exactly preserved');
}
function checkRelated(actual:Record<string,Table>):void {
 assert.deepEqual(Object.keys(actual).sort(),Object.keys(oldRelated).sort());for(const [key,expected] of Object.entries(oldRelated)){const table=actual[key];assert.ok(table);assert.deepEqual(normalize(table),normalize(expected),key);}
}
function actualRelated():Record<string,Table> {return Object.fromEntries([threadRuns,threadRunEvents].map(model=>{const t=metadata(model);return [`public.${t.name}`,t];}));}
function checkSnapshot(s:Snapshot):void {
 assert.equal(previous.id,'652f59a9-6637-445c-a3bc-9b024c35c430');assert.deepEqual(previous.tables['public.threads'],oldParent);assert.equal(s.id,'93799236-f884-4089-aded-07f659b155fa');assert.equal(s.prevId,previous.id);assert.equal(Object.keys(s.tables).length,123);const parent=s.tables['public.threads'];assert.ok(parent);checkParent(parent);const restore=structuredClone(s);const restoredParent=restore.tables['public.threads'];assert.ok(restoredParent);delete restoredParent.uniqueConstraints[constraintName];restore.id=previous.id;restore.prevId=previous.prevId;assert.deepEqual(restore,previous,'all123 original tables/tops restored after removing only new key and lineage');
}
function checkJournal(j:Journal):void {
 const original=JSON.parse(readFileSync(join(server,'drizzle/meta/_journal.json'),'utf8')) as Journal;assert.equal(j.version,original.version);assert.equal(j.dialect,original.dialect);assert.ok(j.entries.length>=93,'stage prefix has no unknown suffix release authority');assert.deepEqual(j.entries.slice(0,81),original.entries);assert.equal(createHash('sha256').update(JSON.stringify(j.entries.slice(0,92))).digest('hex'),'36dcb2e3a8cf40ed2a3b5d5554109d02f10639d8f69ff8be9a5ea5d4db3380cc');const entry=j.entries[92];assert.ok(entry);assert.deepEqual(entry,{idx:92,version:'7',when:1792360807185,tag:'0092_threads_domain_parent_key',breakpoints:true});const prev=j.entries[91];assert.ok(prev);assert.ok(entry.when>prev.when&&entry.when<=Date.now());
}
function filesUnder(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{assert.ok(!entry.isSymbolicLink());const full=join(path,entry.name);return entry.isDirectory()?filesUnder(full):[full];});}
function rejectSQL(before:string,after:string):void {assert.ok(migration.includes(before));const changed=migration.replace(before,after);assert.notEqual(changed,migration);expect(()=>checkSQL(changed)).toThrow();}
describe('Root new threads domain parent key prerequisite only',()=>{
 test('old independent parent and related complete structure raw identities stay fixed',()=>{expect(createHash('sha256').update(oldParentRaw).digest('hex')).toBe(oldParentSHA);expect(createHash('sha256').update(relatedRaw).digest('hex')).toBe(relatedSHA);expect(oldParent.uniqueConstraints).toEqual({});});
 test('exact single ALTER is fully consumed and matches independent Root plain UNIQUE design',()=>checkSQL(migration));
 test('real Drizzle UNIQUE constraint has exact3 ordered columns and inverse metadata equals old parent',()=>checkParent(metadata(threads)));
 test('real related threadRuns/events retain full metadata including both singleid CASCADE FKs',()=>checkRelated(actualRelated()));
 test('existing PK/default/ordinary index and builtin JSONB array driver stay intact without authority claims',()=>{
  const cfg=getTableConfig(threads);expect(threads.id.primary).toBe(true);expect(threads.id.hasDefault).toBe(false);expect(threads.agentId.notNull).toBe(true);expect(threads.tenantId.notNull).toBe(true);expect(cfg.enableRLS).toBe(false);expect(cfg.policies).toHaveLength(0);expect(cfg.indexes).toHaveLength(1);expect(cfg.uniqueConstraints).toHaveLength(1);expect(Array.isArray(threads.messagesSnapshot.default)).toBe(true);expect(threads.messagesSnapshot.default).toEqual([]);expect(threads.messagesSnapshot.mapToDriverValue([])).toBe('[]');expect(threads.messagesSnapshot.mapFromDriverValue('[]')).toEqual([]);
 });
 test('inverse unique and lineage restores complete123-table snapshot and all top-level objects',()=>checkSnapshot(next));
 test('Root92 journal keeps complete0..91 prefix and accepts successor without suffix execution permission',()=>{checkJournal(journal);const j=structuredClone(journal);j.entries.push({idx:93,version:'7',when:Date.now(),tag:'unapproved-prefix-fixture',breakpoints:true});checkJournal(j);expect(j.entries.length).toBe(journal.entries.length+1);});
 test('original163 and all81..91 migration/snapshot immutable identities stay exact',()=>{
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
  }
]){const b=readFileSync(join(server,input.path));expect(b.length).toBe(input.bytes);expect(createHash('sha256').update(b).digest('hex')).toBe(input.sha256);}
 });
 test('DDL rejects missing/extra/reordered key wrong name/table false unique and nulls upgrades',()=>{
  for(const [a,b] of [['("id", "tenant_id", "agent_id")','("id", "tenant_id")'],['("id", "tenant_id", "agent_id")','("id", "tenant_id", "agent_id", "name")'],['("id", "tenant_id", "agent_id")','("tenant_id", "id", "agent_id")'],['"threads_id_tenant_agent_unique"','"threads_wrong_unique"'],['"public"."threads"','"public"."thread_runs"'],[' UNIQUE ',' INDEX '],[' UNIQUE ',' UNIQUE NULLS NOT DISTINCT ']])rejectSQL(a,b);
 });
 test('restricted grammar rejects deferrable partial expression concurrent uniqueIndex and all extra DML/GRANT/RLS',()=>{
  for(const suffix of [' DEFERRABLE',' NOT DEFERRABLE',' DEFERRABLE INITIALLY DEFERRED',' WHERE true'])rejectSQL(');',')'+suffix+';');rejectSQL('("id", "tenant_id", "agent_id")','(lower("id"), "tenant_id", "agent_id")');for(const source of ['CREATE UNIQUE INDEX "threads_id_tenant_agent_unique" ON "public"."threads" ("id", "tenant_id", "agent_id");','CREATE UNIQUE INDEX CONCURRENTLY "threads_id_tenant_agent_unique" ON "public"."threads" ("id", "tenant_id", "agent_id");'])expect(()=>checkSQL(source)).toThrow();for(const extra of ['UPDATE "public"."threads" SET "agent_id"=\'x\';','GRANT ALL ON "public"."threads" TO public;','ALTER TABLE "public"."threads" ENABLE ROW LEVEL SECURITY;','ALTER TABLE "public"."threads" DROP CONSTRAINT "threads_pkey";','ALTER TABLE "public"."threads" ADD COLUMN "fake" text;'])expect(()=>checkSQL(migration+extra)).toThrow();expect(()=>checkSQL(migration+migration)).toThrow();expect(()=>checkSQL(migration.replace(';',''))).toThrow();
 });
 test('metadata inverse rejects wrong unique shape and any old PK/default/index/policy drift',()=>{
  const changes:((t:Table)=>void)[]=[t=>{t.uniqueConstraints={};},t=>{t.uniqueConstraints[constraintName]={...design,nullsNotDistinct:true};},t=>{t.uniqueConstraints[constraintName]={...design,columns:['tenant_id','id','agent_id']};},t=>{t.uniqueConstraints.extra={...design,name:'extra'};},t=>{const c=t.columns.id;assert.ok(c);c.primaryKey=false;},t=>{const c=t.columns.messages_snapshot;assert.ok(c);c.default="'{}'::jsonb";},t=>{t.indexes={};},t=>{t.isRLSEnabled=true;},t=>{t.policies.fake={name:'fake',as:'PERMISSIVE',for:'SELECT',to:['public'],using:'true'};}];for(const change of changes){const t=metadata(threads);change(t);expect(()=>checkParent(t)).toThrow();}
  for(const key of Object.keys(oldRelated)){const actual=actualRelated();const t=actual[key];assert.ok(t);const fk=Object.values(t.foreignKeys)[0];assert.ok(fk);fk.onDelete='no action';expect(()=>checkRelated(actual)).toThrow();}
 });
 test('snapshot and lineage reject oldtable/top/column/parent key and prefix tampering',()=>{
  const changes:((s:Snapshot)=>void)[]=[s=>{s.prevId='wrong';},s=>{s.id=previous.id;},s=>{s.fakeTop=true;},s=>{const t=s.tables['public.threads'];assert.ok(t);delete t.uniqueConstraints[constraintName];},s=>{const t=s.tables['public.threads'];assert.ok(t);t.columns={};},s=>{const t=s.tables['public.thread_runs'];assert.ok(t);t.foreignKeys={};},s=>{const t=s.tables['public.thread_run_events'];assert.ok(t);t.indexes={};},s=>{delete s.tables['public.flow_customization_heads'];}];for(const change of changes){const s=structuredClone(next);change(s);expect(()=>checkSnapshot(s)).toThrow();}for(const idx of [0,81,82,83,84,85,86,87,88,89,90,91,92]){const j=structuredClone(journal);const entry=j.entries[idx];assert.ok(entry);entry.tag='forged';expect(()=>checkJournal(j)).toThrow();}const j=structuredClone(journal);const entry=j.entries[92];assert.ok(entry);entry.when++;expect(()=>checkJournal(j)).toThrow();
 });
});

import { lstat, readFile, realpath } from "node:fs/promises";
import { verifyBundle } from "./bundle";
import {
  exactPrefix,
  type HistoryRow,
  invariant,
  LINEAGE_ID,
  type Manifest,
  object,
  sha256,
  TARGET_CONTRACT,
} from "./manifest";

export interface PgConnection {
  // Implement with a parameterized driver on ONE reserved PostgreSQL connection.
  query(sql: string): Promise<readonly Record<string, unknown>[]>;
}
export interface PgAdapter {
  // BEGIN/COMMIT/ROLLBACK and callback MUST use the same reserved connection.
  // No pooled query dispatch, no reconnect/retry, no success journal on unknown commit.
  transaction<T>(
    callback: (connection: PgConnection) => Promise<T>,
  ): Promise<T>;
}
export const WRITER_LOCK_SQL =
  "select pg_catalog.pg_advisory_xact_lock(20261018, 1)";
export const METADATA_SQL =
  "select pg_catalog.to_regclass('drizzle.__drizzle_migrations')::text as history, pg_catalog.to_regclass('public.__recovery_lineage')::text as marker";
export const HISTORY_SQL =
  "select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id";
export const MARKER_SQL =
  "select lineage_id, bundle_sha256, contract_version from public.__recovery_lineage";
// Exact catalog definitions, not a max(timestamp) or a caller's object count.
// Root must freeze the expected digest per prefix from real PG. Snapshot JSON is
// not evidence for functions, ACLs, policies, triggers or deployment roles.
export const CATALOG_PROTOCOL_VERSION = "recovery-catalog-v2";
export const CATALOG_SQL = `
with ns as (select oid, nspname from pg_catalog.pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'),
facts as (
 select 'catalog-protocol' as kind, 'global' as identity, jsonb_build_object('protocolVersion','${CATALOG_PROTOCOL_VERSION}') as definition
 union all
 select 'context' as kind, 'database' as identity, jsonb_build_object('version',current_setting('server_version_num'),'search_path',current_setting('search_path'),'current_role',current_user,'database',current_database()) as definition
 union all
 select distinct 'object-inventory', d.classid::regclass::text||'/'||o.identity, jsonb_build_object('type',o.type,'schema',o.schema,'name',o.name) from pg_catalog.pg_depend d join ns n on d.refclassid='pg_catalog.pg_namespace'::regclass and d.refobjid=n.oid cross join lateral pg_catalog.pg_identify_object(d.classid,d.objid,d.objsubid) o
 union all
 select 'namespace', n.nspname as identity, jsonb_build_object('owner',pg_catalog.pg_get_userbyid(p.nspowner),'acl',p.nspacl::text) as definition from ns n join pg_catalog.pg_namespace p on p.oid=n.oid
 union all
 select 'relation', n.nspname||'.'||c.relname, jsonb_build_object('kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'has_rules',c.relhasrules,'acl',c.relacl::text,'options',c.reloptions,'partition',pg_catalog.pg_get_expr(c.relpartbound,c.oid)) from pg_catalog.pg_class c join ns n on c.relnamespace=n.oid
 union all
 select 'column', n.nspname||'.'||c.relname||'.'||a.attname, jsonb_build_object('position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text,'collation',co.collname) from pg_catalog.pg_attribute a join pg_catalog.pg_class c on a.attrelid=c.oid join ns n on c.relnamespace=n.oid left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum left join pg_catalog.pg_collation co on a.attcollation=co.oid where a.attnum>0 and not a.attisdropped
 union all
 select 'constraint', n.nspname||'.'||coalesce(c.relname,t.typname,'<global>')||'.'||k.conname, jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) from pg_catalog.pg_constraint k join ns n on k.connamespace=n.oid left join pg_catalog.pg_class c on k.conrelid=c.oid left join pg_catalog.pg_type t on k.contypid=t.oid
 union all
 select 'view', n.nspname||'.'||c.relname, jsonb_build_object('definition',pg_catalog.pg_get_viewdef(c.oid,true)) from pg_catalog.pg_class c join ns n on c.relnamespace=n.oid where c.relkind in ('v','m')
 union all
 select 'sequence', n.nspname||'.'||c.relname, jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,null),'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle) from pg_catalog.pg_sequence s join pg_catalog.pg_class c on c.oid=s.seqrelid join ns n on c.relnamespace=n.oid
 union all
 select 'extension', e.extname, jsonb_build_object('version',e.extversion,'namespace',n.nspname,'owner',pg_catalog.pg_get_userbyid(e.extowner)) from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace
 union all
 select 'index', n.nspname||'.'||c.relname, jsonb_build_object('definition',pg_catalog.pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid join ns n on c.relnamespace=n.oid
 union all
 select 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join ns n on c.relnamespace=n.oid where not t.tgisinternal
 union all
 select 'internal-trigger', jsonb_build_array(n.nspname,c.relname,kn.nspname,kcn.nspname,kc.relname,k.conname,fn.nspname,f.proname,pg_catalog.pg_get_function_identity_arguments(f.oid),t.tgtype,rn.nspname,rc.relname)::text, jsonb_build_object('enabled',t.tgenabled,'constraint',jsonb_build_object('schema',kn.nspname,'table_schema',kcn.nspname,'table',kc.relname,'name',k.conname,'type',k.contype),'event_mask',t.tgtype,'function',jsonb_build_object('schema',fn.nspname,'name',f.proname,'signature',pg_catalog.pg_get_function_identity_arguments(f.oid)),'referenced_relation',jsonb_build_object('schema',rn.nspname,'table',rc.relname),'supporting_index',jsonb_build_object('schema',ixn.nspname,'name',ix.relname),'parent_relation',jsonb_build_object('schema',pn.nspname,'table',pc.relname),'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred,'columns',t.tgattr::text,'args_hex',pg_catalog.encode(t.tgargs,'hex'),'when',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid)) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join ns n on c.relnamespace=n.oid join pg_catalog.pg_proc f on f.oid=t.tgfoid join pg_catalog.pg_namespace fn on fn.oid=f.pronamespace left join pg_catalog.pg_constraint k on k.oid=t.tgconstraint left join pg_catalog.pg_namespace kn on kn.oid=k.connamespace left join pg_catalog.pg_class kc on kc.oid=k.conrelid left join pg_catalog.pg_namespace kcn on kcn.oid=kc.relnamespace left join pg_catalog.pg_class rc on rc.oid=t.tgconstrrelid left join pg_catalog.pg_namespace rn on rn.oid=rc.relnamespace left join pg_catalog.pg_class ix on ix.oid=t.tgconstrindid left join pg_catalog.pg_namespace ixn on ixn.oid=ix.relnamespace left join pg_catalog.pg_trigger pt on pt.oid=t.tgparentid left join pg_catalog.pg_class pc on pc.oid=pt.tgrelid left join pg_catalog.pg_namespace pn on pn.oid=pc.relnamespace where t.tgisinternal
 union all
 select 'rewrite-rule', jsonb_build_array(n.nspname,c.relname,r.rulename)::text, jsonb_build_object('definition',pg_catalog.pg_get_ruledef(r.oid,true),'enabled',r.ev_enabled,'event',r.ev_type,'instead',r.is_instead) from pg_catalog.pg_rewrite r join pg_catalog.pg_class c on c.oid=r.ev_class join ns n on c.relnamespace=n.oid
 union all
 select 'policy', n.nspname||'.'||c.relname||'.'||p.polname, jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',(select jsonb_agg(case when r=0 then 'public' else pg_catalog.pg_get_userbyid(r) end order by r) from unnest(p.polroles) r),'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join ns n on c.relnamespace=n.oid
 union all
 select 'routine', n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')', jsonb_build_object('definition',case when p.prokind in ('f','p') then pg_catalog.pg_get_functiondef(p.oid) else null end,'kind',p.prokind,'owner',pg_catalog.pg_get_userbyid(p.proowner),'acl',p.proacl::text,'security_definer',p.prosecdef,'config',p.proconfig) from pg_catalog.pg_proc p join ns n on p.pronamespace=n.oid
 union all
 select 'type', n.nspname||'.'||t.typname, jsonb_build_object('kind',t.typtype,'owner',pg_catalog.pg_get_userbyid(t.typowner),'acl',t.typacl::text,'base',pg_catalog.format_type(t.typbasetype,t.typtypmod),'enum',(select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid=t.oid)) from pg_catalog.pg_type t join ns n on t.typnamespace=n.oid
 union all
 select 'role', r.rolname, jsonb_build_object('super',r.rolsuper,'inherit',r.rolinherit,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,'config',r.rolconfig) from pg_catalog.pg_roles r where r.rolname !~ '^pg_'
 union all
 select 'membership', jsonb_build_array(pg_catalog.pg_get_userbyid(m.roleid),pg_catalog.pg_get_userbyid(m.member),pg_catalog.pg_get_userbyid(m.grantor))::text, jsonb_build_object('granted_role',pg_catalog.pg_get_userbyid(m.roleid),'member',pg_catalog.pg_get_userbyid(m.member),'grantor',pg_catalog.pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit_option',m.inherit_option,'set_option',m.set_option) from pg_catalog.pg_auth_members m
 union all
 select 'default_acl', coalesce(n.nspname,'<global>')||'/'||pg_catalog.pg_get_userbyid(d.defaclrole)||'/'||d.defaclobjtype, jsonb_build_object('acl',d.defaclacl::text) from pg_catalog.pg_default_acl d left join ns n on n.oid=d.defaclnamespace where d.defaclnamespace=0 or n.oid is not null
)
select kind, identity, definition from facts order by kind, identity`;
export interface CatalogFact {
  kind: string;
  identity: string;
  definition: unknown;
}
export interface LineageMarker {
  lineage_id: string;
  bundle_sha256: string;
  contract_version: string;
}
export interface PgEvidence {
  protocolVersion: string;
  history: HistoryRow[];
  catalog: CatalogFact[];
  marker: LineageMarker | null;
  historyTable: boolean;
}
// Sorting JSON keys prevents driver object-key order from becoming a false diff.
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "BAD_CATALOG_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = object(value);
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(",")}}`;
}
export function catalogDigest(facts: readonly CatalogFact[]): string {
  const sorted = [...facts].sort((a, b) =>
    `${a.kind}\0${a.identity}` < `${b.kind}\0${b.identity}` ? -1 : 1,
  );
  const seen = new Set<string>();
  for (const f of sorted) {
    const key = `${f.kind}\0${f.identity}`;
    invariant(
      f.kind && f.identity && !seen.has(key),
      "INVALID_OR_DUPLICATE_CATALOG_FACT",
    );
    if (f.kind === "membership") {
      const definition = object(f.definition);
      for (const name of ["granted_role", "member", "grantor"])
        invariant(
          typeof definition[name] === "string" && definition[name].length > 0,
          "INVALID_MEMBERSHIP_IDENTITY",
        );
      for (const name of ["admin", "inherit_option", "set_option"])
        invariant(
          typeof definition[name] === "boolean",
          "INVALID_MEMBERSHIP_OPTION",
        );
      // PG JSON text may contain whitespace. Compare the tuple, never a slash-joined name.
      invariant(
        canonical(JSON.parse(f.identity)) ===
          canonical([
            definition.granted_role,
            definition.member,
            definition.grantor,
          ]),
        "MEMBERSHIP_IDENTITY_MISMATCH",
      );
    }
    seen.add(key);
  }
  return sha256(
    canonical({ protocolVersion: CATALOG_PROTOCOL_VERSION, facts: sorted }),
  );
}
export async function readPgEvidence(
  connection: PgConnection,
): Promise<PgEvidence> {
  const meta = await connection.query(METADATA_SQL);
  invariant(meta.length === 1, "UNKNOWN_METADATA_STATE");
  const m = meta[0];
  invariant(m, "UNKNOWN_METADATA_STATE");
  invariant(
    (m.history === null || m.history === "drizzle.__drizzle_migrations") &&
      (m.marker === null ||
        m.marker === "__recovery_lineage" ||
        m.marker === "public.__recovery_lineage"),
    "METADATA_ALIAS",
  );
  const history: HistoryRow[] = [];
  if (m.history !== null)
    for (const row of await connection.query(HISTORY_SQL)) {
      invariant(
        typeof row.id === "number" &&
          Number.isSafeInteger(row.id) &&
          typeof row.hash === "string" &&
          /^[a-f0-9]{64}$/.test(row.hash) &&
          typeof row.created_at === "string" &&
          /^(0|[1-9][0-9]*)$/.test(row.created_at),
        "INVALID_HISTORY_ROW",
      );
      history.push({ id: row.id, hash: row.hash, created_at: row.created_at });
    }
  let marker: LineageMarker | null = null;
  if (m.marker !== null) {
    const rows = await connection.query(MARKER_SQL);
    invariant(rows.length === 1, "INVALID_MARKER_COUNT");
    const row = rows[0];
    invariant(
      row &&
        typeof row.lineage_id === "string" &&
        typeof row.bundle_sha256 === "string" &&
        typeof row.contract_version === "string",
      "INVALID_MARKER",
    );
    marker = {
      lineage_id: row.lineage_id,
      bundle_sha256: row.bundle_sha256,
      contract_version: row.contract_version,
    };
  }
  const catalog: CatalogFact[] = [];
  for (const row of await connection.query(CATALOG_SQL)) {
    invariant(
      typeof row.kind === "string" &&
        typeof row.identity === "string" &&
        row.definition !== undefined,
      "INVALID_CATALOG_ROW",
    );
    catalog.push({
      kind: row.kind,
      identity: row.identity,
      definition: row.definition,
    });
  }
  invariant(
    catalog.some((f) => f.kind === "namespace" && f.identity === "public"),
    "INCOMPLETE_CATALOG",
  );
  const protocols = catalog.filter((fact) => fact.kind === "catalog-protocol");
  invariant(
    protocols.length === 1 &&
      protocols[0]?.identity === "global" &&
      object(protocols[0].definition).protocolVersion ===
        CATALOG_PROTOCOL_VERSION,
    "CATALOG_PROTOCOL_MISMATCH",
  );
  catalogDigest(catalog);
  return {
    protocolVersion: CATALOG_PROTOCOL_VERSION,
    history,
    catalog,
    marker,
    historyTable: m.history !== null,
  };
}
export interface PrefixContract {
  protocolVersion: string;
  catalogSHA256: string;
  marker: LineageMarker | null;
  historyTable: boolean;
}
// PURE evidence comparison. This API never grants permission to run migration.
// Caller-supplied test policies can exercise logic but CANNOT authorize production.
export function assessEvidence(
  manifest: Manifest,
  evidence: PgEvidence,
  contract: PrefixContract,
): { prefix: number; authorization: "NONE"; ready_for_migration: false } {
  invariant(
    evidence.protocolVersion === CATALOG_PROTOCOL_VERSION &&
      contract.protocolVersion === CATALOG_PROTOCOL_VERSION,
    "CATALOG_PROTOCOL_MISMATCH",
  );
  invariant(
    manifest.lineageId === LINEAGE_ID &&
      manifest.targetContract === TARGET_CONTRACT,
    "WRONG_LINEAGE",
  );
  invariant(
    evidence.historyTable === contract.historyTable,
    "HISTORY_TABLE_DRIFT",
  );
  invariant(
    evidence.history.length === 0 || evidence.historyTable,
    "HISTORY_WITHOUT_TABLE",
  );
  const prefix = exactPrefix(manifest.entries, evidence.history);
  invariant(
    catalogDigest(evidence.catalog) === contract.catalogSHA256,
    "CATALOG_DRIFT_OR_MANUAL_OBJECT",
  );
  invariant(
    canonical(evidence.marker) === canonical(contract.marker),
    "LINEAGE_MARKER_MISMATCH",
  );
  if (evidence.marker)
    invariant(
      evidence.marker.lineage_id === LINEAGE_ID &&
        evidence.marker.contract_version === TARGET_CONTRACT,
      "WRONG_LINEAGE_MARKER",
    );
  invariant(
    prefix <= 81 || evidence.marker !== null,
    "NEW_PREFIX_REQUIRES_MARKER",
  );
  return { prefix, authorization: "NONE", ready_for_migration: false };
}
interface ReleaseBinding {
  fileSHA256: string;
  manifestSHA256: string;
  prefixContracts: Readonly<Record<number, PrefixContract>>;
}
const ROOT_RELEASE: ReleaseBinding | null = null;
const ROOT_RELEASE_PATH =
  "/opt/xiongbao/releases/recovery-20261018-v1/bundle.json";
function rootRelease(): ReleaseBinding | null {
  return ROOT_RELEASE;
}
// No repo-root, env override, caller hash/registry, dynamic release registration or CLI.
// Only a separately reviewed Root tool/image release may freeze this binding.
export async function preflight(adapter: PgAdapter): Promise<never> {
  const binding = rootRelease();
  invariant(binding, "ROOT_RELEASE_NOT_FROZEN");
  invariant(
    (await realpath(ROOT_RELEASE_PATH)) === ROOT_RELEASE_PATH &&
      (await lstat(ROOT_RELEASE_PATH)).isFile(),
    "UNTRUSTED_RELEASE_PATH",
  );
  const bytes = await readFile(ROOT_RELEASE_PATH);
  invariant(sha256(bytes) === binding.fileSHA256, "ROOT_RELEASE_FILE_DRIFT");
  const bundle = verifyBundle(bytes);
  invariant(
    bundle.manifest.bundleSHA256 === binding.manifestSHA256,
    "ROOT_RELEASE_MANIFEST_DRIFT",
  );
  await adapter.transaction(async (connection) => {
    await connection.query(WRITER_LOCK_SQL);
    const evidence = await readPgEvidence(connection);
    const prefix = exactPrefix(bundle.manifest.entries, evidence.history);
    const contract = binding.prefixContracts[prefix];
    invariant(contract, "ROOT_PREFIX_CONTRACT_MISSING");
    assessEvidence(bundle.manifest, evidence, contract);
    // Never hand an executable token to a caller while L1/L2/PG validation is absent.
    invariant(false, "TARGET_PREREQUISITES_INCOMPLETE");
  });
  throw new Error("MIGRATION_EXECUTION_NOT_IMPLEMENTED");
}

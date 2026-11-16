import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleBaseline,
  buildBaselineBundle,
  verifyBundle,
} from "../scripts/recovery-lineage/bundle";
import {
  type Bundle,
  exactPrefix,
  type HistoryRow,
  LINEAGE_ID,
  sha256,
  TARGET_CONTRACT,
} from "../scripts/recovery-lineage/manifest";
import {
  assessEvidence,
  CATALOG_PROTOCOL_VERSION,
  CATALOG_SQL,
  type CatalogFact,
  catalogDigest,
  HISTORY_SQL,
  MARKER_SQL,
  METADATA_SQL,
  type PgConnection,
  type PgEvidence,
  type PrefixContract,
  preflight,
  readPgEvidence,
} from "../scripts/recovery-lineage/preflight";

const source = join(import.meta.dir, "../server/drizzle");
let temp: string;
let bundle: Bundle;
let files: Map<string, Uint8Array>;
const history = (count: number): HistoryRow[] =>
  bundle.manifest.entries.slice(0, count).map((e, i) => ({
    id: i + 1,
    hash: e.sql.sha256,
    created_at: String(e.when),
  }));
const catalog: CatalogFact[] = [
  {
    kind: "namespace",
    identity: "public",
    definition: { owner: "fixture_owner", acl: null },
  },
  {
    kind: "catalog-protocol",
    identity: "global",
    definition: { protocolVersion: "recovery-catalog-v2" },
  },
];
const evidence = (count = 0): PgEvidence => ({
  history: history(count),
  catalog: structuredClone(catalog),
  protocolVersion: "recovery-catalog-v2",
  marker: null,
  historyTable: count > 0,
});
const contract = (e: PgEvidence): PrefixContract => ({
  protocolVersion: "recovery-catalog-v2",
  catalogSHA256: catalogDigest(e.catalog),
  marker: e.marker,
  historyTable: e.historyTable,
});
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "recovery-lineage-"));
  bundle = await buildBaselineBundle(source, join(temp, "bundle.json"));
  files = new Map(
    bundle.files.map((f) => [f.path, Buffer.from(f.base64, "base64")]),
  );
});
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
describe("actual frozen bytes, not historical runtime scanning", () => {
  test("81 original migrations and 163 exact files; no activation claim", () => {
    expect(bundle.manifest.entries.length).toBe(81);
    expect(files.size).toBe(163);
    expect(bundle.manifest.ready_for_migration).toBe(false);
    expect(bundle.manifest.targetPrerequisites.length).toBeGreaterThan(0);
    expect(bundle.files.some((f) => /0121|archive|missing/i.test(f.path))).toBe(
      false,
    );
  });
  test("every bundled byte equals the actual original file", async () => {
    for (const [path, bytes] of files)
      expect(Buffer.from(bytes)).toEqual(await readFile(join(source, path)));
  });
  test("deterministic temporary bundle roundtrip and identity", async () => {
    const a = await readFile(join(temp, "bundle.json"));
    expect(verifyBundle(a)).toEqual(bundle);
    await buildBaselineBundle(source, join(temp, "second.json"));
    expect(await readFile(join(temp, "second.json"))).toEqual(a);
    expect(sha256(a)).toBe(sha256(await readFile(join(temp, "second.json"))));
  });
  test("output collision cannot overwrite", async () => {
    await expect(
      buildBaselineBundle(source, join(temp, "bundle.json")),
    ).rejects.toThrow();
  });
  test("frozen source output is refused", async () => {
    await expect(
      buildBaselineBundle(source, join(source, "forbidden.json")),
    ).rejects.toThrow("OUTPUT_INSIDE_FROZEN_SOURCE");
  });
  test("root symlink is refused", async () => {
    await symlink(source, join(temp, "alias"));
    await expect(
      buildBaselineBundle(join(temp, "alias"), join(temp, "alias-out")),
    ).rejects.toThrow("SOURCE_ROOT_ALIAS");
  });
  test("output parent alias cannot write into frozen source", async () => {
    await symlink(source, join(temp, "output-alias"));
    await expect(
      buildBaselineBundle(source, join(temp, "output-alias", "forbidden.json")),
    ).rejects.toThrow("OUTPUT_PARENT_ALIAS_OR_MISSING");
  });
  test("SQL byte tamper rejected even with recomputed caller digest", () => {
    const altered = new Map(files);
    altered.set("0000_schema.sql", Buffer.from("-- changed\n"));
    expect(() => assembleBaseline(altered)).toThrow("FROZEN_BYTES_DRIFT");
    const b = structuredClone(bundle);
    b.manifest.bundleSHA256 = "a".repeat(64);
    expect(() => verifyBundle(Buffer.from(JSON.stringify(b)))).toThrow(
      "MANIFEST_DRIFT",
    );
  });
  test("wrong snapshot prevId and repeated snapshot id rejected", () => {
    for (const key of ["prevId", "id"]) {
      const altered = new Map(files);
      const p = "meta/0001_snapshot.json";
      const first = JSON.parse(
        Buffer.from(files.get("meta/0000_snapshot.json")!).toString(),
      );
      const s = JSON.parse(Buffer.from(files.get(p)!).toString());
      s[key] = key === "id" ? first.id : "00000000-0000-0000-0000-000000000000";
      altered.set(p, Buffer.from(JSON.stringify(s)));
      expect(() => assembleBaseline(altered)).toThrow("BROKEN_SNAPSHOT_CHAIN");
    }
  });
  test("missing SQL, historical extra, duplicate/path escape payloads refused", () => {
    const absent = new Map(files);
    absent.delete("0000_schema.sql");
    expect(() => assembleBaseline(absent)).toThrow("MISSING_SOURCE_BYTES");
    for (const path of ["0121_historical.sql", "../secret", "/absolute"]) {
      const extra = new Map(files);
      extra.set(path, Buffer.from("x"));
      expect(() => assembleBaseline(extra)).toThrow(
        "EXTRA_OR_HISTORICAL_INPUT",
      );
    }
    const dup = structuredClone(bundle);
    dup.files.push(dup.files[0]!);
    expect(() => verifyBundle(Buffer.from(JSON.stringify(dup)))).toThrow(
      "DUPLICATE_OR_INVALID_FILE",
    );
  });
  test("journal idx/tag/time and forged lineage reject", () => {
    for (const change of [{ idx: 81 }, { tag: "0121_old" }, { when: 0 }]) {
      const altered = new Map(files);
      const j = JSON.parse(
        Buffer.from(files.get("meta/_journal.json")!).toString(),
      );
      Object.assign(j.entries[1], change);
      altered.set("meta/_journal.json", Buffer.from(JSON.stringify(j)));
      expect(() => assembleBaseline(altered)).toThrow();
    }
    const b = JSON.parse(JSON.stringify(bundle));
    b.manifest.lineageId = "foreign";
    expect(() => verifyBundle(Buffer.from(JSON.stringify(b)))).toThrow(
      "MANIFEST_DRIFT",
    );
  });
});
describe("exact history, marker and real-catalog evidence contract", () => {
  test("empty/partial/full original prefixes compare, but never authorize", () => {
    for (const n of [0, 1, 40, 81]) {
      const e = evidence(n);
      expect(exactPrefix(bundle.manifest.entries, e.history)).toBe(n);
      expect(assessEvidence(bundle.manifest, e, contract(e))).toEqual({
        prefix: n,
        authorization: "NONE",
        ready_for_migration: false,
      });
    }
  });
  test("hash/time drift and missing earlier records cannot pass maxwhen", () => {
    for (const field of ["hash", "created_at"] as const) {
      const rows = history(2);
      rows[1]![field] = "0";
      expect(() => exactPrefix(bundle.manifest.entries, rows)).toThrow(
        "HISTORY_NOT_EXACT_PREFIX",
      );
    }
    expect(() =>
      exactPrefix(bundle.manifest.entries, history(81).slice(80)),
    ).toThrow();
  });
  test("unknown historical 81..121 and duplicates/reorder fail", () => {
    const extra = history(81);
    extra.push({ id: 82, hash: "a".repeat(64), created_at: "1792000000000" });
    expect(() => exactPrefix(bundle.manifest.entries, extra)).toThrow(
      "UNKNOWN_OR_OLD_LINEAGE_HISTORY",
    );
    const duplicate = history(2);
    duplicate[1] = duplicate[0]!;
    expect(() => exactPrefix(bundle.manifest.entries, duplicate)).toThrow(
      "DUPLICATE_OR_REORDERED_HISTORY",
    );
    expect(() =>
      exactPrefix(bundle.manifest.entries, history(2).reverse()),
    ).toThrow();
  });
  test("synthetic future recovery prefix exercises comparison only; requires marker", () => {
    // Test-only identity, NOT a generated migration, artifact or authorization.
    const m = structuredClone(bundle.manifest);
    const last = m.entries[80]!;
    m.entries.push({
      ...last,
      idx: 81,
      tag: "0081_recovery_fixture_only",
      when: last.when + 1,
      sql: { ...last.sql, sha256: "b".repeat(64) },
    });
    const e = evidence(81);
    e.history.push({
      id: 82,
      hash: "b".repeat(64),
      created_at: String(last.when + 1),
    });
    expect(() => assessEvidence(m, e, contract(e))).toThrow(
      "NEW_PREFIX_REQUIRES_MARKER",
    );
    e.marker = {
      lineage_id: LINEAGE_ID,
      bundle_sha256: "c".repeat(64),
      contract_version: TARGET_CONTRACT,
    };
    expect(assessEvidence(m, e, contract(e)).authorization).toBe("NONE");
  });
  test("manual catalog object/missing object/definition drift reject", () => {
    const base = evidence(1);
    const policy = contract(base);
    for (const altered of [
      [],
      [
        ...catalog,
        { kind: "relation", identity: "public.manual", definition: {} },
      ],
      [{ ...catalog[0]!, definition: { owner: "other" } }],
    ]) {
      const e = { ...base, catalog: altered };
      expect(() => assessEvidence(bundle.manifest, e, policy)).toThrow(
        "CATALOG_DRIFT_OR_MANUAL_OBJECT",
      );
    }
  });
  test("unsafe numeric catalog facts cannot silently lose bigint precision", () => {
    expect(() =>
      catalogDigest([
        {
          kind: "sequence",
          identity: "public.s",
          definition: { max: Number.MAX_SAFE_INTEGER + 1 },
        },
      ]),
    ).toThrow("BAD_CATALOG_NUMBER");
  });
  test("wrong marker and history table identity fail", () => {
    const e = evidence(1);
    const p = contract(e);
    e.marker = {
      lineage_id: "old-lineage",
      bundle_sha256: "d".repeat(64),
      contract_version: TARGET_CONTRACT,
    };
    expect(() => assessEvidence(bundle.manifest, e, p)).toThrow(
      "LINEAGE_MARKER_MISMATCH",
    );
    expect(() => assessEvidence(bundle.manifest, e, contract(e))).toThrow(
      "WRONG_LINEAGE_MARKER",
    );
    e.marker = null;
    e.historyTable = false;
    expect(() => assessEvidence(bundle.manifest, e, p)).toThrow(
      "HISTORY_TABLE_DRIFT",
    );
  });
  test("catalog digest canonical order and duplicates", () => {
    expect(
      catalogDigest([{ kind: "x", identity: "a", definition: { a: 1, b: 2 } }]),
    ).toBe(
      catalogDigest([{ kind: "x", identity: "a", definition: { b: 2, a: 1 } }]),
    );
    expect(() => catalogDigest([...catalog, ...catalog])).toThrow(
      "INVALID_OR_DUPLICATE_CATALOG_FACT",
    );
  });
});
class FakePg implements PgConnection {
  seen: string[] = [];
  responses = new Map<string, readonly Record<string, unknown>[]>([
    [METADATA_SQL, [{ history: "drizzle.__drizzle_migrations", marker: null }]],
    [HISTORY_SQL, []],
    [CATALOG_SQL, catalog.map((f) => ({ ...f }))],
  ]);
  async query(sql: string) {
    this.seen.push(sql);
    const r = this.responses.get(sql);
    if (!r) throw new Error("UNEXPECTED_SQL");
    return r;
  }
}
describe("PG read adapter, fake boundary only", () => {
  test("reads actual catalog SQL and exact history columns, no DDL", async () => {
    const pg = new FakePg();
    pg.responses.set(
      HISTORY_SQL,
      history(1).map((r) => ({ ...r })),
    );
    const e = await readPgEvidence(pg);
    expect(e.history).toEqual(history(1));
    expect(pg.seen).toEqual([METADATA_SQL, HISTORY_SQL, CATALOG_SQL]);
  });
  test("fresh metadata absent still requires full catalog", async () => {
    const pg = new FakePg();
    pg.responses.set(METADATA_SQL, [{ history: null, marker: null }]);
    const e = await readPgEvidence(pg);
    expect(e.historyTable).toBe(false);
    expect(pg.seen).not.toContain(HISTORY_SQL);
  });
  test("unknown metadata, malformed rows, missing catalog, marker duplication fail closed", async () => {
    const cases: [string, readonly Record<string, unknown>[]][] = [
      [METADATA_SQL, []],
      [METADATA_SQL, [{ history: "alias", marker: null }]],
      [HISTORY_SQL, [{ id: 1, hash: "bad", created_at: "x" }]],
      [CATALOG_SQL, []],
    ];
    for (const [sql, rows] of cases) {
      const pg = new FakePg();
      pg.responses.set(sql, rows);
      await expect(readPgEvidence(pg)).rejects.toThrow();
    }
    const pg = new FakePg();
    pg.responses.set(METADATA_SQL, [
      { history: null, marker: "public.__recovery_lineage" },
    ]);
    pg.responses.set(MARKER_SQL, []);
    await expect(readPgEvidence(pg)).rejects.toThrow("INVALID_MARKER_COUNT");
  });
  test("candidate cannot self-authorize or open a PG transaction", async () => {
    let calls = 0;
    await expect(
      preflight({
        async transaction() {
          calls++;
          throw new Error("MUST_NOT_CONNECT");
        },
      }),
    ).rejects.toThrow("ROOT_RELEASE_NOT_FROZEN");
    expect(calls).toBe(0);
  });
});

describe("L0-r2 fixed catalog projection / fake conversion boundary, not PG execution", () => {
  const internal: CatalogFact = {
    kind: "internal-trigger",
    identity: JSON.stringify([
      "public",
      "child",
      "public",
      "public",
      "child",
      "child_parent_fk",
      "pg_catalog",
      "RI_FKey_check_ins",
      "",
      5,
      "public",
      "parent",
    ]),
    definition: {
      enabled: "O",
      constraint: {
        schema: "public",
        table_schema: "public",
        table: "child",
        name: "child_parent_fk",
        type: "f",
      },
      event_mask: 5,
      function: {
        schema: "pg_catalog",
        name: "RI_FKey_check_ins",
        signature: "",
      },
      referenced_relation: { schema: "public", table: "parent" },
      supporting_index: { schema: "public", name: "parent_pkey" },
      parent_relation: { schema: null, table: null },
      deferrable: false,
      initially_deferred: false,
      columns: "",
      args_hex: "",
      when: null,
    },
  };
  const rule: CatalogFact = {
    kind: "rewrite-rule",
    identity: JSON.stringify(["public", "child", "no_delete"]),
    definition: {
      definition:
        "CREATE RULE no_delete AS ON DELETE TO public.child DO INSTEAD NOTHING;",
      enabled: "O",
      event: "4",
      instead: true,
    },
  };
  const withFacts = (...facts: CatalogFact[]): PgEvidence => ({
    ...evidence(1),
    catalog: [...structuredClone(catalog), ...structuredClone(facts)],
  });

  test("SQL retains user triggers and projects internal constraints with stable non-OID identity", () => {
    expect(CATALOG_SQL).toInclude("where not t.tgisinternal");
    const branch = CATALOG_SQL.split("select 'internal-trigger',")[1]?.split(
      "\n union all",
    )[0];
    expect(branch).toBeDefined();
    if (!branch) throw new Error("internal trigger projection absent");
    for (const token of [
      "where t.tgisinternal",
      "t.tgenabled",
      "t.tgconstraint",
      "t.tgtype",
      "t.tgconstrrelid",
      "t.tgconstrindid",
      "t.tgparentid",
      "pg_catalog.pg_constraint",
      "pg_get_function_identity_arguments(f.oid)",
      "t.tgdeferrable",
      "t.tginitdeferred",
    ])
      expect(branch).toInclude(token);
    const identity = branch.split(", jsonb_build_object")[0]!;
    expect(identity).toInclude("n.nspname,c.relname");
    expect(identity).toInclude("k.conname");
    expect(identity).toInclude("fn.nspname,f.proname");
    expect(identity).not.toInclude("tgname");
    expect(identity).not.toInclude("t.oid");
    expect(branch).not.toInclude("pg_get_triggerdef");
  });

  test("SQL rule projection joins actual relation and retains definition plus firing mode", () => {
    const branch = CATALOG_SQL.split("select 'rewrite-rule',")[1]?.split(
      "\n union all",
    )[0];
    expect(branch).toBeDefined();
    if (!branch) throw new Error("rule projection absent");
    for (const token of [
      "pg_catalog.pg_rewrite r",
      "c.oid=r.ev_class",
      "c.relnamespace=n.oid",
      "n.nspname,c.relname,r.rulename",
      "pg_get_ruledef(r.oid,true)",
      "r.ev_enabled",
      "r.ev_type",
      "r.is_instead",
    ])
      expect(branch).toInclude(token);
    expect(CATALOG_SQL).toInclude("'has_rules',c.relhasrules");
  });

  test("fake internal FK disabled/replica/always states cannot match frozen origin state", () => {
    const original = withFacts(internal);
    const expected = contract(original);
    expect(
      assessEvidence(bundle.manifest, original, expected).authorization,
    ).toBe("NONE");
    for (const enabled of ["D", "R", "A"]) {
      const changed = {
        ...internal,
        definition: { ...objectDefinition(internal), enabled },
      };
      expect(() =>
        assessEvidence(bundle.manifest, withFacts(changed), expected),
      ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    }
  });

  test("fake constraint/event/associated relation/function changes remain visible in digest", () => {
    const original = withFacts(internal);
    for (const change of [
      { constraint: { name: "other_fk" } },
      { event_mask: 17 },
      { referenced_relation: { schema: "public", table: "other_parent" } },
      {
        function: {
          schema: "pg_catalog",
          name: "RI_FKey_check_upd",
          signature: "",
        },
      },
    ]) {
      const changed = {
        ...internal,
        definition: { ...objectDefinition(internal), ...change },
      };
      expect(() =>
        assessEvidence(bundle.manifest, withFacts(changed), contract(original)),
      ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    }
  });

  test("fake rule addition/definition/enabled changes reject before any authorization", () => {
    expect(() =>
      assessEvidence(bundle.manifest, withFacts(rule), contract(withFacts())),
    ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    const original = withFacts(rule);
    expect(
      assessEvidence(bundle.manifest, original, contract(original))
        .ready_for_migration,
    ).toBe(false);
    for (const change of [
      {
        definition:
          "CREATE RULE no_delete AS ON DELETE TO public.child DO ALSO NOTHING;",
      },
      { enabled: "D" },
      { enabled: "R" },
      { enabled: "A" },
    ]) {
      const changed = {
        ...rule,
        definition: { ...objectDefinition(rule), ...change },
      };
      expect(() =>
        assessEvidence(bundle.manifest, withFacts(changed), contract(original)),
      ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    }
  });

  test("fake PG adapter preserves internal and rewrite facts through conversion", async () => {
    const pg = new FakePg();
    const facts = withFacts(internal, rule).catalog;
    pg.responses.set(
      CATALOG_SQL,
      facts.map((f) => ({ ...f })),
    );
    pg.responses.set(
      HISTORY_SQL,
      history(1).map((f) => ({ ...f })),
    );
    const actual = await readPgEvidence(pg);
    expect(actual.catalog).toEqual(facts);
    expect(catalogDigest(actual.catalog)).toBe(catalogDigest(facts));
    expect(
      assessEvidence(
        bundle.manifest,
        actual,
        contract(withFacts(internal, rule)),
      ).authorization,
    ).toBe("NONE");
    expect(pg.seen).toEqual([METADATA_SQL, HISTORY_SQL, CATALOG_SQL]);
  });

  test("fake missing internal/rule and changed relhasrules cannot match Root expected facts", () => {
    const expected = contract(withFacts(internal, rule));
    expect(() =>
      assessEvidence(bundle.manifest, withFacts(rule), expected),
    ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    expect(() =>
      assessEvidence(bundle.manifest, withFacts(internal), expected),
    ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    const relation: CatalogFact = {
      kind: "relation",
      identity: "public.child",
      definition: { has_rules: false },
    };
    const changed = { ...relation, definition: { has_rules: true } };
    expect(() =>
      assessEvidence(
        bundle.manifest,
        withFacts(changed),
        contract(withFacts(relation)),
      ),
    ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
  });
});

function objectDefinition(fact: CatalogFact): Record<string, unknown> {
  const value = fact.definition;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("bad fixture definition");
  return value as Record<string, unknown>;
}

describe("L2-01 PG17 membership / global catalog v2, CPU facts only", () => {
  const membership: CatalogFact = {
    kind: "membership",
    identity: '["fixture_granted","fixture_member","fixture_grantor"]',
    definition: {
      granted_role: "fixture_granted",
      member: "fixture_member",
      grantor: "fixture_grantor",
      admin: false,
      inherit_option: true,
      set_option: false,
    },
  };
  const withMembership = (fact = membership): PgEvidence => ({
    ...evidence(),
    catalog: [...structuredClone(catalog), structuredClone(fact)],
  });
  test("real collector projects each PG17 membership identity and option without defaults", () => {
    const branch = CATALOG_SQL.split("select 'membership',")[1]?.split(
      "\n union all",
    )[0];
    expect(branch).toBeDefined();
    if (!branch) throw new Error("membership projection absent");
    for (const token of [
      "m.roleid",
      "m.member",
      "m.grantor",
      "m.admin_option",
      "m.inherit_option",
      "m.set_option",
      "pg_catalog.pg_auth_members m",
    ])
      expect(branch).toInclude(token);
    expect(branch).not.toInclude("coalesce");
    expect(CATALOG_SQL).toInclude("'catalog-protocol'");
    expect(CATALOG_PROTOCOL_VERSION).toBe("recovery-catalog-v2");
  });
  test("same edge with inherit or set drift changes digest and refuses frozen contract", () => {
    const before = withMembership();
    const expected = contract(before);
    expect(
      assessEvidence(bundle.manifest, before, expected).authorization,
    ).toBe("NONE");
    for (const change of [
      { inherit_option: false },
      { set_option: true },
      { admin: true },
    ]) {
      const changed = withMembership({
        ...membership,
        definition: { ...objectDefinition(membership), ...change },
      });
      expect(changed.catalog.at(-1)?.identity).toBe(membership.identity);
      expect(catalogDigest(changed.catalog)).not.toBe(expected.catalogSHA256);
      expect(() => assessEvidence(bundle.manifest, changed, expected)).toThrow(
        "CATALOG_DRIFT_OR_MANUAL_OBJECT",
      );
    }
  });
  test("member, granted role and grantor are bound; distinct grantors do not collide", () => {
    const before = withMembership();
    for (const key of ["member", "granted_role", "grantor"]) {
      const definition = {
        ...objectDefinition(membership),
        [key]: "different_role",
      };
      const changed = {
        ...membership,
        definition,
        identity: JSON.stringify([
          definition.granted_role,
          definition.member,
          definition.grantor,
        ]),
      };
      expect(() =>
        assessEvidence(
          bundle.manifest,
          withMembership(changed),
          contract(before),
        ),
      ).toThrow("CATALOG_DRIFT_OR_MANUAL_OBJECT");
    }
    const other = {
      ...membership,
      identity: '["fixture_granted","fixture_member","other_grantor"]',
      definition: { ...objectDefinition(membership), grantor: "other_grantor" },
    };
    expect(catalogDigest([...before.catalog, other])).not.toBe(
      catalogDigest(before.catalog),
    );
    expect(() =>
      catalogDigest([
        {
          ...membership,
          identity: '["wrong","fixture_member","fixture_grantor"]',
        },
      ]),
    ).toThrow("MEMBERSHIP_IDENTITY_MISMATCH");
  });
  test("missing, null, textual and numeric options reject in digest and real adapter boundary", async () => {
    for (const field of ["admin", "inherit_option", "set_option"]) {
      for (const value of [undefined, null, "false", "f", 0, 1]) {
        const definition = { ...objectDefinition(membership), [field]: value };
        if (value === undefined) Reflect.deleteProperty(definition, field);
        const bad = { ...membership, definition };
        expect(() => catalogDigest(withMembership(bad).catalog)).toThrow(
          "INVALID_MEMBERSHIP_OPTION",
        );
        const pg = new FakePg();
        pg.responses.set(
          CATALOG_SQL,
          withMembership(bad).catalog.map((f) => ({ ...f })),
        );
        await expect(readPgEvidence(pg)).rejects.toThrow(
          "INVALID_MEMBERSHIP_OPTION",
        );
      }
    }
  });
  test("unknown extra facts survive conversion; identity is explicit and nonempty", async () => {
    for (const field of ["member", "granted_role", "grantor"]) {
      const definition = { ...objectDefinition(membership), [field]: null };
      expect(() =>
        catalogDigest(withMembership({ ...membership, definition }).catalog),
      ).toThrow("INVALID_MEMBERSHIP_IDENTITY");
    }
    const future = {
      kind: "future-fact",
      identity: "fixture",
      definition: { future: true },
    };
    const facts = [...withMembership().catalog, future];
    const pg = new FakePg();
    pg.responses.set(
      CATALOG_SQL,
      facts.map((f) => ({ ...f })),
    );
    const read = await readPgEvidence(pg);
    expect(read.catalog).toEqual(facts);
    expect(read.protocolVersion).toBe("recovery-catalog-v2");
    expect(catalogDigest(read.catalog)).toBe(
      catalogDigest([...facts].reverse()),
    );
    expect(catalogDigest(read.catalog)).not.toBe(
      catalogDigest(withMembership().catalog),
    );
  });
  test("missing and old expected/evidence protocol refuse even without memberships", () => {
    for (const side of ["expected", "evidence"]) {
      for (const version of [
        undefined,
        "recovery-catalog-v1",
        "",
        "recovery-catalog-v3",
      ]) {
        const e = evidence();
        const expected = contract(e);
        const target = side === "expected" ? expected : e;
        if (version === undefined)
          Reflect.deleteProperty(target, "protocolVersion");
        else target.protocolVersion = version;
        expect(() => assessEvidence(bundle.manifest, e, expected)).toThrow(
          "CATALOG_PROTOCOL_MISMATCH",
        );
      }
    }
    expect(
      assessEvidence(bundle.manifest, evidence(), contract(evidence())),
    ).toEqual({ prefix: 0, authorization: "NONE", ready_for_migration: false });
  });
  test("adapter refuses old, absent or duplicate collector sentinel in empty-membership catalogs", async () => {
    const namespace = catalog.filter((f) => f.kind !== "catalog-protocol");
    for (const facts of [
      namespace,
      [
        ...namespace,
        {
          kind: "catalog-protocol",
          identity: "global",
          definition: { protocolVersion: "recovery-catalog-v1" },
        },
      ],
      [...catalog, catalog[1]!],
    ]) {
      const pg = new FakePg();
      pg.responses.set(
        CATALOG_SQL,
        facts.map((f) => ({ ...f })),
      );
      await expect(readPgEvidence(pg)).rejects.toThrow(
        "CATALOG_PROTOCOL_MISMATCH",
      );
    }
  });
});

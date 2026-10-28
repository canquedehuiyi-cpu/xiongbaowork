import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { auditEvents } from "../src/db/schema/core";
import { pluginGrants } from "../src/db/schema/plugins";

type Column = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: unknown;
};
type Table = { columns: Record<string, Column>; [key: string]: unknown };
type Snapshot = {
  id: string;
  prevId: string;
  version: string;
  dialect: string;
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
type Addition = { schema: string; table: string; column: string; type: string };
const server = join(import.meta.dir, "..");
const overlay = join(server, "recovery/recovery-20261018-v1");
const original = join(server, "drizzle");
const sql = readFileSync(
  join(overlay, "sql/0081_recovery_subject_and_binding.sql"),
  "utf8",
);
const before = JSON.parse(
  readFileSync(join(original, "meta/0080_snapshot.json"), "utf8"),
) as Snapshot;
const after = JSON.parse(
  readFileSync(join(overlay, "meta/0081_snapshot.json"), "utf8"),
) as Snapshot;
const journalBefore = JSON.parse(
  readFileSync(join(original, "meta/_journal.json"), "utf8"),
) as Journal;
const journalAfter = JSON.parse(
  readFileSync(join(overlay, "meta/_journal.json"), "utf8"),
) as Journal;
const expected: Addition[] = [
  {
    schema: "public",
    table: "audit_events",
    column: "subject_tenant_id",
    type: "text",
  },
  {
    schema: "public",
    table: "plugin_grants",
    column: "assembly_binding",
    type: "jsonb",
  },
];

/** Deliberately restricted DDL grammar. Every character is tokenized; nothing else can execute. */
function parseAdditions(source: string): Addition[] {
  const tokens =
    source
      .replaceAll("--> statement-breakpoint", " ")
      .match(/"[^"\r\n]*"|[A-Za-z_][A-Za-z_0-9]*|[.;]|\S/g) ?? [];
  let at = 0;
  const take = (value: string): void => {
    assert.equal(tokens[at++], value);
  };
  const identifier = (): string => {
    const value = tokens[at++];
    assert.ok(
      value && /^"[a-z][a-z0-9_]*"$/.test(value),
      "quoted identifier required",
    );
    return value.slice(1, -1);
  };
  const additions: Addition[] = [];
  while (at < tokens.length) {
    take("ALTER");
    take("TABLE");
    const schema = identifier();
    take(".");
    const table = identifier();
    take("ADD");
    take("COLUMN");
    const column = identifier();
    const type = tokens[at++];
    assert.ok(type === "text" || type === "jsonb");
    take(";");
    assert.ok(
      !additions.some(
        (item) =>
          item.schema === schema &&
          item.table === table &&
          item.column === column,
      ),
      "duplicate addition",
    );
    additions.push({ schema, table, column, type });
  }
  assert.ok(additions.length > 0, "empty migration");
  return additions;
}

/** Reverse the parsed DDL and require byte-independent structural equality with the real predecessor. */
function checkTransition(source: string, next: Snapshot): void {
  const additions = parseAdditions(source);
  assert.deepEqual(additions, expected);
  assert.equal(next.prevId, before.id);
  assert.match(
    next.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(next.id, before.id);
  const restored = structuredClone(next);
  for (const item of additions) {
    const key = `${item.schema}.${item.table}`;
    assert.ok(
      !before.tables[key]?.columns[item.column],
      "must be a new column",
    );
    const table = restored.tables[key];
    assert.ok(table);
    assert.deepEqual(table.columns[item.column], {
      name: item.column,
      type: item.type,
      primaryKey: false,
      notNull: false,
    });
    delete table.columns[item.column];
  }
  restored.id = before.id;
  restored.prevId = before.prevId;
  assert.deepEqual(
    restored,
    before,
    "only parsed two-column delta allowed, including all FK/index/PK metadata",
  );
}

function checkJournal(next: Journal): void {
  assert.equal(next.version, journalBefore.version);
  assert.equal(next.dialect, journalBefore.dialect);
  // This stage validates its complete prefix, not suffix execution authority.
  assert.ok(next.entries.length >= 82, "complete 0..81 prefix is required");
  assert.deepEqual(next.entries.slice(0, 81), journalBefore.entries);
  const last = next.entries[81];
  assert.ok(last);
  assert.equal(last.when, 1792332786923);
  assert.deepEqual(
    { ...last, when: 0 },
    {
      idx: 81,
      version: "7",
      when: 0,
      tag: "0081_recovery_subject_and_binding",
      breakpoints: true,
    },
  );
  assert.ok(
    Number.isSafeInteger(last.when) &&
      last.when > (next.entries[80]?.when ?? Infinity),
  );
  assert.ok(
    last.when <= Date.now(),
    "generation timestamp cannot be in the future",
  );
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), "baseline input cannot redirect");
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("recovery-20261018-v1 subject and binding overlay", () => {
  test("all 163 original migration inputs retain frozen content identity", () => {
    const records = filesUnder(original)
      .sort()
      .map((path) => {
        const bytes = readFileSync(path);
        return `${relative(original, path)}\0${bytes.byteLength}\0${createHash("sha256").update(bytes).digest("hex")}\n`;
      });
    expect(records).toHaveLength(163);
    expect(createHash("sha256").update(records.join("")).digest("hex")).toBe(
      "9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d",
    );
    expect(before.id).toBe("9830a73c-12c1-4c08-89a9-894184de1449");
  });
  test("actual SQL and adjacent snapshot agree in both directions; all old structure survives", () => {
    checkTransition(sql, after);
    expect(Object.keys(after.tables)).toHaveLength(99);
  });
  test("dedicated overlay journal preserves the exact 0..81 stage prefix with later entries allowed", () =>
    checkJournal(journalAfter));
  test("approved successors preserve the 0..81 prefix without authorizing suffix execution", () => {
    const stage = structuredClone(journalAfter);
    stage.entries = stage.entries.slice(0, 82);
    expect(() => checkJournal(stage)).not.toThrow();
    const successors = journalAfter.entries.slice(82, 84);
    expect(successors.map((entry) => entry.tag)).toEqual([
      "0082_recovery_role_foundations",
      "0083_recovery_task_flow_audit_contract",
    ]);
    stage.entries.push(...successors);
    expect(() => checkJournal(stage)).not.toThrow();
  });
  test("missing prefix and altered idx81 identity are refused even with successors", () => {
    const missing = structuredClone(journalAfter);
    missing.entries = missing.entries.slice(0, 81);
    expect(() => checkJournal(missing)).toThrow();
    for (const mutation of [
      { tag: "forged" },
      { when: 1792332786924 },
      { version: "8" },
      { breakpoints: false },
    ]) {
      const changed = structuredClone(journalAfter);
      Object.assign(changed.entries[81] ?? {}, mutation);
      expect(() => checkJournal(changed)).toThrow();
    }
  });
  test("wrong predecessor, old prefix mutation, and reused idx are refused by the contract", () => {
    const wrongSnapshot = structuredClone(after);
    wrongSnapshot.prevId = "not-the-predecessor";
    expect(() => checkTransition(sql, wrongSnapshot)).toThrow();
    const wrongPrefix = structuredClone(journalAfter);
    const first = wrongPrefix.entries[0];
    assert.ok(first);
    first.tag = "forged";
    expect(() => checkJournal(wrongPrefix)).toThrow();
    const wrongIdx = structuredClone(journalAfter);
    const last = wrongIdx.entries[81];
    assert.ok(last);
    last.idx = 80;
    expect(() => checkJournal(wrongIdx)).toThrow();
  });
  test("parser refuses data rewrites, defaults, null constraints and extra executable statements", () => {
    for (const mutation of [
      sql +
        'UPDATE "public"."audit_events" SET "subject_tenant_id" = \'guessed\';',
      sql.replace(
        '"subject_tenant_id" text;',
        "\"subject_tenant_id\" text DEFAULT 'guessed';",
      ),
      sql.replace(
        '"assembly_binding" jsonb;',
        '"assembly_binding" jsonb NOT NULL;',
      ),
      sql + 'DROP TABLE "public"."audit_events";',
      sql + "/* hidden */ SELECT 1;",
      sql + sql,
    ])
      expect(() => parseAdditions(mutation)).toThrow();
  });
  test("missing SQL, extra snapshot fields and changed old constraints cannot pass the delta check", () => {
    expect(() =>
      checkTransition(sql.split("--> statement-breakpoint")[0] ?? "", after),
    ).toThrow();
    const extra = structuredClone(after);
    const table = extra.tables["public.audit_events"];
    assert.ok(table);
    table.columns.invented = {
      name: "invented",
      type: "text",
      primaryKey: false,
      notNull: false,
    };
    expect(() => checkTransition(sql, extra)).toThrow();
    const changed = structuredClone(after);
    const grants = changed.tables["public.plugin_grants"];
    assert.ok(grants);
    grants.foreignKeys = {};
    expect(() => checkTransition(sql, changed)).toThrow();
  });
  test("schema columns agree with SQL nullable/no-default metadata and custom JSONB does not stringify", () => {
    for (const [table, name, type] of [
      [auditEvents, "subject_tenant_id", "text"],
      [pluginGrants, "assembly_binding", "jsonb"],
    ] as const) {
      const column = getTableConfig(table).columns.find(
        (item) => item.name === name,
      );
      assert.ok(column);
      expect(column.getSQLType()).toBe(type);
      expect(column.notNull).toBe(false);
      expect(column.hasDefault).toBe(false);
      expect(column.default).toBeUndefined();
      expect(column.primary).toBe(false);
    }
    const binding = {
      owner: { tenant: "fixture-only" },
      unknownFutureField: [1, null, "x"],
    };
    expect(pluginGrants.assemblyBinding.mapToDriverValue(binding)).toBe(
      binding,
    );
    const subject: typeof auditEvents.$inferSelect.subjectTenantId = null;
    const unknownBinding: typeof pluginGrants.$inferSelect.assemblyBinding =
      null;
    expect(subject).toBeNull();
    expect(unknownBinding).toBeNull();
  });
});

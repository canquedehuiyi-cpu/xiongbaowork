import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BASELINE_TREE,
  type Bundle,
  type FileIdentity,
  FROZEN_INPUT_SHA256,
  identitiesDigest,
  invariant,
  LINEAGE_ID,
  type Manifest,
  type MigrationIdentity,
  manifestDigest,
  object,
  sha256,
  TARGET_CONTRACT,
  ZERO_ID,
} from "./manifest";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const identity = (path: string, b: Uint8Array): FileIdentity => ({
  path,
  bytes: b.length,
  sha256: sha256(b),
});
export function assembleBaseline(
  files: ReadonlyMap<string, Uint8Array>,
): Bundle {
  const journalPath = "meta/_journal.json";
  const journalBytes = files.get(journalPath);
  invariant(journalBytes, "MISSING_JOURNAL");
  const journal = object(JSON.parse(utf8.decode(journalBytes)));
  invariant(
    journal.version === "7" &&
      journal.dialect === "postgresql" &&
      Array.isArray(journal.entries) &&
      journal.entries.length === 81,
    "FROZEN_JOURNAL_SHAPE",
  );
  const expected = new Set([journalPath]);
  const ids = new Set<string>();
  let prevId = ZERO_ID;
  let prevWhen = -1;
  const entries: MigrationIdentity[] = journal.entries.map((value, idx) => {
    const e = object(value);
    invariant(
      e.idx === idx &&
        e.version === "7" &&
        typeof e.tag === "string" &&
        new RegExp(`^${String(idx).padStart(4, "0")}_[a-z0-9_]+$`).test(e.tag),
      "BAD_IDX_TAG",
    );
    invariant(
      typeof e.when === "number" &&
        Number.isSafeInteger(e.when) &&
        e.when > prevWhen,
      "BAD_ORIGINAL_WHEN",
    );
    prevWhen = e.when;
    const sqlPath = `${e.tag}.sql`;
    const snapshotPath = `meta/${String(idx).padStart(4, "0")}_snapshot.json`;
    expected.add(sqlPath);
    expected.add(snapshotPath);
    const sql = files.get(sqlPath);
    const snapshot = files.get(snapshotPath);
    invariant(sql && snapshot, "MISSING_SOURCE_BYTES");
    const s = object(JSON.parse(utf8.decode(snapshot)));
    invariant(
      typeof s.id === "string" &&
        /^[0-9a-f-]{36}$/.test(s.id) &&
        !ids.has(s.id) &&
        s.prevId === prevId &&
        s.version === "7" &&
        s.dialect === "postgresql",
      "BROKEN_SNAPSHOT_CHAIN",
    );
    const previous = prevId;
    ids.add(s.id);
    prevId = s.id;
    return {
      idx,
      tag: e.tag,
      when: e.when,
      sql: identity(sqlPath, sql),
      snapshot: {
        ...identity(snapshotPath, snapshot),
        id: s.id,
        prevId: previous,
      },
    };
  });
  invariant(
    files.size === expected.size &&
      [...files.keys()].every((p) => expected.has(p)),
    "EXTRA_OR_HISTORICAL_INPUT",
  );
  const rows = [...files].map(([p, b]) => identity(p, b));
  invariant(
    identitiesDigest(rows) === FROZEN_INPUT_SHA256,
    "FROZEN_BYTES_DRIFT",
  );
  const manifest: Manifest = {
    schema: "recovery-lineage-bundle-v1",
    lineageId: LINEAGE_ID,
    baselineTree: BASELINE_TREE,
    frozenInputSHA256: FROZEN_INPUT_SHA256,
    targetContract: TARGET_CONTRACT,
    journal: identity(journalPath, journalBytes),
    entries,
    bundleSHA256: "",
    ready_for_migration: false,
    targetPrerequisites: [
      "L1:51 new tables plus five columns on four tables; AP store separately registered",
      "new idx81 recovery SQL, new snapshot id/actual generation time/0080 prevId",
      "Root frozen release binding and exact pg_catalog contract for every allowed prefix",
      "L2 roles/RLS and old-writer deployment fencing",
      "real PG validation, nonempty backup/restore and persistent wiring",
    ],
  };
  manifest.bundleSHA256 = manifestDigest(manifest);
  return {
    manifest,
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, b]) => ({
        path,
        base64: Buffer.from(b).toString("base64"),
      })),
  };
}
export function verifyBundle(bytes: Uint8Array): Bundle {
  const input = object(JSON.parse(utf8.decode(bytes)));
  invariant(Array.isArray(input.files), "INVALID_BUNDLE_FILES");
  const files = new Map<string, Uint8Array>();
  for (const value of input.files) {
    const f = object(value);
    invariant(
      typeof f.path === "string" &&
        typeof f.base64 === "string" &&
        !files.has(f.path),
      "DUPLICATE_OR_INVALID_FILE",
    );
    const decoded = Buffer.from(f.base64, "base64");
    invariant(decoded.toString("base64") === f.base64, "NONCANONICAL_BASE64");
    files.set(f.path, decoded);
  }
  const rebuilt = assembleBaseline(files);
  invariant(
    JSON.stringify(input.manifest) === JSON.stringify(rebuilt.manifest),
    "MANIFEST_DRIFT",
  );
  return rebuilt;
}
async function ordinaryFile(root: string, relative: string): Promise<Buffer> {
  const file = resolve(root, relative);
  invariant(file.startsWith(`${root}/`), "SOURCE_PATH_ESCAPE");
  // realpath equality refuses aliases in any parent, not just aliases outside root.
  invariant(
    (await realpath(file)) === file && (await lstat(file)).isFile(),
    "SOURCE_ALIAS_OR_NONFILE",
  );
  return readFile(file);
}
export async function buildBaselineBundle(
  drizzleRoot: string,
  destination: string,
): Promise<Bundle> {
  const root = resolve(drizzleRoot);
  invariant(
    (await realpath(root)) === root && (await lstat(root)).isDirectory(),
    "SOURCE_ROOT_ALIAS",
  );
  const journal = await ordinaryFile(root, "meta/_journal.json");
  const parsed = object(JSON.parse(utf8.decode(journal)));
  invariant(
    Array.isArray(parsed.entries) && parsed.entries.length === 81,
    "FROZEN_JOURNAL_SHAPE",
  );
  const files = new Map<string, Uint8Array>([["meta/_journal.json", journal]]);
  for (let idx = 0; idx < 81; idx++) {
    const e = object(parsed.entries[idx]);
    invariant(
      typeof e.tag === "string" &&
        new RegExp(`^${String(idx).padStart(4, "0")}_[a-z0-9_]+$`).test(e.tag),
      "BAD_IDX_TAG",
    );
    for (const path of [
      `${e.tag}.sql`,
      `meta/${String(idx).padStart(4, "0")}_snapshot.json`,
    ])
      files.set(path, await ordinaryFile(root, path));
  }
  // Deliberately no directory scanning: archives/0121/missing-file references cannot enter this bundle.
  const bundle = assembleBaseline(files);
  const target = resolve(destination);
  invariant(
    !target.startsWith(`${root}/`) && target !== root,
    "OUTPUT_INSIDE_FROZEN_SOURCE",
  );
  invariant(
    (await lstat(dirname(target))).isDirectory() &&
      (await realpath(dirname(target))) === dirname(target),
    "OUTPUT_PARENT_ALIAS_OR_MISSING",
  );
  await writeFile(target, `${JSON.stringify(bundle)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return bundle;
}

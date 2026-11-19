import { createHash } from "node:crypto";

export const LINEAGE_ID = "recovery-20261018-v1";
export const TARGET_CONTRACT = "recovery-20261018-v1/L1-L5";
export const BASELINE_TREE =
  "a81cd0487fd515911e1506d0a83ba532568f52bad90f0a8f8367da675392f785";
export const FROZEN_INPUT_SHA256 =
  "9e117f7df289439ac6a0f3e21fe50701bdbc7d5a3328826bcb87dec2c8caaf4d";
export const ZERO_ID = "00000000-0000-0000-0000-000000000000";
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}
export interface MigrationIdentity {
  idx: number;
  tag: string;
  when: number;
  sql: FileIdentity;
  snapshot: FileIdentity & { id: string; prevId: string };
}
export interface Manifest {
  schema: "recovery-lineage-bundle-v1";
  lineageId: typeof LINEAGE_ID;
  baselineTree: typeof BASELINE_TREE;
  frozenInputSHA256: typeof FROZEN_INPUT_SHA256;
  targetContract: typeof TARGET_CONTRACT;
  journal: FileIdentity;
  entries: MigrationIdentity[];
  bundleSHA256: string;
  ready_for_migration: false;
  targetPrerequisites: string[];
}
export interface Bundle {
  manifest: Manifest;
  files: { path: string; base64: string }[];
}
export function invariant(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
export function object(value: unknown): Record<string, unknown> {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_OBJECT",
  );
  return value as Record<string, unknown>;
}
export function identitiesDigest(rows: FileIdentity[]): string {
  return sha256(
    [...rows]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `${f.path}\0${f.bytes}\0${f.sha256}\n`)
      .join(""),
  );
}
// Hash the canonical manifest, excluding only its own digest; all prerequisites are covered.
export function manifestDigest(manifest: Manifest): string {
  const { bundleSHA256: _digest, ...body } = manifest;
  return sha256(JSON.stringify(body));
}
export interface HistoryRow {
  id: number;
  hash: string;
  created_at: string;
}
export function exactPrefix(
  entries: readonly MigrationIdentity[],
  rows: readonly HistoryRow[],
): number {
  invariant(rows.length <= entries.length, "UNKNOWN_OR_OLD_LINEAGE_HISTORY");
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const entry = entries[i];
    invariant(
      entry && entry.idx === i && row.id === i + 1 && !seen.has(row.created_at),
      "DUPLICATE_OR_REORDERED_HISTORY",
    );
    invariant(
      row.hash === entry.sql.sha256 && row.created_at === String(entry.when),
      "HISTORY_NOT_EXACT_PREFIX",
    );
    seen.add(row.created_at);
  }
  return rows.length;
}

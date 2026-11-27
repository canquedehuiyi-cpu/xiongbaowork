/**
 * The release this database may be migrated from, checked before any migration runs.
 *
 * v0.2.16 renamed everything the database had stored under the product's earlier name: the application
 * roles and the system data (migration 0240), the history (0241), and the credentials, resealed from kid
 * `k1` to `k2` in the same transaction. This release no longer carries the code that did that, nor the
 * code that read the old names while it was under way. A database that has not been through v0.2.16 would
 * migrate here and then half-work under names the server no longer reads, so it is refused instead, with
 * the way out: upgrade to v0.2.16 first, let it finish, then come back to this release.
 *
 * A database the migrator has never touched is new and has nothing to rename: it migrates straight
 * from the baseline and is never refused. Nor is one whose ledger already holds the baseline: it was
 * adopted by this release (or a later one), which means it passed this check then.
 *
 * WHAT IT READS SINCE THE BASELINE. v0.2.17 replaced the migration history with one baseline, so the
 * rename migrations are no longer files this release carries. A database that has not been adopted yet
 * still holds the history in its ledger, under the hashes v0.2.16's migrator recorded; the two rename
 * migrations are recognised by those hashes, written below. The check runs on that ledger before the
 * adoption rewrites it (`./baseline-adoption`), in the same transaction.
 *
 * The old names below are what the check looks for, and they are only ever read here, never written.
 * The embedded database's superuser and database names are checked by the delivery image's own boot
 * (docker/s6/scripts/upgrade-gate.sh), since an external database's are the operator's to choose.
 */
import type { TransactionSql } from "postgres";
import type { AppliedMigration } from "./migration-reach";

/**
 * The v0.2.16 rename migrations: journal tag, and the hash v0.2.16's migrator recorded for each (sha256
 * of the whole file as v0.2.16 shipped it, commit e9a669825). docker/s6/scripts/upgrade-gate.sh carries
 * the same two hashes; tests/upgrade-gate.test.ts holds them equal to the files in that commit.
 */
export const RENAME_MIGRATIONS: ReadonlyArray<
  readonly [tag: string, hash: string]
> = [
  [
    "0240_rebrand_names",
    "b58372c5267789fbd30ae8cc0c3c997df9e9e100bb95e0331f4241be3b0f5018",
  ],
  [
    "0241_rebrand_history",
    "524f42fe9c4e6115e478ce41ddb39e3add950a002379bffef6acea43780a5ad5",
  ],
];

/** Each application role as it was named before v0.2.16, and the name 0240 gave it. */
export const RENAMED_ROLES: ReadonlyArray<readonly [string, string]> = [
  ["openbot_app", "xiongbao_app"],
  ["openbot_role_writer", "xiongbao_role_writer"],
];

/** The kid credential envelopes were sealed under before v0.2.16 (v0.2.16 resealed every one as `k2`). */
export const PRE_RENAME_CREDENTIAL_KID = "k1";

export type UpgradeFacts = {
  /** Rows in the migration journal before this run: 0 is a database the migrator has never touched. */
  applied: number;
  /** The rename migrations (by tag) the journal does not hold. */
  missingMigrations: string[];
  /** Application roles still under the name they had before v0.2.16 (their new name absent). */
  oldRoles: string[];
  /** Credential rows still sealed under the pre-v0.2.16 kid. */
  oldCredentials: number;
};

const AFTER =
  "先换回 v0.2.16 镜像启动一次，等它完成改名升级（启动日志里迁移成功、服务正常），再升级到这个版本。";

/**
 * Why this database may not be migrated by this release, or `undefined` when it may.
 *
 * One message naming every reason found, so an operator fixes the state once rather than meeting the
 * reasons one boot at a time. It says nothing has changed, because nothing has: the check runs inside
 * the migration transaction before any migration, and the refusal rolls it back.
 */
export function upgradeRefusal(facts: UpgradeFacts): string | undefined {
  if (facts.applied === 0) return undefined;
  const reasons: string[] = [];
  if (facts.missingMigrations.length > 0)
    reasons.push(
      `迁移记录里没有 v0.2.16 的改名迁移（${facts.missingMigrations.join("、")}）`,
    );
  if (facts.oldRoles.length > 0)
    reasons.push(`应用角色仍是改名前的名字（${facts.oldRoles.join("、")}）`);
  if (facts.oldCredentials > 0)
    reasons.push(
      `credentials 表里还有 ${facts.oldCredentials} 条 v0.2.16 之前格式（kid ${PRE_RENAME_CREDENTIAL_KID}）的凭据`,
    );
  if (reasons.length === 0) return undefined;
  return `这个数据库还没有完成 v0.2.16 的改名升级：${reasons.join("；")}。这个版本只能从 v0.2.16 升级上来，请先升级到 v0.2.16。不迁移、不启动（数据库没有任何改动）。${AFTER}`;
}

/**
 * What {@link upgradeRefusal} decides on, read inside the migration transaction.
 *
 * The credentials are counted in the `platform` frame: row security on `credentials` is forced, so a
 * migration owner that is neither a superuser nor BYPASSRLS sees only the rows its frame admits, and the
 * `tenant_isolation` policies admit every row to that frame (migrations 0114, 0115, 0121 and 0240 run in
 * it the same way). The frame is set inside a savepoint that is rolled back ({@link countOldCredentials}).
 * A database without the table yet is a fresh one and is not asked.
 */
export async function readUpgradeFacts(
  tx: TransactionSql,
  applied: readonly AppliedMigration[],
): Promise<UpgradeFacts> {
  const appliedHashes = new Set(applied.map((row) => row.hash));
  const missingMigrations = RENAME_MIGRATIONS.filter(
    ([, hash]) => !appliedHashes.has(hash),
  ).map(([tag]) => tag);
  const roles = await tx<{ rolname: string }[]>`
    select rolname from pg_roles where rolname in ${tx(RENAMED_ROLES.flat())}`;
  const present = new Set(roles.map((row) => row.rolname));
  const oldRoles = RENAMED_ROLES.filter(
    ([old, renamed]) => present.has(old) && !present.has(renamed),
  ).map(([old]) => old);
  let oldCredentials = 0;
  if (applied.length > 0) {
    const [table] = await tx<{ present: string | null }[]>`
      select to_regclass('public.credentials')::text as present`;
    if (table?.present) oldCredentials = await countOldCredentials(tx);
  }
  return {
    applied: applied.length,
    missingMigrations,
    oldRoles,
    oldCredentials,
  };
}

/** Thrown only to roll the savepoint back, which puts the tenant frame back exactly as it was. */
class FrameRestored extends Error {}

/**
 * The credential rows still sealed under the pre-v0.2.16 kid, counted in the `platform` frame inside a
 * savepoint that is then rolled back. Rolling back restores `app.tenant_id` to whatever it was before,
 * unset included, rather than writing a value of ours over it: a migration after this check sees the frame
 * its caller left. (PostgreSQL itself reads a custom setting that was ever touched in a session as an empty
 * string afterwards, never NULL; nothing here writes one.)
 */
async function countOldCredentials(tx: TransactionSql): Promise<number> {
  let count = 0;
  const restored = new FrameRestored();
  await tx
    .savepoint(async (sp) => {
      await sp`select set_config('app.tenant_id', 'platform', true)`;
      // `sealCredential` writes compact JSON, so the kid is matched as text: casting every row to jsonb
      // would fail on a v1 envelope, which is not JSON.
      const [row] = await sp<{ count: string }[]>`
        select count(*)::text as count from public.credentials
         where encrypted_value like ${'{"version":2,%'}
           and encrypted_value like ${`%"kid":"${PRE_RENAME_CREDENTIAL_KID}"%`}`;
      count = Number(row?.count ?? 0);
      throw restored;
    })
    .catch((failure: unknown) => {
      if (failure !== restored) throw failure;
    });
  return count;
}

/** Thrown instead of migrating a database that has not been through v0.2.16. */
export class UpgradeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeRefusedError";
  }
}

/**
 * The check as the release runs it on a ledger that still holds the history, before the adoption:
 * throws {@link UpgradeRefusedError}. `./baseline-adoption` decides which ledgers those are.
 */
export async function refuseUnrenamedDatabase(
  tx: TransactionSql,
  applied: readonly AppliedMigration[],
): Promise<void> {
  if (applied.length === 0) return;
  const refusal = upgradeRefusal(await readUpgradeFacts(tx, applied));
  if (refusal) throw new UpgradeRefusedError(refusal);
}

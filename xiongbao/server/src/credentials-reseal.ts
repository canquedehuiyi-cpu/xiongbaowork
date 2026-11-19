import { and, asc, count, eq, gt, inArray, notLike } from "drizzle-orm";
import {
  type CredentialBinding,
  decryptSecret,
  openCredential,
  sealCredential,
} from "./credentials";
import type { Database } from "./db/client";
import { reasonWithoutStatement } from "./db/query-failure";
import { credentials } from "./db/schema";
import { runAsTenant } from "./tenant/context";

/**
 * Reseal every unbound (v1) credential row into a v2 envelope bound to its own row (audit #9).
 *
 * WHY. v1 authenticates nothing about where it is stored, so a v1 envelope copied into another
 * tenant's row opens there. `VAULT_REQUIRE_AAD=1` refuses v1, but switching it on while v1 rows
 * remain stops every one of them. This sweep is what makes the switch safe: run it, read
 * `remaining`, and set the variable only once that is 0.
 *
 * HOW. Tenants are listed in the platform frame, which row security lets see every tenant. Each
 * tenant's rows are then read and written inside THAT tenant's frame and filtered to its own
 * `tenant_id` explicitly, because row security also shows `system` rows to every tenant and a row is
 * only ever resealed by the scope that owns it. The binding is the row's own columns.
 *
 * COMPARE-AND-SWAP. The write lands only where the stored value is still exactly the envelope that
 * was read. A rotation or refresh that wrote a new secret in between wins; the sweep counts the row
 * as `changedSinceRead` and a rerun picks it up. Nothing is locked, so a live deployment can run it.
 *
 * IDEMPOTENT. Only rows whose value is not a v2 envelope are read; a resealed row is never read
 * again. A row that cannot be opened (another key, not an envelope) is counted `unreadable`, left as
 * it is, and still counts toward `remaining`.
 *
 * NEVER PRINTS A SECRET. `log` receives counts, tenant ids and row ids. Failures are quoted through
 * {@link reasonWithoutStatement}, because a failed UPDATE's message carries its bound envelope.
 * `updated_at` is left alone: the secret did not change, only how it is wrapped.
 */
export type ResealReport = {
  tenants: number;
  scanned: number;
  resealed: number;
  changedSinceRead: number;
  unreadable: number;
  remaining: number;
};

type UnboundRow = CredentialBinding & { encryptedValue: string };

export type ResealOptions = {
  /** Restrict the sweep to these tenants. Omitted, every tenant holding an unbound row is swept. */
  tenants?: readonly string[];
  /** Where progress lines go. Defaults to stdout as one JSON object per line. */
  log?: (line: string) => void;
  /** Rows read per query; the sweep pages by id. */
  batchSize?: number;
  /** Called between reading a row and writing it. Exists for the compare-and-swap test. */
  beforeWrite?: (row: UnboundRow) => Promise<void>;
};

/** A stored value that is not a v2 envelope. `sealCredential` always starts with these bytes. */
const UNBOUND = notLike(credentials.encryptedValue, '{"version":2,%');

/** Every tenant with at least one unbound row, read in the platform frame. */
export async function listTenantsWithUnboundCredentials(database: Database) {
  const rows = await runAsTenant("platform", () =>
    database
      .selectDistinct({ tenantId: credentials.tenantId })
      .from(credentials)
      .where(UNBOUND)
      .orderBy(asc(credentials.tenantId)),
  );
  return rows.map((row) => row.tenantId);
}

async function countUnbound(database: Database, tenants?: readonly string[]) {
  const [row] = await runAsTenant("platform", () =>
    database
      .select({ value: count() })
      .from(credentials)
      .where(
        tenants
          ? and(UNBOUND, inArray(credentials.tenantId, [...tenants]))
          : UNBOUND,
      ),
  );
  return Number(row?.value ?? 0);
}

async function unboundPage(
  database: Database,
  tenant: string,
  after: string | null,
  limit: number,
): Promise<UnboundRow[]> {
  return runAsTenant(tenant, () =>
    database
      .select({
        id: credentials.id,
        tenantId: credentials.tenantId,
        kind: credentials.kind,
        encryptedValue: credentials.encryptedValue,
      })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenantId, tenant),
          UNBOUND,
          after ? gt(credentials.id, after) : undefined,
        ),
      )
      .orderBy(asc(credentials.id))
      .limit(limit),
  );
}

/** The plaintext of a v1 row, or null when it is not one this key opens. */
async function openUnbound(encryptionKey: string, value: string) {
  try {
    const parsed = JSON.parse(value) as { version?: unknown } | null;
    if (parsed?.version !== 1) {
      return null;
    }
    return await decryptSecret(encryptionKey, value);
  } catch {
    return null;
  }
}

export async function resealCredentials(
  database: Database,
  encryptionKey: string,
  options: ResealOptions = {},
): Promise<ResealReport> {
  const log = options.log ?? ((line: string) => console.info(line));
  const batchSize = options.batchSize ?? 200;
  const tenants =
    options.tenants ?? (await listTenantsWithUnboundCredentials(database));

  const report: ResealReport = {
    tenants: tenants.length,
    scanned: 0,
    resealed: 0,
    changedSinceRead: 0,
    unreadable: 0,
    remaining: 0,
  };

  for (const tenant of tenants) {
    const counts = {
      scanned: 0,
      resealed: 0,
      changedSinceRead: 0,
      unreadable: 0,
    };
    let after: string | null = null;
    for (;;) {
      const page = await unboundPage(database, tenant, after, batchSize);
      if (page.length === 0) {
        break;
      }
      for (const row of page) {
        after = row.id;
        counts.scanned += 1;
        const plaintext = await openUnbound(encryptionKey, row.encryptedValue);
        if (plaintext === null) {
          counts.unreadable += 1;
          log(
            JSON.stringify({
              type: "credential-reseal-unreadable",
              tenant,
              credentialId: row.id,
            }),
          );
          continue;
        }
        const binding: CredentialBinding = {
          tenantId: row.tenantId,
          id: row.id,
          kind: row.kind,
        };
        const sealed = await sealCredential(encryptionKey, binding, plaintext);
        // Proves the new envelope opens for this row before the old one is replaced.
        if (
          (await openCredential(
            encryptionKey,
            { ...binding, encryptedValue: sealed },
            { requireAad: true },
          )) !== plaintext
        ) {
          throw new Error(
            "A resealed credential did not open to its own value",
          );
        }
        await options.beforeWrite?.(row);
        let swapped: { id: string }[];
        try {
          swapped = await runAsTenant(tenant, () =>
            database
              .update(credentials)
              .set({ encryptedValue: sealed })
              .where(
                and(
                  eq(credentials.id, row.id),
                  eq(credentials.tenantId, tenant),
                  eq(credentials.encryptedValue, row.encryptedValue),
                ),
              )
              .returning({ id: credentials.id }),
          );
        } catch (error) {
          throw new Error(
            `Resealing credential ${row.id} of tenant ${tenant} failed: ${reasonWithoutStatement(error)}`,
          );
        }
        if (swapped.length === 1) {
          counts.resealed += 1;
        } else {
          counts.changedSinceRead += 1;
        }
      }
    }
    report.scanned += counts.scanned;
    report.resealed += counts.resealed;
    report.changedSinceRead += counts.changedSinceRead;
    report.unreadable += counts.unreadable;
    log(
      JSON.stringify({ type: "credential-reseal-tenant", tenant, ...counts }),
    );
  }

  report.remaining = await countUnbound(database, options.tenants);
  log(JSON.stringify({ type: "credential-reseal-done", ...report }));
  return report;
}

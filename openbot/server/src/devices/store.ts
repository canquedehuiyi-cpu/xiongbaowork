import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type DeviceApp,
  type DeviceRoot,
  devicePairCodes,
  OFFLINE_AFTER_MS,
  registeredDevices,
  users,
} from "../db/schema";
import type { QuotaService } from "../quota/limits";
import { isAccessRevoked } from "../tenant/access";
import { runAsTenant } from "../tenant/context";

/**
 * Devices and the pairing that admits one (ticket 016).
 *
 * The machine a coworker works on belongs to a tenant and reaches this server from wherever it is, so
 * there is no address here to connect to and no port to open: the runner dials out, and the only
 * credential it ever presents is the token this module handed out once, at pairing.
 */

/** Recognisable on sight, so a leaked one can be found in a log or by a secret scanner. */
const DEVICE_TOKEN_PREFIX = "obot_dev_";
/** Pairing codes are read aloud and typed once, so they stay short and unmistakable. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
/** How long a code survives unspent. Long enough to copy, short enough to be nothing by morning. */
const CODE_TTL_MS = 10 * 60 * 1000;

export type DeviceRecord = {
  id: string;
  deviceId: string;
  name: string;
  platform: string | null;
  lastSeenAt: Date | null;
  online: boolean;
  /** The read-only folders the machine offers (story F1, stage 2): a reference and a name, no path. */
  roots: DeviceRoot[];
  /** The local apps (MCP) the machine offers: a reference and a name, no command or path. */
  apps: DeviceApp[];
};

/**
 * A folder as a report keeps it: the stored `DeviceRoot`, and, when the machine's owner registered it
 * for a project they let coworkers write in (story RES2, decision D3), its mode. No mode is `read`,
 * which is what every folder F1 offers and what an older runner reports.
 */
export type ReportedDeviceRoot = DeviceRoot & { mode?: "read" | "write" };

/** At most this many folders are kept from one report; the runner offers at most 20. */
export const DEVICE_ROOT_LIMIT = 50;
/** The runner's reference shape: `fld_` and 128 random bits in base64url. */
const ROOT_REF = /^fld_[A-Za-z0-9_-]{22}$/;

/**
 * A runner's report of its folders, as this server keeps it, or undefined when the frame carried no
 * report at all (an older runner), which leaves what is stored alone.
 *
 * Whatever the machine sent is untrusted input from a device, so each entry is kept only when its
 * reference has the runner's shape and its name is text of at most 60 characters (with its mode,
 * `read` or `write`, when the runner said one: story RES2, decision D3), and a reference
 * named twice is kept once. Anything else is dropped rather than failing the heartbeat: a machine
 * with one odd entry is still online. A field that looks like a path is never read, so a runner
 * that sent one would not get it stored.
 */
export function reportedRoots(
  value: unknown,
): ReportedDeviceRoot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: ReportedDeviceRoot[] = [];
  for (const entry of value) {
    if (kept.length >= DEVICE_ROOT_LIMIT) break;
    const { ref, name, mode } = (entry ?? {}) as {
      ref?: unknown;
      name?: unknown;
      mode?: unknown;
    };
    if (typeof ref !== "string" || !ROOT_REF.test(ref)) continue;
    if (typeof name !== "string") continue;
    const shown = name.trim();
    if (!shown || [...shown].length > 60) continue;
    if (kept.some((root) => root.ref === ref)) continue;
    // A mode is kept only when it is one of the two the runner knows; anything else is read-only.
    kept.push(
      mode === "write" || mode === "read"
        ? { ref, name: shown, mode }
        : { ref, name: shown },
    );
  }
  return kept;
}

/** At most this many apps are kept from one report. */
export const DEVICE_APP_LIMIT = 20;
/** The runner's app reference shape: `app_` and 128 random bits in base64url. */
const APP_REF = /^app_[A-Za-z0-9_-]{22}$/;

/**
 * A runner's report of its local apps, as this server keeps it, or undefined when the frame carried
 * none (an older runner), which leaves what is stored alone. Untrusted input from a device: an entry
 * is kept only with a reference of the runner's shape and a name of 1 to 40 characters, a reference
 * named twice is kept once, at most 20 are kept, and anything else is dropped, not failed.
 */
export function reportedApps(value: unknown): DeviceApp[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: DeviceApp[] = [];
  for (const entry of value) {
    if (kept.length >= DEVICE_APP_LIMIT) break;
    const { ref, name } = (entry ?? {}) as { ref?: unknown; name?: unknown };
    if (typeof ref !== "string" || !APP_REF.test(ref)) continue;
    if (typeof name !== "string") continue;
    const shown = name.trim();
    if (!shown || [...shown].length > 40) continue;
    if (kept.some((app) => app.ref === ref)) continue;
    kept.push({ ref, name: shown });
  }
  return kept;
}

export type DeviceStore = {
  /** A code for the person's screen, minted under their own tenant. */
  mintPairCode: (
    tenantId: string,
  ) => Promise<{ code: string; expiresAt: Date }>;
  /**
   * Turn a code into a device, and return the token exactly once.
   *
   * Null is the answer for a code that is unknown, expired, or already spent — three different
   * reasons the caller is not told apart, because which one it was is only useful to somebody
   * trying codes.
   */
  redeemPairCode: (
    input: {
      code: string;
      deviceId: string;
      name: string;
      platform: string | null;
    },
    quota?: QuotaService,
  ) => Promise<{ token: string; device: DeviceRecord } | null>;
  list: (tenantId: string) => Promise<DeviceRecord[]>;
  /**
   * Whose machine a live code would admit, without spending it.
   *
   * An informational lookup. Admission itself runs on the claiming transaction's session, so a
   * quota refusal rolls back the claim and concurrent pairings cannot spend the same device slot.
   */
  tenantForCode: (code: string) => Promise<string | null>;
  /** The device a token belongs to, or null. Read by the socket that carries it. */
  deviceForToken: (token: string) => Promise<DeviceOwner | null>;
  isCurrent: (owner: DeviceOwner) => Promise<boolean>;
  isRegistered: (
    target: { tenantId: string; deviceId: string },
    credentialVersion?: string,
  ) => Promise<boolean>;
  /** Presence, and, when the frame carried one, the machine's report of its folders. */
  heartbeat: (
    tenantId: string,
    deviceId: string,
    roots?: DeviceRoot[],
    apps?: DeviceApp[],
  ) => Promise<void>;
  // --- app discovery (sub-project 3) ---
  /**
   * One app the machine just enabled, added to what it reported, so it can be used before the next
   * heartbeat (which reports the machine's whole list again and replaces this one).
   */
  rememberApp: (
    tenantId: string,
    deviceId: string,
    app: DeviceApp,
  ) => Promise<void>;
  // --- end app discovery ---
  remove: (tenantId: string, id: string) => Promise<boolean>;
};

function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  return Array.from(
    bytes,
    (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
  ).join("");
}

function mintDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * The token as stored: a hash, never the token.
 *
 * A dump of this table would otherwise be a working credential for every desktop in the deployment,
 * and a device token lets its holder receive the work a coworker is told to do on that machine.
 */
function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compared without leaking how much of one was right. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Which device a presented token belongs to, and whose it is.
 *
 * Read under the `platform` scope on purpose, and only this read: a socket presents a token and
 * nothing else — no cookie, no session, because an upgrade cannot carry one — so there is no tenant
 * to scope the search by until the search is over. What comes back IS the tenant, and every write that
 * follows is made to run inside that tenant's own scope, so the one unscoped read opens no door.
 *
 * Hashes are compared in constant time rather than in SQL, so a wrong token teaches nobody how much
 * of it was right.
 */
export async function authenticateDeviceToken(
  database: Database,
  token: string,
): Promise<DeviceOwner | null> {
  const rows = await runAsTenant("platform", () =>
    database
      .select({
        id: registeredDevices.id,
        tenantId: registeredDevices.tenantId,
        deviceId: registeredDevices.deviceId,
        tokenHash: registeredDevices.tokenHash,
      })
      .from(registeredDevices),
  );
  const wanted = hashDeviceToken(token);
  const hit = rows.find((row) => sameHash(row.tokenHash, wanted));
  return hit
    ? {
        id: hit.id,
        tenantId: hit.tenantId,
        deviceId: hit.deviceId,
        credentialVersion: hit.tokenHash,
      }
    : null;
}

/** Who a token belongs to: the row, the machine, and the tenant that owns the scope. */
export type DeviceOwner = {
  id: string;
  tenantId: string;
  deviceId: string;
  /** A fingerprint, never the token; changes when the device is re-paired. */
  credentialVersion: string;
};

const record = (row: {
  id: string;
  deviceId: string;
  name: string;
  platform: string | null;
  lastSeenAt: Date | null;
  roots?: DeviceRoot[] | null;
  apps?: DeviceApp[] | null;
  createdAt?: Date;
}): DeviceRecord => ({
  id: row.id,
  deviceId: row.deviceId,
  name: row.name,
  platform: row.platform,
  lastSeenAt: row.lastSeenAt,
  roots: reportedRoots(row.roots) ?? [],
  apps: reportedApps(row.apps) ?? [],
  online:
    row.lastSeenAt !== null &&
    Date.now() - row.lastSeenAt.getTime() < OFFLINE_AFTER_MS,
});

export function createDeviceStore(
  database: Database,
  options?: {
    onRevoked?: (target: { tenantId: string; deviceId: string }) => void;
  },
): DeviceStore {
  const revoke = (target: { tenantId: string; deviceId: string }) =>
    options?.onRevoked?.(target);
  async function isRegistered(
    target: { tenantId: string; deviceId: string },
    credentialVersion?: string,
  ) {
    const [device] = await runAsTenant("platform", () =>
      database
        .select({
          id: registeredDevices.id,
          tokenHash: registeredDevices.tokenHash,
        })
        .from(registeredDevices)
        .innerJoin(users, eq(users.id, registeredDevices.tenantId))
        .where(
          and(
            eq(registeredDevices.tenantId, target.tenantId),
            eq(registeredDevices.deviceId, target.deviceId),
          ),
        )
        .limit(1),
    );
    if (
      !device ||
      (credentialVersion !== undefined &&
        !sameHash(device.tokenHash, credentialVersion))
    )
      return false;
    return !(await isAccessRevoked(database, target.tenantId));
  }
  /*
   * Every operation names the tenant it writes to and runs inside it, rather than reading whichever
   * scope the caller happened to leave on.
   *
   * Three kinds of caller reach this store: a signed-in person (their own scope), a runner with a
   * device token (no scope, because no session), and a socket callback (likewise). A store that relied
   * on the ambient scope would answer the last two as `system`, which row-level security lets it see
   * nothing of — and "nothing" arriving quietly is how a device ends up permanently offline.
   */
  return {
    async mintPairCode(tenantId) {
      const code = mintCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MS);
      await runAsTenant(tenantId, () =>
        database.insert(devicePairCodes).values({ code, tenantId, expiresAt }),
      );
      return { code, expiresAt };
    },

    async redeemPairCode(input, quota) {
      /*
       * The claim is one UPDATE guarded on `used_at IS NULL`, so a code spent twice at the same instant
       * is spent once: a read-then-write would let both runners through the same check.
       *
       * Read under the `platform` scope because a code is the only thing the caller holds, and there is
       * no tenant to scope by until the code names one. Nothing after that trusts the caller for a
       * tenant either — `claimed.tenantId` is the tenant that minted the code, and the device row is
       * written with it.
       */
      const claimed = await runAsTenant("platform", () =>
        database.transaction(async (transaction) => {
          const [code] = await transaction
            .update(devicePairCodes)
            .set({ usedAt: new Date(), deviceId: input.deviceId })
            .where(
              and(
                eq(devicePairCodes.code, input.code.trim().toUpperCase()),
                isNull(devicePairCodes.usedAt),
                gt(devicePairCodes.expiresAt, new Date()),
              ),
            )
            .returning({ tenantId: devicePairCodes.tenantId });
          if (!code) return null;
          // A refusal rolls the code claim back too. Re-pairing an existing id consumes no new seat.
          if (quota) {
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${code.tenantId}`}, 0))`,
            );
            const [existing] = await transaction
              .select({ id: registeredDevices.id })
              .from(registeredDevices)
              .where(
                and(
                  eq(registeredDevices.tenantId, code.tenantId),
                  eq(registeredDevices.deviceId, input.deviceId),
                ),
              )
              .limit(1);
            if (!existing)
              await quota.assertCapacityWithin(
                transaction,
                code.tenantId,
                "devices",
              );
          }
          /*
           * Spent or expired codes are refused the same way and for the same reason: a code that reads
           * `expired` is a hint that the format was right, which is a hint nobody outside needs.
           */
          const token = mintDeviceToken();
          const [device] = await transaction
            .insert(registeredDevices)
            .values({
              tenantId: code.tenantId,
              deviceId: input.deviceId,
              name: input.name,
              platform: input.platform,
              tokenHash: hashDeviceToken(token),
              lastSeenAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [registeredDevices.tenantId, registeredDevices.deviceId],
              set: {
                name: input.name,
                platform: input.platform,
                tokenHash: hashDeviceToken(token),
                lastSeenAt: new Date(),
                updatedAt: new Date(),
              },
            })
            .returning();
          return { token, device };
        }),
      );
      if (!claimed) return null;
      revoke({
        tenantId: claimed.device.tenantId,
        deviceId: claimed.device.deviceId,
      });
      return { token: claimed.token, device: record(claimed.device) };
    },

    async list(tenantId) {
      const rows = await runAsTenant(tenantId, () =>
        database
          .select()
          .from(registeredDevices)
          .where(eq(registeredDevices.tenantId, tenantId))
          .orderBy(desc(registeredDevices.lastSeenAt)),
      );
      return rows.map(record);
    },

    async tenantForCode(code) {
      const wanted = code.trim().toUpperCase();
      if (!wanted) return null;
      const [row] = await runAsTenant("platform", () =>
        database
          .select({ tenantId: devicePairCodes.tenantId })
          .from(devicePairCodes)
          .where(
            and(
              eq(devicePairCodes.code, wanted),
              isNull(devicePairCodes.usedAt),
              gt(devicePairCodes.expiresAt, new Date()),
            ),
          )
          .limit(1),
      );
      return row?.tenantId ?? null;
    },

    async deviceForToken(token) {
      if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
      const owner = await authenticateDeviceToken(database, token);
      if (!owner) return null;
      if (!(await isRegistered(owner, owner.credentialVersion))) return null;
      /*
       * Spec J5: a ban freezes the runner, it does not merely sign the person out of a page. The
       * answer is the same null a wrong token gets, because the alternative — a distinct refusal —
       * tells whoever holds a valid token that the workspace is banned, which is information an
       * abandoned machine has no business receiving. Said in the log, where the operator looking
       * for "why did my device stop" will find it.
       */
      if (await isAccessRevoked(database, owner.tenantId)) {
        console.warn(
          JSON.stringify({
            type: "device-refused-banned-tenant",
            tenantId: owner.tenantId,
            deviceId: owner.deviceId,
          }),
        );
        return null;
      }
      return owner;
    },

    isRegistered,
    async isCurrent(owner) {
      if (!owner.credentialVersion) return false;
      if (!(await isRegistered(owner, owner.credentialVersion))) return false;
      const [row] = await runAsTenant(owner.tenantId, () =>
        database
          .select({ id: registeredDevices.id })
          .from(registeredDevices)
          .where(
            and(
              eq(registeredDevices.id, owner.id),
              eq(registeredDevices.tenantId, owner.tenantId),
              eq(registeredDevices.deviceId, owner.deviceId),
            ),
          )
          .limit(1),
      );
      return Boolean(row);
    },

    async heartbeat(tenantId, deviceId, roots, apps) {
      await runAsTenant(tenantId, () =>
        database
          .update(registeredDevices)
          .set({
            lastSeenAt: new Date(),
            updatedAt: new Date(),
            ...(roots ? { roots } : {}),
            ...(apps ? { apps } : {}),
          })
          .where(
            and(
              eq(registeredDevices.tenantId, tenantId),
              eq(registeredDevices.deviceId, deviceId),
            ),
          ),
      );
    },

    // --- app discovery (sub-project 3) ---
    async rememberApp(tenantId, deviceId, app) {
      /*
       * Not locked against a heartbeat: one composed before the enable and written after this puts
       * the old list back until the next heartbeat (within 20 seconds), which reports the new app.
       */
      await runAsTenant(tenantId, async () => {
        const where = and(
          eq(registeredDevices.tenantId, tenantId),
          eq(registeredDevices.deviceId, deviceId),
        );
        const [row] = await database
          .select({ apps: registeredDevices.apps })
          .from(registeredDevices)
          .where(where)
          .limit(1);
        if (!row) return;
        const stored = reportedApps(row.apps) ?? [];
        if (stored.some((known) => known.ref === app.ref)) return;
        // Checked like a report: a bad reference or name is dropped, and at most 20 are kept.
        const apps = reportedApps([...stored, app]) ?? stored;
        await database
          .update(registeredDevices)
          .set({ apps, updatedAt: new Date() })
          .where(where);
      });
    },
    // --- end app discovery ---

    async remove(tenantId, id) {
      const [removed] = await runAsTenant(tenantId, () =>
        database
          .delete(registeredDevices)
          .where(
            and(
              eq(registeredDevices.tenantId, tenantId),
              eq(registeredDevices.id, id),
            ),
          )
          .returning({
            id: registeredDevices.id,
            deviceId: registeredDevices.deviceId,
          }),
      );
      if (removed) revoke({ tenantId, deviceId: removed.deviceId });
      return Boolean(removed);
    },
  };
}

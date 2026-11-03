import { AsyncLocalStorage } from "node:async_hooks";
import { PLATFORM_TENANT, TEAM_TENANT } from "../db/schema/tenant";

/**
 * Which tenant the current operation belongs to.
 *
 * AsyncLocalStorage rather than a parameter because the database client is reached from a hundred
 * call sites, and a tenant argument threaded through all of them is a hundred places someone forgets
 * to pass it. The client reads this at query time.
 *
 * BACKGROUND WORK DERIVES ITS TENANT FROM A ROW (G01). A timer, a queue sweep or a culler has no
 * person behind it, so it must not act as anybody until it has read whose work it is: the tenant
 * stamped on the row it claimed. It then runs that work inside `runAsTenant(thatTenant)`, after
 * `assertPersonTenant` has refused a row that names nobody. Questions that genuinely belong to no
 * tenant — what is due, what is unheld — say so with an explicit `runAsTenant("platform")`.
 *
 * The `system` answer below for a query with no context is LEGACY. It reads only platform rows, but
 * it also WRITES them, and a `system` row is one every tenant can read, so background work that
 * forgot its frame filed a person's results where everybody could see them. It goes away in
 * follow-up G01-D, when `currentTenant()` throws outside a frame the way `requireTenant()` does now.
 *
 * THE ROAD THERE (G01-D, step one). `OPENBOT_TENANT_FRAME_GUARD` decides what an unframed read of
 * the tenant does, so offenders can be found before the fallback is removed:
 *   - unset / `off`: the legacy `system` answer, silently. Production today.
 *   - `report`: still `system`, but each distinct call site is written once to stderr as a
 *     `tenant-unframed-access` line with the stack that reached it. CI's server shards run this
 *     way, so the logs list every remaining offender without failing anything.
 *   - `throw`: a `TenantContextError`, exactly what G01-D makes the only behaviour. Run a test file
 *     with it to prove that file is clean.
 * The escape for work that genuinely belongs to nobody is NOT the fallback: it is an explicit
 * `runAsTenant("platform", ...)` (a question across tenants, or a deployment row) or, for the
 * catalogue rows every tenant must read, `runAsTenant("system", ...)`, at the call site.
 * `asPlatform(work)` is the short spelling of the first.
 *
 * `team` IS A STAMP, NEVER A FRAME (G01-E). Rows shared by the whole team are stamped `team`, and
 * who may touch one is decided by that row's ownership predicate in the frame of the person asking.
 * Nobody acts as `team`: it is not a person tenant (`isPersonTenant` answers false, so background
 * work stamped `team` has no owner to run as), and `runAsTenant("team", ...)` throws rather than
 * open a frame in which every shared row would look like the caller's own.
 */
const store = new AsyncLocalStorage<string>();

/**
 * The tenant frame exactly as it stands: `undefined` outside any `runAsTenant`, unlike
 * `currentTenant`, which answers that with `system`.
 *
 * The database client needs the difference. A statement built inside a frame is pinned to that frame
 * for good, because the frame can be gone by the time it executes; one built outside every frame keeps
 * the old behaviour of running as whichever frame awaits it. An explicit `runAsTenant("system", ...)`
 * is a frame like any other and pins to `system`.
 */
export function tenantFrame(): string | undefined {
  return store.getStore();
}

/** No trusted tenant to act as: outside any frame, a row that names nobody, or the wrong person. */
export class TenantContextError extends Error {
  override name = "TenantContextError";
}

export type TenantFrameGuard = "off" | "report" | "throw";

/** Read at call time, so a test can switch it for one case and restore it. */
export function tenantFrameGuard(
  env: Record<string, string | undefined> = process.env,
): TenantFrameGuard {
  const value = env.OPENBOT_TENANT_FRAME_GUARD?.trim().toLowerCase();
  return value === "report" || value === "throw" ? value : "off";
}

const reportedSites = new Set<string>();
const REPORTED_SITES_LIMIT = 1000;

/** The first stack frame outside this module and the database client: who forgot the frame. */
function unframedCallSite(stack: string | undefined): string {
  const frames = (stack ?? "").split("\n").slice(1);
  const caller = frames.find(
    (line) =>
      !/tenant[\\/]context\.ts|db[\\/]client\.ts|node_modules|node:/.test(line),
  );
  return (caller ?? frames[0] ?? "unknown").trim();
}

/**
 * Forget which call sites were reported. For the guard's own test: a CI shard runs every file in one
 * process under `report`, so by the time that test runs the cap may already be spent by others.
 */
export function forgetReportedUnframedSites() {
  reportedSites.clear();
}

function reportUnframed(error: Error) {
  const site = unframedCallSite(error.stack);
  if (reportedSites.has(site) || reportedSites.size >= REPORTED_SITES_LIMIT)
    return;
  reportedSites.add(site);
  // stderr rather than console.warn: a test that spies on the console must not see the guard.
  process.stderr.write(
    `${JSON.stringify({
      type: "tenant-unframed-access",
      site,
      stack: (error.stack ?? "")
        .split("\n")
        .slice(1, 9)
        .map((line) => line.trim()),
    })}\n`,
  );
}

export function currentTenant(): string {
  const tenant = store.getStore();
  if (tenant !== undefined) return tenant;
  const guard = tenantFrameGuard();
  if (guard === "throw")
    throw new TenantContextError(
      "no tenant frame (OPENBOT_TENANT_FRAME_GUARD=throw): run this inside runAsTenant",
    );
  if (guard === "report") reportUnframed(new Error("unframed tenant read"));
  return "system";
}

export function isTenantFramed(): boolean {
  return store.getStore() !== undefined;
}

/** The tenant of the frame this runs in. Outside a frame it is an error, never `system`. */
export function requireTenant(): string {
  const tenant = store.getStore();
  if (!tenant) throw new TenantContextError("no tenant frame");
  return tenant;
}

/** A tenant that is a person's own: not empty, and not one of the three that belong to nobody. */
export function isPersonTenant(tenant: unknown): tenant is string {
  return (
    typeof tenant === "string" &&
    tenant !== "" &&
    tenant !== "system" &&
    tenant !== "platform" &&
    tenant !== TEAM_TENANT
  );
}

/**
 * The entry guard for background work. Answers the tenant to run as, or throws.
 *
 * `stamped` is the tenant on the claimed row, written by the database from the frame that offered
 * it, and it is the only trusted answer. `owner` is whoever the payload says the work is for; it can
 * only confirm the stamp, never replace it. And work already running for one person may not resolve
 * into another's: only a frame that is nobody's (`platform`, `system`) hands work out.
 */
export function assertPersonTenant(
  stamped: unknown,
  owner?: string | null,
): string {
  if (!isPersonTenant(stamped))
    throw new TenantContextError("untrusted tenant");
  if (owner != null && owner !== stamped)
    throw new TenantContextError("owner/tenant mismatch");
  const frame = store.getStore();
  if (frame && frame !== "platform" && frame !== "system" && frame !== stamped)
    throw new TenantContextError("cross-tenant");
  return stamped;
}

/**
 * Run one claimed queue item as the tenant stamped on its row, or not at all.
 *
 * `owner` is whoever the item's payload says it is for. It is required, and may only agree with the
 * stamp: a payload with no owner names nobody to act as. A row stamped as nobody's (`system`,
 * `platform`, `team`, empty), a payload naming somebody else, or a caller already acting for another person
 * comes back `{ ran: false }` without `work` being called, and the caller ends the item from the
 * queue's own frame. Everything `work` does — success, failure, audit, notify, cleanup — runs in the
 * stamped tenant.
 */
export async function runAsClaimedTenant<T>(
  item: { tenantId?: unknown },
  owner: unknown,
  work: (tenant: string) => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false; reason: string }> {
  let tenant: string;
  try {
    if (typeof owner !== "string" || owner === "")
      throw new TenantContextError("no owner");
    tenant = assertPersonTenant(item.tenantId, owner);
  } catch (error) {
    if (error instanceof TenantContextError)
      return { ran: false, reason: error.message };
    throw error;
  }
  return { ran: true, value: await runAsTenant(tenant, () => work(tenant)) };
}

export function runAsTenant<T>(tenantId: string, fn: () => T): T {
  // Checked before the frame opens, so `fn` never runs as the shared tenant.
  if (tenantId === TEAM_TENANT)
    throw new TenantContextError("'team' is a stamp, never a frame");
  const result = store.run(tenantId, fn);
  /*
   * drizzle builders are lazy and often awaited after the scope closes. Rather than replacing
   * the builder with a promise -- which would strip the fluent methods callers chain next --
   * wrap its own `then` so the tenant is re-entered at the moment the query actually runs.
   */
  if (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    const thenable = result as unknown as {
      then: (
        onF?: (v: unknown) => unknown,
        onR?: (e: unknown) => unknown,
      ) => unknown;
    };
    const original = thenable.then.bind(thenable);
    // Re-pointing the call at the tenant frame is what makes `await db...` carry the scope, and a
    // `then` property is exactly how a promise-shaped object is intercepted. The name is the API.
    // biome-ignore lint/suspicious/noThenProperty: promise plumbing, not a promise by mistake
    thenable.then = (onF, onR) => store.run(tenantId, () => original(onF, onR));
  }
  return result;
}

/**
 * Run one question that belongs to nobody -- across every tenant, or about a deployment row -- as
 * `platform`. For background, boot and admin code only; a member request path never opens it.
 */
export const asPlatform = <T>(work: () => T): T =>
  runAsTenant(PLATFORM_TENANT, work);

/**
 * THE ADMIN CAPABILITY (G01-E, I10). Being an administrator is a fact about a person; acting with
 * the administrator's write powers over shared governance rows is a fact about one REQUEST. An
 * admin's routines, proactive work and Bot turns run in the admin's frame too, and they must not
 * carry those powers, so the capability is held apart from the frame: only the `adminCapability`
 * middleware in `auth/admin-scope.ts` grants it, after re-reading the role, and the database client
 * hands it to Postgres as `app.capability` on every statement.
 *
 * It names the tenant it was granted for. A statement whose tenant is anything else — a nested
 * `runAsTenant(other)`, an `asPlatform` lookup — sees no capability, so it never travels with a
 * frame change.
 */
type Capability = { tenant: string; capability: "admin" };
const capabilityStore = new AsyncLocalStorage<Capability>();

/** `"admin"` only when the capability was granted for exactly this tenant; otherwise `""`. */
export function capabilityFor(tenant: string): "admin" | "" {
  const held = capabilityStore.getStore();
  return held !== undefined && held.tenant === tenant ? held.capability : "";
}

/**
 * Run `work` holding the admin capability for `tenant`. INTERNAL: only `auth/admin-scope.ts` may
 * call it, after it has re-verified the role; the G01-E allowlist pins that.
 */
export function withCapability<T>(tenant: string, work: () => T): T {
  if (!isPersonTenant(tenant))
    throw new TenantContextError("the admin capability belongs to a person");
  return capabilityStore.run({ tenant, capability: "admin" }, work);
}

/**
 * The capability as it stands for `tenant` right now, captured so it can be carried somewhere Bun
 * does not carry AsyncLocalStorage: a transaction callback, or a statement whose `then` Bun calls
 * outside the caller's context (see `db/client.ts`). INTERNAL to the database client.
 *
 * It can only reproduce what is held at the moment of capture — `run` re-enters exactly that grant,
 * or no grant at all — so it is a way to keep the capability, never a way to obtain one.
 */
export type CapturedCapability = {
  readonly capability: "admin" | "";
  run<T>(work: () => T): T;
};

export function captureCapability(tenant: string): CapturedCapability {
  const held = capabilityStore.getStore();
  const granted =
    held !== undefined && held.tenant === tenant ? held : undefined;
  return {
    capability: granted === undefined ? "" : granted.capability,
    run: (work) =>
      granted === undefined
        ? capabilityStore.exit(work)
        : capabilityStore.run(granted, work),
  };
}

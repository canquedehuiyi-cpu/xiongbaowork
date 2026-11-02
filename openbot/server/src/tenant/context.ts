import { AsyncLocalStorage } from "node:async_hooks";

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
 */
const store = new AsyncLocalStorage<string>();

export function currentTenant(): string {
  return store.getStore() ?? "system";
}

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

export function isTenantFramed(): boolean {
  return store.getStore() !== undefined;
}

/** The tenant of the frame this runs in. Outside a frame it is an error, never `system`. */
export function requireTenant(): string {
  const tenant = store.getStore();
  if (!tenant) throw new TenantContextError("no tenant frame");
  return tenant;
}

/** A tenant that is a person's own: not empty, and not one of the two that belong to nobody. */
export function isPersonTenant(tenant: unknown): tenant is string {
  return (
    typeof tenant === "string" &&
    tenant !== "" &&
    tenant !== "system" &&
    tenant !== "platform"
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
 * `platform`, empty), a payload naming somebody else, or a caller already acting for another person
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

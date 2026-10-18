import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which tenant the current operation belongs to.
 *
 * AsyncLocalStorage rather than a parameter because the database client is reached from a hundred
 * call sites, and a tenant argument threaded through all of them is a hundred places someone forgets
 * to pass it. The client reads this at query time; a query with no context runs as `system` and sees
 * only platform rows, which is the fail-closed side of the deal: forgetting the context loses data
 * loudly rather than leaking it quietly.
 */
const store = new AsyncLocalStorage<string>();

export function currentTenant(): string {
  return store.getStore() ?? "system";
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

import { expect } from "bun:test";
import { TenantContextError } from "../../src/tenant/context";

/**
 * Run `work` with `OPENBOT_TENANT_FRAME_GUARD=throw`, then put the guard back exactly as it was.
 *
 * G01-E: a statement issued outside every tenant frame no longer means "as `system`". Under `throw`
 * it is a `TenantContextError`, which is what G01-D makes the only behaviour. A test that used the
 * unframed statement as an isolation probe asks it here, so the refusal is asserted whichever guard
 * the file itself runs under, and asks the same question again in an explicit frame.
 */
export async function underThrowGuard<T>(
  work: () => Promise<T> | T,
): Promise<T> {
  const saved = process.env.OPENBOT_TENANT_FRAME_GUARD;
  process.env.OPENBOT_TENANT_FRAME_GUARD = "throw";
  try {
    return await work();
  } finally {
    if (saved === undefined) delete process.env.OPENBOT_TENANT_FRAME_GUARD;
    else process.env.OPENBOT_TENANT_FRAME_GUARD = saved;
  }
}

/**
 * `work`, run outside every frame under the `throw` guard, is refused with a `TenantContextError`.
 *
 * The database client reads the frame while the statement is BUILT, so the refusal can be
 * synchronous; `work` is called inside the promise so either shape lands in `rejects`.
 */
export async function expectUnframedRefused(
  work: () => unknown,
): Promise<void> {
  await underThrowGuard(() =>
    expect(Promise.resolve().then(async () => await work())).rejects.toThrow(
      TenantContextError,
    ),
  );
}

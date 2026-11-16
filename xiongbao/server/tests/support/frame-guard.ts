import { expect } from "bun:test";
import { TenantContextError } from "../../src/tenant/context";

/**
 * The refusal `currentTenant()` makes outside every frame, word for word.
 *
 * Pinned literally, because "some `TenantContextError`" is not the question. The same class is
 * thrown for a dozen other refusals — `runAsTenant("team")` ("'team' is a stamp, never a frame"),
 * an owner/stamp mismatch, a cross-tenant resolve — and a probe that accepted any of them would pass
 * for work that was framed after all and refused for some other reason. If the wording in
 * `src/tenant/context.ts` changes, this is meant to fail until it is changed here too.
 */
export const UNFRAMED_REFUSAL = "no tenant frame";

/**
 * `work`, run outside every frame, is refused for having no frame.
 *
 * Exactly that refusal: a `TenantContextError` carrying `UNFRAMED_REFUSAL`. Work that runs and
 * resolves (it was framed after all) fails this, and so does work refused for any other reason.
 *
 * The database client reads the frame while the statement is BUILT, so the refusal can be
 * synchronous; `work` is called inside the promise so either shape lands in the same catch.
 */
export async function expectUnframedRefused(
  work: () => unknown,
): Promise<void> {
  const outcome = await Promise.resolve()
    .then(async () => await work())
    .then(
      (value) => ({ refused: false as const, value }),
      (error: unknown) => ({ refused: true as const, error }),
    );
  if (!outcome.refused)
    throw new Error(
      `expected the unframed work to be refused with "${UNFRAMED_REFUSAL}", but it resolved`,
    );
  expect(outcome.error).toBeInstanceOf(TenantContextError);
  expect((outcome.error as Error).message).toBe(UNFRAMED_REFUSAL);
}

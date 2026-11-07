import { afterEach, beforeEach, expect, test } from "bun:test";
import { autonomousOverviewQueryOptions } from "@/lib/autonomous/queries";

/*
 * The overview read now backs /autonomous's default view (parity plan F3), so the sentence it
 * falls back on when the server sends no reason is something a person reads. It has to be Chinese.
 */

const HAN = /\p{Script=Han}/u;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => new Response(null, { status: 503 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a failed overview read explains itself in Chinese", async () => {
  const { queryFn } = autonomousOverviewQueryOptions(true);
  if (typeof queryFn !== "function") throw new Error("no queryFn");
  const error = await (queryFn as (context: never) => Promise<unknown>)(
    {} as never,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(HAN);
});

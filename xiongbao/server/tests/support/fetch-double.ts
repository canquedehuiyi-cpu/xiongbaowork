// server/tests/support/fetch-double.ts
//
// A stand-in for `fetch` that satisfies the type as well as the call.
//
// WHY THIS EXISTS. Bun's `typeof fetch` is not a bare call signature: it carries `preconnect`.
// A test that hands a plain `async () => new Response(…)` to something typed `typeof fetch` is
// therefore a type error, even though nothing in the product ever calls `preconnect` on an injected
// fetch — `server/src/copilot.ts` says as much where it casts, and ten test files already spell the
// same workaround as `Object.assign(fn, { preconnect: fetch.preconnect })`.
//
// Two things were wrong with leaving it to each site. The workaround is four lines of noise around
// every stub, so sites that hit the error got a cast (`as unknown as typeof fetch`, which asserts
// something untrue) rather than the property. And where the property was supplied, nothing said
// why, so the next person read it as cargo cult.
//
// This does what the `Object.assign` sites do, once: the handler supplies the behaviour, and
// `preconnect` is borrowed from the real `fetch` — the function that would open the connection is
// the platform's, and a double that never opens one has nothing better to offer.
//
// NOT a general-purpose fetch mock. It deliberately keeps the real signature, so a test still has
// to answer with a `Response` and still has to accept whatever the caller passes; it only removes
// the type-level accident. Recording, routing and assertion stay in the test that needs them.

type FetchArgs = Parameters<typeof fetch>;

/** What a double has to answer. Sync or async, because most stubs are a one-line `Response`. */
export type FetchHandler = (...args: FetchArgs) => Response | Promise<Response>;

/**
 * The handler, wearing `fetch`'s type.
 *
 * The parameters are narrowed to `FetchArgs` rather than rest-typed as `any[]` on purpose: a stub
 * that reads `init.headers` is then checked, which is the class of mistake this suite's type check
 * exists to catch.
 */
export const fetchDouble = (handler: FetchHandler): typeof fetch =>
  Object.assign(
    (...args: FetchArgs): Promise<Response> =>
      Promise.resolve(handler(...args)),
    { preconnect: fetch.preconnect },
  );

/**
 * A value a stub or a transaction body fills in later, read from the assertion without TypeScript
 * hiding it.
 *
 * `let seen: T | null = null` does not work for this. Every assignment happens inside a callback — a
 * tool stub, a `begin` body — and TypeScript narrows `seen` to `null` from its initializer, then does
 * not reconsider once the callback runs. Reading it afterwards is reading `null`: a comparison against
 * the real value fails to type-check ("Argument of type '...' is not assignable to parameter of type
 * 'null'"), and a matcher built around the narrowed value compares against `null` without a word.
 *
 * A function body is not narrowed that way, so `get()` answers `T | undefined` — absent when the
 * callback never ran, which a test should hear rather than silently compare.
 */
export function filledLater<T>() {
  let held: T | undefined;
  return {
    /** Called from the stub: the value this run produced. */
    set: (value: T): void => {
      held = value;
    },
    /** Called from the assertion: what the stub left, or `undefined` if it never ran. */
    get: (): T | undefined => held,
  };
}

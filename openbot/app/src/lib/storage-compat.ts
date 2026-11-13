/*
 * Browser storage keys renamed to `xiongbao`, with the name before the rename still read for one
 * release window (N and N+1; N+2 deletes the legacy reads).
 *
 * COPY, NEVER MOVE. A value found only under the legacy key is copied to the new key and left where
 * it was, so a tab that has not reloaded since the upgrade, or a rollback to the previous release,
 * still finds it. Writes go to the new key only; clearing clears both, or the legacy copy would be
 * read back the next time.
 *
 * Storage throws in some privacy modes and for a page that may not use it, so every access is
 * guarded: a refusal reads as "nothing stored" and a failed write is dropped.
 */

export type CompatStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

function local(storage?: CompatStorage): CompatStorage {
  return storage ?? window.localStorage;
}

/** Read the new key; failing that the legacy key, copying its value to the new key without deleting it. A throwing storage reads as nothing. */
export function readCompat(
  key: string,
  legacyKey: string,
  storage?: CompatStorage,
): string | null {
  try {
    const store = local(storage);
    const current = store.getItem(key);
    if (current !== null) return current;
    const legacy = store.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      store.setItem(key, legacy);
    } catch {}
    return legacy;
  } catch {
    return null;
  }
}

/**
 * Like `readCompat`, for a value that a tab still on the previous release may write again after it
 * was copied: when both keys hold one, `choose` says which stands (it may also merge the two), and
 * a result that differs from the new key is written back to it. The legacy key is left as it is.
 */
export function reconcileCompat(
  key: string,
  legacyKey: string,
  choose: (current: string, legacy: string) => string,
  storage?: CompatStorage,
): string | null {
  try {
    const store = local(storage);
    const current = store.getItem(key);
    const legacy = store.getItem(legacyKey);
    if (legacy === null) return current;
    const chosen = current === null ? legacy : choose(current, legacy);
    if (chosen !== current) {
      try {
        store.setItem(key, chosen);
      } catch {}
    }
    return chosen;
  } catch {
    return null;
  }
}

/** Write the new key only. */
export function writeCompat(
  key: string,
  value: string,
  storage?: CompatStorage,
): void {
  try {
    local(storage).setItem(key, value);
  } catch {}
}

/** Remove the new key and the legacy key: something the person cleared must not come back from the old name. */
export function removeCompat(
  key: string,
  legacyKey: string,
  storage?: CompatStorage,
): void {
  try {
    const store = local(storage);
    store.removeItem(key);
    store.removeItem(legacyKey);
  } catch {}
}

/** Every suffix stored under `prefix` or `legacyPrefix`, each once. */
export function compatSuffixes(
  prefix: string,
  legacyPrefix: string,
  storage?: CompatStorage,
): string[] {
  try {
    const store = local(storage);
    const names: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const name = store.key(index);
      if (name !== null) names.push(name);
    }
    const suffixes = new Set<string>();
    for (const name of names) {
      if (name.startsWith(prefix)) suffixes.add(name.slice(prefix.length));
      else if (name.startsWith(legacyPrefix))
        suffixes.add(name.slice(legacyPrefix.length));
    }
    return [...suffixes];
  } catch {
    return [];
  }
}

/*
 * Browser storage keys renamed to `xiongbao`.
 *
 * THE WINDOW HAS CLOSED. While it was open the name before the rename was still read for two releases, and a
 * value found only there was copied to the new key and left where it was (COPY, NEVER MOVE), so a tab that had
 * not reloaded, or a rollback, still found it. Two releases have since shipped, so only the new name is read,
 * written and cleared; a value that still sits under the old name is dead data, and nothing looks it up.
 *
 * Storage itself is still unreliable: it throws in some privacy modes and for a page that may not use it, so
 * every access here stays guarded — a refusal reads as "nothing stored", a failed write is dropped.
 */

export type CompatStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

function local(storage?: CompatStorage): CompatStorage {
  return storage ?? window.localStorage;
}

/** Read the key. A storage that refuses reads as nothing stored. */
export function readCompat(
  key: string,
  storage?: CompatStorage,
): string | null {
  try {
    return local(storage).getItem(key);
  } catch {
    return null;
  }
}

/** Write the key. A storage that refuses drops the write. */
export function writeCompat(
  key: string,
  value: string,
  storage?: CompatStorage,
): void {
  try {
    local(storage).setItem(key, value);
  } catch {}
}

/** Remove the key: something the person cleared must not be read back. */
export function removeCompat(key: string, storage?: CompatStorage): void {
  try {
    local(storage).removeItem(key);
  } catch {}
}

/** Every suffix stored under `prefix`, each once. */
export function compatSuffixes(
  prefix: string,
  storage?: CompatStorage,
): string[] {
  try {
    const store = local(storage);
    const suffixes = new Set<string>();
    for (let index = 0; index < store.length; index++) {
      const name = store.key(index);
      if (name !== null && name.startsWith(prefix))
        suffixes.add(name.slice(prefix.length));
    }
    return [...suffixes];
  } catch {
    return [];
  }
}

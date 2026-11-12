type ReadableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Reads `key`, moving a value left under the pre-rename `legacyKey` across first, so a preference
 * set before the rename survives it. The new key wins when both exist. Storage throws in some
 * privacy modes, so every access is guarded: a refusal reads as "nothing stored", and a failed write
 * keeps the legacy key so the move can be retried on the next read.
 */
export function readMigrated(
  key: string,
  legacyKey: string,
  storage?: ReadableStorage,
): string | null {
  try {
    const store = storage ?? window.localStorage;
    const current = store.getItem(key);
    if (current !== null) return current;
    const legacy = store.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      store.setItem(key, legacy);
      store.removeItem(legacyKey);
    } catch {}
    return legacy;
  } catch {
    return null;
  }
}

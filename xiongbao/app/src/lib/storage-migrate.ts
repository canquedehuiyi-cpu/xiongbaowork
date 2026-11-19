type ReadableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Reads `key`; a refusal by storage (some privacy modes throw) reads as "nothing stored". */
export function readStored(
  key: string,
  storage?: ReadableStorage,
): string | null {
  try {
    return (storage ?? window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

/**
 * Reads `key`, copying a value left under the pre-rename `legacyKey` across first, so a preference
 * set before the rename survives it. The legacy key is left in place, so an older build sharing this
 * storage still finds its value. The new key wins when both exist. Storage throws in some privacy
 * modes, so every access is guarded: a refusal reads as "nothing stored", and a failed write
 * leaves only the legacy key so the copy can be retried on the next read.
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
    } catch {}
    return legacy;
  } catch {
    return null;
  }
}

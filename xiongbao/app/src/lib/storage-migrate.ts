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

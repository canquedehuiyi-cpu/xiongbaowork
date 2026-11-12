import { expect, test } from "bun:test";
import { readMigrated } from "../src/lib/storage-migrate";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

test("only the legacy key present: the value is read, the new key written, the legacy key removed", () => {
  const storage = memory({ "openbot-theme": "dark" });
  expect(readMigrated("xiongbao-theme", "openbot-theme", storage)).toBe("dark");
  expect([...storage.data]).toEqual([["xiongbao-theme", "dark"]]);
});

test("both keys present: the new one wins and the legacy one is left alone", () => {
  const storage = memory({
    "xiongbao-theme": "light",
    "openbot-theme": "dark",
  });
  expect(readMigrated("xiongbao-theme", "openbot-theme", storage)).toBe(
    "light",
  );
  expect(storage.data.get("openbot-theme")).toBe("dark");
});

test("neither key present reads null and writes nothing", () => {
  const storage = memory();
  expect(readMigrated("xiongbao-theme", "openbot-theme", storage)).toBeNull();
  expect(storage.data.size).toBe(0);
});

test("storage that throws never crashes the read", () => {
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(readMigrated("xiongbao-theme", "openbot-theme", refusing)).toBeNull();
});

test("a failed write still returns the legacy value and keeps the legacy key", () => {
  const storage = memory({ "openbot-theme": "dark" });
  storage.setItem = () => {
    throw new Error("quota");
  };
  expect(readMigrated("xiongbao-theme", "openbot-theme", storage)).toBe("dark");
  expect(storage.data.get("openbot-theme")).toBe("dark");
});

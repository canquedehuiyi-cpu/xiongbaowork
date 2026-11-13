import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type CompatStorage,
  compatSuffixes,
  readCompat,
  removeCompat,
  writeCompat,
} from "../src/lib/storage-compat";

/**
 * Browser storage keys renamed from the upstream name to `xiongbao`, with the old name still read
 * for a release window. Reading copies the old value across and leaves it in place, so a tab that
 * has not reloaded since the upgrade, or a rollback to the release before, still finds it.
 */

class FakeStorage implements CompatStorage {
  data = new Map<string, string>();
  writes: [string, string][] = [];
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes.push([key, value]);
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

class ThrowingStorage implements CompatStorage {
  get length(): number {
    throw new Error("refused");
  }
  key(): string | null {
    throw new Error("refused");
  }
  getItem(): string | null {
    throw new Error("refused");
  }
  setItem(): void {
    throw new Error("refused");
  }
  removeItem(): void {
    throw new Error("refused");
  }
}

test("only the legacy key: read, copied to the new key, legacy kept", () => {
  const storage = new FakeStorage();
  storage.setItem("openbot.bot-thread.a", "t-1");
  expect(
    readCompat("xiongbao.bot-thread.a", "openbot.bot-thread.a", storage),
  ).toBe("t-1");
  expect([...storage.data]).toEqual([
    ["openbot.bot-thread.a", "t-1"],
    ["xiongbao.bot-thread.a", "t-1"],
  ]);
});

test("both keys: the new one wins, nothing is written", () => {
  const storage = new FakeStorage();
  storage.data.set("openbot.bot-thread.a", "old");
  storage.data.set("xiongbao.bot-thread.a", "new");
  expect(
    readCompat("xiongbao.bot-thread.a", "openbot.bot-thread.a", storage),
  ).toBe("new");
  expect(storage.writes).toEqual([]);
  expect(readCompat("xiongbao.none", "openbot.none", storage)).toBeNull();
  expect(storage.writes).toEqual([]);
});

test("writeCompat writes only the new key", () => {
  const storage = new FakeStorage();
  writeCompat("xiongbao.teach-a-bot.introduced", "1", storage);
  expect([...storage.data]).toEqual([["xiongbao.teach-a-bot.introduced", "1"]]);
});

test("removeCompat clears both", () => {
  const storage = new FakeStorage();
  storage.data.set("openbot.reachability.pendingSms", "c-1");
  storage.data.set("xiongbao.reachability.pendingSms", "c-1");
  storage.data.set("unrelated", "x");
  removeCompat(
    "xiongbao.reachability.pendingSms",
    "openbot.reachability.pendingSms",
    storage,
  );
  expect([...storage.data]).toEqual([["unrelated", "x"]]);
});

test("compatSuffixes lists both prefixes without duplicates", () => {
  const storage = new FakeStorage();
  storage.data.set("xiongbao:voice-outbox:alice:c:1", "{}");
  storage.data.set("openbot:voice-outbox:alice:c:1", "{}");
  storage.data.set("openbot:voice-outbox:alice:c:2", "{}");
  storage.data.set("xiongbao:voice-outbox:bob:c:3", "{}");
  storage.data.set("xiongbao:carried-on:x", "1");
  expect(
    compatSuffixes(
      "xiongbao:voice-outbox:",
      "openbot:voice-outbox:",
      storage,
    ).sort(),
  ).toEqual(["alice:c:1", "alice:c:2", "bob:c:3"]);
});

test("a throwing storage reads null and never throws", () => {
  const storage = new ThrowingStorage();
  expect(readCompat("xiongbao.a", "openbot.a", storage)).toBeNull();
  expect(() => writeCompat("xiongbao.a", "1", storage)).not.toThrow();
  expect(() => removeCompat("xiongbao.a", "openbot.a", storage)).not.toThrow();
  expect(compatSuffixes("xiongbao:", "openbot:", storage)).toEqual([]);
});

/*
 * The Activity pane's wipes, as a page that has not reloaded since the upgrade still writes them:
 * under the old prefix. Each "page" is the real module, loaded fresh, sharing one `localStorage`.
 */

type ActivityModule = typeof import("../src/lib/computers/activity");
let pages = 0;
async function openPage(): Promise<ActivityModule> {
  pages += 1;
  return (await import(
    `../src/lib/computers/activity.ts?compat-page=${pages}`
  )) as ActivityModule;
}
const BOT = "compat-bot";
const NEW_KEY = `xiongbao:computer-activity-wiped:${BOT}`;
const OLD_KEY = `openbot:computer-activity-wiped:${BOT}`;
const calls = (...ids: string[]) =>
  ids.map((id) => ({
    id,
    did: {
      kind: "command" as const,
      subject: id,
      output: `${id}\n`,
      exitCode: 0,
    },
  }));
const wipe = (at: number, before: string[]) =>
  JSON.stringify({ at, before, after: [] });
/** What an old tab does when it wipes: write the old key, which tells every other page. */
function oldTabWipes(value: string) {
  window.localStorage.setItem(OLD_KEY, value);
  window.dispatchEvent(
    new StorageEvent("storage", { key: OLD_KEY, newValue: value }),
  );
}
const atOf = (key: string) =>
  (JSON.parse(window.localStorage.getItem(key) ?? "{}") as { at?: number }).at;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});
afterEach(() => {
  window.localStorage.clear();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

test("activity wipes under the old prefix are still honoured", async () => {
  const open = await openPage();
  open.recordActivity(BOT, calls("c-1", "c-2"));
  expect(open.activityFor(BOT)).toHaveLength(2);

  oldTabWipes(wipe(Date.now(), ["c-1", "c-2"]));
  expect(open.activityFor(BOT)).toEqual([]);

  // A page opened afterwards reads it too, and the new key now holds it.
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
  expect(window.localStorage.getItem(NEW_KEY)).not.toBeNull();
  expect(window.localStorage.getItem(OLD_KEY)).not.toBeNull();
});

test("an old tab wiping again after the copy: the later wipe survives a reload", async () => {
  // The first wipe, already carried across to the new key.
  window.localStorage.setItem(NEW_KEY, wipe(1000, ["c-1"]));
  window.localStorage.setItem(OLD_KEY, wipe(1000, ["c-1"]));
  const open = await openPage();
  open.recordActivity(BOT, calls("c-1", "c-2"));
  expect(open.activityFor(BOT).map((entry) => entry.id)).toEqual(["c-2"]);

  // A tab still on the old build wipes again: only the old key changes.
  oldTabWipes(wipe(2000, ["c-1", "c-2"]));
  expect(open.activityFor(BOT)).toEqual([]);
  // The listener kept the later wipe under the new key, not only in this page's memory.
  expect(atOf(NEW_KEY)).toBe(2000);

  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
});

test("a later wipe under the old key wins on load even when no page heard it", async () => {
  window.localStorage.setItem(NEW_KEY, wipe(1000, ["c-1"]));
  window.localStorage.setItem(OLD_KEY, wipe(2000, ["c-1", "c-2"]));
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
  expect(atOf(NEW_KEY)).toBe(2000);
});

test("an older wipe under the old key does not undo the new one", async () => {
  window.localStorage.setItem(NEW_KEY, wipe(2000, ["c-1", "c-2"]));
  window.localStorage.setItem(OLD_KEY, wipe(1000, ["c-1"]));
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
  expect(atOf(NEW_KEY)).toBe(2000);
});

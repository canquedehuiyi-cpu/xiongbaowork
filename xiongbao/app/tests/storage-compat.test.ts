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
 * Browser storage keys renamed from the upstream name to `xiongbao`. The window in which the old name was
 * still read has closed: what is read, written and cleared is the new key alone, and a value a page two
 * releases behind left under the old name is dead data. So the cases below say both halves — what the helper
 * does with its own key, and what a value under the old name no longer gets out of it. Storage itself stays
 * unreliable (some privacy modes throw, a page that may not use it throws), and every access keeps that
 * guard: a refusal reads as nothing stored, a failed write is dropped.
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

test("a value under the old name is not read, and nothing is copied from it", () => {
  const storage = new FakeStorage();
  storage.data.set("openbot.bot-thread.a", "t-1");
  expect(readCompat("xiongbao.bot-thread.a", storage)).toBeNull();
  // Not read, not carried across: the store holds only what it held, and nothing was written.
  expect([...storage.data]).toEqual([["openbot.bot-thread.a", "t-1"]]);
  expect(storage.writes).toEqual([]);
});

test("readCompat reads its key and writeCompat writes it alone", () => {
  const storage = new FakeStorage();
  expect(readCompat("xiongbao.none", storage)).toBeNull();
  writeCompat("xiongbao.teach-a-bot.introduced", "1", storage);
  expect(readCompat("xiongbao.teach-a-bot.introduced", storage)).toBe("1");
  expect([...storage.data]).toEqual([["xiongbao.teach-a-bot.introduced", "1"]]);
  expect(storage.writes).toEqual([["xiongbao.teach-a-bot.introduced", "1"]]);
});

test("removeCompat clears the new key and leaves the old name's alone", () => {
  const storage = new FakeStorage();
  storage.data.set("openbot.reachability.pendingSms", "c-1");
  storage.data.set("xiongbao.reachability.pendingSms", "c-1");
  storage.data.set("unrelated", "x");
  removeCompat("xiongbao.reachability.pendingSms", storage);
  // What the person cleared is gone from the key this version reads; the other is nobody's to clear.
  expect([...storage.data]).toEqual([
    ["openbot.reachability.pendingSms", "c-1"],
    ["unrelated", "x"],
  ]);
});

test("compatSuffixes lists the suffixes of one prefix, each once", () => {
  const storage = new FakeStorage();
  storage.data.set("xiongbao:voice-outbox:alice:c:1", "{}");
  storage.data.set("openbot:voice-outbox:alice:c:1", "{}");
  storage.data.set("openbot:voice-outbox:alice:c:2", "{}");
  storage.data.set("xiongbao:voice-outbox:bob:c:3", "{}");
  storage.data.set("xiongbao:carried-on:x", "1");
  expect(compatSuffixes("xiongbao:voice-outbox:", storage).sort()).toEqual([
    "alice:c:1",
    "bob:c:3",
  ]);
});

test("a throwing storage reads null and never throws", () => {
  const storage = new ThrowingStorage();
  expect(readCompat("xiongbao.a", storage)).toBeNull();
  expect(() => writeCompat("xiongbao.a", "1", storage)).not.toThrow();
  expect(() => removeCompat("xiongbao.a", storage)).not.toThrow();
  expect(compatSuffixes("xiongbao:", storage)).toEqual([]);
});

/*
 * The Activity pane's wipes, which one tab stores and every other tab has to honour. Each "page" is the real
 * module, loaded fresh, sharing one `localStorage`. Since the window closed the pane reads one key, so these
 * are the two halves of that: a page on an older release writing under the old prefix changes nothing here,
 * and a wipe under this prefix empties the pane and survives a reload.
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
/** What a page does when it wipes: write the key, which tells every other page. */
function tabWipes(key: string, value: string) {
  window.localStorage.setItem(key, value);
  window.dispatchEvent(
    new StorageEvent("storage", { key, newValue: value }),
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

test("a wipe written under the old prefix changes nothing", async () => {
  const open = await openPage();
  open.recordActivity(BOT, calls("c-1", "c-2"));
  expect(open.activityFor(BOT)).toHaveLength(2);

  tabWipes(OLD_KEY, wipe(Date.now(), ["c-1", "c-2"]));
  // The pane still shows both: the old prefix is no longer the key anybody reads or writes.
  expect(open.activityFor(BOT)).toHaveLength(2);
  expect(window.localStorage.getItem(NEW_KEY)).toBeNull();

  // And a page opened afterwards reads its own key, finds none, and keeps what it has.
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toHaveLength(2);
  expect(window.localStorage.getItem(OLD_KEY)).not.toBeNull();
});

test("a wipe under this prefix empties the pane and survives a reload", async () => {
  const open = await openPage();
  open.recordActivity(BOT, calls("c-1", "c-2"));
  expect(open.activityFor(BOT)).toHaveLength(2);

  tabWipes(NEW_KEY, wipe(1000, ["c-1", "c-2"]));
  expect(open.activityFor(BOT)).toEqual([]);

  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
  expect(atOf(NEW_KEY)).toBe(1000);
});

test("the later of two wipes is the one a reload honours", async () => {
  // The first wipe, already stored when this page reads the conversation.
  window.localStorage.setItem(NEW_KEY, wipe(1000, ["c-1"]));
  const open = await openPage();
  open.recordActivity(BOT, calls("c-1", "c-2"));
  expect(open.activityFor(BOT).map((entry) => entry.id)).toEqual(["c-2"]);

  // Another tab wipes again, later: the pane gives up the rest, and the key holds that wipe.
  tabWipes(NEW_KEY, wipe(2000, ["c-1", "c-2"]));
  expect(open.activityFor(BOT)).toEqual([]);
  expect(atOf(NEW_KEY)).toBe(2000);

  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
});

test("a wipe nothing heard is still read on load", async () => {
  window.localStorage.setItem(NEW_KEY, wipe(2000, ["c-1", "c-2"]));
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
  expect(atOf(NEW_KEY)).toBe(2000);
});

test("a value under the old prefix does not undo a wipe under this one", async () => {
  window.localStorage.setItem(NEW_KEY, wipe(2000, ["c-1", "c-2"]));
  window.localStorage.setItem(OLD_KEY, wipe(1000, ["c-1"]));
  const reloaded = await openPage();
  reloaded.recordActivity(BOT, calls("c-1", "c-2"));
  expect(reloaded.activityFor(BOT)).toEqual([]);
  expect(atOf(NEW_KEY)).toBe(2000);
});

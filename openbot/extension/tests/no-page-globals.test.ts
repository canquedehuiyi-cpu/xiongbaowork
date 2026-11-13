import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { build, type InlineConfig } from "vite";
import { viteConfigs } from "../scripts/build";

/**
 * The two scripts that run inside a recorded page (spec R7, check 1): page-network.js runs in the page's own MAIN world,
 * so any name it leaves on `window` shows in the page's console; content.js runs in the extension's isolated world of the
 * same page. Both are built for real (the release variant, into a scratch folder, not extension/dist) and run on a fresh
 * window.
 */

const ROOT = path.resolve(import.meta.dir, "..", "..");
const BRANDED = /openbot|xiongbao|recorder/i;

/**
 * The flag content.js sets so a second injection does nothing. content-port.test.ts expects it under this name, so it
 * keeps it until plan appendix A row 36 is approved; then this list becomes empty.
 */
const PENDING_ROW_36 = ["__openbotRecorderContent"];

let out: string;
beforeAll(() => {
  out = mkdtempSync(path.join(tmpdir(), "recorder-page-globals-"));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** One of the two IIFE builds from viteConfigs, written to `outDir`, optionally from another entry. */
function scriptBuild(
  index: 1 | 2,
  outDir: string,
  entry?: string,
): InlineConfig {
  const config = viteConfigs({ variant: "release", root: ROOT })[index];
  const lib = config.build?.lib;
  if (!lib) throw new Error("not a library build");
  return {
    ...config,
    logLevel: "silent",
    build: {
      ...config.build,
      outDir,
      lib: entry ? { ...lib, entry } : lib,
    },
  };
}

/** A page's window with the little of `chrome` each script reaches for as it loads. */
function freshWindow(): Window {
  const window = new Window({ url: "https://shop.example.test/cart" });
  const listeners = () => ({ addListener() {}, removeListener() {} });
  Object.assign(window, {
    chrome: {
      runtime: {
        id: "extension-id",
        sendMessage: () => Promise.resolve(),
        connect: () => ({
          name: "content",
          onMessage: listeners(),
          onDisconnect: listeners(),
          postMessage() {},
          disconnect() {},
        }),
      },
    },
  });
  return window;
}

function branded(window: Window): string[] {
  return Object.keys(window).filter((k) => BRANDED.test(k));
}

function run(window: Window, code: string): void {
  (window as unknown as { eval(code: string): unknown }).eval(code);
}

test("a fresh window carries no such name before either script runs", async () => {
  const window = freshWindow();
  expect(branded(window)).toEqual([]);
  await window.happyDOM.close();
});

test("page-network.js leaves no name on the page's window, loaded or configured", async () => {
  await build(scriptBuild(2, out));
  const window = freshWindow();
  run(window, readFileSync(path.join(out, "page-network.js"), "utf8"));
  const registry = window as unknown as Record<symbol, unknown>;
  const configure = (registry[Symbol.for("xb.recorder.configure")] ??
    registry[Symbol.for("openbot.recorder.configure")]) as (id: string) => void;
  configure("extension-id");
  expect(branded(window)).toEqual([]);
  await window.happyDOM.close();
}, 60_000);

test("content.js leaves no name on its window but the flag appendix A row 36 holds back", async () => {
  await build(scriptBuild(1, out));
  const window = freshWindow();
  run(window, readFileSync(path.join(out, "content.js"), "utf8"));
  expect(branded(window)).toEqual(PENDING_ROW_36);
  await window.happyDOM.close();
}, 60_000);

test("an entry that exports something fails the build instead of naming a global", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recorder-export-"));
  try {
    const entry = path.join(dir, "entry.ts");
    writeFileSync(entry, 'export const leaked = 1;\nconsole.log("loaded");\n');
    let built: string | null = null;
    let failure = "";
    try {
      await build(scriptBuild(1, path.join(dir, "out"), entry));
      built = readFileSync(path.join(dir, "out", "content.js"), "utf8");
    } catch (error) {
      failure = String(error);
    }
    // Before the fix this built `var OpenBotRecorderContent=…`, which lands on the window of every page it runs in.
    if (built !== null) {
      const window = freshWindow();
      const before = new Set(Object.keys(window));
      run(window, built);
      const leaked = Object.keys(window).filter((k) => !before.has(k));
      await window.happyDOM.close();
      expect(leaked).toEqual([]);
    }
    expect(failure).toContain("exports");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

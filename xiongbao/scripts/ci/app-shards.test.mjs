import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverTests,
  listShard,
  readManifest,
  SHARD_COUNT,
  shardFiles,
} from "./app-shards.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), "xiongbao-app-shards-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "app/tests/support"), { recursive: true });
  mkdirSync(join(root, "app/src/lib"), { recursive: true });
  mkdirSync(join(root, "app/node_modules/pkg"), { recursive: true });
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  writeFileSync(join(root, "app/tests/a.test.tsx"), "");
  writeFileSync(join(root, "app/tests/support/b.test.ts"), "");
  writeFileSync(join(root, "app/src/lib/c.test.ts"), "");
  writeFileSync(join(root, "app/node_modules/pkg/d.test.ts"), "");
  writeFileSync(join(root, "app/tests/support/preload.ts"), "");
  writeFileSync(join(root, "scripts/ci/app-tests.list.txt"), manifest);
  return root;
}

test("six contiguous ranges include every file exactly once and stay balanced", () => {
  for (const length of [6, 7, 628, 629, 630]) {
    const files = Array.from({ length }, (_, i) => `tests/${i}.test.tsx`);
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) =>
      shardFiles(files, i + 1),
    );
    expect(shards.flat()).toEqual(files);
    const sizes = shards.map((shard) => shard.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(
      Array.from({ length: SHARD_COUNT }, (_, i) => shardFiles(files, i + 1)),
    ).toEqual(shards);
  }
});

test("invalid shard indices cannot select an accidental range", () => {
  for (const shard of [0, 7, 1.5, NaN]) {
    expect(() => shardFiles([], shard)).toThrow(/integer from 1 to 6/);
  }
});

test("the committed manifest matches the entire app suite", () => {
  const root = join(import.meta.dir, "../..");
  expect(readManifest(root)).toEqual(discoverTests(root));
});

test("discovery skips node_modules and keeps .tsx, nested and top-level files", () => {
  const root = fixture("");
  expect(discoverTests(root)).toEqual([
    "src/lib/c.test.ts",
    "tests/a.test.tsx",
    "tests/support/b.test.ts",
  ]);
});

test("a manifest accepts CRLF and includes nested test files", () => {
  const root = fixture(
    "src/lib/c.test.ts\r\ntests/a.test.tsx\r\ntests/support/b.test.ts\r\n",
  );
  expect(readManifest(root)).toEqual([
    "src/lib/c.test.ts",
    "tests/a.test.tsx",
    "tests/support/b.test.ts",
  ]);
});

test("new, deleted, duplicate, and reordered paths all require a manifest update", () => {
  for (const manifest of [
    "src/lib/c.test.ts\ntests/a.test.tsx\n",
    "src/lib/c.test.ts\ntests/a.test.tsx\ntests/missing.test.tsx\ntests/support/b.test.ts\n",
    "src/lib/c.test.ts\ntests/a.test.tsx\ntests/a.test.tsx\ntests/support/b.test.ts\n",
    "tests/a.test.tsx\nsrc/lib/c.test.ts\ntests/support/b.test.ts\n",
  ]) {
    expect(() => readManifest(fixture(manifest))).toThrow(/manifest is stale/);
  }
});

// The annotation is the only place a reader of the failing `app-test (n)` check is told which file
// to edit. It has to be written by the CLI rather than left to the thrown error, because Bun
// re-formats an uncaught error and the `::error` line stops being the first line of output.
test("a stale manifest fails the shard CLI and, on Actions, annotates the manifest", () => {
  const root = fixture("tests/a.test.tsx\n");
  const before = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = "true";
    const ci = listShard("1", root);
    expect(ci.code).toBe(1);
    expect(ci.lines[0]).toContain(
      "::error file=scripts/ci/app-tests.list.txt,line=1,title=",
    );
    expect(ci.lines[0]).toContain("bun run test:shards");
    expect(ci.lines[0]).toContain("3 found");

    process.env.GITHUB_ACTIONS = "";
    const local = listShard("1", root);
    expect(local.code).toBe(1);
    expect(local.lines.join("\n")).not.toContain("::error");
    expect(local.lines.join("\n")).toContain("manifest is stale");
  } finally {
    if (before === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = before;
  }
});

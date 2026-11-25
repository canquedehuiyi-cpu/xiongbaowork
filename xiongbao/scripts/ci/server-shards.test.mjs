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
} from "./server-shards.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), "xiongbao-shards-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "server/tests/support"), { recursive: true });
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  writeFileSync(join(root, "server/tests/a.test.ts"), "");
  writeFileSync(join(root, "server/tests/support/b.test.ts"), "");
  writeFileSync(join(root, "server/tests/support/preload.ts"), "");
  writeFileSync(join(root, "scripts/ci/server-tests.list.txt"), manifest);
  return root;
}

test("six contiguous ranges include every file exactly once and stay balanced", () => {
  for (const length of [6, 7, 308, 309, 310]) {
    const files = Array.from({ length }, (_, i) => `tests/${i}.test.ts`);
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

test("the committed manifest matches the entire server suite", () => {
  const root = join(import.meta.dir, "../..");
  expect(readManifest(root)).toEqual(discoverTests(root));
});

test("a manifest accepts CRLF and includes nested test files", () => {
  const root = fixture("tests/a.test.ts\r\ntests/support/b.test.ts\r\n");
  expect(readManifest(root)).toEqual([
    "tests/a.test.ts",
    "tests/support/b.test.ts",
  ]);
});

test("new, deleted, duplicate, and reordered paths all require a manifest update", () => {
  for (const manifest of [
    "tests/a.test.ts\n",
    "tests/a.test.ts\ntests/support/b.test.ts\ntests/missing.test.ts\n",
    "tests/a.test.ts\ntests/a.test.ts\n",
    "tests/support/b.test.ts\ntests/a.test.ts\n",
  ]) {
    expect(() => readManifest(fixture(manifest))).toThrow(/manifest is stale/);
  }
});

// Same contract as app-shards.test.mjs: the failing shard job must name the file to edit and the
// command that fixes it, and only when it is actually running on Actions.
test("a stale manifest fails the shard CLI and, on Actions, annotates the manifest", () => {
  const root = fixture("tests/a.test.ts\n");
  const before = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = "true";
    const ci = listShard("1", root);
    expect(ci.code).toBe(1);
    expect(ci.lines[0]).toContain(
      "::error file=scripts/ci/server-tests.list.txt,line=1,title=",
    );
    expect(ci.lines[0]).toContain("bun run test:shards");

    process.env.GITHUB_ACTIONS = "";
    const local = listShard("1", root);
    expect(local.code).toBe(1);
    expect(local.lines.join("\n")).not.toContain("::error");
  } finally {
    if (before === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = before;
  }
});

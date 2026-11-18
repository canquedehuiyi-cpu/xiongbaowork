// Splits the app suite (`bun test` run from xiongbao/app) into fixed shards, the way
// server-shards.mjs splits server/tests. Why the app suite needs shards at all:
//
// `app-test` used to run all 628 files in one Bun process. From about 300 files into that run,
// `tests/workbench-frame-routes.test.tsx` stopped rendering the workbench frame: each of its seven
// route cases waited its full `LOAD` (25s) and then failed on a DOM that only held the settings
// page's own shell. The same file alone is 8/8 green in ~1s, and a run of the 200 files before it
// was green too (bisected by file count, on the machine and from the CI log). So the failure is a
// property of how much ran in the process before it, not of the file or the code under test.
//
// The fix here is structural and matches what server-test already does: one process per shard.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  annotationFor,
  assertManifestFresh,
  sliceShard,
  splitManifest,
} from "./sharding.mjs";

// 628 files at the time of writing, i.e. ~105 per shard: below both the 200-file run that was green
// and the 300-file run that reproduced the hang, with room for the suite to grow.
export const SHARD_COUNT = 6;
const MANIFEST = "scripts/ci/app-tests.list.txt";
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "test-results",
]);
const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));

// Paths are relative to xiongbao/app, which is where `bun test` runs, so a manifest line can be
// pasted straight into a shell: `cd app && bun test ./tests/foo.test.tsx`.
export function discoverTests(root) {
  const found = [];
  const walk = (relative) => {
    const directory = relative
      ? join(root, "app", relative)
      : join(root, "app");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path);
      } else if (/\.test\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk("");
  return found.sort();
}

export function readManifest(root) {
  const files = splitManifest(readFileSync(join(root, MANIFEST), "utf8"));
  assertManifestFresh(files, discoverTests(root), {
    command: "bun run test:shards",
    label: "App test",
  });
  return files;
}

export function shardFiles(files, shard) {
  return sliceShard(files, shard, SHARD_COUNT, "App");
}

// The listing a shard job runs, and what it prints when the manifest is stale. Returns the lines and
// the exit code instead of printing and exiting itself, so the stale path can be tested without
// spawning a second Bun process (which on Windows returns an empty stdout and exit code 0 for
// `bun.exe script.mjs`).
export function listShard(action, root = defaultRoot) {
  if (!new RegExp(`^[1-${SHARD_COUNT}]$`).test(action ?? "")) {
    throw new Error(
      `Usage: bun scripts/ci/app-shards.mjs <1..${SHARD_COUNT}|--write> [head product root]`,
    );
  }
  try {
    return {
      code: 0,
      lines: [shardFiles(readManifest(root), Number(action)).join("\n")],
    };
  } catch (error) {
    const annotation = annotationFor(error, {
      manifest: MANIFEST,
      label: "App test",
    });
    return {
      code: 1,
      lines: [...(annotation ? [annotation] : []), error.message],
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, rootArgument] = process.argv.slice(2);
  const root = rootArgument ? resolve(rootArgument) : defaultRoot;
  if (action === "--write") {
    const files = discoverTests(root);
    writeFileSync(join(root, MANIFEST), `${files.join("\n")}\n`);
    console.log(`Recorded ${files.length} app test files.`);
  } else {
    const { code, lines } = listShard(action, root);
    for (const line of lines) console.log(line);
    process.exit(code);
  }
}

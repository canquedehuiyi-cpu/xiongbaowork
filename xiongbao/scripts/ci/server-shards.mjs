import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  annotationFor,
  assertManifestFresh,
  sliceShard,
  splitManifest,
} from "./sharding.mjs";

export const SHARD_COUNT = 6;
const MANIFEST = "scripts/ci/server-tests.list.txt";
const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));

export function discoverTests(root) {
  return readdirSync(join(root, "server/tests"), { recursive: true })
    .map((file) => `tests/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
}

export function readManifest(root) {
  const files = splitManifest(readFileSync(join(root, MANIFEST), "utf8"));
  assertManifestFresh(files, discoverTests(root), {
    command: "bun run test:shards",
    label: "Server test",
  });
  return files;
}

export function shardFiles(files, shard) {
  return sliceShard(files, shard, SHARD_COUNT, "Server");
}

// Same shape as app-shards.mjs's listShard: the lines and the exit code, not a print-and-exit, so
// the stale path is testable in-process (see the comment there about Windows and child processes).
export function listShard(action, root = defaultRoot) {
  if (!new RegExp(`^[1-${SHARD_COUNT}]$`).test(action ?? "")) {
    throw new Error(
      `Usage: bun scripts/ci/server-shards.mjs <1..${SHARD_COUNT}|--write> [head openbot root]`,
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
      label: "Server test",
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
    console.log(`Recorded ${files.length} server test files.`);
  } else {
    const { code, lines } = listShard(action, root);
    for (const line of lines) console.log(line);
    process.exit(code);
  }
}

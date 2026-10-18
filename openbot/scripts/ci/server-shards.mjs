import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SHARD_COUNT = 6;
const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));

export function discoverTests(root) {
  return readdirSync(join(root, "server/tests"), { recursive: true })
    .map((file) => `tests/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
}

export function readManifest(root) {
  const manifest = readFileSync(
    join(root, "scripts/ci/server-tests.list.txt"),
    "utf8",
  )
    .trimEnd()
    .split(/\r?\n/);
  const actual = discoverTests(root);
  if (
    manifest.length !== actual.length ||
    manifest.some((file, i) => file !== actual[i])
  ) {
    throw new Error(
      "Server test manifest is stale. Run bun scripts/ci/server-shards.mjs --write and commit server-tests.list.txt.",
    );
  }
  return manifest;
}

export function shardFiles(files, shard) {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
    throw new RangeError("Server shard must be an integer from 1 to 6.");
  }
  // Contiguous line ranges, independent of filename byte lengths and split implementations.
  return files.slice(
    Math.floor(((shard - 1) * files.length) / SHARD_COUNT),
    Math.floor((shard * files.length) / SHARD_COUNT),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, rootArgument] = process.argv.slice(2);
  const root = rootArgument ? resolve(rootArgument) : defaultRoot;
  if (action === "--write") {
    const files = discoverTests(root);
    writeFileSync(
      join(root, "scripts/ci/server-tests.list.txt"),
      `${files.join("\n")}\n`,
    );
    console.log(`Recorded ${files.length} server test files.`);
  } else {
    if (!/^[1-6]$/.test(action ?? "")) {
      throw new Error(
        "Usage: bun scripts/ci/server-shards.mjs <1..6|--write> [head openbot root]",
      );
    }
    console.log(shardFiles(readManifest(root), Number(action)).join("\n"));
  }
}

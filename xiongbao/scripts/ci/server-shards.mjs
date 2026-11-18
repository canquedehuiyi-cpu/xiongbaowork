import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertManifestFresh, sliceShard, splitManifest } from "./sharding.mjs";

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
    command: "bun scripts/ci/server-shards.mjs --write",
    label: "Server test",
  });
  return files;
}

export function shardFiles(files, shard) {
  return sliceShard(files, shard, SHARD_COUNT, "Server");
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
    if (!/^[1-6]$/.test(action ?? "")) {
      throw new Error(
        "Usage: bun scripts/ci/server-shards.mjs <1..6|--write> [head openbot root]",
      );
    }
    console.log(shardFiles(readManifest(root), Number(action)).join("\n"));
  }
}

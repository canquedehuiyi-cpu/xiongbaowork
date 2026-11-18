// The two shard layouts (server-shards.mjs for server/tests, app-shards.mjs for everything Bun picks
// up under app/) differ only in where they discover files and which manifest they keep. The two
// invariants they must share live here, so a change to one cannot drift from the other:
//
// 1. A shard is a contiguous, balanced range of the committed list, so the split is reproducible
//    from the manifest alone — not from filename byte lengths, readdir order, or the splitter.
// 2. The committed list must equal what is on disk right now. A test file added without a manifest
//    update would otherwise never run in CI: `bun test` is never invoked without an explicit list.
export function sliceShard(files, shard, shardCount, label) {
  if (!Number.isInteger(shard) || shard < 1 || shard > shardCount) {
    throw new RangeError(
      `${label} shard must be an integer from 1 to ${shardCount}.`,
    );
  }
  return files.slice(
    Math.floor(((shard - 1) * files.length) / shardCount),
    Math.floor((shard * files.length) / shardCount),
  );
}

export function assertManifestFresh(files, actual, { command, label }) {
  const first = files.findIndex((file, index) => file !== actual[index]);
  if (files.length === actual.length && first === -1) return;
  // "The manifest is stale" alone sends the reader to diff 628 lines by hand. Name the first
  // difference and the set differences: the interesting case is a platform whose tree does not match
  // the machine that wrote the list (a file that exists on only one of them).
  const at = first === -1 ? Math.min(files.length, actual.length) : first;
  const listed = new Set(files);
  const found = new Set(actual);
  const only = (from, other) =>
    [...from].filter((file) => !other.has(file)).slice(0, 5);
  const show = (items) => (items.length ? items.join(", ") : "无");
  throw new Error(
    `${label} manifest is stale: ${files.length} listed, ${actual.length} found; first difference at line ${at + 1} (listed ${JSON.stringify(files[at] ?? null)}, found ${JSON.stringify(actual[at] ?? null)}); only listed: ${show(only(files, found))}; only found: ${show(only(actual, listed))}. Run \`${command}\` and commit the result.`,
  );
}

// An empty manifest is a deliberate state (a suite with no tests yet), not a parse failure: the
// manifests are written with a trailing newline, so trimEnd turns "one line" into "one line" and ""
// into "".
export function splitManifest(raw) {
  const text = raw.trimEnd();
  return text === "" ? [] : text.split(/\r?\n/);
}

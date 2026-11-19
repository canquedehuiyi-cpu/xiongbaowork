import { mkdir } from "node:fs/promises";
import { lockProviderCredentials } from "../../src/provider-oauth-lock";

const file = process.argv[2];
if (!file) throw new Error("A credential path is required.");
// Said once Bun has started and imported the lock, right before the attempt, so a caller can tell
// a slow start (Bun on a cold Windows runner) from a lock that is held: only after this line does
// "no `locked` yet" say anything about exclusion.
console.log("waiting");
if (process.argv[3] === "legacy") {
  await mkdir(`${file}.lock`, { mode: 0o700 });
  console.log("locked");
  await Bun.stdin.text();
} else {
  const unlock = await lockProviderCredentials(file);
  try {
    console.log("locked");
    await Bun.stdin.text();
  } finally {
    await unlock();
  }
}

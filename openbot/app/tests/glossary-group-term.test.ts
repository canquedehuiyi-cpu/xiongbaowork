import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * CONTEXT.md: a named, ordered set of coworkers (`waker_groups`) is called 群组 — on every screen,
 * in every message the server sends back for a person to read, and in the code's own comments.
 * 小组 was the older word; two words for one thing is how two people end up describing different
 * features. This keeps it from coming back.
 */

const ROOTS = [
  new URL("../src", import.meta.url).pathname,
  new URL("../../server/src", import.meta.url).pathname,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(name)) {
      yield path;
    }
  }
}

test("the app and the server say 群组, never 小组", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes("小组")) offenders.push(`${file}:${index + 1}`);
        });
    }
  }
  expect(offenders).toEqual([]);
});

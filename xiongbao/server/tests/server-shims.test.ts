import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

/*
 * The image carries the server as bundled files in /app/server/dist and keeps one shim at each path an
 * operator, a Helm chart or the manual runs by name (`bun scripts/migrate.ts` from /app/server). A shim
 * is ONE `import` line. Logic in a shim would be code the bundle does not have, and that no test of the
 * source ever runs.
 */
const root = join(import.meta.dir, "../..");
const shimRoot = join(root, "docker/server-shims");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const shims = filesUnder(shimRoot).map((path) => relative(shimRoot, path));
// The source file each shim stands in for is the same path in the repository.
const bundled = [
  ...dockerfile.matchAll(/^\s+bundle (\S+) ([\w-]+)(?: (main))?;?(?: \\)?$/gm),
].map((m) => ({ source: m[1] ?? "", name: m[2] ?? "", main: m[3] === "main" }));

describe("server shims", () => {
  test("every path the chart, compose file and manual name has a shim", () => {
    expect(shims.sort()).toEqual([
      "scripts/composio-smoke.ts",
      "server/scripts/cull-idle-computers.ts",
      "server/scripts/cull-staged-attachments.ts",
      "server/scripts/fire-routines.ts",
      "server/scripts/migrate.ts",
      "server/src/learning/ensure-container.ts",
    ]);
  });

  test.each(shims)("%s is exactly one import of its bundle", (shim) => {
    const text = readFileSync(join(shimRoot, shim), "utf8");
    const entry = bundled.find((b) => b.source === shim);
    expect(entry, `${shim} has no bundle line in the Dockerfile`).toBeDefined();
    // One line, ending in a newline, nothing else: no comment, no argument handling, no exit.
    expect(text.split("\n")).toHaveLength(2);
    const target = posix.join(
      dirname(shim),
      /^import "(.+)";$/.exec(text.trimEnd())?.[1] ?? "no-import",
    );
    expect(target).toBe(`server/dist/${entry?.name}.js`);
  });

  test("the server entry itself is bundled to dist/server.js and the api starts it", () => {
    expect(bundled.find((b) => b.source === "server/src/index.ts")?.name).toBe(
      "server",
    );
    expect(
      readFileSync(join(root, "docker/s6/s6-rc.d/api/run"), "utf8"),
    ).toContain("/usr/local/bin/bun dist/server.js");
  });

  test("an entry guarded by import.meta.main is bundled with it defined", () => {
    // An imported module is never `main`: without the define a shim would load the bundle, do
    // nothing and exit 0.
    for (const entry of bundled) {
      const guarded = readFileSync(join(root, entry.source), "utf8").includes(
        "if (import.meta.main)",
      );
      expect(entry.main, entry.source).toBe(guarded);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * extension/bunfig.toml held against the root one, the same way app/tests/bunfig-preload.test.ts
 * holds app/bunfig.toml.
 *
 * Bun reads bunfig.toml from the current working directory only, so `cd extension && bun test` (the
 * CI command) needs its own copy of the preload list. Without it Base UI's portals are inert in the
 * options, popup and connect page tests and every dialog assertion fails against an empty body. A
 * preload added to the root and not here would bring that back silently, so the agreement is a test
 * rather than a comment.
 */
const repositoryRoot = resolve(import.meta.dir, "..", "..");

function preloadedScripts(bunfigPath: string): string[] {
  const parsed = Bun.TOML.parse(readFileSync(bunfigPath, "utf8")) as {
    test?: { preload?: string[] };
  };
  return (parsed.test?.preload ?? [])
    .map((entry) => resolve(dirname(bunfigPath), entry))
    .sort();
}

describe("extension bunfig preload", () => {
  const rootBunfig = resolve(repositoryRoot, "bunfig.toml");
  const extensionBunfig = resolve(repositoryRoot, "extension", "bunfig.toml");

  test("the root and extension configs preload the same scripts", () => {
    expect(preloadedScripts(extensionBunfig)).toEqual(
      preloadedScripts(rootBunfig),
    );
  });

  test("the DOM preload is among them, and every preloaded script exists", () => {
    const scripts = preloadedScripts(extensionBunfig);
    expect(scripts).toContain(resolve(repositoryRoot, "app/tests/preload.ts"));
    for (const script of scripts) {
      expect(existsSync(script)).toBe(true);
    }
  });
});

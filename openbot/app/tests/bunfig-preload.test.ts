import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * app/bunfig.toml held against the root one, the same way server/tests/bunfig-preload.test.ts holds
 * server/bunfig.toml.
 *
 * Bun reads bunfig.toml from the current working directory only, so `cd app && bun test` needs its
 * own copy of the preload list. Before it had one, Base UI's portals were inert in every app test run
 * from here and twenty assertions failed against an empty body. A preload added to the root and not
 * here would bring that back silently, so the agreement is a test rather than a comment.
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

describe("app bunfig preload", () => {
  const rootBunfig = resolve(repositoryRoot, "bunfig.toml");
  const appBunfig = resolve(repositoryRoot, "app", "bunfig.toml");

  test("the root and app configs preload the same scripts", () => {
    expect(preloadedScripts(appBunfig)).toEqual(preloadedScripts(rootBunfig));
  });

  test("the DOM preload is among them, and every preloaded script exists", () => {
    const scripts = preloadedScripts(appBunfig);
    expect(scripts).toContain(resolve(repositoryRoot, "app/tests/preload.ts"));
    for (const script of scripts) {
      expect(existsSync(script)).toBe(true);
    }
  });
});

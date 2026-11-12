import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ALIAS_FILES = ["shared/apply-env-aliases.ts", "shared/env-aliases.ts"];

// A standalone image copies only the shared files it needs; an entry that imports one missing from
// the image dies at startup, which no unit test notices.
const packages = ["agent-computer", "supervisor"];

describe("images that ship an entry importing shared/apply-env-aliases", () => {
  for (const pkg of packages) {
    test(`${pkg} entry imports it and its Dockerfile copies both files`, () => {
      const entry = readFileSync(join(root, pkg, "src/index.ts"), "utf8");
      expect(entry).toContain('import "../../shared/apply-env-aliases";');
      const dockerfile = readFileSync(join(root, pkg, "Dockerfile"), "utf8");
      const copied = dockerfile
        .split("\n")
        .filter(
          (line) => /^COPY\s/.test(line) && line.trimEnd().endsWith("/shared/"),
        )
        .flatMap((line) => line.split(/\s+/).slice(1, -1));
      for (const file of ALIAS_FILES) expect(copied).toContain(file);
    });
  }
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const ALIAS_FILES = ["shared/apply-env-aliases.ts", "shared/env-aliases.ts"];

// A standalone image copies only the shared files it needs; an entry that imports one missing from
// the image dies at startup, which no unit test notices. worker and runner have no Dockerfile of
// their own (worker runs from the server image, runner is a laptop sidecar), so they are not here.
const packages = ["agent-computer", "supervisor", "server"];

function copiedSharedFiles(dockerfile: string): {
  whole: boolean;
  files: string[];
} {
  const lines = dockerfile.split("\n").filter((line) => /^COPY\s/.test(line));
  // `COPY shared shared` ships the directory, so every file in it.
  const whole = lines.some((line) =>
    /^COPY\s+(--\S+\s+)*shared\/?\s+\S*shared\/?\s*$/.test(line),
  );
  const files = lines
    .filter((line) => line.trimEnd().endsWith("/shared/"))
    .flatMap((line) => line.split(/\s+/).slice(1, -1));
  return { whole, files };
}

describe("images that ship an entry importing shared/apply-env-aliases", () => {
  for (const pkg of packages) {
    test(`${pkg} Dockerfile ships both alias files`, () => {
      const entry = readFileSync(join(root, pkg, "src/index.ts"), "utf8");
      expect(entry).toContain('import "../../shared/apply-env-aliases";');
      const { whole, files } = copiedSharedFiles(
        readFileSync(join(root, pkg, "Dockerfile"), "utf8"),
      );
      if (!whole) for (const file of ALIAS_FILES) expect(files).toContain(file);
      expect(whole || files.length > 0).toBe(true);
    });
  }
});

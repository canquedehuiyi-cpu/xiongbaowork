import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

/*
 * The server image (compose's `server/Dockerfile`) copies single files out of `agent-computer/src`
 * rather than the directory. A file it copies that imports a sibling the image does not copy dies on
 * the server's first import, and no unit test runs inside that image. Every relative import of a
 * copied file must be copied too.
 */
function copiedAgentComputerFiles(dockerfile: string): string[] {
  // Only the final stage ships.
  const finalStage = dockerfile.split(/^FROM\s.*$/m).pop() ?? "";
  return finalStage
    .split("\n")
    .filter((line) => /^COPY\s/.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1))
    .filter((path) => path.startsWith("agent-computer/src/"));
}

function siblingImports(source: string): string[] {
  return [...source.matchAll(/from\s+"\.\/([^"]+)"/g)].map(
    (match) => `agent-computer/src/${match[1]}.ts`,
  );
}

describe("the server image's files from agent-computer/src", () => {
  const dockerfile = readFileSync(join(root, "server/Dockerfile"), "utf8");
  const copied = copiedAgentComputerFiles(dockerfile);

  test("it copies at least the egress rules the server imports", () => {
    expect(copied).toContain("agent-computer/src/egress.ts");
  });

  test("every sibling a copied file imports is copied as well", () => {
    const missing = copied
      .flatMap((file) =>
        siblingImports(readFileSync(join(root, file), "utf8")).map(
          (sibling) => ({ file, sibling }),
        ),
      )
      .filter(({ sibling }) => !copied.includes(sibling));
    expect(missing).toEqual([]);
  });

  test("each import named here exists in the tree", () => {
    for (const file of copied)
      for (const sibling of siblingImports(
        readFileSync(join(root, file), "utf8"),
      ))
        expect(existsSync(join(root, sibling))).toBe(true);
  });
});

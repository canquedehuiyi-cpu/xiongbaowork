import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { expandPackageDocument } from "../server/src/tenant-package";

/** The example package must load before a fresh checkout has a .env file. */

const root = join(import.meta.dir, "..");

describe("a clone that has only run bun install", () => {
  test("can read the example tenant package with nothing set", () => {
    // Server tests load this package by path as a fixture, so a name here with no fallback fails them
    // on a clone with no `.env`.
    const agents = readFileSync(
      join(root, "examples/fintech/agents.yaml"),
      "utf8",
    );
    const referenced = [
      ...agents.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g),
    ];

    expect(referenced.length).toBeGreaterThan(0);
    for (const [, name, rest] of referenced) {
      expect(
        rest.startsWith(":-"),
        `\${${name}} in agents.yaml has no fallback, so a clone with no .env cannot read it`,
      ).toBe(true);
    }
  });

  test("can read the default tenant package with nothing set", () => {
    // With no `TENANT_PACKAGE_DIR`, `pretest` and the server load `examples/xiongbao`, so a name
    // there with no fallback fails the suite before a single test runs.
    //
    // Only the deployment-owned fields are expanded (`expandPackageDocument`): a skill body's
    // `${...}` is a shell or JavaScript template the skill teaches, and loads as written. So each file
    // goes through the loader's own expansion with an empty environment rather than a regex over its
    // text, which would read every such template as a missing name.
    const directory = join(root, "examples/xiongbao");
    const sources = [
      "brand.yaml",
      "agents.yaml",
      "channels.yaml",
      "model.yaml",
      "knowledge.yaml",
      "skills.yaml",
      "connectors.yaml",
      "teams.yaml",
      ...readdirSync(join(directory, "agents"))
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => `agents/${name}`),
    ];
    for (const source of sources) {
      const document = parse(readFileSync(join(directory, source), "utf8"));
      expect(() => expandPackageDocument(document, source, {})).not.toThrow();
    }
  });

  test("keeps every .env variant out of the repository", () => {
    // A backup taken beside .env carried live keys into a commit once.
    const ignored = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain(".env.*");
    expect(ignored).toContain("!.env.example");
  });
});

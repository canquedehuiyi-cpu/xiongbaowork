import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 期五 C: the tools a Bot codes with are in both images. The computer's own image (Ubuntu, apt) has
 * git, python3 and ripgrep; the one-container image already had git and python3 and gains ripgrep.
 * `computer_grep` uses rg when it is there and falls back to grep, so a missing rg only costs speed,
 * but a missing git or python3 means a Bot cannot clone a project or run its tests.
 */

const root = join(import.meta.dir, "..", "..");

/** The packages every `apt-get install` line of a Dockerfile names, continuation lines included. */
function aptPackages(dockerfile: string): Set<string> {
  const text = readFileSync(join(root, dockerfile), "utf8").replace(
    /\\\n/g,
    " ",
  );
  const packages = new Set<string>();
  for (const match of text.matchAll(
    /apt-get install -y --no-install-recommends ([^&\n]+)/g,
  ))
    for (const name of (match[1] ?? "").trim().split(/\s+/))
      if (/^[a-z0-9][a-z0-9.+-]*$/.test(name)) packages.add(name);
  return packages;
}

test("the computer's image installs git, python3 and ripgrep with apt", () => {
  const dockerfile = readFileSync(
    join(root, "agent-computer/Dockerfile"),
    "utf8",
  );
  expect(dockerfile).toContain("FROM ubuntu:24.04");
  const installed = aptPackages("agent-computer/Dockerfile");
  for (const name of ["git", "python3", "ripgrep"])
    expect(installed.has(name)).toBe(true);
});

test("the one-container image installs ripgrep beside git and python3", () => {
  const installed = aptPackages("Dockerfile");
  for (const name of ["git", "python3", "python3-venv", "jq", "ripgrep"])
    expect(installed.has(name)).toBe(true);
});

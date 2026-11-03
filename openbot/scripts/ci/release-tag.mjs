// Release tag gate for .github/workflows/release.yml.
//
//   bun scripts/ci/release-tag.mjs <ref_name> [--check-ancestry] [--notes-file <path>]
//
// Run from openbot/. Accepts vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N (no leading zeros),
// requires package.json's version to equal the base version and CHANGELOG.md to carry a non-empty
// "## <base>" section, and writes tag, version, base and prerelease to $GITHUB_OUTPUT. With
// --check-ancestry the tagged commit (HEAD) must already be on origin/main. This script never
// creates, moves or pushes a tag.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NUMBER = "(0|[1-9]\\d*)";
const TAG = new RegExp(
  `^v${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-rc\\.([1-9]\\d*))?$`,
);

/** Parses a release tag name, or throws when it is not one. */
export function parseTag(ref) {
  const match = TAG.exec(typeof ref === "string" ? ref : "");
  if (!match) {
    throw new Error(
      `Not a release tag: ${JSON.stringify(ref)} (expected vX.Y.Z or vX.Y.Z-rc.N, no leading zeros)`,
    );
  }
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  const rc = match[4];
  return {
    tag: ref,
    version: rc ? `${base}-rc.${rc}` : base,
    base,
    prerelease: rc !== undefined,
  };
}

/** The body of the "## <base>" section, or null when there is no such heading. */
export function changelogSection(changelog, base) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `## ${base}`);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    body.push(line);
  }
  return `${body.join("\n").trim()}\n`;
}

/** Checks package.json and CHANGELOG.md under root against the tag; returns the parsed tag and notes. */
export function verifyRelease(ref, root) {
  const parsed = parseTag(ref);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== parsed.base) {
    throw new Error(
      `package.json version ${JSON.stringify(pkg.version)} does not match tag base ${parsed.base}`,
    );
  }
  const notes = changelogSection(
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    parsed.base,
  );
  if (notes === null) {
    throw new Error(`CHANGELOG.md has no "## ${parsed.base}" section`);
  }
  if (notes.trim() === "") {
    throw new Error(`CHANGELOG.md section "## ${parsed.base}" is empty`);
  }
  return { ...parsed, notes };
}

/** Throws unless HEAD is an ancestor of (or equal to) origin/main in the repository at cwd. */
export function checkAncestry(cwd) {
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
      {
        cwd,
        stdio: "ignore",
      },
    );
  } catch {
    throw new Error("The tagged commit is not on origin/main");
  }
}

export function outputLines(release) {
  return [
    `tag=${release.tag}`,
    `version=${release.version}`,
    `base=${release.base}`,
    `prerelease=${release.prerelease}`,
  ];
}

function main(argv) {
  const args = [...argv];
  let ancestry = false;
  let notesFile;
  const positional = [];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--check-ancestry") ancestry = true;
    else if (arg === "--notes-file") notesFile = args.shift() ?? "";
    else positional.push(arg);
  }
  if (positional.length !== 1 || notesFile === "") {
    throw new Error(
      "usage: release-tag.mjs <ref_name> [--check-ancestry] [--notes-file <path>]",
    );
  }
  const root = process.cwd();
  const release = verifyRelease(positional[0], root);
  if (ancestry) checkAncestry(root);
  if (notesFile) writeFileSync(notesFile, release.notes);
  const lines = outputLines(release);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

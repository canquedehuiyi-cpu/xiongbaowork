import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changelogSection,
  checkAncestry,
  parseTag,
  verifyRelease,
} from "./release-tag.mjs";

const script = join(import.meta.dir, "release-tag.mjs");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- not yet",
  "",
  "## 0.2.0",
  "",
  "- 熊宝首个收费版本。",
  "",
  "### Detail",
  "",
  "kept with the section",
  "",
  "## 0.1.0",
  "",
  "- older",
  "",
].join("\n");

function fixture({ version = "0.2.0", changelog = CHANGELOG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "openbot", version }),
  );
  if (changelog !== null) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  return env;
}

function run(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: "utf8",
  });
}

test("accepts final and release-candidate tags", () => {
  expect(parseTag("v0.2.0")).toEqual({
    tag: "v0.2.0",
    version: "0.2.0",
    base: "0.2.0",
    prerelease: false,
  });
  expect(parseTag("v0.2.0-rc.1")).toEqual({
    tag: "v0.2.0-rc.1",
    version: "0.2.0-rc.1",
    base: "0.2.0",
    prerelease: true,
  });
  expect(parseTag("v10.0.12-rc.23").base).toBe("10.0.12");
});

test("rejects anything that is not vX.Y.Z or vX.Y.Z-rc.N", () => {
  for (const ref of [
    "0.2.0",
    "v0.2",
    "v0.2.0-beta",
    "v0.2.0-beta.1",
    "v0.2.0-rc.01",
    "v0.2.0-rc.0",
    "v0.2.0-rc",
    "v00.2.0",
    "v0.02.0",
    "v0.2.00",
    "v0.2.0 ",
    "v0.2.0x",
    "v0.2.0-rc.1x",
    "v0.2.0-rc.1\n",
    "v0.2.0\nv0.3.0",
    "refs/tags/v0.2.0",
    "main",
    "",
  ]) {
    expect(() => parseTag(ref)).toThrow("Not a release tag");
  }
  expect(() => parseTag(undefined)).toThrow("Not a release tag");
});

test("writes tag, version, base and prerelease to GITHUB_OUTPUT", () => {
  const dir = fixture();
  const output = join(dir, "github-output");
  writeFileSync(output, "earlier=kept\n");
  const notes = join(dir, "notes.md");

  const rc = run(dir, ["v0.2.0-rc.1", "--notes-file", notes], {
    GITHUB_OUTPUT: output,
  });
  expect(rc.status).toBe(0);
  const final = run(dir, ["v0.2.0"], { GITHUB_OUTPUT: output });
  expect(final.status).toBe(0);

  expect(readFileSync(output, "utf8")).toBe(
    [
      "earlier=kept",
      "tag=v0.2.0-rc.1",
      "version=0.2.0-rc.1",
      "base=0.2.0",
      "prerelease=true",
      "tag=v0.2.0",
      "version=0.2.0",
      "base=0.2.0",
      "prerelease=false",
      "",
    ].join("\n"),
  );
  expect(readFileSync(notes, "utf8")).toBe(
    "- 熊宝首个收费版本。\n\n### Detail\n\nkept with the section\n",
  );
});

test("CLI rejects a malformed tag without writing outputs", () => {
  const dir = fixture();
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  for (const ref of ["0.2.0", "v0.2.0-rc.01", "v0.2.0-beta"]) {
    const result = run(dir, [ref], { GITHUB_OUTPUT: output });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Not a release tag");
  }
  expect(readFileSync(output, "utf8")).toBe("");
});

test("rejects a package.json version that differs from the tag base", () => {
  const dir = fixture({ version: "0.1.0" });
  expect(() => verifyRelease("v0.2.0", dir)).toThrow(
    'package.json version "0.1.0" does not match tag base 0.2.0',
  );
  // The rc suffix belongs to the tag only; package.json carries the base version.
  const rcPackage = fixture({ version: "0.2.0-rc.1" });
  expect(() => verifyRelease("v0.2.0-rc.1", rcPackage)).toThrow(
    "does not match tag base 0.2.0",
  );
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const result = run(dir, ["v0.2.0"], { GITHUB_OUTPUT: output });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("does not match tag base 0.2.0");
  expect(readFileSync(output, "utf8")).toBe("");
});

test("rejects a missing or empty CHANGELOG section", () => {
  const missing = fixture({
    changelog:
      "# Changelog\n\n## Unreleased\n\n- 0.2.0 mentioned\n\n## 0.1.0\n\n- old\n",
  });
  expect(() => verifyRelease("v0.2.0", missing)).toThrow(
    'CHANGELOG.md has no "## 0.2.0" section',
  );
  // A heading that only starts with the version is not that version's section.
  const prefixed = fixture({
    changelog: "## 0.2.0-rc.1\n\n- x\n\n## 0.2.01\n\n- y\n",
  });
  expect(() => verifyRelease("v0.2.0", prefixed)).toThrow("has no");
  const empty = fixture({ changelog: "## 0.2.0\n\n\n## 0.1.0\n\n- old\n" });
  expect(() => verifyRelease("v0.2.0", empty)).toThrow("is empty");
  const absent = fixture({ changelog: null });
  expect(() => verifyRelease("v0.2.0", absent)).toThrow();

  const result = run(missing, ["v0.2.0"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no "## 0.2.0" section');
});

test("changelog section tolerates CRLF and ends at the next version heading", () => {
  const crlf = CHANGELOG.replaceAll("\n", "\r\n");
  expect(changelogSection(crlf, "0.2.0")).toBe(
    "- 熊宝首个收费版本。\n\n### Detail\n\nkept with the section\n",
  );
  expect(changelogSection(CHANGELOG, "0.1.0")).toBe("- older\n");
  expect(changelogSection(CHANGELOG, "0.3.0")).toBeNull();
});

test("--check-ancestry requires the tagged commit to be on origin/main", () => {
  const dir = fixture();
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=release-test",
        "-c",
        "user.email=release@example.test",
        ...args,
      ],
      { cwd: dir, env: cleanEnv(), encoding: "utf8" },
    ).trim();
  git("init", "-q", "-b", "main");
  git("add", "package.json", "CHANGELOG.md");
  git("commit", "-q", "-m", "on main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  expect(() => checkAncestry(dir)).not.toThrow();
  expect(run(dir, ["v0.2.0", "--check-ancestry"]).status).toBe(0);

  git("checkout", "-q", "-b", "side");
  git("commit", "-q", "--allow-empty", "-m", "never merged");
  expect(() => checkAncestry(dir)).toThrow("not on origin/main");
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const result = run(dir, ["v0.2.0", "--check-ancestry"], {
    GITHUB_OUTPUT: output,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("not on origin/main");
  expect(readFileSync(output, "utf8")).toBe("");

  // Without origin/main at all the check fails closed.
  git("update-ref", "-d", "refs/remotes/origin/main");
  expect(() => checkAncestry(dir)).toThrow("not on origin/main");
});

test("CLI requires exactly one ref name", () => {
  const dir = fixture();
  expect(run(dir, []).status).toBe(1);
  expect(run(dir, ["v0.2.0", "v0.2.1"]).status).toBe(1);
  expect(run(dir, ["v0.2.0", "--notes-file"]).status).toBe(1);
});

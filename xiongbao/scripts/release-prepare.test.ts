import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRelease } from "./release-prepare";
import type { Kind } from "./release-version";

const directories: string[] = [];

function fixture(version: string, unreleased = "- Something new.\n") {
  const root = mkdtempSync(join(tmpdir(), "openbot-release-prepare-"));
  directories.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "charts/xiongbao"), { recursive: true });
  const write = (path: string, text: string) =>
    writeFileSync(join(root, path), text);
  write("package.json", `${JSON.stringify({ version }, null, 2)}\n`);
  write(
    "CHANGELOG.md",
    `# Changelog\n\n## Unreleased\n\n${unreleased}\n## 0.1.0\n\n- First.\n`,
  );
  write("charts/xiongbao/Chart.yaml", 'name: openbot\nappVersion: "0.0.1"\n');
  copyFileSync(
    join(import.meta.dir, "release-version.ts"),
    join(root, "scripts/release-version.ts"),
  );
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  return { root, read };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stable patch promotes the changelog and moves the chart", () => {
  const { root, read } = fixture("0.2.0");
  const result = prepareRelease(root, "patch", "stable");
  expect(result.version).toBe("0.2.1");
  expect(result.base).toBe("main");
  expect(result.notes).toBe("- Something new.");
  expect(JSON.parse(read("package.json")).version).toBe("0.2.1");
  expect(read("CHANGELOG.md")).toContain(
    "## Unreleased\n\n## 0.2.1\n\n- Something new.",
  );
  expect(read("charts/xiongbao/Chart.yaml")).toContain('appVersion: "0.2.1"');
});

test("a minor release candidate leaves the changelog alone", () => {
  const { root, read } = fixture("0.2.0");
  const before = read("CHANGELOG.md");
  const result = prepareRelease(root, "minor", "rc");
  expect(result.version).toBe("0.3.0-rc.1");
  expect(result.base).toBe("release/0.3");
  expect(result.notes).toBe("- Something new.");
  expect(read("CHANGELOG.md")).toBe(before);
  expect(read("charts/xiongbao/Chart.yaml")).toContain(
    'appVersion: "0.3.0-rc.1"',
  );
});

test("final finishes a candidate under its own heading", () => {
  const { root, read } = fixture("0.3.0-rc.2");
  const result = prepareRelease(root, "patch", "final");
  expect(result.version).toBe("0.3.0");
  expect(result.base).toBe("release/0.3");
  expect(result.notes).toBe("- Something new.");
  expect(read("CHANGELOG.md")).toContain("## Unreleased\n\n## 0.3.0\n");
});

for (const kind of ["stable", "rc", "beta", "final"] as Kind[]) {
  test(`an empty Unreleased throws for ${kind}`, () => {
    const { root } = fixture(kind === "final" ? "0.3.0-rc.1" : "0.2.0", "\n");
    expect(() => prepareRelease(root, "patch", kind)).toThrow(
      "Nothing under '## Unreleased'",
    );
  });
}

test("a missing Unreleased heading throws", () => {
  const { root } = fixture("0.2.0");
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
  expect(() => prepareRelease(root, "patch", "stable")).toThrow(
    "no '## Unreleased' section",
  );
});

function runCli(unreleased?: string) {
  const { root } = fixture("0.2.0", unreleased);
  copyFileSync(
    join(import.meta.dir, "release-prepare.ts"),
    join(root, "scripts/release-prepare.ts"),
  );
  const output = join(root, "github-output.txt");
  const temp = join(root, "runner-temp");
  mkdirSync(temp);
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(root, "scripts/release-prepare.ts"),
      "patch",
      "stable",
    ],
    {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: temp },
    },
  );
  return { run, output, temp };
}

test("the CLI entry writes version and base to GITHUB_OUTPUT, and the notes to a file", () => {
  const { run, output, temp } = runCli();
  expect(run.exitCode).toBe(0);
  const file = join(temp, "release-notes.md");
  expect(readFileSync(output, "utf8")).toBe(
    `version=0.2.1\nbase=main\nnotes_file=${file}\n`,
  );
  expect(readFileSync(file, "utf8")).toBe("- Something new.");
});

test("the notes file holds the whole Unreleased body, past what one env var can carry", () => {
  const line = "- A long note.\n";
  const { run, temp } = runCli(line.repeat(20000));
  expect(run.exitCode).toBe(0);
  const notes = readFileSync(join(temp, "release-notes.md"), "utf8");
  expect(notes.length).toBeGreaterThan(200_000);
  expect(notes).toBe(line.repeat(20000).trim());
});

const policy = (version: string) =>
  `{\n  "$schema": "./shared/release-policy.schema.json",\n  "version": "${version}",\n  "upgrade": { "fromVersions": ["v0.2.0"] }\n}\n`;

test("a candidate carries the policy written for its release", () => {
  const { root, read } = fixture("0.2.0");
  writeFileSync(join(root, "release-policy.json"), policy("v0.3.0"));
  const prepared = prepareRelease(root, "minor", "rc");
  expect(prepared.version).toBe("0.3.0-rc.1");
  expect(read("release-policy.json")).toBe(policy("v0.3.0-rc.1"));
});

test("the final takes over its candidate's policy", () => {
  const { root, read } = fixture("0.3.0-rc.2");
  writeFileSync(join(root, "release-policy.json"), policy("v0.3.0-rc.2"));
  prepareRelease(root, "minor", "final");
  expect(read("release-policy.json")).toBe(policy("v0.3.0"));
});

test("a policy written for another release is left for a person to rewrite", () => {
  const { root, read } = fixture("0.2.0");
  writeFileSync(join(root, "release-policy.json"), policy("v0.2.0"));
  prepareRelease(root, "minor", "rc");
  expect(read("release-policy.json")).toBe(policy("v0.2.0"));
});

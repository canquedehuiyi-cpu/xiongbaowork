import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The computer image carries the LibreOffice command-line tool only through a separate overlay
 * Dockerfile, built on top of an image that is already built. The computer's own Dockerfile does not
 * know about it, so the default build and every test that reads that file are untouched. With no
 * Docker daemon in the unit step, what can be checked here is that shape.
 */
const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const instructions = (text: string) =>
  text
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

test("the computer's own Dockerfile does not mention the tool at all", () => {
  const dockerfile = read("agent-computer/Dockerfile");
  // Comments may name LibreOffice (an existing one says why it is not here); nothing else may.
  expect(instructions(dockerfile).join("\n")).not.toMatch(
    /libreoffice|office-cli|cli-anything/i,
  );
  expect(dockerfile).not.toContain("XIONGBAO_PILOT_OFFICE_CLI");
  // Still a plain multi-stage file whose last stage is the image itself.
  expect(dockerfile).toContain("FROM ubuntu:24.04\n");
  expect(dockerfile.trimEnd().split("\n").at(-1)).toBe(
    'CMD ["bun", "src/index.ts"]',
  );
});

test("the overlay builds on a given image, which has no default", () => {
  const overlay = instructions(read("docker/office-cli/Dockerfile"));
  expect(overlay[0]).toBe("ARG BASE");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile variable, not a template
  expect(overlay[1]).toBe("FROM ${BASE}");
  expect(overlay.filter((line) => line.startsWith("FROM "))).toHaveLength(1);
});

test("the overlay installs LibreOffice, the guard and the launcher, and runs the install checks", () => {
  const overlay = read("docker/office-cli/Dockerfile");
  expect(overlay).toContain("libreoffice-writer");
  expect(overlay).toContain(
    "COPY agent-computer/office-cli/guard.ts /opt/xiongbao-office-cli/guard.ts",
  );
  expect(overlay).toContain("install.sh");
  expect(overlay).toContain("/opt/office-cli-install/xb-office-cli");
});

test("the tool's requirements are pinned with hashes and installed as wheels only, with no resolution", () => {
  const requirements = read("docker/office-cli/requirements.txt");
  const lines = requirements
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines)
    expect(line).toMatch(
      /^[A-Za-z0-9_.-]+==\d[\w.]*\s+--hash=sha256:[0-9a-f]{64}$/,
    );
  const install = read("docker/office-cli/install.sh");
  for (const flag of ["--require-hashes", "--only-binary :all:", "--no-deps"])
    expect(install).toContain(flag);
  // The real tool is not on PATH; only the launcher that goes through the guard is.
  expect(install).toContain("/usr/local/bin/xb-office-cli");
  expect(install).not.toMatch(/ln -s.*cli-anything-libreoffice/);
  // The launcher's protections need these root-owned files: an empty bunfig and an empty tsconfig.
  expect(install).toContain('"$home/bunfig.toml"');
  expect(install).toContain('"$home/tsconfig.json"');
  // The build fails on a Tab that gets through, and on a path outside the workspace.
  expect(install).toContain("xb-office-cli-escape");
});

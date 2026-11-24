import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The computer image carries the LibreOffice command-line tool only when it is built with
 * XIONGBAO_PILOT_OFFICE_CLI=on. Without a Docker daemon in CI's unit step, what can be checked here
 * is the shape that keeps the default build the same as before: the default path ends in an empty
 * stage built on the unchanged one, and nothing about the tool appears in any stage the default
 * build runs.
 */
const root = join(import.meta.dir, "..", "..");
const dockerfile = readFileSync(
  join(root, "agent-computer", "Dockerfile"),
  "utf8",
);

/** The text of each stage, keyed by its name (the last stage, which has none, is keyed "(final)"). */
function stages(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const parts = text
    .split(/^(?=FROM )/m)
    .filter((part) => part.startsWith("FROM "));
  for (const part of parts) {
    const name = /^FROM \S+ AS (\S+)/.exec(part)?.[1] ?? "(final)";
    result.set(name, part);
  }
  return result;
}

const instructions = (stage: string) =>
  stage
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

test("the build argument defaults to off and is declared before the first FROM", () => {
  const arg = dockerfile.indexOf("ARG XIONGBAO_PILOT_OFFICE_CLI=off\n");
  expect(arg).toBeGreaterThan(-1);
  expect(arg).toBeLessThan(dockerfile.search(/^FROM /m));
});

test("the last stage picks computer-off or computer-on by that argument", () => {
  const all = stages(dockerfile);
  expect([...all.keys()].at(-1)).toBe("(final)");
  expect(instructions(all.get("(final)") ?? "")).toEqual([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile variable, not a template
    "FROM computer-${XIONGBAO_PILOT_OFFICE_CLI}",
  ]);
  expect(all.has("computer-off")).toBe(true);
  expect(all.has("computer-on")).toBe(true);
});

test("the default stage adds no instruction to the computer stage", () => {
  const off = stages(dockerfile).get("computer-off") ?? "";
  expect(instructions(off)).toEqual(["FROM computer AS computer-off"]);
});

test("nothing about the tool is in a stage the default build runs", () => {
  const all = stages(dockerfile);
  for (const name of [
    "node-toolchain",
    "bun-toolchain",
    "recorder-build",
    "computer",
    "computer-off",
  ]) {
    const stage = all.get(name);
    expect(stage).toBeDefined();
    // Comments may mention it (an existing one says why LibreOffice is not here); instructions may not.
    expect(instructions(stage ?? "").join("\n")).not.toMatch(
      /libreoffice|office-cli|cli-anything/i,
    );
  }
});

test("the on stage builds on the computer stage, installs the tool and the guard, and the install is checked", () => {
  const on = stages(dockerfile).get("computer-on") ?? "";
  expect(on).toStartWith("FROM computer AS computer-on");
  expect(on).toContain("libreoffice-writer");
  expect(on).toContain(
    "COPY agent-computer/office-cli/guard.ts /opt/xiongbao-office-cli/guard.ts",
  );
  expect(on).toContain("install.sh");
});

test("the tool's requirements are pinned with hashes and installed with --require-hashes", () => {
  const requirements = readFileSync(
    join(root, "docker", "office-cli", "requirements.txt"),
    "utf8",
  );
  const lines = requirements
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines)
    expect(line).toMatch(
      /^[A-Za-z0-9_.-]+==\d[\w.]*\s+--hash=sha256:[0-9a-f]{64}$/,
    );
  const install = readFileSync(
    join(root, "docker", "office-cli", "install.sh"),
    "utf8",
  );
  expect(install).toContain("--require-hashes");
  // The real tool is not on PATH; only the launcher that goes through the guard is.
  expect(install).toContain("/usr/local/bin/xb-office-cli");
  expect(install).not.toMatch(/ln -s.*cli-anything-libreoffice/);
});

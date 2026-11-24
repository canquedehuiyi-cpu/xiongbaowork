import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardInvocation } from "../office-cli/guard";

/**
 * The employee skill that teaches xb-office-cli. Its examples are what a model will copy, so each
 * one has to be a command the guard lets through from the employee's own folder, and the skill has
 * to say what the guard enforces and that the commands go through computer_run_command.
 */
const skill = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "examples",
    "xiongbao",
    "skills",
    "libreoffice-cli",
    "SKILL.md",
  ),
  "utf8",
);

test("the front matter names the skill and says when to use it", () => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
  expect(front).toContain("name: libreoffice-cli");
  expect(front).toMatch(/description: .*xb-office-cli/);
});

test("it sends every command through computer_run_command and names the path rule", () => {
  expect(skill).toContain("computer_run_command");
  expect(skill).toContain("工作区");
  expect(skill).toContain("退出码 2");
});

test("every example command passes the guard from inside a workspace", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "office-cli-skill-")));
  try {
    const found: string[] = [];
    for (const match of skill.matchAll(/`(xb-office-cli [^`]+)`/g))
      found.push(match[1] ?? "");
    for (const match of skill.matchAll(
      /printf '([^']*)' \| (xb-office-cli [^\n]+)/g,
    )) {
      const stdin = (match[1] ?? "").replace(/\\n/g, "\n");
      const args = (match[2] ?? "").split(/\s+/).slice(1);
      expect(() =>
        guardInvocation({ args, stdinText: stdin, root, cwd: root }),
      ).not.toThrow();
    }
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const command of found) {
      const args = command.split(/\s+/).slice(1);
      expect(() =>
        guardInvocation({
          args,
          // An example that opens the REPL needs stdin; the one-shot examples do not read it.
          stdinText: args.includes("repl") ? "exit\n" : null,
          root,
          cwd: root,
        }),
      ).not.toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

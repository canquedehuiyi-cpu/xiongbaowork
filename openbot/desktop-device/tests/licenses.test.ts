import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
const notices = join(root, "licenses", "agent-desktop");
const read = (path: string) => readFileSync(path, "utf8");

test("the agent-desktop notices ship with the bundle", () => {
  const conf = JSON.parse(
    read(join(root, "src-tauri", "tauri.bundle.conf.json")),
  );
  for (const name of ["LICENSE", "THIRD-PARTY.md", "COPYRIGHT"]) {
    expect(conf.bundle.resources[`../licenses/agent-desktop/${name}`]).toBe(
      `licenses/agent-desktop/${name}`,
    );
  }
});

test("no copyleft licence appears in the agent-desktop notice", () => {
  const toml = read(join(notices, "about.toml"));
  const accepted = [...(/accepted\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(accepted.length).toBeGreaterThan(0);
  const md = read(join(notices, "THIRD-PARTY.md"));
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  expect(headings.length).toBeGreaterThan(0);
  for (const heading of headings) expect(accepted).toContain(heading);
  expect(md).not.toMatch(/\b(A?GPL|LGPL|SSPL)-/);
});

test("LICENSE is the Apache-2.0 text and COPYRIGHT is not empty", () => {
  const license = read(join(notices, "LICENSE"));
  expect(license).toContain("Apache License");
  expect(license).toContain("Version 2.0, January 2004");
  expect(read(join(notices, "COPYRIGHT")).trim().length).toBeGreaterThan(0);
});

test("the licence job pins the upstream commit of the lock", () => {
  const lock = JSON.parse(read(join(root, "agent-desktop.lock.json")));
  const ci = Bun.YAML.parse(read(join(repo, ".github", "workflows", "ci.yml")));
  const job = ci.jobs["agent-desktop-licenses"];
  expect(job).toBeDefined();
  const checkout = job.steps.find(
    (step: { uses?: string; with?: { repository?: string } }) =>
      step.uses?.startsWith("actions/checkout@") && step.with?.repository,
  );
  expect(checkout.with.repository).toBe("vercel-labs/agent-desktop");
  expect(checkout.with.ref).toBe(lock.commit);
  expect(checkout.with.path).toBe("upstream");
  expect(job["continue-on-error"]).toBeUndefined();
});

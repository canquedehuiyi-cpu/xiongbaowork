import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const text = (rel: string) => readFileSync(join(root, rel), "utf8");

test("verify-macos checks agent-desktop and its helper, version 1.2.0, team and runtime", () => {
  const sh = text("scripts/verify-macos.sh");
  expect(sh).toContain("Contents/MacOS/agent-desktop");
  expect(sh).toContain("Contents/MacOS/agent-desktop-macos-helper");
  expect(sh).toContain("version");
  expect(sh).toContain("1.2.0");
  expect(sh).toContain("TeamIdentifier");
  expect(sh).toContain("agent-desktop.entitlements.plist");
  expect(sh).toMatch(/runtime/);
});

test("verify-windows-signatures extracts and checks agent-desktop.exe", () => {
  const ps = text("scripts/verify-windows-signatures.ps1");
  expect(ps).toContain("'agent-desktop.exe'");
  const signedBranch = ps.slice(ps.indexOf("} else {\n            if ($signature.Status -ne 'Valid')"));
  expect(signedBranch).toContain("Valid");
  // the loop that runs the signed-branch checks covers the agent-desktop file
  expect(ps).toMatch(/foreach \(\$file in @\(\$installer\.FullName, \$app, \$sidecar, \$agentDesktop\)\)/);
  expect(ps).toContain("agent-desktop.exe");
});

test("macOS 13 is the floor", () => {
  const conf = JSON.parse(text("src-tauri/tauri.macos.conf.json"));
  expect(conf.bundle.macOS.minimumSystemVersion).toBe("13.0");
});

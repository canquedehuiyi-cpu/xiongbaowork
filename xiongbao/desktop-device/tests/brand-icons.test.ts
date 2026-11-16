/**
 * The device app must ship the fork's own icons and copyright line, not the upstream orb that used
 * to be borrowed from desktop/src-tauri/icons.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const tauri = join(import.meta.dir, "..", "src-tauri");
const read = (name: string) => readFileSync(join(tauri, name), "utf8");
const UPSTREAM = "desktop/src-tauri/icons";
const confs = [
  "tauri.conf.json",
  "tauri.bundle.conf.json",
  "tauri.linux.conf.json",
  "tauri.macos.conf.json",
  "tauri.windows-signing.conf.json",
];

test("no config or main.rs points at the upstream icon directory", () => {
  for (const name of [...confs, "src/main.rs", "build.rs"]) {
    expect({ name, hit: read(name).includes(UPSTREAM) }).toEqual({ name, hit: false });
  }
});

test("every listed bundle icon exists in the device's own icons directory", () => {
  const icons: string[] = JSON.parse(read("tauri.conf.json")).bundle.icon;
  expect(icons).toEqual([
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ]);
  for (const icon of icons) expect({ icon, ok: existsSync(join(tauri, icon)) }).toEqual({ icon, ok: true });
  expect(existsSync(join(tauri, "icons/64x64.png"))).toBe(true);
});

test("the tray icon is the device's own 64x64", () => {
  expect(read("src/main.rs")).toContain('"icons/64x64.png"');
});

test("copyright credits the company and CopilotKit", () => {
  const { copyright } = JSON.parse(read("tauri.conf.json")).bundle;
  expect(copyright).toBe("Copyright (c) 2026 熊宝; portions Copyright (c) 2026 CopilotKit (MIT)");
});

test("LICENSE, NOTICE and the third-party notices are bundled from where they are kept or written", () => {
  const { resources } = JSON.parse(read("tauri.bundle.conf.json")).bundle;
  expect(resources).toEqual({
    "../../LICENSE": "LICENSE",
    "../../NOTICE": "NOTICE",
    "../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",
    "../licenses/agent-desktop/LICENSE": "licenses/agent-desktop/LICENSE",
    "../licenses/agent-desktop/THIRD-PARTY.md": "licenses/agent-desktop/THIRD-PARTY.md",
    "../licenses/agent-desktop/COPYRIGHT": "licenses/agent-desktop/COPYRIGHT",
  });
  for (const src of ["../../LICENSE", "../../NOTICE"]) expect(existsSync(join(tauri, src))).toBe(true);
  // Generated, not committed: the bundle reads the file the generator writes at the project root.
  expect(readFileSync(join(tauri, "../../scripts/brand/third-party-notices.ts"), "utf8")).toContain(
    'join(projectRoot, "THIRD-PARTY-NOTICES.md")',
  );
});

test("every device bundle build writes the third-party notices before Tauri bundles them", () => {
  for (const workflow of ["ci.yml", "device-release.yml"]) {
    const text = readFileSync(join(tauri, "../../../.github/workflows", workflow), "utf8");
    const sidecars = text.split("run: bun desktop-device/scripts/build-sidecar.ts").slice(1);
    expect({ workflow, builds: sidecars.length }).toEqual({ workflow, builds: 3 });
    for (const after of sidecars) {
      const beforeBundle = after.slice(0, after.indexOf("tauri build"));
      expect({ workflow, generated: beforeBundle.includes("run: bun scripts/brand/third-party-notices.ts") }).toEqual({
        workflow,
        generated: true,
      });
    }
  }
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectThirdPartyNotices,
  renderNoticesText,
} from "../../scripts/brand/third-party-notices";

const temp = mkdtempSync(join(tmpdir(), "notices-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function install(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, ...manifest }),
  );
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(dir, file), text);
  }
}

describe("third-party notices", () => {
  test("collects transitive production deps, sorted, deduplicated, with UNKNOWN for a missing license", () => {
    const root = join(temp, "a");
    install(
      root,
      "@copilotkit/react-core",
      { version: "1.2.3", license: "MIT", dependencies: { zeta: "^1" } },
      { LICENSE: "copilotkit license text" },
    );
    install(root, "zeta", { version: "2.0.0", license: "ISC" });
    install(root, "alpha", { version: "0.1.0" });
    install(root, "dev-only", { version: "9.9.9", license: "MIT" });

    const notices = collectThirdPartyNotices({
      roots: [join(root, "node_modules")],
      dependencies: ["zeta", "alpha", "@copilotkit/react-core", "zeta"],
    });

    expect(notices).toEqual([
      {
        name: "@copilotkit/react-core",
        version: "1.2.3",
        license: "MIT",
        licenseText: "copilotkit license text",
      },
      { name: "alpha", version: "0.1.0", license: "UNKNOWN" },
      { name: "zeta", version: "2.0.0", license: "ISC" },
    ]);
  });

  test("resolves a nested dependency from the parent's own node_modules before the root", () => {
    const root = join(temp, "b");
    install(root, "parent", {
      version: "1.0.0",
      license: "MIT",
      dependencies: { child: "^1" },
    });
    install(root, "child", { version: "1.0.0", license: "MIT" });
    const nested = join(root, "node_modules", "parent");
    install(nested, "child", { version: "2.0.0", license: "Apache-2.0" });

    const notices = collectThirdPartyNotices({
      roots: [join(root, "node_modules")],
      dependencies: ["parent"],
    });

    expect(notices.map((n) => `${n.name}@${n.version}:${n.license}`)).toEqual([
      "child@2.0.0:Apache-2.0",
      "parent@1.0.0:MIT",
    ]);
  });

  test("keeps two versions of one package, handles cycles and reads license objects", () => {
    const root = join(temp, "c");
    install(root, "a", {
      version: "1.0.0",
      license: { type: "BSD-3-Clause" },
      dependencies: { b: "*" },
    });
    install(root, "b", {
      version: "1.0.0",
      licenses: [{ type: "MIT" }, { type: "ISC" }],
      dependencies: { a: "*" },
    });

    const notices = collectThirdPartyNotices({
      roots: [join(root, "node_modules")],
      dependencies: ["a"],
    });

    expect(notices.map((n) => `${n.name}:${n.license}`)).toEqual([
      "a:BSD-3-Clause",
      "b:(MIT OR ISC)",
    ]);
  });

  test("text rendering lists each package with its license and text", () => {
    const text = renderNoticesText([
      { name: "alpha", version: "0.1.0", license: "UNKNOWN" },
      {
        name: "zeta",
        version: "2.0.0",
        license: "ISC",
        licenseText: "ISC TEXT",
      },
    ]);
    expect(text).toContain("alpha@0.1.0 (UNKNOWN)");
    expect(text).toContain("zeta@2.0.0 (ISC)\nISC TEXT");
  });
});

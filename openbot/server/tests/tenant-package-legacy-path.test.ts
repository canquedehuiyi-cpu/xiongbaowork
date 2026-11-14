import { afterAll, expect, spyOn, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTenantPackage } from "../src/tenant-package";

/**
 * The package directory was renamed examples/qoderwake -> examples/xiongbao. Deployments that set
 * TENANT_PACKAGE_DIR explicitly (env files, compose, Helm values) keep the old spelling until they are
 * edited, so a missing legacy path must still load the renamed package instead of failing the boot.
 */
const root = await mkdtemp(join(tmpdir(), "legacy-tenant-path-"));
await cp(
  join(import.meta.dir, "../../examples/xiongbao"),
  join(root, "examples/xiongbao"),
  {
    recursive: true,
  },
);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a missing examples/qoderwake directory falls back to the sibling examples/xiongbao and says so once", async () => {
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const loaded = await loadTenantPackage(join(root, "examples/qoderwake"));
    const direct = await loadTenantPackage(join(root, "examples/xiongbao"));
    expect(loaded.checksum).toBe(direct.checksum);
    /*
     * Matched by separator-agnostic pattern, not by the spelling written above.
     *
     * The path in the warning is the one the caller passed, and `join` on Windows puts a backslash in
     * it: `includes("examples/qoderwake")` was therefore false on every Windows machine and true only
     * on CI, which made this look like a platform difference rather than a test that could not fail
     * locally. What the warning says is what matters here, not which slash it says it with.
     */
    const legacyWarnings = log.mock.calls.filter((call) =>
      /examples[\\/]qoderwake/.test(String(call[0])),
    );
    expect(legacyWarnings).toHaveLength(1);
    expect(String(legacyWarnings[0]?.[0])).toMatch(/examples[\\/]xiongbao/);
  } finally {
    log.mockRestore();
  }
});

test("a missing directory that is not the legacy path still fails", async () => {
  await expect(loadTenantPackage(join(root, "examples/other"))).rejects.toThrow(
    /ENOENT/,
  );
});

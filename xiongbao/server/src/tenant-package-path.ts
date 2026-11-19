import { existsSync } from "node:fs";

const LEGACY_DIRECTORY = "qoderwake";

/**
 * The package directory was renamed to examples/xiongbao. An explicit TENANT_PACKAGE_DIR written
 * before the rename would otherwise stop the boot, or (for the build cache) hash an empty directory,
 * so a missing legacy path falls back to its sibling. Kept free of server imports so the app's
 * build-cache script can share it with loadTenantPackage.
 */
export function resolveTenantPackageDirectory(sourcePath: string): string {
  const trimmed = sourcePath.replace(/[\\/]+$/, "");
  const legacy = new RegExp(`examples[\\\\/]${LEGACY_DIRECTORY}$`);
  if (!legacy.test(trimmed) || existsSync(trimmed)) return sourcePath;
  const renamed = `${trimmed.slice(0, -LEGACY_DIRECTORY.length)}xiongbao`;
  if (!existsSync(renamed)) return sourcePath;
  console.warn(
    `TENANT_PACKAGE_DIR ${sourcePath} no longer exists; using ${renamed}. Update TENANT_PACKAGE_DIR.`,
  );
  return renamed;
}

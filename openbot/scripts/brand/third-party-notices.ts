import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type ThirdPartyNotice = {
  name: string;
  version: string;
  license: string;
  licenseText?: string;
};

type Manifest = {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function licenseName(entry: unknown): string | undefined {
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object") {
    const type = (entry as { type?: unknown }).type;
    if (typeof type === "string" && type.trim()) return type.trim();
  }
  return undefined;
}

function declaredLicense(manifest: Manifest): string {
  const single = licenseName(manifest.license);
  if (single) return single;
  if (Array.isArray(manifest.licenses)) {
    const names = manifest.licenses.map(licenseName).filter(Boolean);
    if (names.length === 1) return names[0] as string;
    if (names.length > 1) return `(${names.join(" OR ")})`;
  }
  // A package that declares nothing must show up as unknown, never be silently dropped.
  return "UNKNOWN";
}

function readLicenseText(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const file = entries
    .filter((entry) => /^(licen[cs]e|copying)(\..*)?$/i.test(entry))
    .sort()[0];
  if (!file) return undefined;
  try {
    const text = readFileSync(join(dir, file), "utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walks the installed production dependency graph. `roots` are node_modules directories searched in
 * order for top-level names. Transitive names are looked up in the dependent's own node_modules and its
 * siblings first (Bun's isolated layout puts a package's dependencies beside it, and a nested copy can
 * differ from the hoisted one), then in `roots`.
 */
export function collectThirdPartyNotices(options: {
  roots: string[];
  dependencies: string[];
}): ThirdPartyNotice[] {
  const found = new Map<string, ThirdPartyNotice>();
  const visited = new Set<string>();

  const locate = (name: string, searchDirs: string[]) => {
    for (const base of searchDirs) {
      const candidate = join(base, ...name.split("/"));
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
    return undefined;
  };

  const visit = (name: string, searchDirs: string[]) => {
    const located = locate(name, searchDirs);
    if (!located) return; // optional or platform-specific dependency that is not installed
    const dir = realpathSync(located);
    // Workspace packages link to source outside node_modules; they are this product, not third party.
    if (!dir.split(sep).includes("node_modules")) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    const manifest = readManifest(dir);
    if (!manifest) return;

    const version = manifest.version ?? "0.0.0";
    const key = `${name}@${version}`;
    if (!found.has(key)) {
      const text = readLicenseText(dir);
      found.set(key, {
        name,
        version,
        license: declaredLicense(manifest),
        ...(text ? { licenseText: text } : {}),
      });
    }

    // Directory that holds this package inside its node_modules (strip the scope/name segments).
    let holder = dir;
    for (let i = 0; i < name.split("/").length; i++) holder = dirname(holder);
    const children = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    const childDirs = [join(dir, "node_modules"), holder, ...options.roots];
    for (const child of Object.keys(children)) visit(child, childDirs);
  };

  for (const name of new Set(options.dependencies)) visit(name, options.roots);

  return [...found.values()].sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
  );
}

export function renderNoticesText(notices: ThirdPartyNotice[]): string {
  const sections = notices.map((notice) =>
    [
      `${notice.name}@${notice.version} (${notice.license})`,
      ...(notice.licenseText ? [notice.licenseText] : []),
    ].join("\n"),
  );
  return [
    "Third-party software notices",
    "",
    "This product includes the following third-party packages.",
    "",
    sections.join("\n\n----------------------------------------\n\n"),
    "",
  ].join("\n");
}

function main() {
  const projectRoot = resolve(import.meta.dir, "../..");
  const rootModules = join(projectRoot, "node_modules");
  const merged = new Map<string, ThirdPartyNotice>();
  for (const workspace of ["app", "server", "runner"]) {
    const manifest = readManifest(join(projectRoot, workspace));
    const notices = collectThirdPartyNotices({
      roots: [join(projectRoot, workspace, "node_modules"), rootModules],
      dependencies: Object.keys(manifest?.dependencies ?? {}),
    });
    for (const notice of notices) {
      merged.set(`${notice.name}@${notice.version}`, notice);
    }
  }
  const notices = [...merged.values()].sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
  );
  const jsonPath = join(
    projectRoot,
    "app/src/lib/generated/third-party-notices.json",
  );
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(notices, null, 2)}\n`);
  writeFileSync(
    join(projectRoot, "THIRD-PARTY-NOTICES.md"),
    renderNoticesText(notices),
  );
  console.log(`third-party notices: ${notices.length} packages`);
}

if (import.meta.main) main();

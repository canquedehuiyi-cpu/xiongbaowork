import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { AcpPermissionFacts } from "../../../shared/acp";

/**
 * Whether a path an external agent names is inside its working folder, decided here on the device
 * (spec §1: the server only ever holds the folder's `fld_…` reference).
 *
 * REALPATH FIRST. Both sides are resolved as the filesystem resolves them: `..` after a symlink is
 * the link target's parent, and a link inside the folder that points out of it is outside. A path
 * that does not exist yet (a file the agent is about to create) is resolved through its nearest
 * existing parent, then the rest is appended. On Windows the comparison ignores case
 * (`C:\Code\x` and `c:\code\x\..\x` are the same folder).
 *
 * `platform` picks the path rules. The filesystem is only asked when it is this machine's own
 * platform; another platform's paths (tests) are resolved by their text alone.
 *
 * NOTHING ABSOLUTE GOES UP. `permissionFacts` reports each path relative to the working folder, or
 * only the file name of one outside it.
 */

function pathsOf(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/** `path` as the filesystem would resolve it; `path` is absolute. */
function realish(path: string, platform: NodeJS.Platform): string {
  const rules = pathsOf(platform);
  if (platform !== process.platform) return rules.resolve(path);
  const segments = path.split(platform === "win32" ? /[\\/]/ : "/");
  // Longest prefix the filesystem can resolve, then the rest by its text.
  for (let count = segments.length; count > 0; count--) {
    const head =
      count === 1
        ? `${segments[0]}${rules.sep}`
        : segments.slice(0, count).join(rules.sep);
    try {
      return rules.resolve(realpathSync.native(head), ...segments.slice(count));
    } catch {
      // Not there (yet): try its parent.
    }
  }
  return rules.resolve(path);
}

/** `candidate` (relative ones against the folder) and the folder itself, both resolved. */
function resolved(
  workdir: string,
  candidate: string,
  platform: NodeJS.Platform,
): { folder: string; target: string } {
  const rules = pathsOf(platform);
  const absolute = rules.isAbsolute(candidate)
    ? candidate
    : `${workdir}${rules.sep}${candidate}`;
  return {
    folder: realish(workdir, platform),
    target: realish(absolute, platform),
  };
}

/** The folder-relative path, or null when `target` is not inside `folder`. */
function relativeInside(
  folder: string,
  target: string,
  platform: NodeJS.Platform,
): string | null {
  const rules = pathsOf(platform);
  const fold = (path: string) =>
    platform === "win32" ? path.toLowerCase() : path;
  const rel = rules.relative(fold(folder), fold(target));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${rules.sep}`) || rules.isAbsolute(rel))
    return null;
  // The same relative path in the target's own spelling.
  return rules.relative(folder, target) || rel;
}

export function classifyPath(
  workdir: string,
  candidate: string,
  platform: NodeJS.Platform,
): "inside" | "outside" {
  const { folder, target } = resolved(workdir, candidate, platform);
  return relativeInside(folder, target, platform) === null
    ? "outside"
    : "inside";
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys of a tool call's `rawInput` that adapters use for the file a tool acts on. */
const RAW_PATH_KEYS = ["path", "file_path", "filePath", "notebook_path"];

/** Every path an ACP tool call names: its `locations`, its diffs, and its raw input's path fields. */
function namedPaths(toolCall: unknown): string[] {
  if (!isRecord(toolCall)) return [];
  const found: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== "") found.push(value);
  };
  if (Array.isArray(toolCall.locations)) {
    for (const location of toolCall.locations)
      if (isRecord(location)) add(location.path);
  }
  if (Array.isArray(toolCall.content)) {
    for (const item of toolCall.content)
      if (isRecord(item) && item.type === "diff") add(item.path);
  }
  if (isRecord(toolCall.rawInput)) {
    for (const key of RAW_PATH_KEYS) add(toolCall.rawInput[key]);
  }
  return found;
}

/**
 * What the server is told about the paths of a permission request: whether every one is inside the
 * working folder (`null` when the tool call names none), and each one relative to the folder, or
 * its bare file name when it is outside. Duplicates are reported once.
 */
export function permissionFacts(
  workdir: string,
  toolCall: unknown,
  platform: NodeJS.Platform = process.platform,
): AcpPermissionFacts {
  const rules = pathsOf(platform);
  const candidates = namedPaths(toolCall);
  if (candidates.length === 0) return { insideWorkdir: null, paths: [] };
  let inside = true;
  const paths: string[] = [];
  for (const candidate of candidates) {
    const { folder, target } = resolved(workdir, candidate, platform);
    const rel = relativeInside(folder, target, platform);
    let shown: string;
    if (rel === null) {
      inside = false;
      shown = rules.basename(target);
    } else {
      shown = rel === "" ? "." : rel.split(rules.sep).join("/");
    }
    if (!paths.includes(shown)) paths.push(shown);
  }
  return { insideWorkdir: inside, paths };
}

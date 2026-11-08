/**
 * What the device's `apps.discover` answered, kept to the shape this server hands the model (app
 * discovery, spec §3). The device is untrusted: every field is checked and cut here, and anything not
 * listed (the `app` reference, a command, a path) is dropped.
 */

/** The reference of a candidate, as the runner mints it. Kept equal to the runner's own. */
export const CANDIDATE_REF: RegExp = /^cand_[0-9a-z]{1,10}_[A-Za-z0-9_-]{22}$/;

export type DiscoveredCandidate = {
  candidate: string;
  name: string;
  source: string;
  kind: "stdio" | "http";
  status: "ready" | "needs_uv" | "missing_command" | "unsupported";
  note?: string;
};

export type DiscoveryRead = {
  candidates: (DiscoveredCandidate & { enabled: boolean })[];
  installed: string[];
};

export const AVAILABLE_HINT =
  "这些是在主人电脑上发现、但还没启用的应用。可以请主人在设备端窗口的「本机应用」里打开它的开关。";
export const INSTALLED_HINT =
  "这些软件已安装，但没有本机 MCP。需要操作它们时，可以考虑用桌面操控。";
export const OLD_RUNNER =
  "主人电脑上的设备端版本较旧，更新后才能查看可启用的应用。";

const CANDIDATE_LIMIT = 50;
const INSTALLED_LIMIT = 200;
const KINDS: ReadonlySet<string> = new Set(["stdio", "http"]);
const STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "needs_uv",
  "missing_command",
  "unsupported",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A string of 1..`max` characters (code points), or undefined. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return [...value].length <= max ? value : undefined;
}

function readCandidate(
  value: unknown,
): (DiscoveredCandidate & { enabled: boolean }) | undefined {
  if (!isRecord(value)) return undefined;
  const { ref, name, sourceLabel, kind, status, note, enabled } = value;
  if (typeof ref !== "string" || !CANDIDATE_REF.test(ref)) return undefined;
  const readName = text(name, 40);
  const source = text(sourceLabel, 60);
  if (!readName || !source) return undefined;
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  if (typeof enabled !== "boolean") return undefined;
  const readNote = note === undefined ? undefined : text(note, 120);
  return {
    candidate: ref,
    name: readName,
    source,
    kind: kind as DiscoveredCandidate["kind"],
    status: status as DiscoveredCandidate["status"],
    ...(readNote ? { note: readNote } : {}),
    enabled,
  };
}

/** The device's discovery output, or undefined when it is not an object. */
export function readDiscovery(output: unknown): DiscoveryRead | undefined {
  if (!isRecord(output)) return undefined;
  const candidates: DiscoveryRead["candidates"] = [];
  if (Array.isArray(output.candidates)) {
    for (const entry of output.candidates) {
      if (candidates.length >= CANDIDATE_LIMIT) break;
      const read = readCandidate(entry);
      if (read) candidates.push(read);
    }
  }
  const installed: string[] = [];
  if (Array.isArray(output.installed)) {
    for (const entry of output.installed) {
      if (installed.length >= INSTALLED_LIMIT) break;
      const name = text(entry, 120);
      if (name) installed.push(name);
    }
  }
  return { candidates, installed };
}

/** What is left to offer: candidates not enabled, and installed names no app already covers. */
export function discoveryGroups(
  read: DiscoveryRead,
  enabledNames: string[],
): { available: DiscoveredCandidate[]; installed: string[] } {
  const known = new Set(enabledNames.map((name) => name.trim().toLowerCase()));
  for (const candidate of read.candidates)
    known.add(candidate.name.trim().toLowerCase());
  return {
    available: read.candidates
      .filter((candidate) => !candidate.enabled)
      .map(({ enabled: _enabled, ...rest }) => rest),
    installed: read.installed.filter(
      (name) => !known.has(name.trim().toLowerCase()),
    ),
  };
}

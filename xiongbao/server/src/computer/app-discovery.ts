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
  "这些是在主人电脑上发现、但还没启用的应用。要用其中一个，调用 computer_app_enable 并传入它的 candidate；主人批准后就能调用它的工具。";
export const DEVICE_OFFLINE_ENABLE =
  "设备不在线，无法启用本机应用。请等主人的电脑连上后再试。";
/** What the runner says of a candidate it no longer knows (its `CANDIDATE_EXPIRED`), word for word. */
export const CANDIDATE_EXPIRED =
  "这个候选应用已过期或不存在，请重新查看本机应用。";
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

/** A candidate's reference lives this long on the runner; the cache keeps it no longer. */
const CANDIDATE_TTL_MS = 600_000;
const CANDIDATE_CACHE_LIMIT = 1000;

type Machine = { tenantId: string; deviceId: string };

/**
 * The candidates each machine's last listing named, so `computer_app_enable` can name the app and its
 * source on the approval card without asking the machine again. Per tenant and machine, ten minutes
 * (the life of a reference), at most 1000 machines, the oldest listing forgotten first. A miss is
 * not a refusal: the machine is asked about that one candidate instead.
 */
export function createCandidateCache(now: () => number): {
  remember(machine: Machine, candidates: DiscoveryRead["candidates"]): void;
  find(
    machine: Machine,
    ref: string,
  ): (DiscoveredCandidate & { enabled: boolean }) | undefined;
  /** The candidate became an app: a later enable from the same listing is told it already is. */
  markEnabled(machine: Machine, ref: string): void;
} {
  const listings = new Map<
    string,
    {
      at: number;
      byRef: Map<string, DiscoveryRead["candidates"][number]>;
    }
  >();
  const keyOf = (machine: Machine) =>
    JSON.stringify([machine.tenantId, machine.deviceId]);
  const fresh = (machine: Machine) => {
    const listing = listings.get(keyOf(machine));
    return listing && now() - listing.at < CANDIDATE_TTL_MS
      ? listing
      : undefined;
  };
  return {
    remember(machine, candidates) {
      const key = keyOf(machine);
      listings.delete(key);
      listings.set(key, {
        at: now(),
        byRef: new Map(
          candidates.map((candidate) => [
            candidate.candidate,
            { ...candidate },
          ]),
        ),
      });
      // Insertion order is age order: the oldest listings go first once there are too many.
      for (const old of listings.keys()) {
        if (listings.size <= CANDIDATE_CACHE_LIMIT) break;
        listings.delete(old);
      }
    },
    find(machine, ref) {
      const found = fresh(machine)?.byRef.get(ref);
      return found ? { ...found } : undefined;
    },
    markEnabled(machine, ref) {
      const found = fresh(machine)?.byRef.get(ref);
      if (found) found.enabled = true;
    },
  };
}

/** The runner's app reference shape: `app_` and 128 random bits in base64url. */
const APP_REF = /^app_[A-Za-z0-9_-]{22}$/;

/**
 * What the device's `apps.enable` answered: the app's reference and name, and its tool list as the
 * device gave it (read further by the gateway). Undefined when the reference is not of the runner's
 * shape, the name is not 1..40 characters, or the tools are not a list.
 */
export function readEnabled(
  output: unknown,
): { app: { ref: string; name: string }; tools: unknown[] } | undefined {
  if (!isRecord(output) || !isRecord(output.app)) return undefined;
  const { ref, name } = output.app;
  if (typeof ref !== "string" || !APP_REF.test(ref)) return undefined;
  // Trimmed first, as the device store keeps a reported app's name.
  const shown = typeof name === "string" ? text(name.trim(), 40) : undefined;
  if (!shown) return undefined;
  if (!Array.isArray(output.tools)) return undefined;
  return { app: { ref, name: shown }, tools: output.tools };
}

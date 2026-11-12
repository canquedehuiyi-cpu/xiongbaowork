#!/usr/bin/env bun
/**
 * L1 channel: fetch the official capability bundles, record their checksums in `capability-lock.yaml`.
 *
 * L1 does not copy content, it copies the *ability to fetch* content (§2.2 of the plan). The bundles are
 * deployment artefacts, not source: unpacking 300+ marketplace entries into git would put ~74MB of
 * third-party content under a licence nobody has cleared. What enters the repository instead is a lock
 * file of a few hundred lines: which bundle, from where, at which version, with which checksum.
 *
 * P0 implements the part that can be implemented without a working download channel — the source table,
 * the plan printer, and the lock skeleton. Nothing here opens a socket, which is why `--download` refuses
 * instead of pretending.
 *
 *   bun scripts/fetch-capabilities.ts --dry-run
 *   bun scripts/fetch-capabilities.ts --write-lock
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

/** Where a bundle comes from and where it would be unpacked. */
export interface CapabilitySource {
  /** Stable id, used as the directory name under the cache. */
  id: string;
  /** Which capability kind the bundle carries. */
  kind: "expert" | "skill" | "connector";
  /** The URL the bundle would be downloaded from. */
  url: string;
  /** Path under `.cache/capabilities/` the archive would be unpacked into. */
  cachePath: string;
  /**
   * Whether the URL has been confirmed against a real WorkBuddy client.
   *
   * `false` means the shape is right and the host is the one the plan cites, but nobody has watched the
   * request succeed. Anything unverified must not be fetched by CI, so `--dry-run` prints it as unverified
   * and `--download` refuses the whole run.
   */
  verified: boolean;
  /** What the bundle is expected to contain, for the reviewer of the lock file. */
  note: string;
}

/**
 * The three bundles L1 needs.
 *
 * Hosts come from the plan (§6.4 cites `https://download.codebuddy.cn/…`). The paths below are the
 * expected naming, not observed ones: the point of `verified: false` is that this table is a claim to be
 * checked against a real client in P1, and the lock file records that it was not.
 */
export const CAPABILITY_SOURCES: readonly CapabilitySource[] = [
  {
    id: "expert-marketplace",
    kind: "expert",
    url: "https://download.codebuddy.cn/workbuddy/expert-marketplace.zip",
    cachePath: ".cache/capabilities/expert-marketplace",
    verified: false,
    note: "专家市场全量包，约 428 个专家；本机 L0 已有 9 个包，L1 用它补齐其余",
  },
  {
    id: "skill-marketplace",
    kind: "skill",
    url: "https://download.codebuddy.cn/workbuddy/skill-marketplace.zip",
    cachePath: ".cache/capabilities/skill-marketplace",
    verified: false,
    note: "官方技能市场包，约 293 个技能，约 30MB",
  },
  {
    id: "connector-marketplace",
    kind: "connector",
    url: "https://download.codebuddy.cn/workbuddy/connector-marketplace.zip",
    cachePath: ".cache/capabilities/connector-marketplace",
    verified: false,
    note: "连接器定义包，298 个 mcp.json，约 63MB；只入锁，内容不入仓",
  },
];

/** Repository-relative path of the lock file. */
export const LOCK_FILE = "capability-lock.yaml";

/** One locked bundle. Empty in the P0 skeleton; filled by a real fetch in P1. */
export interface LockEntry {
  id: string;
  kind: CapabilitySource["kind"];
  url: string;
  version: string;
  checksum_sha256: string;
  fetched_at: string;
  redistributable: boolean;
}

/** The lock file's shape: `version` / `source` / `entries`, as the plan specifies. */
export interface LockFile {
  version: number;
  source: {
    workbuddy_home: string;
    cache_dir: string;
    phase: string;
    fetched_at: string | null;
    planned_inputs: { id: string; kind: string; url: string; verified: boolean; note: string }[];
  };
  entries: LockEntry[];
}

/**
 * Build the P0 lock skeleton.
 *
 * `entries` stays empty and `fetched_at` stays null on purpose: an entry means "this exact bundle was
 * fetched and hashed", and writing one without fetching would make the lock assert something untrue.
 */
export function buildLockSkeleton(sources: readonly CapabilitySource[] = CAPABILITY_SOURCES): LockFile {
  return {
    version: 1,
    source: {
      workbuddy_home: "~/.workbuddy",
      cache_dir: ".cache/capabilities",
      phase: "p0",
      fetched_at: null,
      planned_inputs: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        url: source.url,
        verified: source.verified,
        note: source.note,
      })),
    },
    entries: [],
  };
}

/** Render the lock skeleton as YAML. */
export function renderLockFile(lock: LockFile): string {
  return stringify(lock, { lineWidth: 0 });
}

/** Render the human-readable plan `--dry-run` prints. */
export function renderPlan(sources: readonly CapabilitySource[]): string {
  const lines: string[] = [
    "fetch-capabilities 计划（P0：只打印，不下载）",
    "",
    "| id | kind | 校验状态 | url | 缓存路径 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const source of sources) {
    lines.push(
      `| ${source.id} | ${source.kind} | ${source.verified ? "已确认" : "未确认"} | ${source.url} | ${source.cachePath} |`,
    );
  }
  const unverified = sources.filter((source) => !source.verified);
  lines.push("");
  if (unverified.length > 0) {
    lines.push(`注意：${unverified.length} 个地址标记为未确认，P1 开工前必须对真实客户端核一次。`);
  }
  lines.push(`锁文件：${LOCK_FILE}（entries 为空，因为还没有真的下载过任何包）`);
  return `${lines.join("\n")}\n`;
}

/**
 * Refuse to download.
 *
 * A silent no-op would let CI believe L1 ran; an explicit refusal tells the next person that the download
 * channel is the work, not a flag.
 */
export function refuseDownload(): string {
  return [
    "P0 未实现下载通道：本阶段只落锁文件骨架与来源表。",
    "P1 需要先解决两件事，再让 --download 存在：",
    "  1. 逐条核实 CAPABILITY_SOURCES 里的 url（当前全部标记 verified: false）；",
    "  2. 决定 .cache/capabilities/ 的解压布局与 checksum 计算口径（按包还是按文件）。",
    "在此之前请用 --dry-run 或 --write-lock。",
  ].join("\n");
}

/** Command line for this script. */
export interface FetchCliOptions {
  dryRun: boolean;
  writeLock: boolean;
  download: boolean;
}

/** Parse the arguments this script accepts. Throws on anything else. */
export function parseArgs(argv: readonly string[]): FetchCliOptions {
  const options: FetchCliOptions = { dryRun: false, writeLock: false, download: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--write-lock") {
      options.writeLock = true;
    } else if (arg === "--download") {
      options.download = true;
    } else if (arg === "--help" || arg === "-h") {
      options.dryRun = true;
    } else {
      throw new Error(`无法识别的参数：${arg}`);
    }
  }
  if (!options.dryRun && !options.writeLock && !options.download) {
    options.dryRun = true;
  }
  return options;
}

/** Run the script; returns a process exit code. */
export function main(argv: readonly string[], cwd = process.cwd()): number {
  let options: FetchCliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.download) {
    console.error(refuseDownload());
    return 2;
  }
  process.stdout.write(renderPlan(CAPABILITY_SOURCES));
  if (options.writeLock) {
    const path = join(cwd, LOCK_FILE);
    writeFileSync(path, renderLockFile(buildLockSkeleton()), "utf8");
    console.log(`已写出锁文件骨架：${path}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}

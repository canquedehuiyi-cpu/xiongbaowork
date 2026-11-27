/**
 * Re-running a delivery's checks (spec 2026-11-25-borrowed-improvements §5.5): which deliveries claim
 * to have been tested, which commands are safe to run a second time, and whether two runs agree.
 *
 * Pure and shared, so the server's delivery gate and its tests read the same lists.
 */

import { IN_PLACE_COMMAND, VERIFYING_COMMAND } from "./verify";

/** At most this many commands are re-run per delivery. */
export const RERUN_MAX = 3;

/** Each re-run is given this long before it is cut off. */
export const RERUN_TIMEOUT_MS = 120_000;

/** Two numbers disagree when they differ by more than this share of the larger one. */
export const RERUN_DRIFT = 0.1;

/** A `checks` entry that starts with this says why nothing can be re-run. */
export const NO_RERUN_PREFIX = "无法复跑：";

/** The words that, said in `checks` or a note, claim the work was tested. */
export const TESTED_CLAIM_WORDS: readonly string[] = [
  "测试",
  "测过",
  "跑过",
  "运行过",
  "跑通",
  "通过",
  "校验过",
  "验证过",
  "passed",
  "tests pass",
  "pytest",
  "jest",
  "vitest",
];

/**
 * 「测试」 followed by one of these is the name of a thing (a test report, test data), not a claim that
 * something was tested: 「这份测试报告的格式已统一」 says nothing about running anything.
 */
const TEST_NOUN =
  /^(报告|文档|计划|用例|数据|环境|账号|样例|样本|文件|页面|模板|格式|题|表)/;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Latin words match on word boundaries ("jest" is not in "majestic"); Chinese ones anywhere. */
const CLAIM_PATTERNS = TESTED_CLAIM_WORDS.map((word) =>
  /^[\x20-\x7e]+$/.test(word)
    ? new RegExp(`\\b${literal(word).replace(/\s+/g, "\\s+")}`, "gi")
    : new RegExp(literal(word), "g"),
);

function claimsInText(text: string): boolean {
  return CLAIM_PATTERNS.some((pattern, index) => {
    for (const found of text.matchAll(pattern)) {
      if (TESTED_CLAIM_WORDS[index] !== "测试") return true;
      const after = text.slice((found.index ?? 0) + found[0].length);
      if (!TEST_NOUN.test(after)) return true;
    }
    return false;
  });
}

/** Whether any of these lines (a delivery's `checks` and note) claims the work was tested. */
export function claimsTested(texts: readonly string[]): boolean {
  return texts.some(claimsInText);
}

/** `>` or `>>` into anything but `/dev/null` or another stream (`2>&1`). */
const REDIRECT = />{1,2}(?!\s*(?:&\d|\/dev\/null\b))/;

/** What a command must not contain to be run a second time, each with the reason it is not. */
const MUTATING: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: IN_PLACE_COMMAND,
    why: "命令会改动文件（sed -i、patch、mv、cp 等）",
  },
  { pattern: REDIRECT, why: "命令把输出写进文件" },
  { pattern: /\btee\b/, why: "命令把输出写进文件（tee）" },
  { pattern: /(?:^|[\s;&|(])rm\s/, why: "命令会删除文件" },
  {
    pattern: /\bgit\s+(?:commit|push|reset|checkout|merge|rebase)\b/,
    why: "命令会改动代码仓库（git 提交、推送、重置等）",
  },
  {
    pattern:
      /\bcurl\b[^;&|]*(?:-X\s*["']?(?:POST|PUT|PATCH|DELETE)\b|--request\s+["']?(?:POST|PUT|PATCH|DELETE)\b|\s-d\b|\s--data)/i,
    why: "命令会向网络写入数据（curl 发送数据）",
  },
  { pattern: /\b(?:npm|bun|pnpm)\s+publish\b/, why: "命令会发布软件包" },
  { pattern: /\bdocker\s+push\b/, why: "命令会推送镜像" },
  { pattern: /\bkubectl\s+(?:apply|delete)\b/, why: "命令会改动集群" },
  {
    pattern: /\bmake\b[^;&|]*\b(?:install|deploy|release)\b/,
    why: "命令会安装、部署或发布",
  },
];

/**
 * Whether a command may be run a second time at delivery: it must look like a check (a test, a
 * build, a lint, a count) and must change nothing — no writes, deletes, commits or network writes.
 */
export function isRerunnable(
  command: string,
): { ok: true } | { ok: false; why: string } {
  if (!VERIFYING_COMMAND.test(command))
    return { ok: false, why: "不像核对命令（测试、校验、统计数）" };
  for (const { pattern, why } of MUTATING)
    if (pattern.test(command)) return { ok: false, why };
  return { ok: true };
}

/** Numbers that say when or how long, not what: a date, a time of day, a duration. */
const DATE = /\d{4}-\d{2}-\d{2}/g;
const CLOCK = /\d{1,2}:\d{2}(?::\d{2})?/g;
const DURATION =
  /-?\d+(?:\.\d+)?\s*(?:ms|sec|min|s|h)(?![A-Za-z])|-?\d+(?:\.\d+)?\s*(?:秒|分)/g;
const NUMBER = /-?\d+(\.\d+)?/g;

/** The numbers in a command's output, in order, with dates, times of day and durations left out. */
export function numbersOf(output: string): number[] {
  const plain = output
    .replace(DATE, " ")
    .replace(CLOCK, " ")
    .replace(DURATION, " ");
  return [...plain.matchAll(NUMBER)].map((found) => Number(found[0]));
}

/**
 * Whether the re-run's number moved more than the allowed drift away from the earlier run's; two zeros
 * agree. Measured against the earlier run (what the employee reported), not the larger of the two:
 * with the larger one, 100 → 111 would pass as an 11 / 111 drift, though it is 11% off what was said.
 */
function drifted(before: number, after: number): boolean {
  return Math.abs(before - after) > RERUN_DRIFT * Math.abs(before);
}

/**
 * Whether a re-run agrees with the run it repeats: a command that succeeded still succeeds, and the
 * numbers in its output (counts of tests, rows, files) are the same ones, in the same order, each
 * within the allowed drift. When the earlier output was cut short, only the numbers both still hold
 * are compared.
 */
export function outputsAgree(
  before: { exitCode: number; output: string },
  after: { exitCode: number; output: string },
  beforeTruncated = false,
): { agree: true } | { agree: false; why: string } {
  if (before.exitCode === 0 && after.exitCode !== 0)
    return {
      agree: false,
      why: `退出码从 ${before.exitCode} 变成了 ${after.exitCode}`,
    };
  let earlier = numbersOf(before.output);
  let later = numbersOf(after.output);
  if (beforeTruncated) {
    const shared = Math.min(earlier.length, later.length);
    earlier = earlier.slice(0, shared);
    later = later.slice(0, shared);
  } else if (earlier.length !== later.length)
    return {
      agree: false,
      why: `输出里的数字个数不同（原来 ${earlier.length} 个，复跑 ${later.length} 个）`,
    };
  for (const [index, a] of earlier.entries()) {
    const b = later[index] ?? 0;
    if (drifted(a, b))
      return {
        agree: false,
        why: `输出里第 ${index + 1} 个数字从 ${a} 变成了 ${b}`,
      };
  }
  return { agree: true };
}

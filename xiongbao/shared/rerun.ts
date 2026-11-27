/**
 * Re-running a delivery's checks (spec 2026-11-25-borrowed-improvements §5.5): which deliveries claim
 * to have been tested, which commands are safe to run a second time, and whether two runs agree.
 *
 * Pure and shared, so the server's delivery gate and its tests read the same lists.
 */

import { parseCheckCommand } from "./rerun-command";

export { parseCheckCommand, sameCheckCommand } from "./rerun-command";

/** At most this many commands are re-run per delivery. */
export const RERUN_MAX = 3;

/** Each re-run is given this long before it is cut off. */
export const RERUN_TIMEOUT_MS = 120_000;

/**
 * A number in the re-run disagrees when it moved more than this share of the earlier run's number:
 * `|a−b| > RERUN_DRIFT × |a|`, `a` being what the employee's own run printed. Not of the larger of
 * the two: the brief's own case, 100 → 111, has to disagree, and against the larger one it is
 * 11 ≤ 11.1 and would agree (decided 2026-11-27).
 */
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

/**
 * Whether a command may be run a second time at delivery: its whole text must be one known check in
 * its read-only form (an allow list, `rerun-command.ts`), so nothing is written, installed, deleted,
 * migrated or sent anywhere by running it again.
 */
export function isRerunnable(
  command: string,
): { ok: true } | { ok: false; why: string } {
  const parsed = parseCheckCommand(command);
  return parsed.ok ? { ok: true } : { ok: false, why: parsed.why };
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

/** Whether the re-run's number moved more than the allowed drift away from the earlier run's; two zeros agree. */
function drifted(before: number, after: number): boolean {
  return Math.abs(before - after) > RERUN_DRIFT * Math.abs(before);
}

/** The first pair of numbers that drifted apart, said in words; null when every pair agrees. */
function firstDrift(
  earlier: readonly number[],
  later: readonly number[],
  where: string,
): string | null {
  for (const [index, a] of earlier.entries()) {
    const b = later[index] ?? 0;
    if (drifted(a, b))
      return `输出里${where}第 ${index + 1} 个数字从 ${a} 变成了 ${b}`;
  }
  return null;
}

/**
 * Whether a re-run agrees with the run it repeats, both outputs whole: a command that succeeded still
 * succeeds, and the numbers in its output (counts of tests, rows, files) are the same ones, in the
 * same order, each within the allowed drift.
 */
export function outputsAgree(
  before: { exitCode: number; output: string },
  after: { exitCode: number; output: string },
): { agree: true } | { agree: false; why: string } {
  if (before.exitCode === 0 && after.exitCode !== 0)
    return {
      agree: false,
      why: `退出码从 ${before.exitCode} 变成了 ${after.exitCode}`,
    };
  const earlier = numbersOf(before.output);
  const later = numbersOf(after.output);
  if (earlier.length !== later.length)
    return {
      agree: false,
      why: `输出里的数字个数不同（原来 ${earlier.length} 个，复跑 ${later.length} 个）`,
    };
  const why = firstDrift(earlier, later, "");
  return why ? { agree: false, why } : { agree: true };
}

/** One run of a command as it was stored or came back: the two streams, and whether the computer cut them. */
export type RunOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The computer kept only the end of a long stream (`agent-computer` keeps the last 64KB). */
  truncated?: boolean;
};

/**
 * What one stream kept, by where its numbers sit: `start` the numbers known to open the output,
 * `end` those known to close it; both are the whole output when nothing was cut (`whole`).
 */
type Kept =
  | { whole: true; start: number[]; end: number[] }
  | { whole: false; start: number[] | null; end: number[] }
  | { unknown: true };

/** `…（前面省略 N 行）…`: the quiet form, only the last lines kept (`tool-output.ts`). */
const TAIL_MARK = /…（前面省略 \d+ 行）…\n?/;
/** `…（中间省略 N 行，约 M 字节）…`: the long form, start and end kept (`tool-output.ts` `excerpt`). */
const MIDDLE_MARK = /\n?…（中间省略 \d+ 行，约 \d+ 字节）…\n?/;
const ANY_MARK = /…（(?:前面|中间)省略 \d+ 行(?:，约 \d+ 字节)?）…/g;

/** The numbers one stream kept, by where they sit; the omission marks themselves are not numbers. */
function keptOf(text: string, cut: boolean): Kept {
  const marks = text.match(ANY_MARK)?.length ?? 0;
  if (marks > 1) return { unknown: true };
  /** After a cut by bytes the first line may be the end of a line, its number only part of one. */
  const fromCut = (rest: string) => {
    if (!cut) return rest;
    const newline = rest.indexOf("\n");
    return newline === -1 ? "" : rest.slice(newline + 1);
  };
  if (TAIL_MARK.test(text)) {
    const [, rest = ""] = text.split(TAIL_MARK);
    return { whole: false, start: null, end: numbersOf(rest) };
  }
  if (MIDDLE_MARK.test(text)) {
    const [start = "", end = ""] = text.split(MIDDLE_MARK);
    // The computer kept only the end: what is in front of the mark is not the start of the output.
    return cut
      ? { whole: false, start: null, end: numbersOf(end) }
      : { whole: false, start: numbersOf(start), end: numbersOf(end) };
  }
  if (cut) return { whole: false, start: null, end: numbersOf(fromCut(text)) };
  const all = numbersOf(text);
  return { whole: true, start: all, end: all };
}

type StreamVerdict =
  | { agree: true }
  | { agree: false; why: string }
  | { unaligned: string };

/** One stream of the earlier run against the same stream of the re-run, lined up by what each kept. */
function streamAgrees(before: Kept, after: Kept, name: string): StreamVerdict {
  if ("unknown" in before || "unknown" in after)
    return { unaligned: `${name}截断的方式认不出，对不齐` };
  if (before.whole && after.whole) {
    if (before.end.length !== after.end.length)
      return {
        agree: false,
        why: `${name}里的数字个数不同（原来 ${before.end.length} 个，复跑 ${after.end.length} 个）`,
      };
    const why = firstDrift(before.end, after.end, name);
    return why ? { agree: false, why } : { agree: true };
  }
  /*
   * The ends, counted from the end. A whole side has to hold at least what the cut side kept; two cut
   * sides compare what both still hold.
   */
  const ending =
    before.whole || after.whole
      ? before.whole
        ? after.end.length
        : before.end.length
      : Math.min(before.end.length, after.end.length);
  const needed =
    ending + (before.start && !before.whole ? before.start.length : 0);
  if (
    (before.whole && before.end.length < ending) ||
    (after.whole && after.end.length < needed)
  )
    return { unaligned: `${name}两边留下的部分对不齐` };
  const endWhy = firstDrift(
    before.end.slice(before.end.length - ending),
    after.end.slice(after.end.length - ending),
    `${name}结尾`,
  );
  if (endWhy) return { agree: false, why: endWhy };
  // The start, only where the earlier run kept one and the re-run is whole.
  if (!before.whole && before.start && after.whole) {
    const startWhy = firstDrift(
      before.start,
      after.start.slice(0, before.start.length),
      `${name}开头`,
    );
    if (startWhy) return { agree: false, why: startWhy };
  }
  return { agree: true };
}

/**
 * Whether a re-run agrees with the run it repeats, as the earlier run was stored: whole, or cut to its
 * end (the computer's 64KB, or a quiet install's last lines), or to its start and end (a long output's
 * excerpt). Each stream is lined up by what it kept — the end against the end, the start against the
 * start — with the omission marks taken out first. A run that succeeded must still succeed. When the
 * two cannot be lined up the answer is `unaligned`: not checked, never a mismatch.
 */
export function runsAgree(
  before: RunOutput,
  after: RunOutput,
): { agree: true } | { agree: false; why: string } | { unaligned: string } {
  if (before.exitCode === 0 && after.exitCode !== 0)
    return {
      agree: false,
      why: `退出码从 ${before.exitCode} 变成了 ${after.exitCode}`,
    };
  let unaligned: string | null = null;
  for (const [name, earlier, later] of [
    ["标准输出", before.stdout, after.stdout],
    ["标准错误", before.stderr, after.stderr],
  ] as const) {
    const verdict = streamAgrees(
      keptOf(earlier, before.truncated === true),
      keptOf(later, after.truncated === true),
      name,
    );
    if ("unaligned" in verdict) unaligned ??= verdict.unaligned;
    else if (!verdict.agree) return verdict;
  }
  return unaligned ? { unaligned } : { agree: true };
}

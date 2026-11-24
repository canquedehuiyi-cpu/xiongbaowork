/**
 * Scores an open-code-review report against the gold set in gold.json.
 *
 *   bun scripts/review/ocr/benchmark/score.ts --report <report.json> --pr pr-807 [--gold gold.json]
 *       [--tolerance 10] [--out scored.json]
 *
 * A comment can match a gold item when all three hold:
 *   file     the comment's path is the gold location's file (a leading "./" or "a/" "b/" is ignored);
 *   lines    its line range, widened by the tolerance (default ten lines) on both sides, overlaps the
 *            gold location's range; a comment with no line at all counts as a file-level comment and
 *            passes this test for every location in that file;
 *   theme    its text contains at least one of the item's keywords (case-insensitive).
 *
 * Matching is one to one: a comment is credited to at most one gold item, and a gold item is claimed by at
 * most one comment. Candidate pairs are taken best first: the more lines of the gold range the comment's
 * own (unwidened) range covers, then the more of the item's keywords the comment contains, then critical
 * and important before minor, then the order in gold.json and in the report. A comment with no line covers
 * none of the lines, so a line-bearing comment beats it. This greedy order is not the optimal assignment,
 * but it is deterministic and never credits one sentence twice.
 *
 * Recall is over the critical and important items; minor items that were also fixed are scored apart,
 * and a comment that matches only a minor item is neither a hit for recall nor a false positive.
 * Precision is the share of comments that match any gold item. Both are listed with the misses and the
 * unmatched comments, so a human can say which "false positive" is a real finding the gold set lacks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export type GoldLocation = {
  file: string;
  start: number;
  end: number;
  inDiff: boolean;
};
export type GoldItem = {
  id: string;
  severity: "critical" | "important" | "minor";
  summary: string;
  locations: GoldLocation[];
  keywords: string[];
  resolution?: string;
};
export type GoldPr = {
  id: string;
  number: number;
  title: string;
  range: { from: string; to: string; fixedBy: string[] };
  items: GoldItem[];
};
export type Gold = { version: number; tolerance: number; prs: GoldPr[] };

export type Comment = {
  path: string;
  content: string;
  start?: number;
  end?: number;
  severity?: string;
  outsideDiff: boolean;
};

export type Match = { comment: number; item: string; location: number };

export type Scored = {
  pr: string;
  comments: number;
  items: {
    id: string;
    severity: GoldItem["severity"];
    found: boolean;
    inDiff: boolean;
    by: number[];
    summary: string;
  }[];
  recall: { found: number; total: number; rate: number | null };
  recallInDiff: { found: number; total: number; rate: number | null };
  minorRecall: { found: number; total: number; rate: number | null };
  precision: { matched: number; total: number; rate: number | null };
  strictPrecision: { matched: number; total: number; rate: number | null };
  misses: string[];
  unmatched: {
    index: number;
    path: string;
    lines: string;
    severity?: string;
    excerpt: string;
  }[];
};

const rateOf = (part: number, total: number) =>
  total === 0 ? null : Number((part / total).toFixed(4));
const ratio = (found: number, total: number) => ({
  found,
  total,
  rate: rateOf(found, total),
});
const share = (matched: number, total: number) => ({
  matched,
  total,
  rate: rateOf(matched, total),
});

export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^[ab]\//, "");
}

/** Reads the delegation report or a native `ocr review --format json` result, tolerating field aliases. */
export function commentsOf(report: unknown): Comment[] {
  const found: unknown[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.comments)) found.push(...record.comments);
    for (const key of ["files", "results", "reviews", "groups"])
      if (Array.isArray(record[key])) walk(record[key], depth + 1);
  };
  walk(report, 0);
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const comments: Comment[] = [];
  for (const raw of found) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const path = [item.path, item.file, item.file_path, item.filename].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    const content = [item.content, item.message, item.comment, item.body].find(
      (value): value is string => typeof value === "string",
    );
    if (!path || content === undefined) continue;
    const start =
      number(item.start_line) ?? number(item.line) ?? number(item.start);
    const end = number(item.end_line) ?? number(item.end) ?? start;
    comments.push({
      path: normalizePath(path),
      content,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(typeof item.severity === "string" ? { severity: item.severity } : {}),
      outsideDiff: item.outside_diff === true,
    });
  }
  return comments;
}

function overlaps(comment: Comment, location: GoldLocation, tolerance: number) {
  if (comment.start === undefined) return true;
  const end = comment.end ?? comment.start;
  return (
    comment.start - tolerance <= location.end &&
    end + tolerance >= location.start
  );
}

function keywordHits(comment: Comment, keywords: string[]) {
  const text = comment.content.toLowerCase();
  return keywords.filter((word) => text.includes(word.toLowerCase())).length;
}

/** How many lines of the gold range the comment's own range covers (0 for a file-level comment). */
function coverage(comment: Comment, location: GoldLocation) {
  if (comment.start === undefined) return 0;
  const end = comment.end ?? comment.start;
  return Math.max(
    0,
    Math.min(end, location.end) - Math.max(comment.start, location.start) + 1,
  );
}

type Candidate = Match & { covered: number; hits: number; major: boolean };

export function matchesOf(
  comments: Comment[],
  items: GoldItem[],
  tolerance: number,
): Match[] {
  const candidates: Candidate[] = [];
  comments.forEach((comment, index) => {
    items.forEach((item) => {
      const hits = keywordHits(comment, item.keywords);
      if (hits === 0) return;
      let best: { at: number; covered: number } | undefined;
      item.locations.forEach((location, at) => {
        if (normalizePath(location.file) !== comment.path) return;
        if (!overlaps(comment, location, tolerance)) return;
        const covered = coverage(comment, location);
        if (!best || covered > best.covered) best = { at, covered };
      });
      if (best)
        candidates.push({
          comment: index,
          item: item.id,
          location: best.at,
          covered: best.covered,
          hits,
          major: item.severity !== "minor",
        });
    });
  });
  const order = new Map(items.map((item, at) => [item.id, at]));
  candidates.sort(
    (left, right) =>
      right.covered - left.covered ||
      right.hits - left.hits ||
      Number(right.major) - Number(left.major) ||
      (order.get(left.item) ?? 0) - (order.get(right.item) ?? 0) ||
      left.comment - right.comment,
  );
  const usedComments = new Set<number>();
  const usedItems = new Set<string>();
  const matches: Match[] = [];
  for (const candidate of candidates) {
    if (usedComments.has(candidate.comment) || usedItems.has(candidate.item))
      continue;
    usedComments.add(candidate.comment);
    usedItems.add(candidate.item);
    matches.push({
      comment: candidate.comment,
      item: candidate.item,
      location: candidate.location,
    });
  }
  return matches;
}

export function scoreReport(
  report: unknown,
  pr: GoldPr,
  tolerance: number,
): Scored {
  const comments = commentsOf(report);
  const matches = matchesOf(comments, pr.items, tolerance);
  const severityOf = new Map(pr.items.map((item) => [item.id, item.severity]));
  const items = pr.items.map((item) => ({
    id: item.id,
    severity: item.severity,
    found: matches.some((match) => match.item === item.id),
    inDiff: item.locations.some((location) => location.inDiff),
    by: matches.filter((match) => match.item === item.id).map((m) => m.comment),
    summary: item.summary,
  }));
  const major = items.filter((item) => item.severity !== "minor");
  const minor = items.filter((item) => item.severity === "minor");
  const majorInDiff = major.filter((item) => item.inDiff);
  const matchedAny = new Set(matches.map((match) => match.comment));
  const matchedMajor = new Set(
    matches
      .filter((match) => severityOf.get(match.item) !== "minor")
      .map((match) => match.comment),
  );
  return {
    pr: pr.id,
    comments: comments.length,
    items,
    recall: ratio(major.filter((item) => item.found).length, major.length),
    recallInDiff: ratio(
      majorInDiff.filter((item) => item.found).length,
      majorInDiff.length,
    ),
    minorRecall: ratio(minor.filter((item) => item.found).length, minor.length),
    precision: share(matchedAny.size, comments.length),
    strictPrecision: share(matchedMajor.size, comments.length),
    misses: major.filter((item) => !item.found).map((item) => item.id),
    unmatched: comments.flatMap((comment, index) =>
      matchedAny.has(index)
        ? []
        : [
            {
              index,
              path: comment.path,
              lines:
                comment.start === undefined
                  ? "file"
                  : `${comment.start}-${comment.end ?? comment.start}`,
              ...(comment.severity ? { severity: comment.severity } : {}),
              excerpt: comment.content.replace(/\s+/g, " ").slice(0, 80),
            },
          ],
    ),
  };
}

/** Adds several scored PRs up: recall and precision over all their items and comments together. */
export function combine(scored: Scored[]) {
  const sum = (pick: (one: Scored) => { found: number; total: number }) =>
    ratio(
      scored.reduce((all, one) => all + pick(one).found, 0),
      scored.reduce((all, one) => all + pick(one).total, 0),
    );
  const precision = (
    pick: (one: Scored) => { matched: number; total: number },
  ) => {
    return share(
      scored.reduce((all, one) => all + pick(one).matched, 0),
      scored.reduce((all, one) => all + pick(one).total, 0),
    );
  };
  return {
    prs: scored.length,
    recall: sum((one) => one.recall),
    recallInDiff: sum((one) => one.recallInDiff),
    minorRecall: sum((one) => one.minorRecall),
    precision: precision((one) => one.precision),
    strictPrecision: precision((one) => one.strictPrecision),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      report: { type: "string", multiple: true },
      pr: { type: "string", multiple: true },
      gold: {
        type: "string",
        default: new URL("gold.json", import.meta.url).pathname,
      },
      tolerance: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.report?.length || values.report.length !== values.pr?.length) {
    console.error(
      "usage: score.ts --report <file> --pr <id> [--report <file> --pr <id> ...] [--gold f] [--tolerance n] [--out f]",
    );
    process.exit(2);
  }
  const gold = JSON.parse(readFileSync(values.gold, "utf8")) as Gold;
  const tolerance = values.tolerance
    ? Number(values.tolerance)
    : gold.tolerance;
  const scored = values.report.map((file, at) => {
    const id = values.pr?.[at] as string;
    const pr = gold.prs.find((one) => one.id === id);
    if (!pr) throw new Error(`no such PR in the gold set: ${id}`);
    return scoreReport(JSON.parse(readFileSync(file, "utf8")), pr, tolerance);
  });
  const result = { tolerance, perPr: scored, total: combine(scored) };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  const pct = (part: {
    rate: number | null;
    found?: number;
    matched?: number;
    total: number;
  }) =>
    part.rate === null
      ? "n/a"
      : `${part.found ?? part.matched}/${part.total} = ${(part.rate * 100).toFixed(1)}%`;
  for (const one of scored) {
    console.log(
      `${one.pr}: recall(C/I) ${pct(one.recall)}, in-diff ${pct(one.recallInDiff)}, minor ${pct(one.minorRecall)}, precision ${pct(one.precision)}, strict ${pct(one.strictPrecision)}`,
    );
    if (one.misses.length) console.log(`  missed: ${one.misses.join(", ")}`);
    for (const miss of one.unmatched)
      console.log(
        `  unmatched #${miss.index} ${miss.path}:${miss.lines} ${miss.excerpt}`,
      );
  }
  console.log(
    `TOTAL: recall(C/I) ${pct(result.total.recall)}, in-diff ${pct(result.total.recallInDiff)}, minor ${pct(result.total.minorRecall)}, precision ${pct(result.total.precision)}, strict ${pct(result.total.strictPrecision)}`,
  );
}

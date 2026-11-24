/**
 * Pure helpers for running open-code-review in delegation mode: `ocr delegate` picks the files and
 * resolves the rules, the host agent reviews, and this turns the host's comments into the structured
 * report with the coverage numbers the delegation skill asks for. Nothing here touches the network
 * or a model.
 */

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];

export type ReviewComment = {
  path: string;
  content: string;
  start_line?: number;
  end_line?: number;
  category?: Category;
  severity?: Severity;
  /**
   * Set when the comment is anchored in a file the diff did not touch: the host followed a caller or a
   * consumer of the changed code into it. Such a comment is kept, flagged, and scored separately.
   */
  outside_diff?: boolean;
};

export type SkippedFile = { path: string; reason: string };

export type DelegatePreview = {
  mode: string;
  from?: string;
  to?: string;
  merge_base?: string;
  reviewable_files: { path: string; status: string }[];
  excluded_files?: { path: string; reason?: string }[];
};

export type DelegateReport = {
  schema: "ocr-delegate-report/1";
  mode: "delegation";
  range: {
    from?: string | undefined;
    to?: string | undefined;
    merge_base?: string | undefined;
  };
  summary: {
    total_files: number;
    reviewed_files: number;
    skipped_files: number;
    coverage_rate: number;
    comments: number;
  };
  comments: ReviewComment[];
  skipped: SkippedFile[];
  notes: string[];
};

/**
 * Prefixes every line of a unified diff that exists in the new file with its line number, so the
 * host can cite exact lines. Removed lines carry no number, hunk headers pass through unchanged.
 */
export function annotateDiff(diff: string): string {
  const out: string[] = [];
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      line = Number(header[1]);
      inHunk = true;
      out.push(raw);
      continue;
    }
    if (!inHunk || raw.startsWith("diff --git")) {
      if (raw.startsWith("diff --git")) inHunk = false;
      out.push(raw);
      continue;
    }
    if (raw.startsWith("-")) {
      out.push(`      ${raw}`);
    } else if (raw.startsWith("\\")) {
      out.push(raw);
    } else {
      out.push(`${String(line).padStart(5)} ${raw}`);
      line += 1;
    }
  }
  return out.join("\n");
}

export class ReportError extends Error {}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Checks the host's comments against what the preview selected and assembles the report. A comment
 * on a file the preview did not select, an unknown severity or category, or an inverted line range is
 * rejected, and every previewed file must end up reviewed or skipped with a reason: the skill makes
 * coverage mandatory.
 */
export function buildReport(input: {
  preview: DelegatePreview;
  comments: ReviewComment[];
  skipped?: SkippedFile[];
  notes?: string[];
}): DelegateReport {
  const { preview, comments } = input;
  const skipped = input.skipped ?? [];
  const selected = new Set(preview.reviewable_files.map((file) => file.path));
  for (const comment of comments) {
    if (!selected.has(comment.path) && comment.outside_diff !== true)
      throw new ReportError(
        `comment on a file the preview did not select: ${comment.path}`,
      );
    if (selected.has(comment.path) && comment.outside_diff === true)
      throw new ReportError(
        `outside_diff set on a selected file: ${comment.path}`,
      );
    if (!comment.content?.trim())
      throw new ReportError(`empty comment on ${comment.path}`);
    if (comment.severity && !SEVERITIES.includes(comment.severity))
      throw new ReportError(
        `unknown severity ${comment.severity} on ${comment.path}`,
      );
    if (comment.category && !CATEGORIES.includes(comment.category))
      throw new ReportError(
        `unknown category ${comment.category} on ${comment.path}`,
      );
    for (const key of ["start_line", "end_line"] as const) {
      const value = comment[key];
      if (value !== undefined && !isInt(value))
        throw new ReportError(
          `${key} must be a positive integer on ${comment.path}`,
        );
    }
    if (
      comment.start_line !== undefined &&
      comment.end_line !== undefined &&
      comment.end_line < comment.start_line
    )
      throw new ReportError(`end_line before start_line on ${comment.path}`);
  }
  for (const file of skipped) {
    if (!selected.has(file.path))
      throw new ReportError(
        `skipped file the preview did not select: ${file.path}`,
      );
    if (!file.reason?.trim())
      throw new ReportError(`skipped file without a reason: ${file.path}`);
  }
  const skippedPaths = new Set(skipped.map((file) => file.path));
  const total = selected.size;
  const reviewed = total - skippedPaths.size;
  return {
    schema: "ocr-delegate-report/1",
    mode: "delegation",
    range: {
      from: preview.from,
      to: preview.to,
      merge_base: preview.merge_base,
    },
    summary: {
      total_files: total,
      reviewed_files: reviewed,
      skipped_files: skippedPaths.size,
      coverage_rate: total === 0 ? 1 : Number((reviewed / total).toFixed(4)),
      comments: comments.length,
    },
    comments,
    skipped,
    notes: input.notes ?? [],
  };
}

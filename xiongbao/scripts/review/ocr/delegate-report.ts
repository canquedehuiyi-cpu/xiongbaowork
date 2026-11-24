/**
 * Assembles the structured delegation report from the preview and the host's comments.
 *
 *   bun scripts/review/ocr/delegate-report.ts --preview <preview.json> --comments <comments.json>
 *       --out <report.json>
 *
 * comments.json is `{ "comments": [...], "skipped": [{path, reason}], "notes": [...] }` in the field
 * layout of the delegation skill (path, content, start_line, end_line, category, severity).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  buildReport,
  type DelegatePreview,
  type ReviewComment,
  type SkippedFile,
} from "./delegate-lib";

const { values } = parseArgs({
  options: {
    preview: { type: "string" },
    comments: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.preview || !values.comments || !values.out) {
  console.error(
    "usage: delegate-report.ts --preview <f> --comments <f> --out <f>",
  );
  process.exit(2);
}
const preview = JSON.parse(
  readFileSync(values.preview, "utf8"),
) as DelegatePreview;
const given = JSON.parse(readFileSync(values.comments, "utf8")) as {
  comments: ReviewComment[];
  skipped?: SkippedFile[];
  notes?: string[];
};
const report = buildReport({ preview, ...given });
writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary));

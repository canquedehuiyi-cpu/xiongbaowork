/**
 * Prepares one delegation-mode review for a host agent: runs `ocr delegate preview` and
 * `ocr delegate rule`, then writes, per reviewable file, its rule group and its diff with new-file
 * line numbers. Usage:
 *
 *   bun scripts/review/ocr/delegate-pack.ts --from <ref> --to <ref> --out <dir>
 *       [--repo <dir>] [--rule <file>] [--exclude <patterns>]
 *
 * `OCR_BIN` names the ocr executable (default: `ocr` on PATH). The pack is the host's reading
 * material; `delegate-report.ts` turns the host's comments into the report.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { annotateDiff, type DelegatePreview } from "./delegate-lib";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    repo: { type: "string", default: process.cwd() },
    rule: { type: "string", default: "" },
    exclude: { type: "string", default: "" },
  },
});
if (!values.from || !values.to || !values.out) {
  console.error("usage: delegate-pack.ts --from <ref> --to <ref> --out <dir>");
  process.exit(2);
}
const repo = values.repo as string;
const ocr = process.env.OCR_BIN || "ocr";
const scope = [
  "--repo",
  repo,
  "--from",
  values.from,
  "--to",
  values.to,
  "--format",
  "json",
  ...(values.rule ? ["--rule", values.rule] : []),
  ...(values.exclude ? ["--exclude", values.exclude] : []),
];

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

const preview = JSON.parse(
  run(ocr, ["delegate", "preview", ...scope]),
) as DelegatePreview;
const paths = preview.reviewable_files.map((file) => file.path);
const rules = JSON.parse(
  run(ocr, ["delegate", "rule", ...scope, ...paths]),
) as {
  groups: { group_id: number; rule: string; files: string[] }[];
};

const out = values.out as string;
mkdirSync(join(out, "diffs"), { recursive: true });
writeFileSync(
  join(out, "preview.json"),
  `${JSON.stringify(preview, null, 2)}\n`,
);
writeFileSync(join(out, "rules.json"), `${JSON.stringify(rules, null, 2)}\n`);

const groupOf = new Map<string, number>();
for (const group of rules.groups)
  for (const file of group.files) groupOf.set(file, group.group_id);

const index: string[] = [];
for (const file of preview.reviewable_files) {
  const diff = run("git", [
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    `${preview.merge_base}..${preview.to}`,
    "--",
    file.path,
  ]);
  const name = `${String(index.length + 1).padStart(2, "0")}-${file.path.replaceAll("/", "__")}.diff`;
  writeFileSync(join(out, "diffs", name), annotateDiff(diff));
  index.push(
    `${name}\t${file.status}\trule-group ${groupOf.get(file.path) ?? "?"}\t${diff.split("\n").length} lines`,
  );
}
writeFileSync(join(out, "index.tsv"), `${index.join("\n")}\n`);
console.log(
  `${paths.length} reviewable files, ${rules.groups.length} rule groups -> ${out}`,
);

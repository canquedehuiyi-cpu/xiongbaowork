import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseLog(raw) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Bun logs contain ANSI colour escapes.
  const text = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const counts = [...text.matchAll(/^\s*(\d+) fail\s*$/gm)];
  const ran = text.match(/^Ran (\d+) tests? across /m);
  if (!counts.length || !ran || Number(ran[1]) === 0) {
    throw new Error("No completed Bun test summary; this run is unverified.");
  }
  if (
    /remaining connection slots|too many clients|\(unnamed\)|error:.*preload|^\s*[1-9]\d* errors?\s*$/im.test(
      text,
    )
  ) {
    throw new Error(
      "Infrastructure/import failure; this run cannot be compared.",
    );
  }
  const failures = new Map();
  for (const match of text.matchAll(/^\(fail\) (.+)$/gm)) {
    const name = match[1].replace(/\s+\[[\d.]+m?s\]\s*$/, "");
    failures.set(name, (failures.get(name) ?? 0) + 1);
  }
  const fail = Number(counts.at(-1)[1]);
  if (fail > 0 && failures.size === 0) {
    throw new Error(
      "Bun reports failures without names; comparison is unverified.",
    );
  }
  return { fail, failures };
}

export function difference(left, right) {
  return [...left]
    .map(([name, count]) => [name, count - (right.get(name) ?? 0)])
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

function names(items) {
  return items.length
    ? items.map(([name, count]) => `- ${count} × ${name}`).join("\n")
    : "- 无";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [basePath, headPath, label] = process.argv.slice(2);
  let summary;
  try {
    const base = parseLog(readFileSync(basePath, "utf8"));
    const head = parseLog(readFileSync(headPath, "utf8"));
    summary = `## ${label}\n\n基线：${process.env.DELIVERY_BASELINE_SHA ?? "local"}（同一测试范围，独立库）\n\n基线 ${base.fail} fail；本次 ${head.fail} fail。仅日志明确 0 fail 才判绿。\n\n### 新增失败（多重集差集）\n\n${names(difference(head.failures, base.failures))}\n\n### 消失的失败（多重集差集）\n\n${names(difference(base.failures, head.failures))}\n\n阶段 0–2 的 continue-on-error 不是 DoD-1 全绿。阶段 3 必须移除。\n`;
    process.exitCode = head.fail === 0 ? 0 : 1;
  } catch (error) {
    summary = `## ${label}\n\n未验证：${error.message}\n`;
    process.exitCode = 1;
  }
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

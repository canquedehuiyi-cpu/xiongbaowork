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
  // An unnamed failure (a hook that threw) cannot be compared. Bun 1.4 also prints `(skip) … > (unnamed)`
  // for the hooks of a skipped describe, which is not a failure and must not invalidate the run.
  if (
    /remaining connection slots|too many clients|^\(fail\)[^\n]*\(unnamed\)|error:.*preload|^\s*[1-9]\d* errors?\s*$/im.test(
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

/**
 * 每个失败用例前面 Bun 打出的那段报错（从上一个用例的结果行之后到它自己的 `(fail)` 行）。
 * 任务日志里只列名字时，偶发失败（只在 CI 的负载下出现）就看不到原因；附件又不一定下得到。
 * 太长的只留最靠近失败的 `lines` 行，最多 `limit` 个失败。
 */
export function failureExcerpts(raw, { limit = 5, lines = 40 } = {}) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Bun logs contain ANSI colour escapes.
  const text = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const excerpts = [];
  let since = [];
  for (const line of text.split("\n")) {
    const fail = line.match(/^\(fail\) (.+)$/);
    if (fail) {
      if (excerpts.length < limit)
        excerpts.push({
          name: fail[1].replace(/\s+\[[\d.]+m?s\]\s*$/, ""),
          lines: since.filter((kept) => kept.trim() !== "").slice(-lines),
        });
      since = [];
    } else if (/^\((pass|skip|todo)\) /.test(line)) since = [];
    else since.push(line);
  }
  return excerpts;
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
    // The head log alone decides the gate. A baseline that cannot be parsed (the frozen baseline
    // predates fixes this branch carries, e.g. its migrations) only loses the comparison section.
    const head = parseLog(readFileSync(headPath, "utf8"));
    let base;
    let baseProblem;
    try {
      base = parseLog(readFileSync(basePath, "utf8"));
    } catch (error) {
      baseProblem = error.message;
    }
    const comparison = base
      ? `基线 ${base.fail} fail；本次 ${head.fail} fail。仅日志明确 0 fail 才判绿。\n\n### 新增失败（多重集差集）\n\n${names(difference(head.failures, base.failures))}\n\n### 消失的失败（多重集差集）\n\n${names(difference(base.failures, head.failures))}`
      : `基线不可比较：${baseProblem}\n\n本次 ${head.fail} fail。仅日志明确 0 fail 才判绿。\n\n### 本次失败\n\n${names([...head.failures].sort(([a], [b]) => a.localeCompare(b)))}`;
    summary = `## ${label}\n\n基线：${process.env.DELIVERY_BASELINE_SHA ?? "local"}（同一测试范围，独立库）\n\n${comparison}\n\n本次测试步骤不带 continue-on-error（阶段 3 已移除）：任一失败直接判红；只有基线步骤保留它，仅供比较。\n`;
    process.exitCode = head.fail === 0 ? 0 : 1;
  } catch (error) {
    summary = `## ${label}\n\n未验证：${error.message}\n`;
    process.exitCode = 1;
  }
  console.log(summary);
  // 报错片段只进任务日志，不进步骤摘要：摘要保持短，日志里能看到失败的原因。
  try {
    for (const { name, lines } of failureExcerpts(
      readFileSync(headPath, "utf8"),
    ))
      console.log(`### 失败片段：${name}\n\n${lines.join("\n")}\n`);
  } catch {}
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

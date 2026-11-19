/**
 * 后台长跑冒烟（期九·六）`disconnect` / `reconnect` 用的题：一个要 8 次以上工具调用、预计 3 到 5 分钟的小任务，
 * 带一个校验脚本，退出码 0 就算做对。
 *
 * 题：给一个小语料（6 个英文文本 + 停用词表），让员工写词频统计程序、写测试并跑通、生成 counts.json 和
 * report.md。要读语料、写程序、写测试、跑程序、跑测试、对结果，一步一步下来是十几次工具调用，足够员工在
 * 断开和重连时还在中途。
 *
 * 语料用固定种子生成（每次落地都一样），写在这里而不是夹具目录：和 smoke.ts 里其他场景一样，其中的测试
 * 文件不能放成 `*.test.ts` 被仓库的 `bun test ./scripts/` 收走。
 *
 * 校验脚本不放进员工的工作区：它是一段文本，评测脚本把员工的产物拷进临时目录、把原始语料盖回去，再用
 * `bun verify.ts <目录>` 跑它。员工看不到它，也改不了语料。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyTree } from "./lib";

/** 种子固定的伪随机数，保证语料每次一样。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const STOPWORDS = ["the", "and", "of", "to", "in", "a", "is", "it"];
const CONTENT_WORDS = [
  "river",
  "stone",
  "lantern",
  "harbor",
  "violin",
  "meadow",
  "copper",
  "winter",
  "garden",
  "bridge",
  "ember",
  "falcon",
  "marble",
  "orchard",
  "thunder",
  "willow",
];
const PUNCTUATION = ["", "", "", ",", ".", "!", ";", " -", "?"];

/** 6 个语料文件，每个约 200 个词，大小写、标点、连字符混着来。 */
export function corpusFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < 6; index += 1) {
    const next = lcg(20_261_119 + index);
    const words: string[] = [];
    for (let count = 0; count < 200; count += 1) {
      const pool = next() < 0.35 ? STOPWORDS : CONTENT_WORDS;
      // 前几个词出现得更多，让名次有区分又留一些并列。
      const pick = Math.floor(next() * next() * pool.length);
      let word = pool[pick] as string;
      const style = next();
      if (style < 0.12) word = word.toUpperCase();
      else if (style < 0.3) word = word[0]?.toUpperCase() + word.slice(1);
      else if (style < 0.36)
        word = `${word}-${CONTENT_WORDS[Math.floor(next() * 4)]}`;
      words.push(
        word + (PUNCTUATION[Math.floor(next() * PUNCTUATION.length)] ?? ""),
      );
    }
    const lines: string[] = [];
    for (let at = 0; at < words.length; at += 12)
      lines.push(words.slice(at, at + 12).join(" "));
    files[`corpus/part${index + 1}.txt`] = `${lines.join("\n")}\n`;
  }
  return files;
}

/** 落进员工工作区的全部夹具。 */
export function wordfreqFiles(): Record<string, string> {
  return {
    ...corpusFiles(),
    "stopwords.txt": `${STOPWORDS.join("\n")}\n`,
  };
}

export const WORDFREQ_PROMPT = [
  "{dir}/ 下有一个小语料：corpus/ 里是 6 个英文文本文件（*.txt），stopwords.txt 是停用词表（每行一个词）。请做一个词频统计小程序，全部做完再回复。先用命令看一眼 corpus/ 里的文件和 stopwords.txt 长什么样，不要凭空写。",
  "1. 写 {dir}/wordfreq.ts（Bun + TypeScript，不装任何依赖）。在 {dir} 里不带参数运行 `bun wordfreq.ts`，它读 corpus/ 下全部 .txt 文件统计词频。单词 = 连续的英文字母，统一转小写，其余字符都当分隔符（所以 well-known 是 well 和 known 两个词）；stopwords.txt 里的词不统计；按次数从多到少排，次数相同的按字母顺序排。",
  '2. 程序把前 10 名写成 {dir}/counts.json，格式 [["word", 次数], ...]；同时写 {dir}/report.md：一个 Markdown 表格，三列「名次 | 单词 | 次数」，共 10 行数据。',
  "3. 写 {dir}/wordfreq.test.ts，至少 3 个测试（分词、停用词、同次数的排序），用 bun test 跑通。",
  "4. 最后在 {dir} 里实际运行一次 `bun wordfreq.ts` 和 `bun test`，核对结果。",
].join("\n");

/**
 * 校验脚本：`bun verify.ts <目录>`，目录里是员工的产物加上原始语料。退出码 0 = 全部通过；没过的项逐行打在标准
 * 输出里（`FAIL …`）。它自己从语料算出标准答案，重新运行员工的程序，不信员工留下的 counts.json。
 */
export const VERIFY_SCRIPT = `import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const failures: string[] = [];
const fail = (reason: string) => failures.push(reason);

const stop = new Set(
  readFileSync(join(dir, "stopwords.txt"), "utf8").split(/\\r?\\n/).map((w) => w.trim()).filter(Boolean),
);
const counts = new Map<string, number>();
for (const name of readdirSync(join(dir, "corpus")).filter((n) => n.endsWith(".txt")).sort())
  for (const word of readFileSync(join(dir, "corpus", name), "utf8").toLowerCase().match(/[a-z]+/g) ?? [])
    if (!stop.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
const expected = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);

if (!existsSync(join(dir, "wordfreq.ts"))) fail("wordfreq.ts is missing");
else {
  for (const name of ["counts.json", "report.md"]) rmSync(join(dir, name), { force: true });
  const run = Bun.spawnSync([process.execPath, "wordfreq.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  if (run.exitCode !== 0) fail("bun wordfreq.ts exited " + run.exitCode);
  try {
    const got = JSON.parse(readFileSync(join(dir, "counts.json"), "utf8"));
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail("counts.json is not the expected top 10");
  } catch {
    fail("counts.json is missing or not JSON");
  }
  try {
    const report = readFileSync(join(dir, "report.md"), "utf8");
    let at = -1;
    for (const [word, n] of expected) {
      const line = report.split(/\\r?\\n/).findIndex((l, i) => i > at && new RegExp("\\\\b" + word + "\\\\b").test(l) && new RegExp("\\\\b" + n + "\\\\b").test(l));
      if (line < 0) { fail("report.md has no line for " + word + " " + n + " in order"); break; }
      at = line;
    }
  } catch {
    fail("report.md is missing");
  }
}

const tests = readdirSync(dir).filter((n) => /\\.test\\.(ts|js)$/.test(n));
if (tests.length === 0) fail("no test file");
else {
  const run = Bun.spawnSync([process.execPath, "test"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const text = run.stdout.toString() + run.stderr.toString();
  const passed = Number(/(\\d+) pass/.exec(text)?.[1] ?? 0);
  if (run.exitCode !== 0) fail("bun test exited " + run.exitCode);
  else if (passed < 3) fail("fewer than 3 tests passed (" + passed + ")");
}

for (const reason of failures) console.log("FAIL " + reason);
process.exit(failures.length === 0 ? 0 : 1);
`;

/** 在临时目录里跑校验脚本：员工的产物 + 原始语料，返回退出码和没过的项。 */
export function runWordfreqVerify(dir: string): {
  ok: boolean;
  detail: string;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "smoke-wordfreq-"));
  const tool = mkdtempSync(join(tmpdir(), "smoke-verify-"));
  try {
    copyTree(dir, sandbox);
    // 原始语料盖回去：员工动过语料也不影响标准答案。
    rmSync(join(sandbox, "corpus"), { recursive: true, force: true });
    for (const [path, contents] of Object.entries(wordfreqFiles())) {
      mkdirSync(dirname(join(sandbox, path)), { recursive: true });
      writeFileSync(join(sandbox, path), contents);
    }
    const script = join(tool, "verify.ts");
    writeFileSync(script, VERIFY_SCRIPT);
    const run = Bun.spawnSync([process.execPath, script, sandbox], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 150_000,
    });
    const failures = run.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("FAIL "))
      .map((line) => line.slice(5));
    return {
      ok: run.exitCode === 0,
      detail:
        run.exitCode === 0
          ? "校验脚本退出 0"
          : `校验脚本退出 ${run.exitCode}：${failures.join("；") || "无输出"}`,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(tool, { recursive: true, force: true });
  }
}

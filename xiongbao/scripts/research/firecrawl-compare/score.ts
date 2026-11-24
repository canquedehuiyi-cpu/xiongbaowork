/**
 * 评分：拿标准答案（见 pages.ts）去量一段工具输出。纯函数，不碰网络和文件。
 *
 * 比较前两边都只留字母和数字（汉字、拉丁字母、数字），空白、Markdown 符号、标点一律丢掉，这样表格写成
 * `| a | b |` 还是 `a b` 都不影响内容比较；表格的结构保真单独由行检查来量。
 */
import type { Truth } from "./pages";

/** 只留字母与数字，统一小写。 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const SHINGLE = 6;

function shingles(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length <= SHINGLE) {
    if (text) set.add(text);
    return set;
  }
  for (let i = 0; i + SHINGLE <= text.length; i++)
    set.add(text.slice(i, i + SHINGLE));
  return set;
}

/** 标准段落里连续 6 个字符的片段，有多少比例出现在输出里（0 到 1）。 */
export function bodyRecall(output: string, paragraphs: string[]): number {
  const have = shingles(normalize(output));
  let total = 0;
  let hit = 0;
  for (const paragraph of paragraphs) {
    for (const piece of shingles(normalize(paragraph))) {
      total++;
      if (have.has(piece)) hit++;
    }
  }
  return total === 0 ? 1 : hit / total;
}

/** 关键事实有多少条原样出现（比较前同样只留字母数字）。 */
export function factRecall(output: string, facts: string[]): number {
  if (facts.length === 0) return 1;
  const flat = normalize(output);
  return (
    facts.filter((fact) => flat.includes(normalize(fact))).length / facts.length
  );
}

/** 噪声词句有多少条出现在输出里，越低越好。没有噪声词的页返回 null。 */
export function noiseRate(output: string, noise: string[]): number | null {
  if (noise.length === 0) return null;
  const flat = normalize(output);
  return (
    noise.filter((item) => flat.includes(normalize(item))).length / noise.length
  );
}

/** 表格单元格有多少个出现在输出里。没有表格返回 null。 */
export function cellRecall(output: string, rows: string[][]): number | null {
  const cells = rows.flat();
  if (cells.length === 0) return null;
  const flat = normalize(output);
  return (
    cells.filter((cell) => flat.includes(normalize(cell))).length / cells.length
  );
}

/**
 * 表格行保真：一行的全部单元格按列顺序出现在输出的同一行文字里才算保住。输出把表格拆成一格一行或者
 * 压成一段，这一项就会掉。没有表格返回 null。
 */
export function rowFidelity(output: string, rows: string[][]): number | null {
  if (rows.length === 0) return null;
  const lines = output.split(/\r?\n/).map(normalize);
  const kept = rows.filter((row) => {
    const joined = row.map(normalize).join("");
    return lines.some((line) => line.includes(joined));
  });
  return kept.length / rows.length;
}

export type PageScore = {
  chars: number;
  bodyRecall: number;
  factRecall: number;
  noiseRate: number | null;
  cellRecall: number | null;
  rowFidelity: number | null;
  /** 只对需要脚本渲染的页有意义：正文召回过 0.8 且事实全到。其他页为 null。 */
  gotJsBody: boolean | null;
};

export function scoreOutput(output: string, truth: Truth): PageScore {
  const body = bodyRecall(output, truth.paragraphs);
  const facts = factRecall(output, truth.facts);
  return {
    chars: output.length,
    bodyRecall: round(body),
    factRecall: round(facts),
    noiseRate: roundOrNull(noiseRate(output, truth.noise)),
    cellRecall: roundOrNull(cellRecall(output, truth.tableRows)),
    rowFidelity: roundOrNull(rowFidelity(output, truth.tableRows)),
    gotJsBody: truth.needsJs ? body >= 0.8 && facts === 1 : null,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : round(value);
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

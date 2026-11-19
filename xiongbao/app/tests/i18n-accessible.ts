import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * 可访问名与 toast 标题的取数，供 i18n-accessible-names.test.ts 用。拆出来是为了：
 * 判据（测试）与取数（本文件）分开写得清；再者 `bun -e` 也能直接调用它列出全部命中，
 * 允许表就是照那份清单一条条写的，不是凭印象补的。
 *
 * 不复用 scripts/brand/guard/scan.ts：它把仓库根算成 `URL.pathname`，Windows 下既多一个
 * 前导斜杠、又把中文目录百分号编码，一导入就 ENOENT。
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));

export const CJK = /[\u3400-\u9fff]/;

function walkFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, into);
    else into.push(path);
  }
  return into;
}

/**
 * 去掉块注释与行注释，保留换行（行号不变）。字符串和模板里的斜杠不动。
 * `//` 只在上一个非空字符是 `;{}(),` 一类收尾符时才算注释——这样正则里的 `/a\/\/b/` 不会被
 * 当成注释把整行吃掉（吃掉就会**漏报**，那是这量具最不该犯的错）。
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let block = false;
  let quote: string | null = null;
  let lastSignificant = "\n";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (block) {
      if (char === "*" && next === "/") {
        block = false;
        index += 2;
        continue;
      }
      if (char === "\n") out += "\n";
      index += 1;
      continue;
    }
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      block = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "/" && ";{}(),".includes(lastSignificant)) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
    if (char.trim()) lastSignificant = char;
    index += 1;
  }
  return out;
}

export function commentFreeLines(
  source: string,
): { line: string; number: number }[] {
  return stripComments(source)
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }));
}

/** `aria-label="…"` / `placeholder="…"` / `title="…"`，只认双引号或单引号的字面量。 */
const NAMED_ATTRIBUTE =
  /\b(aria-label|placeholder|title)=(?:"([^"]*)"|'([^']*)')/g;

export type NameHit = {
  file: string;
  number: number;
  attribute: string;
  text: string;
};

/** 从一份源码里抠出「没有汉字」的可访问名。 */
export function accessibleNamesIn(file: string, source: string): NameHit[] {
  const hits: NameHit[] = [];
  for (const { line, number } of commentFreeLines(source)) {
    for (const match of line.matchAll(NAMED_ATTRIBUTE)) {
      const text = (match[2] ?? match[3] ?? "").trim();
      if (!text || CJK.test(text)) continue;
      hits.push({ file, number, attribute: match[1], text });
    }
  }
  return hits;
}

export type Source = { file: string; source: string };

/** `app/src` 下的全部 TS/TSX，路径相对仓库根、正斜杠。 */
export function appSources(): Source[] {
  return walkFiles(join(REPO, "app/src"))
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => ({
      file: relative(REPO, file).replace(/\\/g, "/"),
      source: readFileSync(file, "utf8"),
    }));
}

/** 全部英文可访问名，只算 `.tsx`——`.ts` 里没有 JSX 属性。 */
export function everyNameHit(sources: Source[] = appSources()): NameHit[] {
  return sources.flatMap(({ file, source }) =>
    file.endsWith(".tsx") ? accessibleNamesIn(file, source) : [],
  );
}

/*
 * toast 的标题不在 JSX 属性里，是对象字段（`toast.add({ title: … })`）。判据：标题要么是含汉字
 * 的字面量，要么指向一个能在本仓库找到定义的常量（那个常量的值也得含汉字）；按函数算出来的、
 * 或服务端原样转述的，静态看不出来，进 allowlist。
 */
const TOAST_CALL = /\btoast\.add\(/g;

function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, index);
    }
  }
  return source.slice(openParen + 1);
}

/** `title:` 之后、到同层逗号或收尾为止的那段表达式。 */
function titleExpression(args: string): string | null {
  const start = /\btitle:\s*/.exec(args);
  if (!start) return null;
  let depth = 0;
  let out = "";
  for (const char of args.slice(start.index + start[0].length)) {
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === "," && depth === 0) break;
    out += char;
  }
  return out.trim();
}

const LITERAL = /^(["'`])([\s\S]*)\1$/;

/**
 * 仓库里 `const NAME = "…"` 的定义，用来把常量标题展开成它的值。
 * 在整段源码上匹配而不是逐行——`AUTO_COMPACTION_FAILED_NOTICE` 就是等号换行、值在下一行。
 */
export function constants(
  sources: Source[] = appSources(),
): Map<string, string> {
  const found = new Map<string, string>();
  for (const { source } of sources) {
    for (const match of stripComments(source).matchAll(
      /\b(?:const|let)\s+(\w+)\s*=\s*(["'`])([\s\S]*?)\2/g,
    )) {
      found.set(match[1], match[3]);
    }
  }
  return found;
}

export type ToastHit = {
  file: string;
  line: number;
  title: string;
  literal: string | null;
  call: string | null;
};

/** 每处 `toast.add` 的标题，以及它静态展开后的值（拿不到就是 null）。 */
export function toastTitlesIn(
  file: string,
  source: string,
  table: Map<string, string>,
): ToastHit[] {
  const hits: ToastHit[] = [];
  for (const match of source.matchAll(TOAST_CALL)) {
    const open = match.index + match[0].length - 1;
    const expression = titleExpression(callArguments(source, open));
    if (expression === null) continue;
    const literal = LITERAL.exec(expression);
    const call = /^([A-Za-z_$][\w$]*)\(/.exec(expression);
    hits.push({
      file,
      // 行号算在原始源码上：剥注释后的文本更短，拿原索引去切会往后偏。
      line: source.slice(0, match.index).split("\n").length,
      title: expression,
      literal: literal ? literal[2] : (table.get(expression) ?? null),
      call: call ? call[1] : null,
    });
  }
  return hits;
}

export function everyToastHit(sources: Source[] = appSources()): ToastHit[] {
  const table = constants(sources);
  return sources.flatMap(({ file, source }) =>
    toastTitlesIn(file, source, table),
  );
}

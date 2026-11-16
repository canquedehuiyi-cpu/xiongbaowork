import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { addressOf, SCANNED, UNCOVERED } from "./i18n-route-table";

/**
 * DoD-7 的守卫：`app/src/routes` 下**每一个**路由文件，要么在扫表里，要么在台账里有一条写明的理由。
 *
 * 这不是「文件是否存在」那种检查——文件当然都在，不然 `tsc` 早就红了。它查的是另一件事：
 * **这个文件有没有被扫过**。没有守卫的时候，加一个路由文件是静默的：扫表还是那几行，扫出来还是 0 行
 * 纯英文，报告照样漂亮，只是新页面从来没进过镜头。`server-tests.list.txt` 那类「文件存在但从不运行」
 * 的坑，形状完全一样。
 *
 * 三条断言，各挡一种退化：
 *
 * 1. `SCANNED` 里的 `at` 必须与文件名推出来的地址一致 —— 挡「地址写错了，扫的其实是另一页」。
 * 2. `UNCOVERED` 里的文件不许再出现在 `SCANNED` 里 —— 挡「已经扫住了，台账没跟着改」，也就是记分牌
 *    比现实乐观。这是棘轮：覆盖率只会涨，因为要涨就得删台账。
 * 3. 磁盘上的文件必须全部分配完 —— 挡「新加了页面，没人记得分类」。
 */

const ROUTES = join(import.meta.dir, "..", "src", "routes");

/** `app/src/routes` 下全部 `.tsx`，正斜杠相对路径，和台账里的写法一致。 */
function routeFiles(dir = ROUTES): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name.endsWith(".tsx"))
      out.push(relative(ROUTES, full).split(sep).join("/"));
  }
  return out.sort();
}

const FILES = routeFiles();
const SCANNED_FILES = new Set(SCANNED.map((one) => one.file));
const LEDGER = new Map(
  UNCOVERED.flatMap((bucket) =>
    bucket.files.map((file) => [file, bucket.why] as const),
  ),
);

describe("DoD-7 覆盖台账", () => {
  test("扫表里的地址与文件名对得上", () => {
    const wrong = SCANNED.filter((one) => addressOf(one.file) !== one.at).map(
      (one) => `${one.file} 推出 ${addressOf(one.file)}，台账写 ${one.at}`,
    );
    expect(wrong).toEqual([]);
  });

  test("台账里的文件都还在磁盘上", () => {
    const known = new Set(FILES);
    const listed = [...SCANNED.map((one) => one.file), ...LEDGER.keys()];
    expect(listed.filter((file) => !known.has(file))).toEqual([]);
  });

  test("没有任何路由文件落在两者之外", () => {
    expect(
      FILES.filter((file) => !SCANNED_FILES.has(file) && !LEDGER.has(file)),
    ).toEqual([]);
  });

  /*
   * 这一条是棘轮的方向：扫住了却还挂在台账里，说明有人把扫表扩了、没把台账收窄。那会让台账比现实
   * 悲观——不致命，但会让「还剩多少没扫」这个数慢慢变成假话，下一次就没人信它了。
   */
  test("扫住了的文件不再挂在未覆盖台账里", () => {
    expect(
      [...LEDGER.keys()].filter((file) => SCANNED_FILES.has(file)),
    ).toEqual([]);
  });

  test("同一个文件只在一处", () => {
    const seen = new Map<string, number>();
    for (const file of LEDGER.keys()) seen.set(file, (seen.get(file) ?? 0) + 1);
    expect([...seen].filter(([, times]) => times > 1).map(([f]) => f)).toEqual(
      [],
    );
  });

  /*
   * 数出来的账打出来。测试通过时没人看日志，但它失败的时候——或者有人问「到底盖了多少」的时候——
   * 这几行就是答案，不用再去数。
   */
  test("打印台账", () => {
    const rows = [
      `路由文件 ${FILES.length} 个：已扫 ${SCANNED.length}`,
      ...UNCOVERED.map(
        (one) => `  ${one.why} ${one.files.length}：${one.note}`,
      ),
    ];
    console.log(`\n${rows.join("\n")}\n`);
    expect(FILES.length).toBe(SCANNED.length + LEDGER.size);
  });
});

/**
 * `usage.test.ts` 那种「这个文件被谁引用」的检查不在这里：这一份只回答「扫没扫到」。
 * 但有一件事顺手可查——扫表用的 `file` 必须真的导出一个 `Route`，否则扫表指向一个空文件也能全绿。
 * 那属于 `i18n-dom-scan.test.tsx` 的 `ROUTES` 表要保证的事，两边由测试文件里的断言对齐。
 */
test("扫表里的每个文件都导出了 Route", () => {
  const missing = SCANNED.filter((one) => {
    const source = readFileSync(join(ROUTES, one.file), "utf8");
    return !/export const Route = createFileRoute\(/.test(source);
  }).map((one) => one.file);
  expect(missing).toEqual([]);
});

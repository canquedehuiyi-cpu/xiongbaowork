import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveMoveIn, SETTINGS_MOVES } from "@/lib/settings/moves";

/*
 * 应用内链接扫描（设计 §10.1 第三条）：`app/src` 里任何 `to="..."`、`to: "..."`、`href="/..."` 不得指向
 * `SETTINGS_MOVES` 里的旧地址。表是唯一的名单，后续 PR 加行后这里自动多查一条，不用改本文件。
 *
 * 不扫的：`moves.ts` 自己（表就写在那里）、`routeTree.gen.ts`（生成的）、`routes/` 下旧地址自己的重定向
 * 文件（它们是旧地址的家，文件名就是旧地址；里面若写了去向，去向也不该是旧地址，所以只放过「旧地址
 * 文件本身」不放过别的文件）。
 */
const SRC = path.resolve(import.meta.dir, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** `to="/x"`、`to: "/x"`、`href="/x"`、`href: "/x"`、`to={"/x"}`（单双引号与反引号都算）。 */
const LINK_TARGET = /\b(?:to|href)\s*(?:=\s*\{?|:\s*)\s*(["'`])(\/[^"'`]*)\1/g;

/** 去掉地址里的 `?查询` 和 `#锚点`，并把 `${...}` 插值当成一段。 */
function pathOf(target: string): string {
  return (target.split(/[?#]/)[0] ?? "").replace(/\$\{[^}]*\}/g, "x");
}

function isOldAddress(target: string): boolean {
  const pathname = pathOf(target);
  // TanStack 的类型化写法里 `$key` 是路由模式本身，不是具体地址：按「一段」代入再匹配。
  const concrete = pathname.replace(/\$[A-Za-z]+/g, "x");
  return (
    resolveMoveIn(SETTINGS_MOVES, concrete, {}) !== null ||
    resolveMoveIn(SETTINGS_MOVES, pathname, {}) !== null
  );
}

test("扫描器认得出各种写法的链接", () => {
  const found = (text: string) =>
    [...text.matchAll(LINK_TARGET)].map((match) => match[2]);
  expect(found('<Link to="/a/b">')).toEqual(["/a/b"]);
  expect(found('linkOptions({ to: "/a" })')).toEqual(["/a"]);
  expect(found('<a href="/a#x">')).toEqual(["/a#x"]);
  expect(found("navigate({ href: `/a/b` })")).toEqual(["/a/b"]);
});

test("app/src 里没有链接指向 SETTINGS_MOVES 的旧地址", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file);
    if (relative === path.join("lib", "settings", "moves.ts")) continue;
    if (relative === "routeTree.gen.ts") continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(LINK_TARGET)) {
      const target = match[2] as string;
      if (isOldAddress(target)) offenders.push(`${relative}: ${target}`);
    }
  }
  expect(offenders).toEqual([]);
});

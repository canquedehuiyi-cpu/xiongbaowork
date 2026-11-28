import { describe, expect, test } from "bun:test";
import { appSources, stripComments } from "./i18n-accessible";

/*
 * 一个设置一个名字（spec §5.8、§10.3）：改名清单左列的旧名不再出现在 `app/src` 的**界面字符串**里。
 * 只扫用户读得到的字：JSX 文字，以及 title / label / aria-label / placeholder 的整段字面量
 * （属性写法 `title="…"` 和对象字段 `label: "…"` 都算）。注释、标识符、错误信息常量不扫。
 * 写法同 glossary-terms.test.ts：只按字面包含判断。
 */

/** 旧名。后续 PR 把自己改掉的名字追加到这里（§5.8 左列）。 */
const RETIRED: readonly string[] = ["偏好设置", "我的电脑", "我的设备"];

type Kept = { file: string; text: string; reason: string };

/**
 * 合法保留的说法：`text` 是含旧名的那段界面字符串的全文（去掉首尾空白）。
 * 例：节名「我的设备」、「从我的电脑招」（5.8：页与入口改叫电脑与设备，节名保留我的设备）。
 */
const KEPT: readonly Kept[] = [
  {
    file: "app/src/components/settings/my-devices.tsx",
    text: "我的设备",
    reason:
      "§5.8：页与入口改叫电脑与设备，电脑与设备页第一节（#my-devices）的节名保留「我的设备」",
  },
  {
    file: "app/src/components/bots/bots-page.tsx",
    text: "从我的电脑招",
    reason:
      "招人页签的名字（?source=computer，外部员工 Task 10），说的是从本人电脑上招智能体，不是 我 菜单里改名的「我的电脑」入口",
  },
  {
    file: "app/src/components/agents/external/hire-from-computer.tsx",
    text: "现在请先在「从我的电脑招」里，把电脑上的智能体招进来。",
    reason: "引用招人页签「从我的电脑招」的名字，同上",
  },
  {
    file: "app/src/skins/xiongbao/contacts.tsx",
    text: "人才市场 · 从我的电脑招",
    reason: "引用招人页签「从我的电脑招」的名字，同上",
  },
];

type UiString = { file: string; number: number; text: string };

const UI_ATTRIBUTE = "(?:title|label|aria-label|placeholder)";
// title="…" / label='…' / title={"…"}，以及对象字段 label: "…"
const ATTRIBUTE_LITERAL = new RegExp(
  String.raw`\b${UI_ATTRIBUTE}(?:=\{?\s*|\s*:\s*)(?:"([^"\n]*)"|'([^'\n]*)'|` +
    "`([^`$\\n]*)`" +
    ")",
  "g",
);
// 两个标签或花括号之间的文字：`>文字<`、`}文字<`、`>文字{`
const JSX_TEXT = /[>}]([^<>{}]*)(?=[<{])/g;

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/** 一份源码里的界面字符串（已去注释）。 */
export function uiStringsIn(file: string, source: string): UiString[] {
  const code = stripComments(source);
  const found: UiString[] = [];
  for (const match of code.matchAll(ATTRIBUTE_LITERAL)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (text)
      found.push({ file, number: lineOf(code, match.index ?? 0), text });
  }
  for (const match of code.matchAll(JSX_TEXT)) {
    const text = (match[1] ?? "").replace(/\s+/g, " ").trim();
    if (text)
      found.push({ file, number: lineOf(code, match.index ?? 0), text });
  }
  return found;
}

function retiredHits(
  strings: UiString[],
  retired: readonly string[],
): (UiString & { word: string })[] {
  return strings.flatMap((entry) =>
    retired
      .filter((word) => entry.text.includes(word))
      .map((word) => ({ ...entry, word })),
  );
}

describe("量具自检：小样本", () => {
  const sample = [
    "// 偏好设置 在注释里",
    "/* 我的设备 在块注释里 */",
    "const 我的电脑 = 1;",
    "export const a = <h1>偏好设置</h1>;",
    'export const b = <Tab title="我的设备" />;',
    'export const c = <Item label={"我的电脑"} />;',
    'const d = { label: "偏好设置页" };',
    'export const e = <i aria-label="干净" />;',
    "export const f = <p>{n} 台我的电脑</p>;",
    'throw new Error("偏好设置没读到");',
  ].join("\n");
  const hits = retiredHits(uiStringsIn("x.tsx", sample), [
    "偏好设置",
    "我的设备",
    "我的电脑",
  ]);

  test("抓得到 JSX 文字、title、label={…}、label: 字段、花括号后的文字", () => {
    expect(
      [...hits]
        .sort((a, b) => a.number - b.number)
        .map((hit) => [hit.number, hit.word, hit.text]),
    ).toEqual([
      [4, "偏好设置", "偏好设置"],
      [5, "我的设备", "我的设备"],
      [6, "我的电脑", "我的电脑"],
      [7, "偏好设置", "偏好设置页"],
      [9, "我的电脑", "台我的电脑"],
    ]);
  });

  test("忽略注释、标识符和错误信息常量", () => {
    const lines = new Set(hits.map((hit) => hit.number));
    for (const ignored of [1, 2, 3, 10]) expect(lines.has(ignored)).toBe(false);
  });
});

describe("界面字符串里没有旧名", () => {
  const strings = appSources()
    .filter(({ file }) => file.endsWith(".tsx"))
    .flatMap(({ file, source }) => uiStringsIn(file, source));
  const hits = retiredHits(strings, RETIRED);
  const isKept = (hit: { file: string; text: string }) =>
    KEPT.some((kept) => kept.file === hit.file && kept.text === hit.text);

  test("量具没有扫空：能读出大量界面字符串", () => {
    expect(strings.length).toBeGreaterThan(500);
  });

  test("旧名没有空串、没有重复", () => {
    expect(RETIRED.every((word) => word.trim().length > 0)).toBe(true);
    expect(new Set(RETIRED).size).toBe(RETIRED.length);
  });

  test("没有旧名落在保留清单之外", () => {
    const offenders = hits
      .filter((hit) => !isKept(hit))
      .map(
        (hit) =>
          `${hit.file}:${hit.number}: 「${hit.word}」 in 「${hit.text}」`,
      );
    expect(offenders).toEqual([]);
  });

  test("保留清单只收窄：每条都还对得上一处真实的旧名", () => {
    const stale = KEPT.filter(
      (kept) =>
        !hits.some((hit) => hit.file === kept.file && hit.text === kept.text),
    ).map((kept) => `${kept.file}: ${kept.text}`);
    expect(stale).toEqual([]);
    expect(KEPT.every((kept) => kept.reason.trim().length > 0)).toBe(true);
  });
});

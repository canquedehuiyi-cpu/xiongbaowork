import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  accessibleNamesIn,
  appSources,
  CJK,
  commentFreeLines,
  everyNameHit,
  everyToastHit,
} from "./i18n-accessible";

/*
 * 屏幕阅读器念出来的名字（aria-label）、输入框的占位提示（placeholder）、按钮和分区的悬停提示
 * （title），以及 toast 的标题，都是用户会**读到**的字。它们此前没有任何测试盯着：页面扫描
 * （i18n-dom-scan）只覆盖画得出来的页面，而 /admin/* 要管理员身份、正好落在「缺夹具」里，
 * 于是这几片的英文一路漏到现在。
 *
 * 这一份是**源码级**的：不渲染、不需要身份，直接把字面量抠出来看有没有汉字。
 */

type AllowEntry = { file: string; text: string; reason: string };
const ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(
    new URL("./i18n-accessible-allowlist.json", import.meta.url),
    "utf8",
  ),
);

const CATEGORIES = [
  "example-value", // 示例输入（域名、邮箱、仓名、ID 形态），是照着填的样子，不是句子
  "proper-noun", // 产品名、协议名、服务名，翻了反而认不出来
  "unwired", // 这个文件当前没有任何引用；等它真被挂上去，这条豁免自己失效（见下面的测试）
] as const;

const sameHit = (hit: { file: string; text: string }, entry: AllowEntry) =>
  hit.file === entry.file && hit.text === entry.text;

describe("可访问名里没有英文", () => {
  const sources = appSources();
  const all = everyNameHit(sources);

  test("量具没有扫空", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  test("allowlist 每条都写了已知类别和说明", () => {
    const bad = ALLOWLIST.filter((entry) => {
      const [category, note] = entry.reason.split(/:\s*/, 2);
      return (
        !CATEGORIES.includes(category as (typeof CATEGORIES)[number]) ||
        !note?.trim()
      );
    });
    expect(bad).toEqual([]);
  });

  test("allowlist 只收窄：每条都还能命中一个真实的可访问名", () => {
    const stale = ALLOWLIST.filter(
      (entry) => !all.some((hit) => sameHit(hit, entry)),
    ).map((entry) => `${entry.file}: ${entry.text}`);
    expect(stale).toEqual([]);
  });

  test("没有英文可访问名落在 allowlist 之外", () => {
    const unexplained = all
      .filter((hit) => !ALLOWLIST.some((entry) => sameHit(hit, entry)))
      .map(
        (hit) => `${hit.file}:${hit.number}: ${hit.attribute}="${hit.text}"`,
      );
    expect(unexplained).toEqual([]);
  });

  /*
   * 「未接线」这条豁免是有条件的：这一簇文件必须真的没有**簇外**的引用方。它们之间互相 import
   * 是允许的（computer-sections 引 network-describe），但只要有簇外的文件引到，就红——逼着先
   * 翻中文，否则豁免会变成永久的英文洞。
   */
  test("unwired 豁免的那一簇，没有簇外的引用方", () => {
    const unwired = new Set(
      ALLOWLIST.filter((e) => e.reason.startsWith("unwired:")).map(
        (e) => e.file,
      ),
    );
    expect(unwired.size).toBeGreaterThan(0);
    const wired: string[] = [];
    for (const file of unwired) {
      const base = file
        .split("/")
        .pop()!
        .replace(/\.tsx?$/, "");
      const outside = sources
        .filter((other) => other.file !== file && !unwired.has(other.file))
        .filter((other) =>
          commentFreeLines(other.source).some(({ line }) =>
            line.includes(base),
          ),
        )
        .map((other) => other.file);
      if (outside.length > 0) wired.push(`${file} ← ${outside[0]}`);
    }
    expect(wired).toEqual([]);
  });
});

describe("量具本身认得该报的和不该报的", () => {
  const at = (source: string) => accessibleNamesIn("app/src/x.tsx", source);

  test("报出英文的 aria-label、placeholder、title", () => {
    expect(
      at(
        [
          '<Switch aria-label="Require SSO" />',
          '<Input placeholder="owner/name" />',
          '<ControlsSection title="Sign-in">',
        ].join("\n"),
      ).map((hit) => hit.text),
    ).toEqual(["Require SSO", "owner/name", "Sign-in"]);
  });

  test("放过中文、放过表达式、放过注释", () => {
    expect(
      at(
        [
          '<Switch aria-label="要求 SSO" />',
          "<Input aria-label={label} />",
          '{/* 上游原样：title="Idle computers" */}',
          '<Input placeholder="owner/仓库" />',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("空值不算东西要翻", () => {
    expect(at('<span title="" aria-label="  " />')).toEqual([]);
  });

  test("字符串里的 // 不会被当成注释把后面吃掉", () => {
    expect(
      at('<a title="docs" href="https://x.dev//a" />').map((hit) => hit.number),
    ).toEqual([1]);
  });
});

const TOAST_ALLOW: { file: string; title: string; reason: string }[] = [
  {
    file: "app/src/components/browser/browser-nav-item.tsx",
    title: "storeTabSentence(store)",
    reason:
      "compute: 函数按标签页拼中文句子（用完的 / 正在用的），句子在 browser-bar.tsx 里",
  },
  {
    file: "app/src/components/app-sidebar/use-sign-out.ts",
    title: "error.message",
    reason: "server-message: 服务端拒绝的原文，前端原样转述、不改写",
  },
  {
    file: "app/src/lib/models/run-model.ts",
    title: "error.message",
    reason: "server-message: 服务端拒绝的原文，前端原样转述、不改写",
  },
];

describe("toast 标题是中文", () => {
  const sources = appSources();
  const all = everyToastHit(sources);

  test("每处 toast.add 都拿到了标题，量具没有扫空", () => {
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  test("标题要么含汉字，要么是允许表里的那句表达式", () => {
    const bad = all
      .filter((hit) => {
        if (hit.literal !== null && CJK.test(hit.literal)) return false;
        return !TOAST_ALLOW.some(
          (entry) => entry.file === hit.file && entry.title === hit.title,
        );
      })
      .map((hit) => `${hit.file}:${hit.line}: ${hit.title}`);
    expect(bad).toEqual([]);
  });

  test("允许表只收窄：每条都还能命中一处真实调用", () => {
    const stale = TOAST_ALLOW.filter(
      (entry) =>
        !all.some(
          (hit) => hit.file === entry.file && hit.title === entry.title,
        ),
    ).map((entry) => `${entry.file}: ${entry.title}`);
    expect(stale).toEqual([]);
  });

  test("允许表每条都写了类别和说明", () => {
    const bad = TOAST_ALLOW.filter((entry) => {
      const [category, note] = entry.reason.split(/:\s*/, 2);
      return !["compute", "server-message"].includes(category) || !note?.trim();
    });
    expect(bad).toEqual([]);
  });
});

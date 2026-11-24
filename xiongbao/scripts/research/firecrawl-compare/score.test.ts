import { describe, expect, test } from "bun:test";
import { onlyLoopback } from "./isolation";
import { buildPages } from "./pages";
import {
  bodyRecall,
  cellRecall,
  factRecall,
  median,
  noiseRate,
  normalize,
  rowFidelity,
  scoreOutput,
} from "./score";

describe("评分", () => {
  test("normalize 丢掉空白、Markdown 符号和标点，保留汉字字母数字", () => {
    expect(normalize("| **A-1** | 价格：¥3.5 |")).toBe("a1价格35");
  });

  test("全文在输出里时正文召回为 1，缺一半时约为一半", () => {
    const paragraphs = ["第一段内容足够长用来分片", "第二段内容同样足够长度"];
    expect(bodyRecall(paragraphs.join("\n\n"), paragraphs)).toBe(1);
    const half = bodyRecall(paragraphs[0] as string, paragraphs);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(bodyRecall("完全无关的文字", paragraphs)).toBe(0);
  });

  test("事实要原样出现，比较不受空白和标点影响", () => {
    expect(factRecall("在 2026 年 3 月 12 日发布", ["2026年3月12日"])).toBe(1);
    expect(factRecall("没有", ["2026年3月12日", "B-12"])).toBe(0);
    expect(factRecall("编号 B-12", ["2026年3月12日", "B-12"])).toBe(0.5);
  });

  test("噪声率按出现的词句占比算，没有噪声词时是 null", () => {
    const noise = ["立即抢购", "隐私政策"];
    expect(noiseRate("正文 立即抢购", noise)).toBe(0.5);
    expect(noiseRate("干净的正文", noise)).toBe(0);
    expect(noiseRate("任何文字", [])).toBeNull();
  });

  test("单元格召回与行保真：一格一行时行保真掉到 0，单元格召回仍为 1", () => {
    const rows = [
      ["SKU-1", "甲", "¥10"],
      ["SKU-2", "乙", "¥20"],
    ];
    const asTable = "| SKU-1 | 甲 | ¥10 |\n| SKU-2 | 乙 | ¥20 |";
    const oneCellPerLine = "SKU-1\n甲\n¥10\nSKU-2\n乙\n¥20";
    expect(cellRecall(asTable, rows)).toBe(1);
    expect(rowFidelity(asTable, rows)).toBe(1);
    expect(cellRecall(oneCellPerLine, rows)).toBe(1);
    expect(rowFidelity(oneCellPerLine, rows)).toBe(0);
    expect(cellRecall("无表格", [])).toBeNull();
    expect(rowFidelity("无表格", [])).toBeNull();
  });

  test("列顺序错了的行不算保住", () => {
    expect(rowFidelity("| 甲 | SKU-1 |", [["SKU-1", "甲"]])).toBe(0);
  });

  test("scoreOutput 对脚本页：正文和事实齐全才算拿到正文", () => {
    const truth = {
      paragraphs: ["港口调度中心发布了第七号公告"],
      facts: ["第七号公告"],
      tableRows: [],
      noise: [],
      needsJs: true,
    };
    expect(scoreOutput("港口调度中心发布了第七号公告", truth).gotJsBody).toBe(
      true,
    );
    expect(scoreOutput("正在加载…", truth).gotJsBody).toBe(false);
    expect(scoreOutput("x", { ...truth, needsJs: false }).gotJsBody).toBeNull();
  });

  test("median 取中位数，偶数个取中间两个的平均", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("测试页与标准答案", () => {
  test("每页的段落、事实、表格单元格都真的写在该页的源码里", () => {
    for (const page of buildPages()) {
      const source = normalize(page.html.replace(/<[^>]+>/g, " "));
      const expected = [
        ...page.truth.paragraphs,
        ...page.truth.facts,
        ...page.truth.noise,
        ...page.truth.tableRows.flat(),
      ];
      for (const item of expected)
        expect([page.id, source.includes(normalize(item))]).toEqual([
          page.id,
          true,
        ]);
    }
  });

  test("页面生成是确定的，页面编号不重复", () => {
    const first = buildPages();
    expect(buildPages().map((page) => page.html)).toEqual(
      first.map((page) => page.html),
    );
    expect(new Set(first.map((page) => page.id)).size).toBe(first.length);
  });

  test("脚本页的正文不在静态源码的标签文字里，只在脚本数据里", () => {
    const page = buildPages().find((item) => item.truth.needsJs);
    const visible = (page?.html ?? "")
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, "");
    expect(normalize(visible)).not.toContain(
      normalize(page?.truth.paragraphs[0] ?? ""),
    );
  });
});

describe("网络隔离自检", () => {
  test("只有回环网卡才算隔离，多一块网卡或没有回环都不算", () => {
    expect(onlyLoopback(["lo"])).toBe(true);
    expect(onlyLoopback(["lo", "eth0"])).toBe(false);
    expect(onlyLoopback(["eth0"])).toBe(false);
    expect(onlyLoopback([])).toBe(false);
  });
});

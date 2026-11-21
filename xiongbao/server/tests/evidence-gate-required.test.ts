import { expect, test } from "bun:test";
import { requiredItemMet, requiredItemsOf } from "../src/tasks/evidence-gate";

/**
 * 「必需：…」 in a card's criteria names what a hand-in must mention (spec 2026-11-15-delivery-loop §5).
 * An item is cut out by punctuation, and by 「和」「及」 only where they stand apart: inside a word they
 * are part of it, and a one-character item would be met by almost any hand-in.
 */
test("required items are split on punctuation, and on 和 / 及 only when they stand apart", () => {
  expect(requiredItemsOf("三家都核对完。必需：A家、B家，C家")).toEqual([
    "A家",
    "B家",
    "C家",
  ]);
  expect(requiredItemsOf("必需: 发票/收据; 其余随意")).toEqual([
    "发票",
    "收据",
  ]);
  expect(requiredItemsOf("必需：涉及金额、发票和收据")).toEqual([
    "涉及金额",
    "发票和收据",
  ]);
  expect(requiredItemsOf("必需：汇总表 和 原始凭证 及 说明")).toEqual([
    "汇总表",
    "原始凭证",
    "说明",
  ]);
  expect(requiredItemsOf("必需：三家等")).toEqual(["三家"]);
  expect(requiredItemsOf("结论写清楚")).toEqual([]);
  expect(requiredItemsOf(null)).toEqual([]);
});

/*
 * 必需项的比对（第二轮压步数）：标点、括号、引号、空格不影响；整项是子串，或拆出的各段（长度 >= 2）都出现。
 * 完全没提到的仍然算缺。
 */
test("a required item is met when its punctuation differs, or when each of its parts is named", () => {
  expect(requiredItemMet("汇总表", "交付物：汇总表.xlsx")).toBe(true);
  expect(requiredItemMet("单元测试(unit)", "已跑 单元测试 “unit”")).toBe(true);
  expect(requiredItemMet("README 更新", "更新了 README 文件")).toBe(true);
  expect(requiredItemMet("A-B  Report", "a b report 已核对")).toBe(true);
});

test("a required item nobody mentions is still missing", () => {
  expect(requiredItemMet("发票", "交付物：汇总表 自查：核对了三家")).toBe(
    false,
  );
  expect(requiredItemMet("README 更新", "更新了文档")).toBe(false);
  // 单个汉字的段不算：只提到「更」不能让「更新日志」对上。
  expect(requiredItemMet("更 新", "更改了配置")).toBe(false);
});

import { expect, test } from "bun:test";
import { requiredItemsOf } from "../src/tasks/evidence-gate";

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

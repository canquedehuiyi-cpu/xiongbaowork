import { describe, expect, test } from "bun:test";
import { slimComputerGuidance } from "../src/agents/slim-guidance";

/*
 * 期 1 评测的网页表单题：紧急联系人一栏模型多填了「（母亲）」两个字，原文里没有。瘦身提示的电脑段里要
 * 有一句：提交前逐项对照要求的原值核对，不加原文没有的字。
 */

const holding = { search: true, personal: false, browserSearch: false };

describe("电脑段的表单核对", () => {
  test("每一栏只填这一栏要的那部分，不加原文没有的字", () => {
    const text = slimComputerGuidance(holding);
    expect(text).toContain("Before submitting a form");
    // 第一层：只填该栏要的那部分，括号里的关系、备注不填进姓名栏。
    expect(text).toContain("only the part that field asks for");
    expect(text).toContain("name alone, not a bracketed note");
    expect(text).toContain("relationship or remark");
    // 第二层：不加原文没有的字。
    expect(text).toContain("never add words the source does not have");
    // 不能再叫模型「原样照填」：「周丽华（母亲）」会被整个填进姓名栏。
    expect(text).not.toContain("exactly the original value");
  });

  test("说在提交之前，而不是提交之后才查", () => {
    const text = slimComputerGuidance(holding);
    expect(text.indexOf("Before submitting a form")).toBeLessThan(
      text.indexOf("After submitting a form"),
    );
  });
});

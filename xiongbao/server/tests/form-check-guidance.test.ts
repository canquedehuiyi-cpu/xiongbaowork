import { describe, expect, test } from "bun:test";
import { slimComputerGuidance } from "../src/agents/slim-guidance";

/*
 * 期 1 评测的网页表单题：紧急联系人一栏模型多填了「（母亲）」两个字，原文里没有。瘦身提示的电脑段里要
 * 有一句：提交前逐项对照要求的原值核对，不加原文没有的字。
 */

const holding = { search: true, personal: false, browserSearch: false };

describe("电脑段的表单核对", () => {
  test("提交表单前逐项对照原值核对，不加原文没有的字", () => {
    const text = slimComputerGuidance(holding);
    expect(text).toContain("Before submitting a form");
    expect(text).toContain("against the values you were given");
    expect(text).toContain("never add words the original does not have");
    // 例子就是评测里出的错：名字后面多写了关系。
    expect(text).toContain("(mother)");
  });

  test("说在提交之前，而不是提交之后才查", () => {
    const text = slimComputerGuidance(holding);
    expect(text.indexOf("Before submitting a form")).toBeLessThan(
      text.indexOf("After submitting a form"),
    );
  });
});

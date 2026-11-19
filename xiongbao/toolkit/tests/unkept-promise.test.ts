import { describe, expect, test } from "bun:test";
import { unkeptPromise } from "../src/copilotkit/unkept-promise";

/**
 * The rule that decides a run ended on a promise, held against what models actually write. The
 * promises are the routine that found this ("I'll fetch the rest now") and the shapes public agent
 * bug reports quote; the answers that are finished are ordinary endings that must never be sent back.
 */

describe("an answer that ends on a promise", () => {
  test.each([
    [
      "I've pulled 11 of the 20 issues. I'll fetch the rest now.",
      "I'll fetch the rest now.",
    ],
    [
      "Let me pull the remaining issues from Linear.",
      "Let me pull the remaining issues from Linear.",
    ],
    [
      "Next, I'll check the Candidates page in Notion.",
      "Next, I'll check the Candidates page in Notion.",
    ],
    [
      "I'm going to look up ENG-412 and ENG-418 next.",
      "I'm going to look up ENG-412 and ENG-418 next.",
    ],
    ["Doing it now.", "Doing it now."],
    [
      "Fetching the remaining 9 issues now.",
      "Fetching the remaining 9 issues now.",
    ],
    [
      "Now checking Notion for the matches.",
      "Now checking Notion for the matches.",
    ],
    ["Got the cycle. I’ll now go and rank them.", "I’ll now go and rank them."],
    [
      "I have the first batch. I'll fetch the remaining nine now, then rank them.\n\n- ENG-1: Todo\n- ENG-2: In Progress",
      "I'll fetch the remaining nine now, then rank them.",
    ],
  ])("%j", (answer, promise) => {
    expect(unkeptPromise(answer)).toBe(promise);
  });
});

describe("an answer that is finished, or is the person's to answer", () => {
  test.each([
    "Here is the ranked list. Let me know if you want it posted to Slack.",
    "Done. I'll be here if you need anything else.",
    "Do you want me to fetch the rest as well?",
    "I'll send the draft once you confirm the recipients.",
    "Posted the summary. I'll run again tomorrow at 9.",
    "Here's what I'll cover:",
    "The sync is running now and the numbers are up to date.",
    "ENG-1 is in Todo, ENG-2 is In Progress.",
    "I'll keep an eye on the cycle and flag anything that slips.",
    "",
  ])("%j", (answer) => {
    expect(unkeptPromise(answer)).toBeUndefined();
  });
});

describe("an answer that ends on a Chinese promise", () => {
  test.each([
    ["我先看看现有文件，我这就改。", "我先看看现有文件，我这就改。"],
    ["缺陷已定位三处。接下来我去修第一处。", "接下来我去修第一处。"],
    ["这就去查剩下的两页。", "这就去查剩下的两页。"],
    [
      "我现在就把这三处修掉，修完一次性交全套。开工。",
      "我现在就把这三处修掉，修完一次性交全套。",
    ],
    ["我先看看，马上就去修。", "我先看看，马上就去修。"],
    ["Here is the result. 我这就去修。", "我这就去修。"],
  ])("%j", (answer, promise) => {
    expect(unkeptPromise(answer)).toBe(promise);
  });
});

describe("a Chinese answer that is finished, or is deferred, or is a question", () => {
  test.each([
    "15 页杂志 HTML 已生成。",
    "结构自查全部通过，没有断链。",
    "本轮工作已完成。",
    "要我现在就发吗？",
    "等你确认后我这就发。",
    "我明天再去查。",
    "已经开工修了三分之一。",
    "",
  ])("%j", (answer) => {
    expect(unkeptPromise(answer)).toBeUndefined();
  });
});

/**
 * How DeepSeek opens the step it then never takes: 「让我先查看一下项目结构。」 and no call after it.
 * One case for each opening it was seen to use, and the endings around them that are finished work.
 */
describe("an answer that ends on a DeepSeek-style Chinese opening", () => {
  test.each([
    ["让我先查看一下项目结构。", "让我先查看一下项目结构。"],
    [
      "好的。让我看看 config.ts 里是怎么配的。",
      "让我看看 config.ts 里是怎么配的。",
    ],
    ["我将读取三个配置文件并逐一比对。", "我将读取三个配置文件并逐一比对。"],
    ["收到。我先跑一遍测试，看看哪些失败。", "我先跑一遍测试，看看哪些失败。"],
    ["我来修复这个空指针问题。", "我来修复这个空指针问题。"],
    ["我来把它修了。", "我来把它修了。"],
    ["首先，我需要确认数据库的表结构。", "首先，我需要确认数据库的表结构。"],
    ["首先查看一下日志目录。", "首先查看一下日志目录。"],
    ["下面开始逐个检查接口。", "下面开始逐个检查接口。"],
    ["第一处已经修好。接下来我检查第二处。", "接下来我检查第二处。"],
    [
      "先读完文档，然后我会更新测试用例。",
      "先读完文档，然后我会更新测试用例。",
    ],
    [
      "明白了。我会先备份数据库，再执行迁移。",
      "我会先备份数据库，再执行迁移。",
    ],
    ["马上开始生成报告。", "马上开始生成报告。"],
    ["好的，马上处理。", "好的，马上处理。"],
    [
      "第一处的原因是缓存过期，我已经修好了。我先修好了第二处。让我再看看第三处。",
      "让我再看看第三处。",
    ],
  ])("%j", (answer, promise) => {
    expect(unkeptPromise(answer)).toBe(promise);
  });
});

describe("a Chinese answer that is finished work, said in the same words", () => {
  test.each([
    "我已经完成了全部三处修复，测试全部通过。",
    "我已经完成了报告，保存在 report.md。",
    "让我总结一下：三处缺陷都已修复，测试全部通过。",
    "三处都改好了。让我总结一下：\n1. 缓存过期已修复\n2. 空指针已修复\n3. 测试已补齐",
    "全部完成。\n\n让我总结一下：\n\n- 登录模块已修复\n- 报表已生成",
    "我将结果保存到了 report.md。",
    "我先修复了登录模块，然后补了两条测试。",
    "首先，我修复了缓存过期的问题；其次，补了回归测试。",
    "我来总结一下这次的改动。",
    "对我来说，这个方案最稳妥。",
    "需要我继续处理剩下的部分吗？",
    "让我知道你想先做哪一个。",
  ])("%j", (answer) => {
    expect(unkeptPromise(answer)).toBeUndefined();
  });
});

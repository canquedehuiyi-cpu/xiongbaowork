import { describe, expect, test } from "bun:test";
import type { GrantedTool } from "../src/plugins/tools";
import {
  createDeliveryReview,
  isCodingCard,
  REVIEW_CHECKLIST,
  REVIEW_NOTE_LABEL,
  REVIEW_NOTE_LIMIT,
  reviewBrief,
  reviewNote,
  roundCalls,
} from "../src/tasks/delivery-review";

/** 交付前评审：清单、判定规则、交给只读子代理的说明，和评审意见怎么附上。 */

describe("the checklist", () => {
  test("is exactly the three questions, in this order", () => {
    expect(REVIEW_CHECKLIST.map((item) => item.id)).toEqual([
      "tests",
      "scope",
      "assertions",
    ]);
    expect(REVIEW_CHECKLIST[0].ask).toContain("测试是否跑过");
    expect(REVIEW_CHECKLIST[1].ask).toContain("改动是否超出卡片范围");
    expect(REVIEW_CHECKLIST[2].ask).toContain("有无删除既有断言");
  });

  test("every question is put to the reviewer, numbered, with what it is reviewing", () => {
    const { task, answer } = reviewBrief({
      title: "修复登录超时",
      criteria: "必需：测试结果",
      items: [{ kind: "workspace_file", ref: "src/login.ts", title: "登录" }],
      checks: ["bun test 全过"],
      calls: ['computer_run_command {"command":"bun test"}'],
    });
    for (const [index, item] of REVIEW_CHECKLIST.entries())
      expect(task).toContain(`${index + 1}. ${item.ask}`);
    expect(task).toContain("修复登录超时");
    expect(task).toContain("必需：测试结果");
    expect(task).toContain("src/login.ts");
    expect(task).toContain("bun test 全过");
    expect(task).toContain("computer_run_command");
    expect(task).toContain("只出意见");
    expect(answer).toContain("通过");
  });
});

describe("which cards are coding cards", () => {
  const card = { title: "整理本周周报", criteria: "发给主人" };

  test("a change summary or a source file in the hand-in is", () => {
    expect(
      isCodingCard({ ...card, items: [{ kind: "diff", ref: "run-1" }] }),
    ).toBe(true);
    for (const ref of ["src/a.ts", "tools/run.py", "web/App.tsx", "build.sh"])
      expect(
        isCodingCard({ ...card, items: [{ kind: "workspace_file", ref }] }),
      ).toBe(true);
  });

  test("a report or a sheet is not, whatever the title says", () => {
    expect(
      isCodingCard({
        title: "修复报表口径",
        criteria: "代码改完",
        items: [{ kind: "workspace_file", ref: "reports/对比.xlsx" }],
      }),
    ).toBe(false);
  });

  test("with nothing named, the card's own words decide", () => {
    expect(
      isCodingCard({
        title: "修复登录页的 bug",
        items: [{ kind: "note", ref: "已修复" }],
      }),
    ).toBe(true);
    expect(
      isCodingCard({
        title: "整理周报",
        criteria: "三段话",
        items: [{ kind: "note", ref: "好了" }],
      }),
    ).toBe(false);
  });
});

describe("what the reviewer is shown of the round", () => {
  test("is each call with its arguments, newest last, cut to a size", () => {
    const messages = [
      { role: "user", content: "改一下" },
      {
        role: "assistant",
        toolCalls: [
          {
            id: "1",
            function: { name: "edit_file", arguments: '{"path":"a.ts"}' },
          },
          { id: "2", function: { name: "run", arguments: "x".repeat(900) } },
        ],
      },
    ];
    const lines = roundCalls(messages, 60, 50);
    expect(lines).toEqual([
      'edit_file {"path":"a.ts"}',
      `run ${"x".repeat(50)}`,
    ]);
    expect(roundCalls(messages, 1)[0]).toStartWith("run ");
  });
});

describe("the opinion as it is attached", () => {
  test("carries the reviewer's words under a label that says it only advises", () => {
    const note = reviewNote({
      answer: "1 通过\n2 通过\n3 看不出\n总的：可以交",
      threadId: "t",
      steps: 3,
    });
    expect(note).toStartWith(`${REVIEW_NOTE_LABEL}：`);
    expect(note).toContain("可以交");
    expect(REVIEW_NOTE_LABEL).toContain("不挡交付");
  });

  test("a long one is cut, and a review that did not run says so", () => {
    expect(
      [...reviewNote({ answer: "长".repeat(5000), threadId: "t", steps: 1 })]
        .length,
    ).toBeLessThanOrEqual(REVIEW_NOTE_LIMIT + REVIEW_NOTE_LABEL.length + 1);
    expect(reviewNote({ error: "超时", threadId: "t", steps: 0 })).toContain(
      "没跑成：超时",
    );
    expect(reviewNote(null)).toContain("没跑成");
  });
});

describe("the review step", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    actorId: "owner",
    botId: "bot",
    card: { title: "修复登录页的 bug", criteria: null },
    items: [{ kind: "workspace_file", ref: "src/login.ts" }],
    checks: ["bun test 全过"],
    messages: [],
    runId: "run-1",
    threadId: "thread-1",
    ...overrides,
  });

  function review(
    options: { declared?: boolean; answer?: string | Error } = {},
  ) {
    const briefs: unknown[] = [];
    const held: unknown[] = [];
    const step = createDeliveryReview({
      declared: async () => options.declared ?? true,
      reviewer: (parent) => {
        held.push(parent);
        return {
          name: "run_subagent",
          ref: "bot/run_subagent",
          description: "",
          parameters: {} as never,
          execute: async (args: unknown) => {
            briefs.push(args);
            if (options.answer instanceof Error) throw options.answer;
            return JSON.stringify({
              answer: options.answer ?? "总的：可以交",
              threadId: "sub",
              steps: 2,
            });
          },
        } satisfies GrantedTool;
      },
    });
    return { step, briefs, held };
  }

  test("a coding card's hand-in is reviewed once, by a reviewer of this run", async () => {
    const { step, briefs, held } = review();
    const note = await step(input());
    expect(note).toContain("可以交");
    expect(briefs).toHaveLength(1);
    expect(held[0]).toMatchObject({
      actorId: "owner",
      botId: "bot",
      runId: "run-1",
    });
  });

  test("another kind of card is not, nor is an employee that did not declare the pilot", async () => {
    const other = review();
    expect(
      await other.step(
        input({
          card: { title: "周报", criteria: null },
          items: [{ kind: "note", ref: "好了" }],
        }),
      ),
    ).toBeUndefined();
    expect(other.briefs).toHaveLength(0);
    const undeclared = review({ declared: false });
    expect(await undeclared.step(input())).toBeUndefined();
    expect(undeclared.briefs).toHaveLength(0);
  });

  test("a review that fails is a note, never an error", async () => {
    const { step } = review({ answer: new Error("没有电脑") });
    expect(await step(input())).toContain("没跑成：没有电脑");
  });
});

import { describe, expect, test } from "bun:test";
import type { GrantedTool } from "../src/plugins/tools";
import {
  createDeliveryReview,
  isCodingCard,
  REVIEW_CHECKLIST,
  REVIEW_NOTE_LABEL,
  REVIEW_NOTE_LIMIT,
  REVIEW_RESERVE_MS,
  REVIEW_TIMED_OUT,
  REVIEW_TIMEOUT_MS,
  reviewBrief,
  reviewNote,
  roundCalls,
  roundLimitMs,
  roundRemainingMs,
  withoutQuotedText,
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

  test("config and build files are, a note in markdown is not", () => {
    for (const ref of [
      "Dockerfile",
      "docker/Dockerfile.dev",
      "ci/build.yml",
      "ci/build.yaml",
      "package.json",
      "pyproject.toml",
    ])
      expect(
        isCodingCard({ ...card, items: [{ kind: "workspace_file", ref }] }),
      ).toBe(true);
    expect(
      isCodingCard({
        ...card,
        items: [{ kind: "workspace_file", ref: "docs/说明.md" }],
      }),
    ).toBe(false);
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

  test("only the calls after the person's last message, not the whole conversation's", () => {
    const call = (name: string) => ({
      toolCalls: [{ id: name, function: { name, arguments: "{}" } }],
      role: "assistant",
    });
    const messages = [
      { role: "user", content: "早先的事" },
      call("earlier_call"),
      { role: "user", content: "这一轮的事" },
      call("this_round"),
    ];
    expect(roundCalls(messages)).toEqual(["this_round {}"]);
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
    ).toBeLessThanOrEqual(REVIEW_NOTE_LIMIT);
    expect(REVIEW_NOTE_LIMIT).toBe(1000);
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

describe("a review that takes too long", () => {
  const input = {
    actorId: "owner",
    botId: "bot",
    card: { title: "修复登录页的 bug", criteria: null },
    items: [{ kind: "workspace_file", ref: "src/login.ts" }],
    checks: [],
    messages: [],
    runId: "run-1",
    threadId: "thread-1",
  };
  const hanging = (): GrantedTool => ({
    name: "run_subagent",
    ref: "bot/run_subagent",
    description: "",
    parameters: {} as never,
    execute: () => new Promise<string>(() => undefined),
  });

  test("is given up inside its own time, and the hand-in is told so", async () => {
    const step = createDeliveryReview({
      declared: async () => true,
      reviewer: hanging,
      timeoutMs: 30,
    });
    const started = Date.now();
    expect(await step(input)).toBe(REVIEW_TIMED_OUT);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(REVIEW_TIMED_OUT).toContain("评审超时，未附意见");
  });

  test("is cut to what is left of the round, less a reserve, and not started with nothing left", async () => {
    let started = 0;
    const step = createDeliveryReview({
      declared: async () => true,
      reviewer: () => ({
        ...hanging(),
        execute: async () => {
          started += 1;
          return "{}";
        },
      }),
      remainingMs: async () => REVIEW_RESERVE_MS - 1,
    });
    expect(await step(input)).toBe(REVIEW_TIMED_OUT);
    expect(started).toBe(0);
    const tight = createDeliveryReview({
      declared: async () => true,
      reviewer: hanging,
      remainingMs: async () => REVIEW_RESERVE_MS + 40,
    });
    const at = Date.now();
    expect(await tight(input)).toBe(REVIEW_TIMED_OUT);
    expect(Date.now() - at).toBeLessThan(2000);
    expect(REVIEW_TIMEOUT_MS).toBe(120_000);
  });

  test("a reviewer that answers in time is heard", async () => {
    const step = createDeliveryReview({
      declared: async () => true,
      reviewer: () => ({
        ...hanging(),
        execute: async () =>
          JSON.stringify({ answer: "总的：可以交", threadId: "s", steps: 1 }),
      }),
      timeoutMs: 1000,
    });
    expect(await step(input)).toContain("可以交");
  });
});

describe("what of the answer is attached", () => {
  test("fenced blocks and long lines are dropped, the verdict lines stay", () => {
    const answer = [
      "1 通过：测试跑过",
      "```",
      "const secret = 'abc';",
      "```",
      "x".repeat(300),
      "总的：可以交",
    ].join("\n");
    expect(withoutQuotedText(answer)).toBe("1 通过：测试跑过\n\n总的：可以交");
    const note = reviewNote({ answer, threadId: "t", steps: 1 });
    expect(note).not.toContain("secret");
    expect(note).not.toContain("xxx");
    expect(note).toContain("可以交");
    // An unclosed fence takes the rest with it.
    expect(withoutQuotedText("结论\n```\n后面全是原文")).toBe("结论\n");
    expect(
      reviewNote({ answer: "```\n只有原文\n```", threadId: "t", steps: 1 }),
    ).toContain("没有可附的结论");
  });
});

describe("how long the round has", () => {
  const limits = { board: 25 * 60_000, light: 5 * 60_000 };
  test("a card's round has the working clock, any other the light one", () => {
    expect(roundLimitMs(true, limits)).toBe(25 * 60_000);
    expect(roundLimitMs(false, limits)).toBe(5 * 60_000);
  });

  test("what is left is the limit less what has run, and the whole limit when the start is unknown", () => {
    const started = new Date(1_000_000);
    expect(roundRemainingMs(300_000, started, 1_000_000 + 200_000)).toBe(
      100_000,
    );
    expect(roundRemainingMs(300_000, started, 1_000_000 + 400_000)).toBe(
      -100_000,
    );
    expect(roundRemainingMs(300_000, undefined, 5)).toBe(300_000);
  });

  test("a hand-in made late in a five-minute round is not reviewed, with the reserve kept back", async () => {
    let started = 0;
    const step = createDeliveryReview({
      declared: async () => true,
      reviewer: () => ({
        name: "run_subagent",
        ref: "bot/run_subagent",
        description: "",
        parameters: {} as never,
        execute: async () => {
          started += 1;
          return "{}";
        },
      }),
      remainingMs: async () =>
        roundRemainingMs(roundLimitMs(false, limits), new Date(0), 290_000),
    });
    const outcome = await step({
      actorId: "o",
      botId: "b",
      card: { title: "修复 bug", criteria: null },
      items: [{ kind: "workspace_file", ref: "a.ts" }],
      checks: [],
      messages: [],
      runId: "r",
      threadId: "t",
    });
    expect(outcome).toBe(REVIEW_TIMED_OUT);
    expect(started).toBe(0);
  });
});

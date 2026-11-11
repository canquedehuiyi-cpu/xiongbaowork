import { describe, expect, test } from "bun:test";
import {
  type EvidenceThread,
  mask,
  transcriptOf,
} from "../src/local-learning/evidence";
import {
  MAX_PROPOSALS_PER_AGENT,
  parseProposals,
  proposalPrompt,
} from "../src/local-learning/propose";

const thread = (n: number): EvidenceThread => ({
  threadId: `t${n}`,
  runId: `r${n}`,
  agentId: "a",
  at: new Date(2026, 10, n),
  name: `对话${n}`,
  transcript: `Person: 第 ${n} 次`,
});
const shown = [thread(1), thread(2), thread(3)];
const steps =
  "先确认对方要的范围，再按固定顺序整理，最后检查有没有遗漏。这样做是因为对方每次都要同样的格式。";
const skill = (overrides: Record<string, unknown> = {}) => ({
  slug: "weekly-report",
  title: "整理周报",
  summary: "按固定格式整理",
  instructions: steps,
  reason: "对话 1、2",
  evidence: [1, 2],
  ...overrides,
});

describe("what the model is shown", () => {
  test("only what the person and the Bot said, and the names of the tools it used", () => {
    const text = transcriptOf([
      { role: "system", content: "系统指令" },
      {
        role: "user",
        content: [
          { type: "text", text: "帮我查一下" },
          { type: "binary", data: "xx" },
        ],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { function: { name: "search", arguments: '{"q":"秘密"}' } },
          { function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "搜索结果原文" },
      { role: "assistant", content: "查到了" },
    ]);

    expect(text).toBe(
      "Person: 帮我查一下\n(Bot used tools: search)\nBot: 查到了",
    );
  });

  test("a conversation without a word from the person teaches nothing", () => {
    expect(transcriptOf([{ role: "assistant", content: "我自己在跑" }])).toBe(
      "",
    );
    expect(transcriptOf("not messages")).toBe("");
  });

  test("a huge message with no spaces is cut before it is masked, so it cannot stall the process", () => {
    const started = performance.now();

    const text = transcriptOf([
      { role: "user", content: "a-".repeat(200_000) },
      { role: "user", content: "a".repeat(400_000) },
    ]);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(text.length).toBeLessThan(1_200);
  });

  test("addresses, numbers, keys and query strings are masked", () => {
    expect(
      mask(
        "发给 a.b@example.com，打 +86 138-0013-8000，密钥 sk-abcdefghijklmnop1234，看 https://x.test/p?token=abc",
      ),
    ).toBe("发给 [email]，打 [number]，密钥 [key]，看 https://x.test/p");
  });

  test("the prompt names the Bot, its skills and numbered conversations", () => {
    expect(
      proposalPrompt({
        agentName: "助手",
        existingSkills: [],
        threads: shown.slice(0, 1),
      }),
    ).toBe(
      "Bot: 助手\n\nExisting skills:\n(none yet)\n\n### Conversation 1 (对话1)\nPerson: 第 1 次",
    );
  });
});

describe("what the model answered", () => {
  test("a well-formed skill becomes a draft that names its conversations", () => {
    const [draft] = parseProposals(
      `好的：${JSON.stringify({ skills: [skill()] })}`,
      shown,
      new Set(),
    );

    expect(draft).toMatchObject({
      slug: "weekly-report",
      title: "整理周报",
      summary: "按固定格式整理",
      instructions: steps,
    });
    expect(draft?.evidence.map((t) => t.threadId)).toEqual(["t1", "t2"]);
  });

  test.each([
    ["a slug that is not a command", { slug: "Weekly Report" }],
    ["a slug already taken", { slug: "taken" }],
    ["no title", { title: "" }],
    ["instructions too short to follow", { instructions: "照做" }],
    ["no conversation it came from", { evidence: [7] }],
  ])("%s is dropped", (_name, overrides) => {
    expect(
      parseProposals(
        JSON.stringify({ skills: [skill(overrides)] }),
        shown,
        new Set(["taken"]),
      ),
    ).toEqual([]);
  });

  test("at most a couple per Bot, and never the same slug twice", () => {
    const drafts = parseProposals(
      JSON.stringify({
        skills: [
          skill(),
          skill(),
          skill({ slug: "second" }),
          skill({ slug: "third" }),
        ],
      }),
      shown,
      new Set(),
    );

    expect(drafts.map((d) => d.slug)).toEqual(["weekly-report", "second"]);
    expect(drafts.length).toBe(MAX_PROPOSALS_PER_AGENT);
  });

  test("an item that is not an object is skipped, not a failed run", () => {
    expect(
      parseProposals(
        JSON.stringify({ skills: [null, "x", [1], skill()] }),
        shown,
        new Set(),
      ).map((d) => d.slug),
    ).toEqual(["weekly-report"]);
  });

  test("an answer that is not JSON proposes nothing", () => {
    expect(parseProposals("我觉得没有可学的。", shown, new Set())).toEqual([]);
  });
});

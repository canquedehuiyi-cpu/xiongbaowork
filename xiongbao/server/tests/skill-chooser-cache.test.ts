import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { RuntimeModel } from "../src/copilot";
import { selectTools } from "../src/plugins/selection";
import { createSkillChooser } from "../src/routing/model";
import { fetchDouble } from "./support/fetch-double";

/*
 * 期 1·1.3：技能挑选（每轮多一次模型调用）在同一线程里缓存：消息和上次挑选时的消息主题相同（词重叠相似度
 * 不低于阈值）就复用上次的结果，不再调用模型。主题变了、换了线程、技能目录变了、过了有效期都重挑。
 */

const model: RuntimeModel = { provider: "openai", defaultModel: "test-model" };

let calls: string[];
let answer: string;
beforeEach(() => {
  calls = [];
  answer = JSON.stringify({ skills: ["drive-audit"] });
  spyOn(globalThis, "fetch").mockImplementation(
    fetchDouble(async (_url, init) => {
      calls.push(String(init?.body));
      return Response.json({ choices: [{ message: { content: answer } }] });
    }),
  );
});
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const chooser = (options: Parameters<typeof createSkillChooser>[2] = {}) =>
  createSkillChooser(model, async () => "test-key", options);

const hint = (
  text: string,
  extra: { threadId?: string; catalogue?: string } = {},
) => ({
  hint: {
    text,
    threadId: "thread-1",
    catalogue: "drive-audit|slack-digest",
    ...extra,
  },
});

describe("the skill chooser's per-thread cache", () => {
  test("a second message on the same topic in the same thread makes no model call", async () => {
    const choose = chooser();
    const first = await choose(
      "prompt A",
      undefined,
      hint("summarize the Q3 sales spreadsheet in Drive"),
    );
    expect(calls).toHaveLength(1);
    const second = await choose(
      "prompt B",
      undefined,
      hint("now summarize the Q3 sales spreadsheet in Drive again"),
    );
    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  test("Chinese messages on the same topic reuse it, a new topic does not", async () => {
    const choose = chooser();
    await choose("p", undefined, hint("帮我汇总第三季度销售表格里的数据"));
    await choose("p", undefined, hint("再汇总一下第三季度销售表格里的数据"));
    expect(calls).toHaveLength(1);
    await choose("p", undefined, hint("给张经理发一封会议邀请邮件"));
    expect(calls).toHaveLength(2);
  });

  test("a different topic asks the model again, and the new answer is used", async () => {
    const choose = chooser();
    await choose(
      "p1",
      undefined,
      hint("summarize the Q3 sales spreadsheet in Drive"),
    );
    answer = JSON.stringify({ skills: ["slack-digest"] });
    const next = await choose(
      "p2",
      undefined,
      hint("send an email to Bob about the meeting"),
    );
    expect(calls).toHaveLength(2);
    expect(next).toContain("slack-digest");
    // And the thread now remembers the newer topic.
    await choose(
      "p3",
      undefined,
      hint("send an email to Bob about the meeting tomorrow"),
    );
    expect(calls).toHaveLength(2);
  });

  test("another thread does not borrow this thread's choice", async () => {
    const choose = chooser();
    const text = "summarize the Q3 sales spreadsheet in Drive";
    await choose("p", undefined, hint(text));
    await choose("p", undefined, hint(text, { threadId: "thread-2" }));
    expect(calls).toHaveLength(2);
  });

  test("a changed skill catalogue is not answered from the old choice", async () => {
    const choose = chooser();
    const text = "summarize the Q3 sales spreadsheet in Drive";
    await choose("p", undefined, hint(text));
    await choose(
      "p",
      undefined,
      hint(text, { catalogue: "drive-audit|new-skill" }),
    );
    expect(calls).toHaveLength(2);
  });

  test("a choice expires", async () => {
    let now = 1_000_000;
    const choose = chooser({ now: () => now });
    const text = "summarize the Q3 sales spreadsheet in Drive";
    await choose("p", undefined, hint(text));
    now += 9 * 60_000;
    await choose("p", undefined, hint(text));
    expect(calls).toHaveLength(1);
    now += 2 * 60_000;
    await choose("p", undefined, hint(text));
    expect(calls).toHaveLength(2);
  });

  test("a short follow-up with no words in common is chosen afresh", async () => {
    const choose = chooser();
    await choose(
      "p",
      undefined,
      hint("summarize the Q3 sales spreadsheet in Drive"),
    );
    await choose("p", undefined, hint("ok go on"));
    expect(calls).toHaveLength(2);
  });

  test("a failed call is not cached, and the error still goes out", async () => {
    const choose = chooser();
    const text = "summarize the Q3 sales spreadsheet in Drive";
    spyOn(globalThis, "fetch").mockImplementationOnce(
      fetchDouble(async () => new Response("no", { status: 500 })),
    );
    spyOn(console, "warn").mockImplementation(() => {});
    await expect(choose("p", undefined, hint(text))).rejects.toThrow();
    await choose("p", undefined, hint(text));
    expect(calls).toHaveLength(1);
  });

  test("without a hint (no thread to key on) every call goes to the model", async () => {
    const choose = chooser();
    await choose("same prompt");
    await choose("same prompt");
    expect(calls).toHaveLength(2);
  });

  test("XIONGBAO_SKILL_CHOOSE_CACHE=off turns it off", async () => {
    const choose = chooser({ env: { XIONGBAO_SKILL_CHOOSE_CACHE: "off" } });
    const text = "summarize the Q3 sales spreadsheet in Drive";
    await choose("p", undefined, hint(text));
    await choose("p", undefined, hint(text));
    expect(calls).toHaveLength(2);
  });

  test("the cache holds a bounded number of threads", async () => {
    const choose = chooser({ maxThreads: 2 });
    const text = "summarize the Q3 sales spreadsheet in Drive";
    for (const id of ["a", "b", "c"])
      await choose("p", undefined, hint(text, { threadId: id }));
    expect(calls).toHaveLength(3);
    await choose("p", undefined, hint(text, { threadId: "c" }));
    expect(calls).toHaveLength(3);
    await choose("p", undefined, hint(text, { threadId: "a" }));
    expect(calls).toHaveLength(4);
  });
});

describe("selectTools hands the chooser what it needs to key on", () => {
  const tools = Array.from({ length: 16 }, (_, index) => ({
    ref: `drive/tool_${index}`,
  }));
  const skills = [
    {
      slug: "drive-audit",
      title: "Drive audit",
      summary: "Read Drive.",
      tools: ["drive/tool_0"],
    },
  ];

  test("the message, the thread and a key for the catalogue", async () => {
    const seen: unknown[] = [];
    await selectTools({
      tools,
      skills,
      text: "read my drive",
      threadId: "t-9",
      choose: async (_prompt, _signal, given) => {
        seen.push(given?.hint);
        return JSON.stringify({ skills: ["drive-audit"] });
      },
    });
    expect(seen).toHaveLength(1);
    const given = seen[0] as {
      text: string;
      threadId: string;
      catalogue: string;
    };
    expect(given.text).toBe("read my drive");
    expect(given.threadId).toBe("t-9");
    expect(given.catalogue).toContain("drive-audit");
  });

  test("no thread id: the hint carries none", async () => {
    const seen: unknown[] = [];
    await selectTools({
      tools,
      skills,
      text: "read my drive",
      choose: async (_prompt, _signal, given) => {
        seen.push(given?.hint);
        return JSON.stringify({ skills: ["drive-audit"] });
      },
    });
    expect(seen[0]).not.toHaveProperty("threadId");
  });
});

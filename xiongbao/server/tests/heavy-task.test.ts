import { afterEach, describe, expect, test } from "bun:test";
import {
  configureHeavyTaskFacts,
  type HeavyTaskFacts,
  heavyTaskGuidance,
  heavyTaskReasons,
  heavyTaskRoutingOn,
  loadHeavyTaskFacts,
  noteHeavyTasks,
} from "../src/agents/heavy-task";

/*
 * 期 4 · Task 4.3：重活分流。识别用规则，不调模型：任务说明里明说「重构整个项目」，或者涉及的文件数、预计的
 * 步数多。识别出来按顺序建议：员工设了难任务模型就用它（run_subagent 的 model: "hard"）；否则有固定员工
 * Codex 或 Claude Code，建议请本人转交；都没有照常做，什么也不加。
 */

afterEach(() => {
  configureHeavyTaskFacts(undefined);
});

describe("识别大型编码任务", () => {
  test("明说重构整个项目一类（并且有代码语境）", () => {
    for (const text of [
      "把整个项目重构成 TypeScript",
      "帮我重构整个代码库的目录结构",
      "重写整个后端服务，换成 Go",
      "把全部代码迁移到新的框架上",
      "这是一次大规模重构，代码先别动，先给个方案",
      "Please refactor the entire codebase to use the new API",
      "We need to migrate the whole repository to a monorepo",
      "A large-scale refactor of the billing module",
    ])
      expect(heavyTaskReasons(text)).not.toEqual([]);
  });

  test("涉及的文件数多", () => {
    expect(
      heavyTaskReasons("把 12 个源文件里的日志调用都改成新的写法"),
    ).toEqual(["涉及约 12 个文件"]);
    expect(
      heavyTaskReasons("rename the helper across 30 source files in the repo"),
    ).toEqual(["涉及约 30 个文件"]);
    // 数目不到门槛、或者不是在改东西，都不算。
    expect(heavyTaskReasons("把 3 个源文件里的日志改一下")).toEqual([]);
    expect(heavyTaskReasons("帮我整理 20 个源文件的名字，放进相册")).toEqual(
      [],
    );
  });

  test("列了很多文件路径", () => {
    const paths = Array.from(
      { length: 9 },
      (_, index) => `src/service/part${index}.ts`,
    ).join("、");
    expect(heavyTaskReasons(`需要改这些：${paths}`)).toEqual([
      "列出了 9 个文件",
    ]);
    // 同一个路径写几遍只算一个。
    expect(
      heavyTaskReasons(`改 src/a.ts，再改 src/a.ts，还有 src/a.ts`),
    ).toEqual([]);
  });

  test("预计步数多、清单项多", () => {
    expect(
      heavyTaskReasons("改完这个接口，预计要 30 步，每一步都要跑测试"),
    ).toEqual(["预计约 30 步"]);
    const list = Array.from(
      { length: 10 },
      (_, index) => `${index + 1}. 修改 handler 的第 ${index + 1} 处实现`,
    ).join("\n");
    expect(heavyTaskReasons(`按这个计划改代码：\n${list}`)).toEqual([
      "计划有 10 项",
    ]);
    expect(heavyTaskReasons("预计 5 步就能改好这个函数")).toEqual([]);
  });

  test("没有代码语境的不算，哪怕规模很大（审查给的反例）", () => {
    for (const text of [
      "升级全公司的系统账号密码",
      "改一下这 20 个文件名，按日期排好",
      "整理 30 个组件的文档，放进共享盘",
      `${Array.from({ length: 10 }, (_, index) => `${index + 1}. 会议议程第 ${index + 1} 项`).join("\n")}\n帮我在每项前面加一个「改」字`,
      "重写整个项目的周报模板，全部换成新格式",
    ])
      expect(heavyTaskReasons(text)).toEqual([]);
  });

  test("短回复不判断", () => {
    for (const text of ["继续", "好的", "行，继续", "go on"])
      expect(heavyTaskReasons(text)).toEqual([]);
  });

  test("平常的编码活不算，闲聊和别的活更不算", () => {
    for (const text of [
      "修一下登录页面的校验 bug，代码在 login.ts 里",
      "给这个函数加一个单元测试，覆盖空输入",
      "重构一下 utils.ts 里的日期函数，保持接口不变",
      "把这个项目的 README 翻译成英文，然后发给我",
      "整个项目的进度怎么样了，说说看",
      "帮我写一封邮件给客户，说明交付时间",
      "",
    ])
      expect(heavyTaskReasons(text)).toEqual([]);
  });
});

const facts = (over: Partial<HeavyTaskFacts> = {}): HeavyTaskFacts => ({
  externalCoders: [],
  ...over,
});

const heavy = "把整个项目重构成 TypeScript，涉及 40 个文件";
const holds = { subagent: true, handoff: true };

describe("按顺序建议", () => {
  test("先看难任务模型：有就建议用 run_subagent 的 hard", () => {
    const text = heavyTaskGuidance({
      text: heavy,
      facts: facts({
        hardModel: "deepseek-reasoner",
        externalCoders: [{ name: "代码员", harness: "codex" }],
      }),
      holds,
    });
    expect(text).toContain("大型编码任务");
    expect(text).toContain("deepseek-reasoner");
    expect(text).toContain("run_subagent");
    expect(text).toContain('"hard"');
    expect(text).not.toContain("代码员");
  });

  test("没有难任务模型，有固定员工 Codex 或 Claude Code：建议请本人转交，不自动转", () => {
    const text = heavyTaskGuidance({
      text: heavy,
      facts: facts({
        externalCoders: [
          { name: "小码", harness: "codex" },
          { name: "克劳", harness: "claude-code" },
        ],
      }),
      holds,
    });
    expect(text).toContain("Codex「小码」");
    expect(text).toContain("Claude Code「克劳」");
    expect(text).toContain("本人");
    expect(text).toContain("不要自己擅自转交");
    expect(text).not.toContain("run_subagent");
  });

  test("没有 run_subagent 时，难任务模型用不上，退到固定员工；都没有就照常做", () => {
    const coders = [{ name: "小码", harness: "codex" as const }];
    expect(
      heavyTaskGuidance({
        text: heavy,
        facts: facts({ hardModel: "m", externalCoders: coders }),
        holds: { subagent: false, handoff: true },
      }),
    ).toContain("小码");
    expect(
      heavyTaskGuidance({
        text: heavy,
        facts: facts({ hardModel: "m" }),
        holds: { subagent: false, handoff: true },
      }),
    ).toBeUndefined();
  });

  test("都没有：照常做，什么也不加", () => {
    expect(
      heavyTaskGuidance({ text: heavy, facts: facts(), holds }),
    ).toBeUndefined();
  });

  test("不是大型任务：什么也不加，哪怕设了难任务模型", () => {
    expect(
      heavyTaskGuidance({
        text: "修一下登录页面的 bug",
        facts: facts({ hardModel: "m" }),
        holds,
      }),
    ).toBeUndefined();
  });

  test("手上既不能派子代理也不能转交的运行（子代理本身）什么也不加", () => {
    expect(
      heavyTaskGuidance({
        text: heavy,
        facts: facts({
          hardModel: "m",
          externalCoders: [{ name: "小码", harness: "codex" }],
        }),
        holds: { subagent: false, handoff: false },
      }),
    ).toBeUndefined();
  });

  test("说出为什么判成大型任务", () => {
    const text = heavyTaskGuidance({
      text: heavy,
      facts: facts({ hardModel: "m" }),
      holds,
    });
    expect(text).toContain("涉及约 40 个文件");
  });
});

describe("开关和事实的来源", () => {
  const heavyMessage = { role: "user", content: heavy };

  test("XIONGBAO_HEAVY_TASK_ROUTING=off 关掉，别的值或没写都是开", () => {
    expect(heavyTaskRoutingOn({})).toBe(true);
    expect(heavyTaskRoutingOn({ XIONGBAO_HEAVY_TASK_ROUTING: "on" })).toBe(
      true,
    );
    expect(heavyTaskRoutingOn({ XIONGBAO_HEAVY_TASK_ROUTING: " OFF " })).toBe(
      false,
    );
  });

  test("先判规则，没有消息命中就不查事实", async () => {
    let asked = 0;
    configureHeavyTaskFacts(async () => {
      asked += 1;
      return facts({ hardModel: "m" });
    });
    expect(
      await loadHeavyTaskFacts("agent", [{ role: "user", content: "继续" }]),
    ).toBeUndefined();
    expect(asked).toBe(0);
    expect(await loadHeavyTaskFacts("agent", [heavyMessage])).toMatchObject({
      hardModel: "m",
    });
    expect(asked).toBe(1);
  });

  test("关着时不去查事实，也不加建议", async () => {
    let asked = 0;
    configureHeavyTaskFacts(async () => {
      asked += 1;
      return facts({ hardModel: "m" });
    });
    const env = { XIONGBAO_HEAVY_TASK_ROUTING: "off" };
    expect(
      await loadHeavyTaskFacts("agent", [heavyMessage], env),
    ).toBeUndefined();
    expect(asked).toBe(0);
    const messages = [heavyMessage];
    expect(
      noteHeavyTasks(
        messages,
        facts({ hardModel: "m" }),
        ["run_subagent"],
        env,
      ),
    ).toBe(messages);
  });

  test("没接事实来源、查出错、或什么事实都没有，都当没有：照常做", async () => {
    expect(await loadHeavyTaskFacts("agent", [heavyMessage])).toBeUndefined();
    configureHeavyTaskFacts(async () => {
      throw new Error("database down");
    });
    expect(await loadHeavyTaskFacts("agent", [heavyMessage])).toBeUndefined();
    configureHeavyTaskFacts(async () => facts());
    expect(await loadHeavyTaskFacts("agent", [heavyMessage])).toBeUndefined();
  });
});

describe("建议跟在那条用户消息自己后面", () => {
  const hard = facts({ hardModel: "m" });

  test("只加在被判成大型任务的那条消息末尾，别的消息原样", () => {
    const messages = [
      { id: "1", role: "user", content: heavy },
      { id: "2", role: "assistant", content: "好的，我先看看代码。" },
      { id: "3", role: "user", content: "继续" },
    ];
    const noted = noteHeavyTasks(messages, hard, ["run_subagent"]);
    expect(noted[0]?.content).toContain(heavy);
    expect(noted[0]?.content).toContain("<heavy_task>");
    expect(noted[0]?.content).toContain("run_subagent");
    expect(noted[1]).toBe(messages[1]);
    // 「继续」不判断、不加：只有那条消息自己带建议。
    expect(noted[2]).toBe(messages[2]);
    // 原来的消息没被改。
    expect(messages[0]?.content).toBe(heavy);
  });

  test("历史前缀逐字节不变：后面再来消息，前面那条的内容和上一轮一样", () => {
    const first = [{ id: "1", role: "user", content: heavy }];
    const later = [
      ...first,
      { id: "2", role: "assistant", content: "做完第一步了。" },
      { id: "3", role: "user", content: "继续" },
    ];
    expect(
      JSON.stringify(noteHeavyTasks(later, hard, ["run_subagent"])[0]),
    ).toBe(JSON.stringify(noteHeavyTasks(first, hard, ["run_subagent"])[0]));
  });

  test("分段内容在最后加一段文字，没有建议就是同一个数组", () => {
    const parts = [
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: heavy },
          { type: "binary", mimeType: "image/png", id: "x" },
        ],
      },
    ];
    const noted = noteHeavyTasks(parts, hard, ["run_subagent"]);
    const content = noted[0]?.content as { type: string; text?: string }[];
    expect(content).toHaveLength(3);
    expect(content[2]?.text).toContain("<heavy_task>");
    const quiet = [{ id: "1", role: "user", content: "修一下登录页面的 bug" }];
    expect(noteHeavyTasks(quiet, hard, ["run_subagent"])).toBe(quiet);
    // 这一轮派不了子代理也不能转交：什么也不加。
    const same = [{ id: "1", role: "user", content: heavy }];
    expect(noteHeavyTasks(same, hard, ["web_search"])).toBe(same);
  });
});

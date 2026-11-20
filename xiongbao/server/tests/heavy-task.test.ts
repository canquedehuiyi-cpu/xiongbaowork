import { afterEach, describe, expect, test } from "bun:test";
import {
  configureHeavyTaskFacts,
  type HeavyTaskFacts,
  heavyTaskGuidance,
  heavyTaskGuidanceFor,
  heavyTaskReasons,
  heavyTaskRoutingOn,
  loadHeavyTaskFacts,
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
  test("明说重构整个项目一类", () => {
    for (const text of [
      "把整个项目重构成 TypeScript",
      "帮我重构整个代码库的目录结构",
      "重写整个后端服务，换成 Go",
      "把全部代码迁移到新的框架上",
      "这是一次大规模重构，先别动手，先给个方案",
      "Please refactor the entire codebase to use the new API",
      "We need to migrate the whole repository to a monorepo",
      "A large-scale refactor of the billing module",
    ])
      expect(heavyTaskReasons(text)).not.toEqual([]);
  });

  test("涉及的文件数多", () => {
    expect(heavyTaskReasons("把 12 个文件里的日志调用都改成新的写法")).toEqual([
      "涉及约 12 个文件",
    ]);
    expect(heavyTaskReasons("rename the helper across 30 files")).toEqual([
      "涉及约 30 个文件",
    ]);
    // 数目不到门槛、或者不是在改东西，都不算。
    expect(heavyTaskReasons("把 3 个文件里的日志改一下")).toEqual([]);
    expect(heavyTaskReasons("帮我整理 20 个文件的名字，放进相册")).toEqual([]);
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
    expect(heavyTaskReasons(`按这个计划做：\n${list}`)).toEqual([
      "计划有 10 项",
    ]);
    expect(heavyTaskReasons("预计 5 步就能改好这个函数")).toEqual([]);
  });

  test("平常的编码活不算，闲聊和别的活更不算", () => {
    for (const text of [
      "修一下登录页面的校验 bug",
      "给这个函数加一个单元测试",
      "重构一下 utils.ts 里的日期函数",
      "把这个项目的 README 翻译成英文",
      "整个项目的进度怎么样了",
      "帮我写一封邮件",
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
  test("XIONGBAO_HEAVY_TASK_ROUTING=off 关掉，别的值或没写都是开", () => {
    expect(heavyTaskRoutingOn({})).toBe(true);
    expect(heavyTaskRoutingOn({ XIONGBAO_HEAVY_TASK_ROUTING: "on" })).toBe(
      true,
    );
    expect(heavyTaskRoutingOn({ XIONGBAO_HEAVY_TASK_ROUTING: " OFF " })).toBe(
      false,
    );
  });

  test("关着时不去查事实，也不给建议", async () => {
    let asked = 0;
    configureHeavyTaskFacts(async () => {
      asked += 1;
      return facts({ hardModel: "m" });
    });
    const env = { XIONGBAO_HEAVY_TASK_ROUTING: "off" };
    expect(await loadHeavyTaskFacts("agent", env)).toBeUndefined();
    expect(asked).toBe(0);
    expect(
      heavyTaskGuidanceFor(
        { messages: [{ id: "1", role: "user", content: heavy }] },
        facts({ hardModel: "m" }),
        ["run_subagent"],
        env,
      ),
    ).toBeUndefined();
  });

  test("没接事实来源、或查事实出错，都当没有：照常做", async () => {
    expect(await loadHeavyTaskFacts("agent")).toBeUndefined();
    configureHeavyTaskFacts(async () => {
      throw new Error("database down");
    });
    expect(await loadHeavyTaskFacts("agent")).toBeUndefined();
  });

  test("按这一轮手上的工具和消息出建议", async () => {
    configureHeavyTaskFacts(async () => facts({ hardModel: "m" }));
    const loaded = await loadHeavyTaskFacts("agent");
    const input = {
      messages: [{ id: "1", role: "user" as const, content: heavy }],
    };
    expect(heavyTaskGuidanceFor(input, loaded, ["run_subagent"])).toContain(
      "run_subagent",
    );
    // 手上没有 run_subagent 也没有 message_bot：这一轮派不出去。
    expect(heavyTaskGuidanceFor(input, loaded, ["web_search"])).toBeUndefined();
    expect(
      heavyTaskGuidanceFor(input, undefined, ["run_subagent"]),
    ).toBeUndefined();
  });
});

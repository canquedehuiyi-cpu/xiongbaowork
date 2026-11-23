import { expect, test } from "bun:test";
import type { Capabilities } from "./metrics";
import type { EvalPath, EvalRecord, EvalResults } from "./records";
import { pathComparison, pathOfResults, renderReport } from "./report";

const capabilities = (over: Partial<Capabilities> = {}): Capabilities => ({
  plan: "no",
  planDone: "n/a",
  subagent: "no",
  subagentCount: 0,
  reasoning: "n/a",
  verified: "n/a",
  editTool: "n/a",
  grepTool: "n/a",
  stepLimit: "no",
  autoContinued: "no",
  ...over,
});

const record = (task: string, over: Partial<EvalRecord> = {}): EvalRecord => ({
  task,
  title: task,
  passed: true,
  wallMs: 60_000,
  timedOut: false,
  steps: 10,
  modelCalls: 10,
  toolCalls: 12,
  tokens: { input: 1000, output: 200, total: 1200, cachedInput: 500 },
  silentStop: false,
  nudges: 0,
  tools: {},
  capabilities: capabilities(),
  checks: [],
  ...over,
});

const side = (
  path: EvalPath | undefined,
  records: EvalRecord[],
  suite: "tasks" | "smoke" = "tasks",
): EvalResults => ({
  side: "xiongbao",
  suite,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseUrl: null,
  runner: path ?? "旧结果文件",
  ...(path ? { path } : {}),
  mock: false,
  startedAt: "",
  finishedAt: "",
  records,
  notes: [],
});

test("a result file without a path field is a board run", () => {
  expect(pathOfResults(side(undefined, []))).toBe("board");
  expect(pathOfResults(side("chat", []))).toBe("chat");
});

test("the two paths side by side carry pass counts, tokens, steps, wall clock, limit stops, plan and subagent use", () => {
  const board = side("board", [
    record("research", {
      tools: { update_plan: 3 },
      capabilities: capabilities({ plan: "yes" }),
    }),
    record("docs", { passed: false, wallMs: 120_000 }),
  ]);
  const chat = side("chat", [
    record("research", {
      modelCalls: 14,
      tokens: { input: 3000, output: 500, total: 3500, cachedInput: 2400 },
      limitStops: 1,
      nudges: 1,
      capabilities: capabilities({ subagent: "yes", subagentCount: 2 }),
    }),
    record("docs", { timedOut: true }),
  ]);
  const rows = pathComparison(board, chat);
  const row = (label: string) =>
    rows.find((item) => item[0]?.startsWith(label)) as string[];
  expect(row("通过率")).toEqual(["通过率（通过 / 评分题数）", "1/2", "2/2"]);
  expect(row("token")[1]).toBe("2,000 / 400 / 1,000（50%）");
  expect(row("token")[2]).toBe("4,000 / 700 / 2,900（73%）");
  expect(row("步数")).toEqual([
    "步数（模型调用数；Codex 为动作数）",
    "20",
    "24",
  ]);
  expect(row("墙钟")[1]).toBe("60 s / 120 s；合计 180 s");
  expect(row("是否中途停")[1]).toBe("0 题");
  expect(row("是否中途停")[2]).toBe("2 题（research 上限×1、docs 墙钟）");
  expect(row("计划")[1]).toBe("1 题建了计划，更新 3 次");
  expect(row("计划")[2]).toBe("没建计划");
  expect(row("子代理")[1]).toBe("没派子代理");
  expect(row("子代理")[2]).toBe("1 题派了子代理，共 2 个");
  expect(row("追")[1]).toBe("0 次");
  expect(row("追")[2]).toBe("1 次");
  // The Codex baseline is one more column when it is there.
  const codex: EvalResults = {
    ...side(undefined, [record("research")]),
    side: "codex",
  };
  expect(pathComparison(board, chat, codex)[0]).toHaveLength(4);
  // No chat records: every chat cell is a dash rather than a made-up zero.
  expect(pathComparison(board, undefined)[0]).toEqual([
    "通过率（通过 / 评分题数）",
    "1/2",
    "—",
  ]);
  // Smoke scenarios are not part of the tasks comparison.
  const withSmoke = side("chat", [record("research"), record("plan")]);
  expect(pathComparison(board, withSmoke)[0]?.[2]).toBe("1/1");
});

test("with a chat result the task table gets a column per path; without one it is the old table", () => {
  const board = side("board", [record("data")]);
  const chat = side("chat", [record("data", { passed: false })]);
  const both = renderReport([board, chat]);
  expect(both).toContain(
    "## 五道题（熊宝（看板） 1/1，熊宝（单聊） 0/1，Codex —）",
  );
  expect(both).toContain("| 题目 | 熊宝（看板） | 熊宝（单聊） | Codex |");
  expect(both).toContain("### 单聊路径 vs 看板路径（验收文档 §3）");
  expect(both).toContain("### 熊宝员工的工作方式（每期能力）：单聊路径");
  expect(both).toContain("**熊宝（单聊） · data**");
  expect(both).toContain("**熊宝员工（单聊路径）**");

  // A board-only report is what it was: one 熊宝 column, no comparison section.
  const only = renderReport([board]);
  expect(only).toContain("## 五道题（熊宝 1/1，Codex —）");
  expect(only).toContain("| 题目 | 熊宝 | Codex | 熊宝墙钟 |");
  expect(only).not.toContain("单聊路径 vs 看板路径");
  expect(only).toContain("### 熊宝员工的工作方式（每期能力）\n");

  // A chat-only report still shows the chat column and says so.
  expect(renderReport([chat])).toContain("熊宝（单聊） 0/1");

  // Codex's column stays next to both.
  const codex: EvalResults = {
    ...side(undefined, [record("data")]),
    side: "codex",
  };
  expect(renderReport([board, chat, codex])).toContain("Codex 1/1");
  expect(renderReport([board, chat, codex])).toContain("基线（Codex）");
});

test("the smoke table names the path when a scenario ran over chat", () => {
  const mixed = side(
    "board",
    [
      record("plan", { title: "计划" }),
      record("disconnect", { title: "断开", path: "chat" }),
    ],
    "smoke",
  );
  const markdown = renderReport([mixed]);
  expect(markdown).toContain("| 场景 | 路径 | 结果 |");
  expect(markdown).toContain("| 计划 | 看板 |");
  expect(markdown).toContain("| 断开 | 单聊 |");
  expect(markdown).toContain("## 能力冒烟（2/2）");
  // A smoke file from the board path alone keeps the old columns.
  const plain = renderReport([side("board", [record("plan")], "smoke")]);
  expect(plain).toContain("| 场景 | 结果 | 墙钟 |");
  // Two smoke files (board and chat) are one table.
  const two = renderReport([
    side("board", [record("plan")], "smoke"),
    side("chat", [record("plan", { title: "计划（单聊）" })], "smoke"),
  ]);
  expect(two).toContain("## 能力冒烟（2/2）");
  expect(two).toContain("| 计划（单聊） | 单聊 |");
});

const DELIVERABLES = [
  "deliv-pptx",
  "deliv-docx",
  "deliv-xlsx",
  "deliv-web",
  "deliv-app",
  "deliv-image",
  "deliv-video",
];

const deliverableSides = (
  mutate: (path: "chat" | "group", task: string) => Partial<EvalRecord> | null,
) =>
  (["chat", "group"] as const).map((path) =>
    side(
      path,
      DELIVERABLES.flatMap((task) => {
        const over = mutate(path, task);
        return over === null ? [] : [record(task, { reruns: 0, ...over })];
      }),
    ),
  );

test("all 14 deliverable cells passing, one after a rerun, is reached", () => {
  const markdown = renderReport(
    deliverableSides((path, task) =>
      path === "group" && task === "deliv-web" ? { reruns: 1 } : {},
    ),
  );
  expect(markdown).toContain("## 交付题验收（14/14）");
  expect(markdown).toContain("| 题目 | 单聊 | 群聊 |");
  expect(markdown).toContain("✅ 通过（重跑 1 次）");
  expect(markdown).toContain("判定：达成");
  expect(markdown).not.toContain("判定：未达成");
  // Group results are their own path, not a board column.
  expect(markdown).not.toContain("熊宝（看板）");
  expect(markdown).not.toContain("## 五道题");
});

test("a missing cell makes the deliverables verdict not reached and names it", () => {
  const markdown = renderReport(
    deliverableSides((path, task) =>
      path === "chat" && task === "deliv-video" ? null : {},
    ),
  );
  expect(markdown).toContain("## 交付题验收（13/14）");
  expect(markdown).toContain("判定：未达成");
  expect(markdown).toContain("没有结果：deliv-video（单聊）");
});

test("a cell still failing after its rerun is a failure and shows reruns", () => {
  const markdown = renderReport(
    deliverableSides((path, task) =>
      path === "group" && task === "deliv-app"
        ? { passed: false, reruns: 1 }
        : {},
    ),
  );
  expect(markdown).toContain("## 交付题验收（13/14）");
  expect(markdown).toContain("❌ 未过（重跑 1 次）");
  expect(markdown).toContain("判定：未达成");
  expect(markdown).toContain("**熊宝（群聊） · deliv-app**");
});

test("group results sit in their own column next to the board and chat ones", () => {
  const board = side("board", [record("data")]);
  const group = side("group", [record("data", { passed: false })]);
  const markdown = renderReport([board, group]);
  expect(markdown).toContain("熊宝（群聊） 0/1");
  expect(markdown).toContain("| 题目 | 熊宝（看板） | 熊宝（群聊） | Codex |");
  expect(markdown).toContain("**熊宝（群聊） · data**");
});

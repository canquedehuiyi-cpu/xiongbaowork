/**
 * 离线复算：单聊路径做一道调研题（主员工带子代理）时，每一步发给模型的输入，改动前后各是多少。不连模型、不连库。
 *
 * 模型：一个对话是若干步，第 i 步发出去的 = 固定前缀（系统提示 + 工具定义）+ 前 i-1 步攒下的历史；每一步往历史里
 * 加一段助手文字加工具调用，和一个工具结果。主员工在第 {@link Scenario.spawnAt} 步派出若干子代理，各自一个新对话，从任务
 * 起头；它们的答复回到主员工的历史里。折叠用 `turn-folding.ts` 里真的那个函数在合成的提示上跑，预算和窗口取产品的值，
 * 所以什么时候折、折掉多少是代码算出来的，不是拍的。token 都是折叠自己的估算口径（`estimateTokens`）。
 *
 * 缓存：提供方按前缀命中缓存。一步里和上一步完全相同的前缀（固定前缀加没变的历史消息）算命中，其余算未命中；
 * 折叠改写前缀的那一步，被改写处之后的整段都是未命中。等效计费 = 未命中 + 命中 × {@link CACHED_PRICE}。
 *
 * 校准：每步工具结果多大没有实测（结果文件只有总量），由「改动前总输入 = 实测的 4,949,852」反解出来，所以
 * 「改动前」的总量按构造就对得上，要看的是同一组参数下「改动后」少了多少。
 *
 * 用法：bun scripts/e2e/employee-eval/subagent-sim.ts [--json]
 */

import type { Prompt } from "../../../toolkit/src/copilotkit/last-step";
import {
  estimateTokens,
  FOLD_BUDGET_TOKENS,
  FOLDED_PREFIX,
  foldEarlyResults,
} from "../../../toolkit/src/copilotkit/turn-folding";

/** 评测 run 44530026370 里调研题单聊路径的实测：模型调用次数、总输入 token、缓存命中。 */
export const MEASURED = {
  modelCalls: 71,
  input: 4_949_852,
  cachedInput: 4_200_448,
} as const;

/** 缓存命中的输入按未命中的一成价算（DeepSeek 的价目，和折叠预算那段注释里的算法一致）。 */
export const CACHED_PRICE = 0.1;

export type Scenario = {
  /** 主员工的模型调用次数。 */
  mainSteps: number;
  /** 子代理个数，各自跑 {@link subSteps} 步。 */
  subagents: number;
  subSteps: number;
  /** 主员工在第几步（从 1 数）派出子代理。 */
  spawnAt: number;
  /** 主员工、子代理每一步都要重发的固定前缀（系统提示 + 工具定义）。 */
  mainFixed: number;
  subFixed: number;
  /** 每一步工具结果的 token（调研题：一个网页）。 */
  resultTokens: number;
  /** 每一步助手文字加工具调用的 token。 */
  stepTokens: number;
  /** 一个子代理的答复回到主员工历史里是多少 token。 */
  answerTokens: number;
  /** 折叠：不给就是不折（改动前，规格 v2 的模型）。 */
  fold?: { window: number; budget: number };
};

export type Thread = {
  /** 每一步发出去的输入（含固定前缀）。 */
  inputs: number[];
  /** 其中命中缓存的部分。 */
  hits: number[];
};

const CHARS_PER_TOKEN = 3.5;
const textOf = (tokens: number, mark: string) =>
  `${mark}${"x".repeat(Math.max(0, Math.round(tokens * CHARS_PER_TOKEN) - mark.length))}`;

type Step = { call: number; result: number; label: string };

/** 一个对话走完全部步骤后的完整提示：用户一条，之后每步一条助手加一条工具结果。 */
function promptOf(task: number, steps: readonly Step[]): Prompt {
  const prompt: unknown[] = [
    { role: "user", content: [{ type: "text", text: textOf(task, "task") }] },
  ];
  steps.forEach((step, index) => {
    prompt.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `${step.label}-${index}`,
          toolName: "web_fetch",
          input: textOf(step.call, "call"),
        },
      ],
    });
    prompt.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `${step.label}-${index}`,
          toolName: "web_fetch",
          output: {
            type: "text",
            value: textOf(step.result, `result-${step.label}${index}: `),
          },
        },
      ],
    });
  });
  return prompt as Prompt;
}

type Part = { type: string; [key: string]: unknown };
const tokenCache = new WeakMap<object, number>();
const keyCache = new WeakMap<object, string>();
function tokensOf(message: Prompt[number]): number {
  const known = tokenCache.get(message);
  if (known !== undefined) return known;
  const tokens = (message.content as Part[]).reduce((sum, part) => {
    if (part.type === "text") return sum + estimateTokens(String(part.text));
    if (part.type === "tool-call")
      return sum + estimateTokens(String(part.input));
    const output = part.output as { value: string };
    return sum + estimateTokens(output.value);
  }, 0);
  tokenCache.set(message, tokens);
  return tokens;
}
function keyOf(message: Prompt[number]): string {
  const known = keyCache.get(message);
  if (known !== undefined) return known;
  const key = JSON.stringify(message);
  keyCache.set(message, key);
  return key;
}

/** 一个对话每一步的输入。`steps` 是它依次做的每一步。 */
export function runThread(options: {
  fixed: number;
  task: number;
  steps: readonly Step[];
  fold?: Scenario["fold"];
}): Thread {
  const inputs: number[] = [];
  const hits: number[] = [];
  const whole = promptOf(options.task, options.steps);
  let previous: Prompt = [];
  for (let index = 0; index < options.steps.length; index += 1) {
    // 第 index 步发出去的是前 index 步攒下的：用户一条，加 index 对助手和结果。
    const raw = whole.slice(0, 1 + 2 * index);
    const sent = options.fold ? foldEarlyResults(raw, options.fold) : raw;
    let common = 0;
    while (
      common < sent.length &&
      common < previous.length &&
      (sent[common] === previous[common] ||
        keyOf(sent[common] as Prompt[number]) ===
          keyOf(previous[common] as Prompt[number]))
    )
      common += 1;
    const tokens = sent.map(tokensOf);
    const total = options.fixed + tokens.reduce((a, b) => a + b, 0);
    inputs.push(total);
    // 第一步没有上一步可比，固定前缀由别的对话（同一员工的另一个子代理）先发出去，这里不算命中。
    hits.push(
      index === 0
        ? 0
        : options.fixed + tokens.slice(0, common).reduce((a, b) => a + b, 0),
    );
    previous = sent;
  }
  return { inputs, hits };
}

export type Run = {
  main: Thread;
  subs: Thread[];
  /** 全部调用的总输入。 */
  total: number;
  hit: number;
  /** 等效计费 token：未命中 + 命中 × {@link CACHED_PRICE}。 */
  billed: number;
  calls: number;
  /** 最长的一步。 */
  peak: number;
};

export function simulate(scenario: Scenario): Run {
  const subSteps: Step[] = Array.from({ length: scenario.subSteps }, () => ({
    call: scenario.stepTokens,
    result: scenario.resultTokens,
    label: "s",
  }));
  const subs = Array.from({ length: scenario.subagents }, () =>
    runThread({
      fixed: scenario.subFixed,
      task: 300,
      steps: subSteps,
      ...(scenario.fold ? { fold: scenario.fold } : {}),
    }),
  );
  // 派出子代理的那一步，三个子代理的答复一起回来，当作那一步的结果。
  const mainSteps: Step[] = Array.from(
    { length: scenario.mainSteps },
    (_, index) => ({
      call: scenario.stepTokens,
      result:
        index + 1 === scenario.spawnAt && scenario.subagents > 0
          ? scenario.answerTokens * scenario.subagents
          : scenario.resultTokens,
      label: "m",
    }),
  );
  const main = runThread({
    fixed: scenario.mainFixed,
    task: 200,
    steps: mainSteps,
    ...(scenario.fold ? { fold: scenario.fold } : {}),
  });
  const threads = [main, ...subs];
  const total = threads.reduce(
    (sum, thread) => sum + thread.inputs.reduce((a, b) => a + b, 0),
    0,
  );
  const hit = threads.reduce(
    (sum, thread) => sum + thread.hits.reduce((a, b) => a + b, 0),
    0,
  );
  return {
    main,
    subs,
    total,
    hit,
    billed: total - hit + hit * CACHED_PRICE,
    calls: threads.reduce((sum, thread) => sum + thread.inputs.length, 0),
    peak: Math.max(...threads.flatMap((thread) => thread.inputs)),
  };
}

/** 反解每步工具结果的大小，使不折叠时的总输入等于 `target`。总量随它单调增，二分。 */
export function calibrate(
  scenario: Omit<Scenario, "resultTokens" | "fold">,
  target: number,
): number {
  let low = 0;
  let high = 40_000;
  for (let round = 0; round < 40; round += 1) {
    const middle = (low + high) / 2;
    const { total } = simulate({ ...scenario, resultTokens: middle });
    if (total < target) low = middle;
    else high = middle;
  }
  return Math.round((low + high) / 2);
}

/**
 * 各部分的固定前缀（token-breakdown 的估算口径，在本机假模型下用同一个员工、同一套工具录下的真实请求体量出来）：
 * 主员工 系统提示 6558 + 工具定义 7339（44 个）；子代理改动前 6263 + 6677（42 个，少 `ask_person`、`run_subagent`），
 * 改动后 6109 + 5235（34 个，再少交付三步、跟进三个、签到邀请、应用权限卡，交付规矩一段也跟着没了）。
 */
export const FIXED = {
  main: 6_558 + 7_339,
  subBefore: 6_263 + 6_677,
  subAfter: 6_109 + 5_235,
} as const;

/**
 * 从模型调用次数推主员工和子代理的分账（结果文件里没有分开记）：工具调用次数里，评测只数主员工自己的对话
 * （子代理另有对话，事件不在内），共 44 次，含 3 次 `run_subagent`；看板路径同一道题 24 次工具调用对 16 次模型调用，
 * 平均每步 1.5 个。按这个比例，主员工约 29 步，其余 42 步是 3 个子代理，各约 14 步。
 */
export const BASE_SCENARIO = {
  mainSteps: 29,
  subagents: 3,
  subSteps: 14,
  spawnAt: 3,
  mainFixed: FIXED.main,
  subFixed: FIXED.subBefore,
  stepTokens: 500,
  answerTokens: 1_200,
} as const;

export type Row = {
  name: string;
  run: Run;
};

/** 改动前、只折叠、只瘦身子代理、两样都做；同一组参数。 */
export function compare(options: {
  mainSteps?: number;
  subSteps?: number;
  target?: number;
}): { resultTokens: number; rows: Row[] } {
  const base = {
    ...BASE_SCENARIO,
    ...(options.mainSteps ? { mainSteps: options.mainSteps } : {}),
    ...(options.subSteps ? { subSteps: options.subSteps } : {}),
  };
  const resultTokens = calibrate(base, options.target ?? MEASURED.input);
  const fold = { window: 1_000_000, budget: FOLD_BUDGET_TOKENS };
  const at = (patch: Partial<Scenario>) =>
    simulate({ ...base, resultTokens, ...patch });
  return {
    resultTokens,
    rows: [
      { name: "改动前（规格 v2 的模型不折叠，子代理带全套）", run: at({}) },
      { name: "只折叠（预算 64K）", run: at({ fold }) },
      {
        name: "只瘦身子代理的工具",
        run: at({ subFixed: FIXED.subAfter }),
      },
      {
        name: "折叠 + 瘦身子代理的工具",
        run: at({ fold, subFixed: FIXED.subAfter }),
      },
    ],
  };
}

const k = (value: number) => `${(value / 1000).toFixed(1)}k`;
const pct = (after: number, before: number) =>
  `${(((after - before) / before) * 100).toFixed(0)}%`;

export function render(): string {
  const lines: string[] = [
    "# 单聊调研题离线复算（主员工 29 步 + 3 个子代理各 14 步，共 71 次调用）",
    "",
  ];
  const { resultTokens, rows } = compare({});
  const before = rows[0]?.run as Run;
  lines.push(
    `按「改动前总输入 = 实测 ${MEASURED.input.toLocaleString("en-US")}」反解，每步工具结果约 ${resultTokens} token。`,
    "",
    "| 方案 | 调用数 | 总输入 | 对比改动前 | 命中缓存 | 等效计费 | 对比改动前 | 最长一步 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      ({ name, run }) =>
        `| ${name} | ${run.calls} | ${run.total.toLocaleString("en-US")} | ${pct(run.total, before.total)} | ${((run.hit / run.total) * 100).toFixed(0)}% | ${Math.round(run.billed).toLocaleString("en-US")} | ${pct(run.billed, before.billed)} | ${k(run.peak)} |`,
    ),
    "",
    `实测命中缓存 ${((MEASURED.cachedInput / MEASURED.input) * 100).toFixed(0)}%；上表命中率是同一模型在合成历史上的推算，只用来比方案。`,
    "",
    "## 每步输入（改动前 → 折叠 + 瘦身后）",
    "",
    "| 步 | 主员工前 | 主员工后 | 子代理前 | 子代理后 |",
    "| --- | --- | --- | --- | --- |",
  );
  const after = rows[3]?.run as Run;
  const steps = Math.max(before.main.inputs.length, 14);
  for (let index = 0; index < steps; index += 1)
    lines.push(
      `| ${index + 1} | ${k(before.main.inputs[index] ?? 0)} | ${k(after.main.inputs[index] ?? 0)} | ${index < 14 ? k(before.subs[0]?.inputs[index] ?? 0) : ""} | ${index < 14 ? k(after.subs[0]?.inputs[index] ?? 0) : ""} |`,
    );
  lines.push(
    "",
    "## 对分账假设的敏感度（折叠 + 瘦身，对比各自的改动前）",
    "",
    "| 主员工步数 | 子代理每个步数 | 每步结果 | 总输入 前 | 后 | 变化 | 等效计费 变化 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const [main, sub] of [
    [26, 15],
    [29, 14],
    [35, 12],
    [41, 10],
  ] as const) {
    const { resultTokens: size, rows: cases } = compare({
      mainSteps: main,
      subSteps: sub,
    });
    const a = cases[0]?.run as Run;
    const b = cases[3]?.run as Run;
    lines.push(
      `| ${main} | ${sub} | ${size} | ${a.total.toLocaleString("en-US")} | ${b.total.toLocaleString("en-US")} | ${pct(b.total, a.total)} | ${pct(b.billed, a.billed)} |`,
    );
  }
  lines.push(
    "",
    `折叠摘要的开头是「${FOLDED_PREFIX}」；预算 ${FOLD_BUDGET_TOKENS}（估算 token），窗口按 1M（DeepSeek）。`,
    "",
  );
  return lines.join("\n");
}

if (import.meta.main) {
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(compare({}), null, 2));
  else console.log(render());
}

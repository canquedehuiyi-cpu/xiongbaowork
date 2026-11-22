/** 一次评测的结果文件格式：两个跑评测的脚本写，`report.ts` 读。 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Bookkeeping } from "./bookkeeping";
import { type Check, REPEAT_TASK, TASK_TITLES, type TaskName } from "./lib";
import type { Capabilities, PromptChars } from "./metrics";
import { addWallSplits, type WallSplit } from "./wall-split";

export type Side = "xiongbao" | "codex";
export type Suite = "tasks" | "smoke";
/** 熊宝侧的执行路径：看板派活，或单聊接口（`EVAL_PATH`）。没写这个字段的旧结果文件是看板路径。 */
export type EvalPath = "board" | "chat";

/**
 * 一次运行（含它之后等复盘的那一段）里这位员工学到了什么：只有熊宝侧的重复任务记。
 * 新增是和这次运行开始前比的：技能读 `learned_skills` 的新行（名字取技能表里的标题），记忆读员工形成的记忆条数。
 */
export type RunLearning = {
  /** 这次运行之后新增的员工自写技能的名字。 */
  newSkills: string[];
  /**
   * 这次运行之后新增的待审技能名：复盘存了，但步骤要求访问或外发到网址、或带越权的步骤，转给本人审批，
   * 没授予员工，也不在自写技能里。没有就不带这一项。
   */
  heldSkills?: string[];
  /**
   * 这次运行之后新增的自写技能的正文，每条只取前 800 字（`newSkillBodies`）：报告在「学没学到」表下面列出，
   * 看技能到底写了什么。旧结果文件没有。
   */
  skillBodies?: { title: string; text: string }[];
  /** 这次运行之后新增的、这位员工形成的记忆条数。 */
  newMemories: number;
  /**
   * 这次运行里用到的自写技能的名字：那一轮对得上这件事、已放进上下文的，或员工用 `refine_skill` 读过的，
   * 技能账里的使用次数涨了的就算。
   */
  usedSkills: string[];
  /** 这次运行结束后等复盘的情况；没等（没有服务器日志可读）时没有这一项。 */
  retro?: {
    /** 等了多久（毫秒）。 */
    waitedMs: number;
    /** `logged`：看到了这张卡的复盘有结论的日志（存了、不值得、冷却等，步数不够的跳过不算）；`skill`：库里出现了新技能；`timeout`：到了上限照常往下走。 */
    ended: "logged" | "skill" | "timeout";
    /**
     * 复盘的结果：`saved`（存为自用并生效）、`held`（存了但转待审，没授予）、`refused`（被拒，没存）、
     * `nothing` `similar` `skipped`；没看到日志时没有。
     */
    outcome?: string;
    /** 复盘是按什么触发的：`steps` `card_delivered` `card_accepted` `card_turn`（看板卡派的一轮，没交付）。 */
    trigger?: string;
    /** 复盘看的工具调用步数。 */
    steps?: number;
    /** 转待审的原因（`retrospect-held` 日志行里的）；没转待审时没有。 */
    heldReason?: string;
    /** 存下复盘技能时替换掉的员工这一轮自存的技能条数；没替换时没有。 */
    replaced?: number;
    /** 跳过的原因（`steps` `failed` `card_done`）；没写就是冷却、额度、没开或出错。 */
    reason?: string;
    /** 复盘出错时的错误类型（`retrospect-error` 行）；没出错时没有。 */
    error?: string;
    /** 草稿没有快路径、复盘追问了一次；没追问时没有。 */
    askedFastPath?: true;
    /** 追问之后用上的草稿带快路径；没补上或没追问时没有。 */
    gotFastPath?: true;
    /** 草稿只因破坏性命令要转待审，复盘让模型改写了一次；没改写时没有。 */
    rewroteUnsafe?: true;
    /** 改写后的草稿过了安全检查、用上了；没成或没改写时没有。 */
    rewriteCleared?: true;
    /** 这一轮带了运行错误，但自己有一次交付成功，复盘照常跑了；其余情况没有。 */
    failedButDelivered?: true;
  };
  /** 这次运行的运行错误（同 `EvalRecord.runErrors`）；没有就没有这一项。 */
  runErrors?: string[];
};

/** 轮外的背景调用（复盘、自动抽记忆；计量记成 `unscoped`）：次数和输入 token。不计入题目自身的步数和 token。 */
export type BackgroundCalls = { count: number; inputTokens: number };

/** 重复任务里一次运行的指标（`firstRun` / `secondRun`）。 */
export type RunMetrics = {
  passed: boolean;
  wallMs: number;
  /** 步数（熊宝：模型调用次数；Codex：动作数）。 */
  steps: number | null;
  toolCalls: number | null;
  modelCalls: number | null;
  /** 输入 / 输出 / 合计 token；提供方没报时 null。 */
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;
  nudges: number;
  backgroundCalls?: BackgroundCalls;
  /** 这次运行学到了什么（见 {@link RunLearning}）。 */
  learning?: RunLearning;
  /** 这次运行用的夹具种子（夹具由种子生成的题才有）。 */
  seed?: string;
};

/** 一对：第一次、第二次，和（有坑可学熊宝侧才有的）同种子对照运行。 */
export type PairMetrics = {
  firstRun: RunMetrics;
  secondRun: RunMetrics;
  controlRun?: RunMetrics;
};

export type EvalRecord = {
  /** 题名（五道题）或冒烟场景名。 */
  task: string;
  title: string;
  passed: boolean;
  wallMs: number;
  /** 撞上了墙钟上限。 */
  timedOut: boolean;
  /**
   * 步数。熊宝：模型调用次数，读 `model_token_calls` 的行数（每一步一次调用，与运行事件存没存下无关）；
   * Codex：`codex exec --json` 不报每一步的模型调用，记它的动作数（命令、改文件等）。
   */
  steps: number | null;
  /** 工具调用次数（熊宝：主运行里的工具调用；Codex：命令、改文件等动作）。旧结果文件没有这一项。 */
  toolCalls?: number | null;
  /** 模型调用次数（熊宝读 model_token_calls 的行数）。 */
  modelCalls: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
    /** 输入里命中上下文缓存的部分（已含在 input 里）；提供方没报时 null。 */
    cachedInput?: number | null;
    /** 输出里推理（思考）的部分（已含在 output 里）；没报时 null。 */
    reasoning?: number | null;
  } | null;
  /**
   * 逐步计量（熊宝侧，读 `model_token_calls`，和 `tokens` 同一批行）：每次模型调用的输入 token，按时间从早到晚。
   * 旧结果文件没有这三项；提供方没报的那一步是 null。
   */
  callInputs?: (number | null)[];
  /** 每次调用里命中上下文缓存的 token（已含在 `callInputs` 里）。 */
  callCached?: (number | null)[];
  /** 每次调用是主员工的（`main`）还是别处的（`other`：子代理、压缩等不在主运行里的调用）。 */
  callAgents?: ("main" | "other")[];
  /** 每一轮的模型调用次数（熊宝侧，`model_token_calls` 按运行号分）：第一项是员工自己做的那一轮，后面是评测脚本追「继续」的轮。 */
  roundCalls?: number[];
  /**
   * 记账步（熊宝侧，读运行事件；事件没存全时没有这一项）：接活、计划、交付各自单独占的步，和交付之后的那一步。旧结果文件没有这一项；
   * Codex 侧没有。见 `bookkeeping.ts`。
   */
  bookkeeping?: Bookkeeping;
  /**
   * 墙钟拆分（熊宝侧）：模型时间 / 工具时间 / 其余，毫秒；某项拿不到可靠时间戳时是 null（报告里写「—」）。口径见
   * `wall-split.ts`。旧结果文件没有这一项；Codex 侧没有。
   */
  wallSplit?: WallSplit;
  /** 这道题走的执行路径；旧结果文件没有，按看板路径算。Codex 侧没有。 */
  path?: EvalPath;
  /** 停在时间或段数上限的轮数（`turn-limit` / `step-limit` 事件）。旧结果文件没有这一项。 */
  limitStops?: number;
  /** 没写完、没触顶、也没问人就停了。读不到时 null。 */
  silentStop: boolean | null;
  /** 跑题方停下后，评测脚本追了几次「继续」。 */
  nudges: number;
  /** 用到的工具名和次数。 */
  tools: Record<string, number>;
  capabilities: Capabilities;
  checks: Check[];
  error?: string;
  /** 运行事件里的 `RUN_ERROR`，每条一句（见 `metrics.ts` 的 `runErrorsIn`）；没有就没有这一项。 */
  runErrors?: string[];
  /**
   * 提示词体积（熊宝侧，记录发给模型的请求体）：系统提示各段、工具定义、历史各多少字符。只有开了请求记录才有
   * （本机假模型模式，或 `EVAL_PROMPT_CHARS=on`）；Codex 侧读不到，没有这一项。
   */
  promptChars?: PromptChars;
  /** 重复任务（`repeat`）：同一位员工连做两次，各自的指标。其他题没有这两项。 */
  firstRun?: RunMetrics;
  secondRun?: RunMetrics;
  /**
   * 重复类的题连做多对（输入 `repeat_pairs` 大于 1）时，每一对的第一次、第二次；这时 `firstRun` / `secondRun`
   * 不再单独写（用 {@link pairsOf} 读，一对时读 `firstRun` / `secondRun`）。每一对用新员工、新种子。
   */
  pairs?: PairMetrics[];
  /**
   * 有坑可学（熊宝侧）的对照运行：同一个第二次的夹具，由没有自写技能、没有记忆的新员工做。不计入这条记录的总量
   * （和 Codex 的总量同一口径）；一对时记在这里，多对时记在 `pairs` 的每一项里。
   */
  controlRun?: RunMetrics;
  /** 这次运行用的夹具种子（重复任务合成前的单次记录；合成后在 `firstRun` / `secondRun` 里）。 */
  seed?: string;
  /** 这道题期间员工的背景调用；没有这一项的旧结果文件读作没记。 */
  backgroundCalls?: BackgroundCalls;
  /** 重复任务的一次运行（合成前的单次记录）里员工学到了什么；合成后在 `firstRun` / `secondRun` 里。 */
  learning?: RunLearning;
};

export type EvalResults = {
  side: Side;
  suite: Suite;
  provider: string;
  model: string;
  baseUrl: string | null;
  /** 熊宝侧走的执行路径，或 Codex 的版本。 */
  runner: string;
  /** 熊宝侧的执行路径；旧结果文件没有，按看板路径算。 */
  path?: EvalPath;
  mock: boolean;
  startedAt: string;
  finishedAt: string;
  records: EvalRecord[];
  notes: string[];
};

export function writeResults(path: string, results: EvalResults) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}

const add = (a: number | null, b: number | null) =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

/** 一条记录里重复任务要记的那几项。 */
export function runMetrics(record: EvalRecord): RunMetrics {
  return {
    passed: record.passed,
    wallMs: record.wallMs,
    steps: record.steps,
    toolCalls: record.toolCalls ?? null,
    modelCalls: record.modelCalls,
    tokens: record.tokens
      ? {
          input: record.tokens.input,
          output: record.tokens.output,
          total: record.tokens.total,
        }
      : null,
    nudges: record.nudges,
    ...(record.learning ? { learning: record.learning } : {}),
    ...(record.seed ? { seed: record.seed } : {}),
    ...(record.backgroundCalls
      ? { backgroundCalls: record.backgroundCalls }
      : {}),
  };
}

/**
 * 把同一位员工连做两次的两条记录合成 `repeat` 这一条：总量（墙钟、步数、token、追「继续」）是两次之和，
 * 通过要两次都过，检查项加「第一次：」「第二次：」前缀，`firstRun` / `secondRun` 各记一次的指标。
 * 工作方式（`capabilities`）、提示词体积取第二次的：那是学到东西以后的样子。
 */
export function combineRepeat(
  first: EvalRecord,
  second: EvalRecord,
  task: TaskName = REPEAT_TASK,
  control?: EvalRecord,
): EvalRecord {
  const tools: Record<string, number> = {};
  for (const record of [first, second])
    for (const [name, count] of Object.entries(record.tools))
      tools[name] = (tools[name] ?? 0) + count;
  const errors = [first.error, second.error].filter(Boolean);
  return {
    task,
    title: TASK_TITLES[task],
    ...(second.path ? { path: second.path } : {}),
    passed: first.passed && second.passed,
    wallMs: first.wallMs + second.wallMs,
    timedOut: first.timedOut || second.timedOut,
    steps: add(first.steps, second.steps),
    toolCalls: add(first.toolCalls ?? null, second.toolCalls ?? null),
    modelCalls: add(first.modelCalls, second.modelCalls),
    tokens:
      first.tokens || second.tokens
        ? {
            input: add(
              first.tokens?.input ?? null,
              second.tokens?.input ?? null,
            ),
            output: add(
              first.tokens?.output ?? null,
              second.tokens?.output ?? null,
            ),
            total: add(
              first.tokens?.total ?? null,
              second.tokens?.total ?? null,
            ),
            cachedInput: add(
              first.tokens?.cachedInput ?? null,
              second.tokens?.cachedInput ?? null,
            ),
            reasoning: add(
              first.tokens?.reasoning ?? null,
              second.tokens?.reasoning ?? null,
            ),
          }
        : null,
    ...(first.callInputs || second.callInputs
      ? {
          callInputs: [
            ...(first.callInputs ?? []),
            ...(second.callInputs ?? []),
          ],
          callCached: [
            ...(first.callCached ?? []),
            ...(second.callCached ?? []),
          ],
          callAgents: [
            ...(first.callAgents ?? []),
            ...(second.callAgents ?? []),
          ],
        }
      : {}),
    limitStops: (first.limitStops ?? 0) + (second.limitStops ?? 0),
    silentStop:
      first.silentStop === null && second.silentStop === null
        ? null
        : Boolean(first.silentStop || second.silentStop),
    nudges: first.nudges + second.nudges,
    tools,
    ...(first.wallSplit && second.wallSplit
      ? { wallSplit: addWallSplits(first.wallSplit, second.wallSplit) }
      : {}),
    ...(first.bookkeeping && second.bookkeeping
      ? {
          bookkeeping: {
            steps: first.bookkeeping.steps + second.bookkeeping.steps,
            accept: first.bookkeeping.accept + second.bookkeeping.accept,
            plan: first.bookkeeping.plan + second.bookkeeping.plan,
            deliver: first.bookkeeping.deliver + second.bookkeeping.deliver,
            afterDeliver:
              first.bookkeeping.afterDeliver + second.bookkeeping.afterDeliver,
            total: first.bookkeeping.total + second.bookkeeping.total,
          },
        }
      : {}),
    capabilities: second.capabilities,
    checks: [
      ...first.checks.map((item) => ({
        ...item,
        name: `第一次：${item.name}`,
      })),
      ...second.checks.map((item) => ({
        ...item,
        name: `第二次：${item.name}`,
      })),
    ],
    ...(errors.length ? { error: errors.join("；") } : {}),
    ...(second.promptChars ? { promptChars: second.promptChars } : {}),
    ...(first.backgroundCalls || second.backgroundCalls
      ? {
          backgroundCalls: {
            count:
              (first.backgroundCalls?.count ?? 0) +
              (second.backgroundCalls?.count ?? 0),
            inputTokens:
              (first.backgroundCalls?.inputTokens ?? 0) +
              (second.backgroundCalls?.inputTokens ?? 0),
          },
        }
      : {}),
    firstRun: runMetrics(first),
    secondRun: runMetrics(second),
    ...(control ? { controlRun: runMetrics(control) } : {}),
  };
}

/**
 * 重复类的题连做多对：每一对已经是 {@link combineRepeat} 的结果。总量是各对之和，通过要每一对都过，检查项加「第 N 对·」
 * 前缀，`pairs` 逐对记两次的指标。只有一对时原样返回（和原来的记录一个样）。
 */
export function combinePairs(task: TaskName, pairs: EvalRecord[]): EvalRecord {
  const [head, ...rest] = pairs;
  if (!head) throw new Error("combinePairs needs at least one pair");
  if (rest.length === 0) return head;
  const summed = rest.reduce(
    (total, next) => combineRepeat(total, next, task),
    head,
  );
  const {
    firstRun: _first,
    secondRun: _second,
    controlRun: _control,
    ...whole
  } = summed;
  return {
    ...whole,
    checks: pairs.flatMap((pair, index) =>
      pair.checks.map((item) => ({
        ...item,
        name: `第${index + 1}对·${item.name}`,
      })),
    ),
    pairs: pairs.flatMap((pair) =>
      pair.firstRun && pair.secondRun
        ? [
            {
              firstRun: pair.firstRun,
              secondRun: pair.secondRun,
              ...(pair.controlRun ? { controlRun: pair.controlRun } : {}),
            },
          ]
        : [],
    ),
  };
}

/** 一条重复类记录里的各对：多对读 `pairs`，一对读 `firstRun` / `secondRun`（旧结果文件也是这样）。 */
export function pairsOf(record: EvalRecord | undefined): PairMetrics[] {
  if (!record) return [];
  if (record.pairs) return record.pairs;
  return record.firstRun && record.secondRun
    ? [
        {
          firstRun: record.firstRun,
          secondRun: record.secondRun,
          ...(record.controlRun ? { controlRun: record.controlRun } : {}),
        },
      ]
    : [];
}

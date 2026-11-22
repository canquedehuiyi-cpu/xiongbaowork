/**
 * 把评测结果合成一份 Markdown 报告：五道题两边并排的对比表、熊宝每道题的工作方式指标、能力冒烟表，以及没过
 * 的检查项。写到 `<结果目录>/report.md`，在 GitHub Actions 里同时追加到 `$GITHUB_STEP_SUMMARY`。
 *
 * 用法：bun scripts/e2e/employee-eval/report.ts <结果目录>
 * 目录里有哪几份（xiongbao.json、xiongbao-chat.json、codex.json、smoke.json、smoke-chat.json）就合哪几份，缺的
 * 那一侧在表里显示「—」。有单聊路径的结果（`-chat`）时，五道题的表里看板和单聊并排，另出一张两条路径的验收对比表
 * （通过率、token、步数、墙钟、中途停、计划、子代理），Codex 的对照列照旧。
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { bookkeepingShare } from "./bookkeeping";
import {
  HARD_SUITE,
  REPEAT_PITFALL_TASK,
  REPEAT_TASKS,
  TASK_TITLES,
  TASKS,
} from "./lib";
import {
  type Capabilities,
  inputThirds,
  longestInput,
  TOOL,
  type Tri,
} from "./metrics";
import {
  type EvalPath,
  type EvalRecord,
  type EvalResults,
  pairsOf,
  type RunLearning,
  type RunMetrics,
} from "./records";
import { secondsCell } from "./wall-split";

const DASH = "—";
const TRI: Record<Tri, string> = { yes: "是", no: "否", "n/a": "不适用" };

const seconds = (ms: number) => `${(ms / 1000).toFixed(0)} s`;
const tokens = (record: EvalRecord | undefined) =>
  record?.tokens?.total == null
    ? DASH
    : record.tokens.total.toLocaleString("en-US");
const verdict = (record: EvalRecord | undefined) =>
  !record
    ? DASH
    : record.error?.startsWith("不适用")
      ? "不适用"
      : record.passed
        ? "✅ 通过"
        : "❌ 未过";
/** 输入里命中上下文缓存的比例；提供方没报缓存时「—」。 */
export const cacheShare = (record: EvalRecord | undefined) => {
  const input = record?.tokens?.input;
  const cached = record?.tokens?.cachedInput;
  return input && cached != null
    ? `${Math.round((cached / input) * 100)}%`
    : DASH;
};
const count = (value: number | null | undefined) =>
  value == null ? DASH : String(value);
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function passCount(
  results: EvalResults | undefined,
  only?: readonly string[],
): string {
  if (!results) return DASH;
  const scored = results.records.filter(
    (record) =>
      !record.error?.startsWith("不适用") &&
      (!only || only.includes(record.task)),
  );
  return `${scored.filter((record) => record.passed).length}/${scored.length}`;
}

/** 一份结果走的路径；旧结果文件没有这个字段，按看板路径算。 */
export const pathOfResults = (results: EvalResults): EvalPath =>
  results.path ?? "board";
/** 一条记录走的路径：记录自己写的，没有就取它所在文件的。 */
const pathOfRecord = (record: EvalRecord, results: EvalResults): EvalPath =>
  record.path ?? pathOfResults(results);

const sumOf = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};
const group = (value: number | null) =>
  value == null ? DASH : value.toLocaleString("en-US");

/**
 * 验收 §3 要的两条路径并排数字：通过率、token（输入 / 输出 / 缓存命中）、步数、墙钟、中途停、计划、子代理。
 * `codex` 给了就多一列基线。只看五道对标题和加难题（冒烟场景不算）。每格都是从记录里算出来的，没有记录显示「—」。
 */
export function pathComparison(
  board: EvalResults | undefined,
  chat: EvalResults | undefined,
  codex?: EvalResults,
): string[][] {
  const taskNames: readonly string[] = [...TASKS, ...HARD_SUITE];
  const scored = (side: EvalResults | undefined) =>
    (side?.records ?? []).filter((record) => taskNames.includes(record.task));
  const column = (side: EvalResults | undefined) => {
    const records = scored(side);
    if (!side || !records.length)
      return [DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH];
    const input = sumOf(records.map((record) => record.tokens?.input));
    const output = sumOf(records.map((record) => record.tokens?.output));
    const cached = sumOf(records.map((record) => record.tokens?.cachedInput));
    const wall = records.map((record) => record.wallMs);
    const stopped = records.filter(
      (record) => record.timedOut || (record.limitStops ?? 0) > 0,
    );
    const planned = records.filter(
      (record) => record.capabilities.plan === "yes",
    );
    const subagents = records.filter(
      (record) => record.capabilities.subagent === "yes",
    );
    return [
      passCount(side, taskNames),
      `${group(input)} / ${group(output)} / ${group(cached)}${
        input && cached != null
          ? `（${Math.round((cached / input) * 100)}%）`
          : ""
      }`,
      group(sumOf(records.map((record) => record.modelCalls ?? record.steps))),
      `${wall.map(seconds).join(" / ")}；合计 ${seconds(wall.reduce((a, b) => a + b, 0))}`,
      stopped.length
        ? `${stopped.length} 题（${stopped
            .map(
              (record) =>
                `${record.task}${record.timedOut ? " 墙钟" : ""}${record.limitStops ? ` 上限×${record.limitStops}` : ""}`,
            )
            .join("、")}）`
        : "0 题",
      planned.length
        ? `${planned.length} 题建了计划，更新 ${records.reduce(
            (total, record) => total + (record.tools[TOOL.plan] ?? 0),
            0,
          )} 次`
        : "没建计划",
      subagents.length
        ? `${subagents.length} 题派了子代理，共 ${records.reduce(
            (total, record) => total + record.capabilities.subagentCount,
            0,
          )} 个`
        : "没派子代理",
      `${records.reduce((total, record) => total + record.nudges, 0)} 次`,
    ];
  };
  const mine = column(board);
  const yours = column(chat);
  const base = codex ? column(codex) : undefined;
  const labels = [
    "通过率（通过 / 评分题数）",
    "token（输入 / 输出 / 缓存命中）",
    "步数（模型调用数；Codex 为动作数）",
    "墙钟（每题 / 合计）",
    "是否中途停（超墙钟或停在上限的题）",
    "计划的使用",
    "子代理的使用",
    "追「继续」次数",
  ];
  return labels.map((label, index) => [
    label,
    mine[index] as string,
    yours[index] as string,
    ...(base ? [base[index] as string] : []),
  ]);
}

/** 逐步计量表里一道题的三格；这道题没有逐步数字（旧结果文件、没跑这题）都是「—」。 */
export function stepCells(record: EvalRecord | undefined): string[] {
  if (!record?.callInputs?.length) return [DASH, DASH, DASH];
  const longest = longestInput(record.callInputs);
  const [front, middle, back] = inputThirds(record.callInputs);
  const other = (record.callAgents ?? []).filter(
    (agent) => agent === "other",
  ).length;
  return [
    longest === null ? DASH : longest.toLocaleString("en-US"),
    [front, middle, back].map((value) => group(value)).join(" / "),
    record.callAgents ? String(other) : DASH,
  ];
}

/**
 * 一道题平均每步工具调用数：运行事件里的工具调用数除以模型调用数，一位小数。一步一个调用是 1.0；每步都要把整段
 * 历史再发一遍，这个数越大，同样的活发的历史越少。缺哪个数、或模型调用是 0，都是「—」。
 */
export function toolCallsPerStep(record: EvalRecord | undefined): string {
  const tools = record?.toolCalls;
  const steps = record?.modelCalls;
  if (tools == null || steps == null || steps <= 0) return DASH;
  return (tools / steps).toFixed(1);
}

/** 变化的百分比，例如 `-35%`；基数没有或是 0 时「—」。 */
const change = (
  before: number | null | undefined,
  after: number | null | undefined,
) =>
  before == null || after == null || before === 0
    ? DASH
    : Math.round((Math.abs(after - before) / before) * 100) === 0
      ? "0%"
      : `${after >= before ? "+" : "-"}${Math.round((Math.abs(after - before) / before) * 100)}%`;

/** 重复任务一次运行的一格：通过、步数、输入 token、墙钟。 */
const runCell = (run: RunMetrics) =>
  `${run.passed ? "✅" : "❌"} ${count(run.steps)} 步 / 输入 ${group(run.tokens?.input ?? null)} / ${seconds(run.wallMs)}`;

/** 期 2 的目标：第二次比第一次，步数和输入 token 都降至少这么多（百分比）。 */
export const REPEAT_TARGET_PERCENT = 30;

type Sides = readonly (readonly [string, EvalResults | undefined])[];

/** 一侧结果里的重复类记录，按 `repeat`、`repeat-pitfall` 的顺序。 */
const repeatRecordsOf = (results: EvalResults | undefined): EvalRecord[] =>
  REPEAT_TASKS.flatMap((task) =>
    (results?.records ?? []).filter((record) => record.task === task),
  );

/**
 * 重复类记录在表里的名字：有坑可学的带「有坑可学」；会议纪要那道只有同一侧还有有坑可学时才注明（作对照），
 * 单独跑时保持原来的样子。
 */
function repeatTag(
  label: string,
  record: EvalRecord,
  results: EvalResults | undefined,
): string {
  if (record.task === REPEAT_PITFALL_TASK) return `${label} · 有坑可学`;
  const withPitfall = (results?.records ?? []).some(
    (item) => item.task === REPEAT_PITFALL_TASK,
  );
  return withPitfall ? `${label} · 会议纪要（对照）` : label;
}

/** 第二次相对第一次的变化（百分数，未取整）；基数没有或是 0 时 null。 */
const changePercent = (
  before: number | null | undefined,
  after: number | null | undefined,
): number | null =>
  before == null || after == null || before === 0
    ? null
    : ((after - before) / before) * 100;

/** 百分数的写法，和 {@link change} 一致：取整，正数带 +，0 写 0%。 */
const percentText = (value: number | null): string =>
  value === null
    ? DASH
    : Math.round(Math.abs(value)) === 0
      ? "0%"
      : `${value >= 0 ? "+" : "-"}${Math.round(Math.abs(value))}%`;

const meanOf = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length
    ? known.reduce((total, value) => total + value, 0) / known.length
    : null;
};

/** 各对里两次都通过的（只有它们进平均：没做成的那次步数少不代表学到了）。 */
const validPairs = (record: EvalRecord) =>
  pairsOf(record).filter(
    (pair) => pair.firstRun.passed && pair.secondRun.passed,
  );

/** 一条重复类记录的平均：各对（两次都通过的）的指标平均，和各对变化的平均。 */
function repeatAverage(record: EvalRecord) {
  const pairs = validPairs(record);
  const field = (pick: (run: RunMetrics) => number | null | undefined) => ({
    first: meanOf(pairs.map((pair) => pick(pair.firstRun) ?? null)),
    second: meanOf(pairs.map((pair) => pick(pair.secondRun) ?? null)),
    change: meanOf(
      pairs.map((pair) =>
        changePercent(pick(pair.firstRun), pick(pair.secondRun)),
      ),
    ),
  });
  return {
    valid: pairs.length,
    total: pairsOf(record).length,
    steps: field((run) => run.steps),
    input: field((run) => run.tokens?.input),
    wall: field((run) => run.wallMs),
  };
}

/** 平均行里一次运行的一格：平均步数、平均输入 token、平均墙钟；没有有效的对时「—」。 */
const averageCell = (
  steps: number | null,
  input: number | null,
  wall: number | null,
) =>
  steps === null
    ? DASH
    : `✅ ${Number.isInteger(steps) ? steps : steps.toFixed(1)} 步 / 输入 ${group(
        input === null ? null : Math.round(input),
      )} / ${wall === null ? DASH : seconds(wall)}`;

/**
 * 重复任务表（子项目 2 要看的数字）：每一侧、每道重复题一行（连做多对时每一对一行，再加一行平均），第一次、
 * 第二次各自的结果，以及第二次相对第一次的步数、输入 token、墙钟变化。平均行是各对（两次都通过的）的平均，
 * 变化是各对变化的平均。`sides` 是 `[标签, 结果文件]`，没有重复类记录的一侧不出行。
 */
export function repeatRows(sides: Sides): string[][] {
  return sides.flatMap(([label, results]) =>
    repeatRecordsOf(results).flatMap((record) => {
      const tag = repeatTag(label, record, results);
      const pairs = pairsOf(record);
      const rows = pairs.map((pair, index) => [
        pairs.length > 1 ? `${tag} · 第${index + 1}对` : tag,
        runCell(pair.firstRun),
        runCell(pair.secondRun),
        change(pair.firstRun.steps, pair.secondRun.steps),
        change(pair.firstRun.tokens?.input, pair.secondRun.tokens?.input),
        change(pair.firstRun.wallMs, pair.secondRun.wallMs),
      ]);
      if (pairs.length < 2) return rows;
      const average = repeatAverage(record);
      return [
        ...rows,
        [
          `${tag} · 平均（${average.valid}/${average.total} 对有效）`,
          averageCell(
            average.steps.first,
            average.input.first,
            average.wall.first,
          ),
          averageCell(
            average.steps.second,
            average.input.second,
            average.wall.second,
          ),
          percentText(average.steps.change),
          percentText(average.input.change),
          percentText(average.wall.change),
        ],
      ];
    }),
  );
}

/** 同种子对照里「有技能」的第二次和「没技能」的对照运行都通过的对（任一次没做成就不进平均）。 */
const validAbPairs = (record: EvalRecord) =>
  pairsOf(record).filter(
    (pair) =>
      pair.controlRun !== undefined &&
      pair.secondRun.passed &&
      pair.controlRun.passed,
  );

/** 这条记录有没有同种子对照运行（熊宝侧有坑可学才有；旧结果文件没有）。 */
const hasControl = (record: EvalRecord) =>
  pairsOf(record).some((pair) => pair.controlRun !== undefined);

/** 有技能相对没技能的变化：有技能 ÷ 没技能 − 1，百分数未取整；没技能的基数没有或是 0 时 null。 */
const abChange = (
  withSkill: number | null | undefined,
  control: number | null | undefined,
): number | null =>
  withSkill == null || control == null || control === 0
    ? null
    : (withSkill / control - 1) * 100;

/**
 * 同种子对照的平均（有坑可学，熊宝侧）：只算两次都通过的对。每个指标给三样：各对变化的平均（`mean`，判定用）、
 * 总量之比 − 1（`ratio`，参考），和两侧的平均值（`withSkill`、`control`，用来画平均行）。
 */
export function abAverage(record: EvalRecord) {
  const pairs = validAbPairs(record);
  const field = (pick: (run: RunMetrics) => number | null | undefined) => {
    const both = pairs.filter(
      (pair) =>
        pair.controlRun &&
        pick(pair.secondRun) != null &&
        pick(pair.controlRun) != null,
    );
    return {
      withSkill: meanOf(both.map((pair) => pick(pair.secondRun) ?? null)),
      control: meanOf(
        both.map(
          (pair) => (pair.controlRun ? pick(pair.controlRun) : null) ?? null,
        ),
      ),
      withSkillTotal: sumOf(both.map((pair) => pick(pair.secondRun))),
      controlTotal: sumOf(
        both.map((pair) => (pair.controlRun ? pick(pair.controlRun) : null)),
      ),
      mean: meanOf(
        pairs.map((pair) =>
          pair.controlRun
            ? abChange(pick(pair.secondRun), pick(pair.controlRun))
            : null,
        ),
      ),
      ratio: abChange(
        sumOf(both.map((pair) => pick(pair.secondRun))),
        sumOf(
          both.map((pair) => (pair.controlRun ? pick(pair.controlRun) : null)),
        ),
      ),
    };
  };
  return {
    valid: pairs.length,
    total: pairsOf(record).length,
    steps: field((run) => run.steps),
    input: field((run) => run.tokens?.input),
    wall: field((run) => run.wallMs),
  };
}

/**
 * 「重复任务 · 同种子对照（有技能 vs 没技能）」表：每一侧、每道带对照运行的题，每一对一行（第二次有技能、对照没技能、
 * 步数 / 输入 token / 墙钟变化），再加两行平均：各对变化的平均（判定用）和总量之比（参考，各对总量相加后相除）。
 * 平均只算两次都通过的对。没有对照运行的记录不出行。
 */
export function abRows(sides: Sides): string[][] {
  return sides.flatMap(([label, results]) =>
    repeatRecordsOf(results)
      .filter(hasControl)
      .flatMap((record) => {
        const tag = repeatTag(label, record, results);
        const pairs = pairsOf(record);
        const rows = pairs.map((pair, index) => [
          pairs.length > 1 ? `${tag} · 第${index + 1}对` : tag,
          runCell(pair.secondRun),
          pair.controlRun ? runCell(pair.controlRun) : DASH,
          pair.controlRun
            ? percentText(abChange(pair.secondRun.steps, pair.controlRun.steps))
            : DASH,
          pair.controlRun
            ? percentText(
                abChange(
                  pair.secondRun.tokens?.input,
                  pair.controlRun.tokens?.input,
                ),
              )
            : DASH,
          pair.controlRun
            ? percentText(
                abChange(pair.secondRun.wallMs, pair.controlRun.wallMs),
              )
            : DASH,
        ]);
        const average = abAverage(record);
        return [
          ...rows,
          [
            `${tag} · 平均：各对百分比的平均，判定用（${average.valid}/${average.total} 对有效）`,
            averageCell(
              average.steps.withSkill,
              average.input.withSkill,
              average.wall.withSkill,
            ),
            averageCell(
              average.steps.control,
              average.input.control,
              average.wall.control,
            ),
            percentText(average.steps.mean),
            percentText(average.input.mean),
            percentText(average.wall.mean),
          ],
          [
            `${tag} · 总量之比，参考（${average.valid}/${average.total} 对有效）`,
            averageCell(
              average.steps.withSkillTotal,
              average.input.withSkillTotal,
              average.wall.withSkillTotal,
            ),
            averageCell(
              average.steps.controlTotal,
              average.input.controlTotal,
              average.wall.controlTotal,
            ),
            percentText(average.steps.ratio),
            percentText(average.input.ratio),
            percentText(average.wall.ratio),
          ],
        ];
      }),
  );
}

/**
 * 平均值对照目标：每一侧、每道有坑可学的题（和连做了多对的题）一句话，说平均步数、平均输入 token 的变化和
 * 有几对有效，再判是否达到「都降 ≥30%」。Codex 只作对照，也给，但注明。
 */
export function repeatVerdicts(sides: Sides): string[] {
  return sides.flatMap(([label, results]) =>
    repeatRecordsOf(results)
      .filter(
        (record) =>
          record.task === REPEAT_PITFALL_TASK || pairsOf(record).length > 1,
      )
      .map((record) => {
        const tag = repeatTag(label, record, results);
        // 有坑可学（熊宝侧）有同种子对照运行时，判有技能比没技能；会议纪要和没有对照运行的旧结果仍是第二次比第一次。
        if (record.task === REPEAT_PITFALL_TASK && hasControl(record)) {
          const ab = abAverage(record);
          if (ab.steps.mean === null || ab.input.mean === null)
            return `- **${tag}**：没有第二次和对照都通过的对（${ab.valid}/${ab.total}），算不出平均，不判目标`;
          const abMet =
            Math.round(ab.steps.mean) <= -REPEAT_TARGET_PERCENT &&
            Math.round(ab.input.mean) <= -REPEAT_TARGET_PERCENT;
          return `- **${tag}**：有技能比没技能：平均步数 ${percentText(ab.steps.mean)}、平均输入 token ${percentText(ab.input.mean)}（${ab.valid}/${ab.total} 对有效）；目标是两项都降 ≥${REPEAT_TARGET_PERCENT}%：${abMet ? "✅ 达标" : "❌ 未达标"}`;
        }
        const average = repeatAverage(record);
        const control = label === "Codex" ? "（Codex 只作对照）" : "";
        if (average.steps.change === null || average.input.change === null)
          return `- **${tag}**${control}：没有两次都通过的对（${average.valid}/${average.total}），算不出平均，不判目标`;
        const met =
          Math.round(average.steps.change) <= -REPEAT_TARGET_PERCENT &&
          Math.round(average.input.change) <= -REPEAT_TARGET_PERCENT;
        return `- **${tag}**${control}：平均步数 ${percentText(average.steps.change)}、平均输入 token ${percentText(average.input.change)}（${average.valid}/${average.total} 对有效）；目标是两项都降 ≥${REPEAT_TARGET_PERCENT}%：${met ? "✅ 达标" : "❌ 未达标"}`;
      }),
  );
}

/** 一次运行新增的东西：技能名（带引号）、记忆条数，和转待审的技能（有才写）。 */
const addedCell = (learning: RunLearning | undefined) => {
  if (!learning) return DASH;
  const held = learning.heldSkills ?? [];
  return `技能 ${learning.newSkills.length}${
    learning.newSkills.length
      ? `（${learning.newSkills.map((name) => `「${name}」`).join("、")}）`
      : ""
  } / 记忆 ${learning.newMemories}${
    held.length
      ? ` / 待审 ${held.length}（${held.map((name) => `「${name}」`).join("、")}）`
      : ""
  }`;
};

/** 复盘结果的三类：存了并生效照旧写 saved，转待审和被拒要把后果说出来，免得一个 saved 掩盖了没生效。 */
const OUTCOME_NOTE: Readonly<Record<string, string>> = {
  held: "held：存为待审，没授予员工",
  refused: "refused：被拒，没存",
};

/** 这次运行事件里的运行错误：附在「学没学到」那一格后面；没有就是空。 */
const runErrorsNote = (learning: RunLearning | undefined) =>
  learning?.runErrors?.length
    ? `；运行错误：${learning.runErrors.join("；")}`
    : "";

/** 一次运行之后等复盘的情况，一句话：结果、触发、步数、等了多久。 */
const retroCell = (learning: RunLearning | undefined) => {
  const retro = learning?.retro;
  if (!retro) return DASH;
  const waited = seconds(retro.waitedMs);
  if (retro.ended === "timeout")
    return `等满 ${waited}，没等到复盘结果${retro.trigger ? `（${retro.trigger} / ${retro.steps ?? "?"} 步）` : ""}`;
  const how = retro.trigger
    ? `（${retro.trigger} / ${retro.steps ?? "?"} 步）`
    : "";
  const outcome = retro.outcome
    ? (OUTCOME_NOTE[retro.outcome] ?? retro.outcome)
    : "新增了技能";
  const why = retro.heldReason
    ? `，原因：${retro.heldReason}`
    : retro.error
      ? `，出错：${retro.error}`
      : retro.outcome === "skipped" && retro.reason
        ? `，原因：${retro.reason}`
        : "";
  const replaced = retro.replaced
    ? `，替换了员工自存的 ${retro.replaced} 条`
    : "";
  const asked = retro.askedFastPath
    ? `，追问快路径（${retro.gotFastPath ? "补上了" : "没补上"}）`
    : "";
  const rewrote = retro.rewroteUnsafe
    ? `，改写去掉破坏性命令（${retro.rewriteCleared ? "成了" : "没成"}）`
    : "";
  const failedButDelivered = retro.failedButDelivered
    ? "，这一轮带运行错误但已交付"
    : "";
  return `${outcome}${how}${why}${replaced}${asked}${rewrote}${failedButDelivered}，等了 ${waited}${runErrorsNote(learning)}`;
};

/**
 * 重复任务「学没学到」表：每一侧一行。两次之间复盘跑没跑、结果是什么，第一次之后新增的自写技能和员工形成的记忆，
 * 第二次那一轮用到了哪些自写技能，第二次之后又新增了什么。没有学习记录的一侧（Codex、旧结果文件）不出行。
 */
export function learningRows(sides: Sides): string[][] {
  return sides.flatMap(([label, results]) =>
    repeatRecordsOf(results).flatMap((record) => {
      const tag = repeatTag(label, record, results);
      const pairs = pairsOf(record);
      return pairs.flatMap((pair, index) => {
        const first = pair.firstRun.learning;
        const second = pair.secondRun.learning;
        if (!first && !second) return [];
        return [
          [
            pairs.length > 1 ? `${tag} · 第${index + 1}对` : tag,
            retroCell(first),
            addedCell(first),
            second?.usedSkills.length
              ? second.usedSkills.map((name) => `「${name}」`).join("、")
              : second
                ? "没有"
                : DASH,
            addedCell(second),
          ],
        ];
      });
    }),
  );
}

/**
 * 「学没学到」表下面的一段：第一次之后存下的技能正文的前 800 字，每条一个标题加一个代码块。第二次没变快时
 * 先看这里，技能写了什么就一目了然。只放技能正文。没记正文的一侧（Codex、旧结果文件）不出。
 */
export function skillBodyBlocks(sides: Sides): string[] {
  return sides.flatMap(([label, results]) =>
    repeatRecordsOf(results).flatMap((record) => {
      const tag = repeatTag(label, record, results);
      const pairs = pairsOf(record);
      return pairs.flatMap((pair, index) =>
        (pair.firstRun.learning?.skillBodies ?? []).flatMap((body) => {
          // 正文里要是有连续的反引号，围栏就多放一个，免得冲破代码块。
          const longest = Math.max(
            2,
            ...(body.text.match(/`+/g) ?? []).map((run) => run.length),
          );
          const fence = "`".repeat(longest + 1);
          return [
            `**${pairs.length > 1 ? `${tag} · 第${index + 1}对` : tag}：「${body.title}」**（技能正文，前 ${body.text.length} 字）`,
            "",
            `${fence}text\n${body.text}\n${fence}`,
            "",
          ];
        }),
      );
    }),
  );
}

/**
 * 后台调用表：每道题一行，题目自身的输入 token、后台调用（复盘、自动抽记忆）的次数和输入 token，以及含后台的
 * 输入 token 合计。题目自身的步数和 token 只算主运行，后台成本在这里完整可见。没有 `backgroundCalls`
 * 的记录（Codex、旧结果文件）不出行。
 */
export function backgroundRows(
  sides: readonly (readonly [string, EvalResults | undefined])[],
): string[][] {
  return sides.flatMap(([label, results]) =>
    (results?.records ?? []).flatMap((record) => {
      const background = record.backgroundCalls;
      if (!background) return [];
      const own = record.tokens?.input ?? null;
      return [
        [
          `${record.title}（${label}）`,
          group(own),
          `${background.count} 次 / ${group(background.inputTokens)}`,
          own === null ? DASH : group(own + background.inputTokens),
        ],
      ];
    }),
  );
}

const chars = (value: number | undefined) =>
  value === undefined ? DASH : value.toLocaleString("en-US");

/**
 * 提示词体积表（熊宝侧，记录发给模型的请求体）：每道题第一个带工具的请求（员工主运行的第一步）里系统提示、
 * 工具定义、历史各多少字符，以及最大的一次请求。没有 `promptChars` 的记录（Codex、没开请求记录）不出行。
 */
export function promptRows(
  sides: readonly (readonly [string, EvalResults | undefined])[],
): string[][] {
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0);
  return sides.flatMap(([label, results]) =>
    (results?.records ?? []).flatMap((record) => {
      const prompt = record.promptChars;
      if (!prompt) return [];
      const biggest = Object.entries(prompt.first.system)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, size]) => `${name} ${chars(size)}`)
        .join("、");
      return [
        [
          `${record.title}（${label}）`,
          String(prompt.requests),
          chars(sum(Object.values(prompt.first.system))),
          chars(prompt.first.tools),
          chars(sum(Object.values(prompt.first.history))),
          chars(prompt.first.total),
          chars(prompt.peak.total),
          chars(sum(Object.values(prompt.peak.history))),
          biggest || DASH,
        ],
      ];
    }),
  );
}

function capabilityRow(
  capabilities: Capabilities,
  record: EvalRecord,
): string[] {
  return [
    TRI[capabilities.plan],
    TRI[capabilities.planDone],
    capabilities.subagent === "yes"
      ? `是（${capabilities.subagentCount}）`
      : TRI[capabilities.subagent],
    TRI[capabilities.reasoning],
    TRI[capabilities.verified],
    TRI[capabilities.editTool],
    TRI[capabilities.grepTool],
    TRI[capabilities.stepLimit],
    TRI[capabilities.autoContinued],
    record.silentStop == null ? DASH : record.silentStop ? "是" : "否",
    String(record.nudges),
  ];
}

const CAPABILITY_HEADER = [
  "计划",
  "计划全完成",
  "子代理",
  "推理事件",
  "改完验证",
  "编辑工具",
  "检索工具",
  "触顶",
  "自动续跑",
  "无提示停下",
  "追「继续」",
];

function header(results: EvalResults[]): string[] {
  const lines: string[] = [];
  for (const side of results) {
    const chat = side.side === "xiongbao" && pathOfResults(side) === "chat";
    const name =
      side.side === "codex"
        ? "Codex"
        : side.suite === "smoke"
          ? `熊宝（能力冒烟${chat ? "，单聊路径" : ""}）`
          : `熊宝员工${chat ? "（单聊路径）" : ""}`;
    lines.push(
      `- **${name}**：${side.provider} / \`${side.model}\`${side.baseUrl ? `（${side.baseUrl}）` : ""}；${side.runner}${side.mock ? "；⚠️ 本机假模型，结果不代表能力" : ""}`,
    );
    for (const note of side.notes) lines.push(`  - ${note}`);
  }
  // 三方对照：熊宝侧换了模型（workflow 输入 xiongbao_model）时，在这里写明两侧各用什么。
  const codexSide = results.find((side) => side.side === "codex");
  const swapped = results.find(
    (side) =>
      side.side === "xiongbao" && codexSide && side.model !== codexSide.model,
  );
  if (codexSide && swapped)
    lines.push(
      `- **模型不同**：熊宝侧用 \`${swapped.model}\`，Codex 侧用 \`${codexSide.model}\`；差距里有一部分来自模型，不全是做法`,
    );
  return lines;
}

export function renderReport(results: EvalResults[]): string {
  const taskSide = (path: EvalPath) =>
    results.find(
      (side) =>
        side.side === "xiongbao" &&
        side.suite === "tasks" &&
        pathOfResults(side) === path,
    );
  const board = taskSide("board");
  const chat = taskSide("chat");
  const codex = results.find((side) => side.side === "codex");
  const smokes = results.filter((side) => side.suite === "smoke");
  /*
   * 熊宝侧的列：只有看板路径（或什么都没有）时和原来一样叫「熊宝」；有单聊路径的结果就看板、单聊各一列。
   */
  const mineSides: { label: string; results: EvalResults | undefined }[] = chat
    ? [
        { label: "熊宝（看板）", results: board },
        { label: "熊宝（单聊）", results: chat },
      ]
    : [{ label: "熊宝", results: board }];
  const out: string[] = [
    "# 熊宝员工 vs Codex 对标评测",
    "",
    ...header(results),
    "",
  ];

  if (board || chat || codex) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    const tasks = TASKS.filter(
      (task) =>
        mineSides.some((mine) => find(mine.results, task)) || find(codex, task),
    );
    const marked = (record: EvalRecord | undefined) =>
      verdict(record) + (record?.timedOut ? " ⏱" : "");
    out.push(
      `## 五道题（${mineSides
        .map((mine) => `${mine.label} ${passCount(mine.results, TASKS)}`)
        .join("，")}，Codex ${passCount(codex, TASKS)}）`,
      "",
    );
    out.push(
      table(
        [
          "题目",
          ...mineSides.map((mine) => mine.label),
          "Codex",
          ...mineSides.map((mine) => `${mine.label}墙钟`),
          "Codex 墙钟",
          ...mineSides.map((mine) => `${mine.label} token`),
          "Codex token",
          ...mineSides.map((mine) => `${mine.label}步数`),
          "Codex 步数",
        ],
        tasks.map((task) => {
          const mine = mineSides.map((side) => find(side.results, task));
          const theirs = find(codex, task);
          return [
            `${TASK_TITLES[task]}（${task}）`,
            ...mine.map(marked),
            marked(theirs),
            ...mine.map((record) => (record ? seconds(record.wallMs) : DASH)),
            theirs ? seconds(theirs.wallMs) : DASH,
            ...mine.map(tokens),
            tokens(theirs),
            ...mine.map((record) => count(record?.steps)),
            count(theirs?.steps),
          ];
        }),
      ),
      "",
      "⏱ = 撞上墙钟上限。步数：熊宝 = 模型调用次数（`model_token_calls` 的行数，一步一次调用，不受运行事件存没存下影响）；Codex = 命令、改文件等动作数（`codex exec --json` 不报每一步的模型调用）。",
      "",
    );
    if (chat)
      out.push(
        "### 单聊路径 vs 看板路径（验收文档 §3）",
        "",
        table(
          [
            "项",
            "看板路径",
            "单聊路径（`EVAL_PATH=chat`）",
            ...(codex ? ["基线（Codex）"] : []),
          ],
          pathComparison(board, chat, codex),
        ),
        "",
        "只算五道对标题和加难题；每格由结果文件里的记录算出，没有记录显示「—」。单聊路径的办公题不查「任务卡进入等验收」（没有这张卡，记为不适用，不算失败）。",
        "",
      );
    out.push(
      "### token 与步数细分",
      "",
      table(
        [
          "题目",
          ...mineSides.flatMap((mine) => [
            `${mine.label}模型调用`,
            `${mine.label}工具调用`,
          ]),
          "Codex 动作",
          ...mineSides.flatMap((mine) => [
            `${mine.label}输入`,
            `${mine.label}缓存命中`,
            `${mine.label}推理输出`,
          ]),
          "Codex 输入",
          "Codex 缓存命中",
        ],
        tasks.map((task) => {
          const mine = mineSides.map((side) => find(side.results, task));
          const theirs = find(codex, task);
          return [
            TASK_TITLES[task],
            ...mine.flatMap((record) => [
              count(record?.modelCalls),
              count(record?.toolCalls),
            ]),
            count(theirs?.toolCalls ?? theirs?.steps),
            ...mine.flatMap((record) => [
              count(record?.tokens?.input),
              cacheShare(record),
              count(record?.tokens?.reasoning),
            ]),
            count(theirs?.tokens?.input),
            cacheShare(theirs),
          ];
        }),
      ),
      "",
      "熊宝工具调用 = 运行事件里的工具调用数（事件没存下时读对话快照）。缓存命中 = 输入 token 里命中提供方上下文缓存的比例（DeepSeek 按前缀命中，命中部分按低价计费）；提供方没报时「—」。推理输出 = 输出 token 里思考的部分。",
      "",
    );
    const stepped = mineSides.filter((mine) =>
      mine.results?.records.some((record) => record.callInputs?.length),
    );
    if (stepped.length)
      out.push(
        "### 每步输入（逐步计量）",
        "",
        table(
          [
            "题目",
            ...stepped.flatMap((mine) => [
              `${mine.label}最长一步输入`,
              `${mine.label}前 / 中 / 后平均`,
              `${mine.label}非主运行调用`,
              `${mine.label}每步工具调用`,
            ]),
          ],
          tasks.map((task) => [
            TASK_TITLES[task],
            ...stepped.flatMap((mine) => [
              ...stepCells(find(mine.results, task)),
              toolCallsPerStep(find(mine.results, task)),
            ]),
          ]),
        ),
        "",
        "最长一步输入 = 这道题所有模型调用里输入 token 最多的一次；前 / 中 / 后平均 = 按时间把每次调用的输入平均分成三段各取平均，平的说明每步输入稳住了，越往后越大说明历史在越滚越大。非主运行调用 = 不在主员工那几轮里的调用（子代理等，记在同一个员工名下，汇总里混着它们）。数字读 `model_token_calls`，和上表的 token 同一批行；提供方没报的那一步不计入。每步工具调用 = 熊宝工具调用数 ÷ 模型调用数（一步一个调用是 1.0，越大说明一步里并行发出的调用越多）。",
        "",
      );
    for (const mine of mineSides) {
      if (!mine.results?.records.length) continue;
      out.push(
        `### 熊宝员工的工作方式（每期能力）${chat ? `：${mine.label === "熊宝（单聊）" ? "单聊路径" : "看板路径"}` : ""}`,
        "",
      );
      out.push(
        table(
          ["题目", ...CAPABILITY_HEADER],
          mine.results.records.map((record) => [
            record.title,
            ...capabilityRow(record.capabilities, record),
          ]),
        ),
        "",
      );
    }
    if (codex?.records.length) {
      out.push("### Codex 的工作方式（对照）", "");
      out.push(
        table(
          ["题目", "计划", "计划全完成", "子代理", "推理事件", "改完验证"],
          codex.records.map((record) => [
            record.title,
            TRI[record.capabilities.plan],
            TRI[record.capabilities.planDone],
            TRI[record.capabilities.subagent],
            TRI[record.capabilities.reasoning],
            TRI[record.capabilities.verified],
          ]),
        ),
        "",
      );
    }
  }

  const hard = HARD_SUITE.filter((task) =>
    [...mineSides.map((mine) => mine.results), codex].some((side) =>
      side?.records.some((record) => record.task === task),
    ),
  );
  if (hard.length) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    const tri = (value: Tri | undefined) => (value ? TRI[value] : DASH);
    out.push(
      "## 加难题（多个独立部分 + 汇总：看会不会列计划、派子代理）",
      "",
      table(
        [
          "题目",
          ...mineSides.map((mine) => mine.label),
          "Codex",
          ...mineSides.map((mine) => `${mine.label} token`),
          "Codex token",
          ...mineSides.map((mine) => `${mine.label}步数`),
          ...mineSides.map((mine) => `${mine.label}计划`),
          ...mineSides.map((mine) => `${mine.label}子代理`),
          "Codex 计划",
          "Codex 子代理",
        ],
        hard.map((task) => {
          const mine = mineSides.map((side) => find(side.results, task));
          const theirs = find(codex, task);
          return [
            TASK_TITLES[task],
            ...mine.map(
              (record) => verdict(record) + (record?.timedOut ? " ⏱" : ""),
            ),
            verdict(theirs) + (theirs?.timedOut ? " ⏱" : ""),
            ...mine.map(tokens),
            tokens(theirs),
            ...mine.map((record) => count(record?.steps)),
            ...mine.map((record) => tri(record?.capabilities.plan)),
            ...mine.map((record) =>
              record?.capabilities.subagent === "yes"
                ? `是（${record.capabilities.subagentCount}）`
                : tri(record?.capabilities.subagent),
            ),
            tri(theirs?.capabilities.plan),
            tri(theirs?.capabilities.subagent),
          ];
        }),
      ),
      "",
    );
  }

  if (hard.length) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    out.push(
      "### 难题的墙钟与逐步计量",
      "",
      table(
        [
          "题目",
          ...mineSides.flatMap((mine) => [
            `${mine.label}墙钟`,
            `${mine.label}最长一步输入`,
            `${mine.label}前 / 中 / 后平均`,
          ]),
          "Codex 墙钟",
        ],
        hard.map((task) => [
          TASK_TITLES[task],
          ...mineSides.flatMap((mine) => {
            const record = find(mine.results, task);
            const [longest, thirds] = stepCells(record);
            return [
              record ? seconds(record.wallMs) : DASH,
              longest as string,
              thirds as string,
            ];
          }),
          find(codex, task)
            ? seconds((find(codex, task) as EvalRecord).wallMs)
            : DASH,
        ]),
      ),
      "",
      "最长一步输入、前 / 中 / 后平均的算法同上面的「每步输入」表；逐步数字只有熊宝侧读得到，Codex 没有。",
      "",
    );
  }

  /*
   * 记账步占比：接活、计划、交付各自单独占的步，和交付之后那一步（员工多说的收尾的话）。五道题和难题都看，
   * 只要熊宝侧的记录里有这一项（旧结果文件没有，就没有这张表）。
   */
  const booked = [...TASKS, ...hard].filter((task) =>
    mineSides.some((mine) =>
      mine.results?.records.some(
        (record) => record.task === task && record.bookkeeping,
      ),
    ),
  );
  if (booked.length) {
    const find = (side: EvalResults | undefined, task: string) =>
      side?.records.find((record) => record.task === task);
    out.push(
      "### 记账步占比（接活、计划、交付，以及交付之后的一步）",
      "",
      table(
        [
          "题目",
          ...mineSides.flatMap((mine) => [
            `${mine.label}步数`,
            `${mine.label}接活`,
            `${mine.label}计划`,
            `${mine.label}交付`,
            `${mine.label}交付后一步`,
            `${mine.label}记账占比`,
          ]),
        ],
        booked.map((task) => [
          TASK_TITLES[task],
          ...mineSides.flatMap((mine) => {
            const found = find(mine.results, task)?.bookkeeping;
            return found
              ? [
                  count(found.steps),
                  count(found.accept),
                  count(found.plan),
                  count(found.deliver),
                  count(found.afterDeliver),
                  bookkeepingShare(found),
                ]
              : Array.from({ length: 6 }, () => DASH);
          }),
        ]),
      ),
      "",
      "记账步 = 一步里只有 accept_task、update_plan、deliver_task、request_extension 的步，再加交付被接受之后的那一步（没有任何工具调用的收尾话）；和读取、命令同一步发出的不算。一步记在一类名下，优先级 交付 > 接活 > 计划。步数 = 模型调用次数（和上面的表同一批 `model_token_calls`）；记账占比 = 记账步总数 ÷ 步数（含申请延期的步）。这几步各自要把整段历史再发一遍，占比越低越好；Codex 没有这几步，不列。",
      "",
    );
  }

  /*
   * 墙钟拆分：每道题的墙钟花在模型、工具还是别处。只要熊宝侧的记录里有这一项（旧结果文件没有，就没有这张表）。
   */
  const split = [...TASKS, ...hard].filter((task) =>
    mineSides.some((mine) =>
      mine.results?.records.some(
        (record) => record.task === task && record.wallSplit,
      ),
    ),
  );
  if (split.length) {
    out.push(
      "### 墙钟拆分（模型时间 / 工具时间 / 其余）",
      "",
      table(
        [
          "题目",
          ...mineSides.flatMap((mine) => [
            `${mine.label}墙钟`,
            `${mine.label}模型`,
            `${mine.label}工具`,
            `${mine.label}其余`,
            `${mine.label}步数`,
          ]),
        ],
        split.map((task) => [
          TASK_TITLES[task],
          ...mineSides.flatMap((mine) => {
            const found = mine.results?.records.find(
              (record) => record.task === task,
            );
            const parts = found?.wallSplit;
            return parts && found
              ? [
                  secondsCell(found.wallMs),
                  secondsCell(parts.modelMs),
                  secondsCell(parts.toolMs),
                  secondsCell(parts.otherMs),
                  count(found.steps),
                ]
              : Array.from({ length: 5 }, () => DASH);
          }),
        ]),
      ),
      "",
      "口径：模型 = 每次模型调用从发出请求到流读完（`model_token_calls` 的 started_at 到 observed_at）的时长之和，并行的按区间并集算；工具 = 各工具调用从开始执行（`TOOL_CALL_END`，没有时间戳时用 `TOOL_CALL_START`）到 `TOOL_CALL_RESULT` 的区间并集，用运行事件里的 `timestamp`，和模型区间重叠的部分只算模型；其余 = 墙钟 − 模型 − 工具（服务器写库、续接、评测脚本追「继续」的等待等）。「—」= 拿不到可靠时间戳（事件没带时间戳、事件没存全、或有调用没记下结束时刻），不拿别的数凑；工具拿不到时，其余 = 墙钟 − 模型（含工具执行）；模型拿不到时其余也不给。事件库表的 `created_at` 是写库时间，不用。Codex 没有这几项，不列。",
      "",
    );
  }

  const repeatTable = repeatRows([
    ...mineSides.map((mine) => [mine.label, mine.results] as const),
    ["Codex", codex] as const,
  ]);
  const repeatSides = [
    ...mineSides.map((mine) => [mine.label, mine.results] as const),
    ["Codex", codex] as const,
  ];
  const verdicts = repeatVerdicts(repeatSides);
  if (repeatTable.length)
    out.push(
      repeatSides.some(([, results]) =>
        repeatRecordsOf(results).some(hasControl),
      )
        ? "## 重复任务 · 第二次比第一次（参考，有坑可学的判定看后面的同种子对照）"
        : "## 重复任务（同一位员工把同一道题连做两次）",
      "",
      table(
        [
          "一侧",
          "第一次（通过 / 步数 / 输入 token / 墙钟）",
          "第二次",
          "步数变化",
          "输入 token 变化",
          "墙钟变化",
        ],
        repeatTable,
      ),
      "",
      "两次在各自干净的目录里做，各开一段新对话，员工是同一位；变化是第二次相对第一次。Codex 每次都是全新的环境，没有跨次的记忆，只作对照。",
      "",
      ...(verdicts.length
        ? [
            `有坑可学一题是账单导入：第一次要排查几处（报错指向没坏的那一项，还有一步文档没写的初始化），学会以后能直接跳过；夹具由种子生成，每一次的文件名、分隔符、汇率目录、币种、金额都不同，只有写成通用做法的技能才有用。连做多对时每一对用新员工、新的随机种子，复盘和技能只在同一对内有效（每次运行做完就把它的目录移出工作区，连同工作区里落盘的工具输出，后面的运行看不到；员工的命令读不到评测仓库，开头的自检备注会写明隔离是否生效）；平均行是各对（两次都通过的）的平均，变化是各对变化的平均，输入 token 和上表同一口径。熊宝、Codex 都给出各对的变化和平均值，Codex 只作对照。`,
            "",
            `**平均值对照目标（期 2：步数和输入 token 都降 ≥${REPEAT_TARGET_PERCENT}%；熊宝有坑可学比有技能和没技能的同种子对照，其余比第二次和第一次）**`,
            "",
            ...verdicts,
            "",
          ]
        : []),
    );

  const abTable = abRows(repeatSides);
  if (abTable.length)
    out.push(
      "## 重复任务 · 同种子对照（有技能 vs 没技能）",
      "",
      table(
        [
          "一侧",
          "第二次，有技能（通过 / 步数 / 输入 token / 墙钟）",
          "对照，没技能",
          "步数变化",
          "输入 token 变化",
          "墙钟变化",
        ],
        abTable,
      ),
      "",
      `对照运行是同一份第二次的夹具（同一个种子，新拷一份，各在自己的目录里），由一位全新的员工做：没有自写技能、没有记忆，学习功能照常配置；它自己的复盘不等、不计。变化 = 有技能 ÷ 没技能 − 1。平均只算两次都通过的对：**各对百分比的平均是判定用的**（和上面「第二次比第一次」同一个约定），总量之比（各对总量相加后相除）只作参考。有坑可学的判定看这张表：目标是步数和输入 token 都降 ≥${REPEAT_TARGET_PERCENT}%。上面「第二次比第一次」的表只作参考，第一次的运行噪声大。对照运行不计入重复任务的总量。Codex 没有跨次的记忆，它的第二次本来就是对照，不另做。`,
      "",
    );

  const learningTable = learningRows([
    ...mineSides.map((mine) => [mine.label, mine.results] as const),
    ["Codex", codex] as const,
  ]);
  if (learningTable.length)
    out.push(
      "## 重复任务：学没学到",
      "",
      table(
        [
          "一侧",
          "两次之间的复盘",
          "第一次之后新增（自写技能 / 员工形成的记忆）",
          "第二次那一轮用到的自写技能",
          "第二次之后新增",
        ],
        learningTable,
      ),
      "",
      "新增是和该次运行开始前比的；复盘结果分三类：`saved` 存为自用并生效，`held` 存了但转待审（步骤要求访问或外发到网址、或带越权的步骤，本人批准前不授予员工，不进自写技能，在「待审」里列出），`refused` 被拒（含密钥、手机号、口令等，没存）；复盘结果取自服务器日志里这次最后一轮的 `retrospect` 行，第一次结束后等到复盘出结论再开第二次，最多等 600 秒（复盘模型调用超时 120 秒、超时自动重试一次，再加追问快路径同样最多 240 秒，共约 480 秒 + 余量），超时照常开始；第二次之后只为记下它的结论，最多等 270 秒。「用到」指技能账里的使用次数涨了：那一轮对得上这件事、已经放进上下文的，或员工用 `refine_skill` 读过的。",
      "",
    );

  const skillBodies = skillBodyBlocks([
    ...mineSides.map((mine) => [mine.label, mine.results] as const),
    ["Codex", codex] as const,
  ]);
  if (skillBodies.length)
    out.push("### 第一次之后存下的技能正文（前 800 字）", "", ...skillBodies);

  const backgroundTable = backgroundRows([
    ...mineSides.map((mine) => [mine.label, mine.results] as const),
    ["Codex", codex] as const,
  ]);
  if (backgroundTable.length)
    out.push(
      "## 后台调用（复盘、自动抽记忆）",
      "",
      table(
        [
          "题目",
          "题目自身输入 token",
          "后台调用（次 / 输入 token）",
          "含后台的输入 token 合计",
        ],
        backgroundTable,
      ),
      "",
      "题目自身的步数和 token 只算主运行；复盘、自动抽记忆是轮结束后另起的模型调用（计量记成 unscoped），单独列在这里，合计把它们算进去。",
      "",
    );

  const promptTable = promptRows([
    ...mineSides.map((mine) => [mine.label, mine.results] as const),
    ["Codex", codex] as const,
  ]);
  if (promptTable.length)
    out.push(
      "## 提示词体积（熊宝侧，字符数）",
      "",
      table(
        [
          "题目",
          "请求数",
          "首步系统提示",
          "首步工具定义",
          "首步历史",
          "首步合计",
          "最大一步合计",
          "最大一步的历史",
          "首步系统提示里最大的段",
        ],
        promptTable,
      ),
      "",
      "记录的是熊宝服务器发给模型的请求体：首步 = 这道题第一个带工具的请求（员工主运行的第一步）；最大一步 = 总字符最多的一次请求（历史越滚越大的话，差距在历史上）。请求数含子代理、压缩、挑选技能等不在主运行里的调用。字符数不是 token，看比例和趋势。",
      "",
    );

  const smokeRows = smokes.flatMap((side) =>
    side.records.map((record) => ({
      record,
      path: pathOfRecord(record, side),
    })),
  );
  if (smokeRows.length) {
    const all = smokeRows.map((row) => row.record);
    const scored = all.filter((record) => !record.error?.startsWith("不适用"));
    const showPath = smokeRows.some((row) => row.path === "chat");
    out.push(
      `## 能力冒烟（${scored.filter((record) => record.passed).length}/${scored.length}）`,
      "",
    );
    out.push(
      table(
        [
          "场景",
          ...(showPath ? ["路径"] : []),
          "结果",
          "墙钟",
          "token",
          ...CAPABILITY_HEADER,
          "说明",
        ],
        smokeRows.map(({ record, path }) => [
          record.title,
          ...(showPath ? [path === "chat" ? "单聊" : "看板"] : []),
          verdict(record),
          seconds(record.wallMs),
          tokens(record),
          ...capabilityRow(record.capabilities, record),
          record.error ??
            (record.checks
              .filter((item) => !item.ok)
              .map((item) => item.name)
              .join("；") ||
              ""),
        ]),
      ),
      "",
    );
  }

  const failures = results.flatMap((side) =>
    side.records
      .filter((record) => !record.passed && !record.error?.startsWith("不适用"))
      .map((record) => ({ side, record })),
  );
  if (failures.length) {
    out.push("<details><summary>没过的检查项</summary>", "");
    for (const { side, record } of failures) {
      const name =
        side.side === "codex"
          ? "Codex"
          : pathOfRecord(record, side) === "chat"
            ? "熊宝（单聊）"
            : "熊宝";
      out.push(
        `**${name} · ${record.title}**${record.error ? `（${record.error}）` : ""}`,
        "",
      );
      for (const item of record.checks.filter((check) => !check.ok))
        out.push(`- ${item.name}${item.detail ? `：${item.detail}` : ""}`);
      out.push("");
    }
    out.push("</details>", "");
  }
  out.push(
    "说明：「不适用」= 产品里还没有这项能力，或这道题不考这一项；「无提示停下」= 产物没写完或计划没做完、没触顶、也没以问句收尾就停了；「追『继续』」= 评测脚本在一轮停下后替人再派的「继续」次数。",
  );
  return `${out.join("\n")}\n`;
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "employee-eval-out");
  const results = [
    "xiongbao.json",
    "xiongbao-chat.json",
    "codex.json",
    "smoke.json",
    "smoke-chat.json",
  ]
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as EvalResults);
  if (!results.length) {
    console.error(
      `${dir} 里没有评测结果（xiongbao.json / xiongbao-chat.json / codex.json / smoke.json / smoke-chat.json）`,
    );
    process.exit(1);
  }
  const markdown = renderReport(results);
  writeFileSync(join(dir, "report.md"), markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
}

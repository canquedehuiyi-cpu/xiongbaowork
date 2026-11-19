/** 一次评测的结果文件格式：两个跑评测的脚本写，`report.ts` 读。 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Check } from "./lib";
import type { Capabilities } from "./metrics";

export type Side = "xiongbao" | "codex";
export type Suite = "tasks" | "smoke";

export type EvalRecord = {
  /** 题名（五道题）或冒烟场景名。 */
  task: string;
  title: string;
  passed: boolean;
  wallMs: number;
  /** 撞上了墙钟上限。 */
  timedOut: boolean;
  /** 工具调用次数（熊宝：主运行里的工具调用；Codex：命令、改文件等动作）。 */
  steps: number | null;
  /** 模型调用次数（熊宝读 model_token_calls 的行数）。 */
  modelCalls: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;
  /** 没写完、没触顶、也没问人就停了。读不到时 null。 */
  silentStop: boolean | null;
  /** 跑题方停下后，评测脚本追了几次「继续」。 */
  nudges: number;
  /** 用到的工具名和次数。 */
  tools: Record<string, number>;
  capabilities: Capabilities;
  checks: Check[];
  error?: string;
};

export type EvalResults = {
  side: Side;
  suite: Suite;
  provider: string;
  model: string;
  baseUrl: string | null;
  /** 熊宝侧走的执行路径，或 Codex 的版本。 */
  runner: string;
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

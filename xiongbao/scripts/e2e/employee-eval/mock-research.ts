/**
 * 本机假模型的「调研题」剧本：不懂题目，只一步接一步地跑命令，每一步读回一段十几 KB 的文字，像一道要连着读
 * 十几个网页的调研题那样把对话越撑越大，最后给一句收尾。用来在本机看一轮里每一步发给模型的请求有多大、
 * 较早的工具结果有没有被折叠。`EVAL_MOCK_SCRIPT=research` 打开，步数和每步字节数可调；
 * `EVAL_MOCK_SCREENSHOTS=6,12` 让第 6、12 步改成「打开假模型自己的网页再截一张图」。
 */

import { TOOL } from "./metrics";
import type { MockRequest, MockTurn } from "./mock-model";

export type ResearchScript = {
  /** 读几份资料之后收尾。 */
  steps: number;
  /** 每次命令输出的字节数（不超过 16KB，超过的输出服务器会存进文件、只回头尾）。 */
  bytes: number;
  /** 哪几步（从 1 起）不读文字，改成打开网页并截图。 */
  screenshots: number[];
};

export const DEFAULT_RESEARCH: ResearchScript = {
  steps: 18,
  bytes: 14_000,
  screenshots: [],
};

/** 剧本里的截图用到的两个浏览器工具。 */
export const NAVIGATE_TOOL = "computer_navigate";
export const SCREENSHOT_TOOL = "computer_screenshot";

/** 从环境变量读剧本；没打开返回 null，数字不合理的按默认值。 */
export function researchScriptFrom(
  env: Record<string, string | undefined>,
): ResearchScript | null {
  if (env.EVAL_MOCK_SCRIPT?.trim() !== "research") return null;
  const positive = (raw: string | undefined, fallback: number, max: number) => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 && value <= max
      ? value
      : fallback;
  };
  const screenshots = (env.EVAL_MOCK_SCREENSHOTS ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return {
    steps: positive(env.EVAL_MOCK_STEPS, DEFAULT_RESEARCH.steps, 60),
    bytes: positive(env.EVAL_MOCK_BYTES, DEFAULT_RESEARCH.bytes, 16_000),
    screenshots,
  };
}

/** 第 `step`（从 1 起）步要跑的命令：打印约 `bytes` 字节、每步内容不同的英文文字。 */
export function pageCommand(step: number, bytes: number): string {
  const line = `Page ${step}: the quarterly report lists revenue, margin and headcount by region, with notes on supply, pricing and the outlook for the next year.`;
  return `yes '${line}' | head -c ${bytes}`;
}

type Call = NonNullable<MockTurn["tools"]>[number];

/** 剧本要依次发出的全部工具调用：每次一个，截图的那一步是「打开网页、截图」两个。 */
export function researchCalls(script: ResearchScript, pageUrl: string): Call[] {
  const calls: Call[] = [];
  for (let step = 1; step <= script.steps; step += 1)
    if (script.screenshots.includes(step))
      calls.push(
        { name: NAVIGATE_TOOL, arguments: { url: pageUrl } },
        { name: SCREENSHOT_TOOL, arguments: {} },
      );
    else
      calls.push({
        name: TOOL.command,
        arguments: { command: pageCommand(step, script.bytes) },
      });
  return calls;
}

/**
 * 剧本的下一步：已经收到几次工具结果，就发第几个调用；发完了收尾。评测脚本在一轮没做完时会追一句「继续」，
 * 追的那一轮直接收尾，不再把剧本从头演一遍。
 */
export function researchPolicy(
  request: MockRequest,
  script: ResearchScript,
  pageUrl: string,
): MockTurn {
  const calls = researchCalls(script, pageUrl);
  const done = request.toolResultsSinceUser;
  const nudged = /继续完成上面交代的任务/.test(request.lastUser);
  const next = nudged ? undefined : calls[done];
  return next
    ? { tools: [next] }
    : { text: `读完了 ${script.steps} 份资料（假模型）。` };
}

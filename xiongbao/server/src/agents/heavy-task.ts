/**
 * 重活分流（期 4 · Task 4.3）：大型编码任务，建议用更合适的办法做，而不是员工一个人在平时的模型上硬做。
 *
 * 怎么识别：用规则，不调模型（最便宜、也最稳：一轮的提示词里多一次模型调用不值）。一条用户消息自己说的
 * 话（不拼别的消息，「继续」「好」这类短回复不判断），必须同时满足两条：
 *  - 有代码语境：出现代码文件扩展名、代码路径，或者「代码、代码库、模块、函数、接口、仓库、repo、源文件」一类的词；
 *  - 规模条件之一：
 *    - 明说要大范围重构：「重构整个项目」「重写整个代码库」「大规模重构」，和英文的同类说法；
 *    - 涉及的文件多：写明「N 个文件」（N 不小于 {@link HEAVY_FILES}），或者列出了不少于 {@link HEAVY_PATHS} 个不同的文件路径；
 *    - 预计步数多：写明「预计 N 步」（N 不小于 {@link HEAVY_STEPS}），或者计划清单有不少于 {@link HEAVY_ITEMS} 项。
 * 数字类的规模条件还要话里有改动的动词，免得「整理 20 个文件的名字」被当成编码活。
 *
 * 识别出来后，按顺序建议，只建议，从不自动转交：
 *  1. 员工设置里有「难任务模型」（`shared/hard-model.ts`），而这一轮能派子代理：建议自己先读代码、列计划，把最重的编码
 *     用 `run_subagent` 交出去，`model` 写 "hard"；
 *  2. 没有（或这一轮派不了子代理），但这个人有固定员工 Codex 或 Claude Code：建议先跟本人说，请本人同意转交给它；
 *  3. 都没有：照常做，什么也不加。
 * 这一轮手上既不能派子代理也不能转交的（子代理自己，它不能再往下派），什么也不加。
 *
 * 建议跟在那条用户消息自己的末尾（只给模型看的那一份，不改存下来的对话），不放在系统提示里：系统提示是整个
 * 请求的最前面，它一变，后面所有历史的缓存都作废。判断只看每条消息自己的字和这位员工固定的事实（难任务模型、
 * 固定员工），所以同一条消息每一轮的字节都一样，历史前缀不变；只有设置难任务模型这样的事实变了才会变一次。
 * 先判规则，有消息命中了才去查事实。`XIONGBAO_HEAVY_TASK_ROUTING=off` 关掉：不查事实，也不加这段话。
 */
import { SUBAGENT_TOOL } from "../../../shared/subagent";
import { HANDOFF_TOOL } from "./handoff-tool";
import { textOf } from "./message-text";

export const HEAVY_TASK_ROUTING_ENV = "XIONGBAO_HEAVY_TASK_ROUTING";

/** 开着：默认开，只有明确写 `off` 才关。 */
export function heavyTaskRoutingOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[HEAVY_TASK_ROUTING_ENV]?.trim().toLowerCase() !== "off";
}

/** 判成大型任务的门槛：文件数、列出的不同路径数、预计步数、计划清单项数。 */
export const HEAVY_FILES = 10;
export const HEAVY_PATHS = 8;
export const HEAVY_STEPS = 15;
export const HEAVY_ITEMS = 10;

/** 明说大范围重构的几种写法。 */
const WIDE = "(?:整个|整体|全部|所有|全)";
const TARGET =
  "(?:项目|工程|代码库|代码仓库|仓库|代码|系统|服务|模块|前端|后端)";
const REWORK = "(?:重构|重写|迁移|改造|改写|翻新|升级)";
const EXPLICIT: readonly RegExp[] = [
  new RegExp(`${REWORK}[^。！？\\n]{0,6}${WIDE}[^。！？\\n]{0,4}${TARGET}`),
  new RegExp(`${WIDE}[^。！？\\n]{0,4}${TARGET}[^。！？\\n]{0,6}${REWORK}`),
  /(?:大规模|大型|全面|整体|彻底|系统性)(?:的)?(?:重构|重写|改造|迁移)/,
  /\b(?:refactor|rewrite|migrate|port|overhaul|restructure)\b[^.\n]{0,40}\b(?:entire|whole|all of the|every)\b[^.\n]{0,24}\b(?:project|codebase|code base|repo|repository|modules?|application|app|backend|frontend)\b/i,
  /\b(?:large[- ]scale|massive|major|full|wholesale|sweeping)\s+(?:refactor|rewrite|migration|overhaul)/i,
];

/** 话里有改代码的动词：数字类的规则要有它才算。 */
const CODING =
  /改|修改|重构|迁移|重写|改写|改成|改为|替换|重命名|更新|升级|修复|实现|添加|新增|删除|拆分|合并|优化|调整|改造|refactor|migrate|rename|replace|update|upgrade|fix|implement|rewrite|port|convert|add\b|remove\b|change/i;

const FILE_COUNT =
  /(\d{1,5})\s*\+?\s*个?\s*(?:文件|模块|组件|接口|源文件|(?:source )?files|modules|components|endpoints|services)/gi;
const FILE_PATH =
  /[\w@.\-/]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|vue|svelte|sql|scala|sh)\b/gi;
const STEP_COUNT =
  /(?:预计|大概|大约|约|至少|需要|要)[^0-9\n]{0,6}(\d{1,4})\s*(?:个)?(?:步骤|步)|(\d{1,4})\s*(?:steps|个步骤)/gi;
const PLAN_ITEM = /^\s*(?:\d{1,3}\s*[.、)）]|[-*]\s*\[[ xX]\])\s*\S/gm;

/** 短于这个字数的消息（「继续」「好的」）不判断。 */
export const HEAVY_MIN_CHARS = 6;

/** 有代码语境：代码文件扩展名，或者代码相关的词。没有它，不管多大的规模都不是编码任务。 */
const CODE_CONTEXT =
  /\.(?:tsx?|jsx?|mjs|cjs|py|go|java|rs|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|vue|svelte|sql|sh)\b|代码|源码|源文件|模块|函数|接口|仓库|前端|后端|\b(?:repo|repository|modules?|codebase|code base|source files?|api|typescript|javascript|python|golang|rust|java|react|vue|backend|frontend)\b/i;

/** 这件事为什么算大型编码任务：每条一句话。空就是不算。 */
export function heavyTaskReasons(text: string): string[] {
  if (text.trim().length < HEAVY_MIN_CHARS || !CODE_CONTEXT.test(text))
    return [];
  const reasons: string[] = [];
  if (EXPLICIT.some((pattern) => pattern.test(text)))
    reasons.push("明说要大范围重构");
  if (!CODING.test(text)) return reasons;
  const files = Math.max(
    0,
    ...[...text.matchAll(FILE_COUNT)].map((match) => Number(match[1])),
  );
  if (files >= HEAVY_FILES) reasons.push(`涉及约 ${files} 个文件`);
  const paths = new Set(
    (text.match(FILE_PATH) ?? []).map((path) => path.toLowerCase()),
  ).size;
  if (paths >= HEAVY_PATHS) reasons.push(`列出了 ${paths} 个文件`);
  const steps = Math.max(
    0,
    ...[...text.matchAll(STEP_COUNT)].map((match) =>
      Number(match[1] ?? match[2]),
    ),
  );
  if (steps >= HEAVY_STEPS) reasons.push(`预计约 ${steps} 步`);
  const items = (text.match(PLAN_ITEM) ?? []).length;
  if (items >= HEAVY_ITEMS) reasons.push(`计划有 ${items} 项`);
  return reasons;
}

/** 建议要用到的事实：员工设置的难任务模型，和这个人手上固定的 Codex、Claude Code 员工。 */
export type HeavyTaskFacts = {
  hardModel?: string;
  externalCoders: readonly { name: string; harness: "codex" | "claude-code" }[];
};

const HARNESS_NAME = { codex: "Codex", "claude-code": "Claude Code" } as const;

/** 这一轮手上能不能派子代理、能不能转交别的员工。 */
export type HeavyTaskHolds = { subagent: boolean; handoff: boolean };

export function heavyTaskGuidance(input: {
  text: string;
  facts: HeavyTaskFacts;
  holds: HeavyTaskHolds;
}): string | undefined {
  const { facts, holds } = input;
  if (!holds.subagent && !holds.handoff) return undefined;
  const reasons = heavyTaskReasons(input.text);
  if (reasons.length === 0) return undefined;
  const opening = `这件活看起来是大型编码任务（${reasons.join("、")}）。`;
  if (facts.hardModel && holds.subagent)
    return `${opening}你设置了难任务模型「${facts.hardModel}」：自己先读代码、列计划，把最重的编码和改写部分用 run_subagent 交出去，model 写 "hard"，每个子任务写清范围和要交回什么；汇总、验证和最后的交付自己做。`;
  if (facts.externalCoders.length > 0) {
    const names = facts.externalCoders
      .map((coder) => `${HARNESS_NAME[coder.harness]}「${coder.name}」`)
      .join("、");
    return `${opening}你的同事里有固定员工 ${names}，更适合做大型编码。不要自己擅自转交：先用一两句话告诉本人这件活比较大，建议转交给它${holds.handoff ? "（本人同意后再用 message_bot 交过去）" : ""}；本人不想转交，就照常自己做。`;
  }
  return undefined;
}

/** 事实从哪来：`index.ts` 开机时接上，按员工查。 */
type HeavyTaskFactsSource = (agentId: string) => Promise<HeavyTaskFacts>;
let source: HeavyTaskFactsSource | undefined;

export function configureHeavyTaskFacts(
  next: HeavyTaskFactsSource | undefined,
): void {
  source = next;
}

type MessageLike = { role?: string; content?: unknown };

/** 这些消息里有没有哪条用户消息自己被规则判成大型编码任务。纯规则，不查库。 */
export function hasHeavyTask(
  messages: readonly MessageLike[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    heavyTaskRoutingOn(env) &&
    messages.some(
      (message) =>
        message.role === "user" &&
        heavyTaskReasons(textOf(message.content)).length > 0,
    )
  );
}

/**
 * 这一轮用的事实。先判规则：没有消息命中、关着、没接来源、查出错、或者什么事实都没有（没有难任务模型也没有
 * 固定员工，建议不会出现），都答 undefined：照常做，不因为这一步耽误一轮。
 */
export async function loadHeavyTaskFacts(
  agentId: string,
  messages: readonly MessageLike[],
  env: Record<string, string | undefined> = process.env,
): Promise<HeavyTaskFacts | undefined> {
  if (!source || !hasHeavyTask(messages, env)) return undefined;
  try {
    const facts = await source(agentId);
    return facts.hardModel || facts.externalCoders.length > 0
      ? facts
      : undefined;
  } catch {
    return undefined;
  }
}

const NOTE_TAG = "heavy_task";

/**
 * 给模型看的那份消息：每条被判成大型编码任务的用户消息，在自己的末尾带上建议。字符串内容直接接在后面；
 * 分段内容在最后一个文字段后面加一段。没有要加的就原样返回同一个数组。
 */
export function noteHeavyTasks<T extends MessageLike>(
  messages: readonly T[],
  facts: HeavyTaskFacts | undefined,
  toolNames: Iterable<string>,
  env: Record<string, string | undefined> = process.env,
): readonly T[] {
  if (!facts || !heavyTaskRoutingOn(env)) return messages;
  const held = new Set(toolNames);
  const holds = {
    subagent: held.has(SUBAGENT_TOOL),
    handoff: held.has(HANDOFF_TOOL),
  };
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "user") return message;
    const note = heavyTaskGuidance({
      text: textOf(message.content),
      facts,
      holds,
    });
    if (!note) return message;
    const block = `\n\n<${NOTE_TAG}>${note}</${NOTE_TAG}>`;
    const content = message.content;
    if (typeof content === "string") {
      changed = true;
      return { ...message, content: `${content}${block}` };
    }
    if (Array.isArray(content)) {
      changed = true;
      return {
        ...message,
        content: [...content, { type: "text", text: block.trim() }],
      };
    }
    return message;
  });
  return changed ? out : messages;
}

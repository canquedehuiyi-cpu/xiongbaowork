import {
  BLOB_CHARS_PER_TOKEN,
  BLOB_MIN_CHARS,
  blobChars,
  withoutBlobs,
} from "../tool-result-blobs";
import type { Prompt } from "./last-step";

/**
 * 一轮之内的压缩（期七）：对话越过模型窗口的 70%（或绝对预算 {@link FOLD_BUDGET_TOKENS}，取小的）时，把较早的
 * 工具结果折成一句摘要，只改发给模型的那一份。
 *
 * 为什么：历史里的工具结果占一轮 token 的七成左右（评测 #713），一轮里每多一步，前面所有的结果都要再发一遍。
 * 「轮次开始前压缩」（`server/src/threads/compaction.ts`）管的是下一轮，这一轮里越滚越大的结果它够不着。
 *
 * 做法，都是确定性的规则，不另外调用模型：
 *  - 一步里的估算 = 这一步发出去的全部文字估成 token，再加一份固定的工具定义开销；
 *  - 估算超过 `min(窗口 × {@link FOLD_AT}, {@link FOLD_BUDGET_TOKENS})` 时，把「最近 {@link FOLD_KEEP_STEPS} 步」之外、足够长的工具结果换成
 *    「[已折叠：xx 工具输出 N 字，要点：…]」，要点是头尾的几句话；最近几步的结果原样不动；
 *  - 存起来的对话一个字不改，只有这一步发给模型的提示变短。
 *
 * 缓存稳定：提供方按前缀命中缓存，一步一步把已经发出去的历史改写，缓存就全废了。所以折叠不是「每步看一眼
 * 再改」，而是**从头重放**：沿着提示里每一次模型调用（每条 assistant 消息）的位置，用当时看到的前缀算估算，
 * 越线就折叠一批，折完要再涨一截（{@link FOLD_REGROW} 个窗口，绝对预算生效时取 {@link FOLD_REGROW_OF_BUDGET} 个预算，
 * 两者取小）才会折下一批。这个重放只看前缀，所以
 *  - 没越线时一个字节不动（返回同一个数组）；
 *  - 越线折叠之后，下一步重放到同一个位置，得到同样的折叠结果，已折叠的部分逐字节不变，新的一步只在末尾添加；
 *  - 不靠任何实例里的状态：一轮被服务器分成几次运行、或者下一轮从存起来的完整历史重新开始，重放出的折叠
 *    仍然是同一份，缓存跨轮也接得上。
 * 只在越线的那一步，前缀变一次（折叠本来就要改写它）。
 */

/** 超过窗口的这个比例就折叠。 */
export const FOLD_AT = 0.7;
/** 最近这么多步（带工具调用的模型回合）的结果原样保留。 */
export const FOLD_KEEP_STEPS = 4;
/** 折完之后要再涨这么多窗口，才折下一批：把「每步折一条」合成一批一批。 */
export const FOLD_REGROW = 0.15;
/**
 * 绝对预算生效时，折完要再涨这么多预算才折下一批。窗口很大时 {@link FOLD_REGROW} 乘窗口是一个巨大的数，等于
 * 折一次就不再折了；按预算的比例算，才是一批一批地折，而不是每步改一点前缀、把提供方的缓存前缀每步都废掉。
 */
export const FOLD_REGROW_OF_BUDGET = 0.25;
/**
 * 一轮的绝对预算（估算的 token）：不管窗口多大，估算超过它就折叠。窗口比例管不住大窗口：DeepSeek 的窗口是 1M，
 * 70% 是 70 万，一道调研题发到 13 万一步也没越线（评测 run 44517530843：19 步共输入 247 万，Codex 同题 34 万）。
 *
 * 取 18K（token 第六轮，用户批准，原来 24K，更早是 64K）：评测里调研题后段每步约 36K token、历史最长约 8.5 万字符，
 * 64K 的线基本不触发，历史越滚越大。18K 约等于固定开销 6K 加十来步普通结果，轻的任务（写文档、改代码、办公，每步一两千 token）
 * 十来步内不越线，行为不变；重的任务（每步一个 16KB 网页）更早开始折。折完之后的下限（固定开销 6K、最近 4 步每步最多
 * 一个 16KB 的结果约 5K、较早的摘要每条约 0.5K）可能高过 18K，所以折完不会「立刻再折」：要再涨 {@link FOLD_REGROW_OF_BUDGET}
 * （25%，4.5K）才折下一批，缓存前缀一批才废一次。部署用环境变量 `XIONGBAO_TURN_FOLD_BUDGET_TOKENS` 覆盖（设 64000 回到更早的值），
 * 0 表示关掉绝对预算（只按窗口比例）。
 */
export const FOLD_BUDGET_TOKENS = 18_000;
/** 覆盖 {@link FOLD_BUDGET_TOKENS} 的环境变量。 */
export const FOLD_BUDGET_ENV = "XIONGBAO_TURN_FOLD_BUDGET_TOKENS";
/** 短于这么多字的结果不折：折了省不了几个 token，摘要还会比它长。 */
export const FOLD_MIN_CHARS = 1_500;
/** 读不到模型窗口时按这个算：目前常见模型里偏小的一档（128k），宁可早折也不撑爆。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 工具定义和提示头的固定开销（token）。不取这一步实际带的工具：工具搜索会让它逐步变化，重放就不稳了。 */
export const FIXED_PROMPT_TOKENS = 6_000;
/** 一张图或一个文件算多少 token，不按它的 base64 长度算。 */
const MEDIA_TOKENS = 1_500;

/*
 * 工具结果文字里夹着的二进制数据（截图的 base64）：模型读不了它，提供方却照字数收 token，一张 1280×800 的
 * 截图约 40 万个字符。主要的处理在发给模型之前（`withoutToolBlobs`，`../tool-result-blobs.ts`）；这里是兜底，
 * 给到不了那一步的提示：估算时二进制数据按每 {@link BLOB_CHARS_PER_TOKEN} 个字符 1 个 token 算，越线判断才不会慢。
 * 折叠的范围不变：最近几步的结果照旧原样，不因为带二进制数据就多折。
 */
export { BLOB_CHARS_PER_TOKEN, BLOB_MIN_CHARS };

/**
 * 一个工具结果的文字估成多少 token：二进制数据的字符按 {@link BLOB_CHARS_PER_TOKEN} 估，其余按 {@link estimateTokens}。
 * 没有二进制数据时和 `estimateTokens` 完全一样。
 */
function resultTokens(text: string): number {
  const blob = blobChars(text);
  return blob === 0
    ? estimateTokens(text)
    : estimateTokens(withoutBlobs(text)) +
        Math.ceil(blob / BLOB_CHARS_PER_TOKEN);
}

/**
 * 读环境变量里的绝对预算：没设、空、不是数字、负数都当没设（用默认值），`0` 表示关掉绝对预算，其余取整。
 */
export function foldBudgetFrom(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

type Env = Record<string, string | undefined>;

/**
 * 折叠摘要写短一点（token 第五轮）：只留工具、字数、退出码一类的短字段、头尾各一句和存盘的路径，不留 `ok=true`、
 * 空字段、耗时这类没信息量的。`XIONGBAO_TURN_FOLD_BRIEF=off` 回到原来的摘要。
 */
export function foldBriefOn(env: Env = process.env): boolean {
  return env.XIONGBAO_TURN_FOLD_BRIEF?.trim().toLowerCase() !== "off";
}

/**
 * 较早的写文件、改文件、长命令的参数里的大段文字（整份文件、整段脚本）也折成一句：它们发出去之后留在历史里，
 * 之后每一步再发一遍，而文件已经写在工作区里。`XIONGBAO_TURN_FOLD_CALLS=off` 关掉。
 */
export function foldCallsOn(env: Env = process.env): boolean {
  return env.XIONGBAO_TURN_FOLD_CALLS?.trim().toLowerCase() !== "off";
}

/** 折叠摘要的开头；已经是摘要的结果不再折。 */
export const FOLDED_PREFIX = "[已折叠：";

type Message = Prompt[number];
type Part = Exclude<Message["content"], string>[number];

/**
 * 一段文字估成多少 token：ASCII 约每 3.5 个字符一个，其它字符（中日韩）约一个字符一个。偏高一点没关系，
 * 估高只会让折叠早一点；估得太低才会撑爆窗口。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) < 128) ascii += 1;
    else other += 1;
  return Math.ceil(ascii / 3.5 + other);
}

type Output = { type: string; value?: unknown; reason?: string };

/** 一个工具结果在模型眼里的文字，以及里面带了几个图片或文件。 */
function viewOf(output: Output): { text: string; media: number } {
  switch (output.type) {
    case "text":
    case "error-text":
      return { text: String(output.value ?? ""), media: 0 };
    case "json":
    case "error-json":
      return { text: JSON.stringify(output.value ?? null), media: 0 };
    case "execution-denied":
      return { text: output.reason ?? "", media: 0 };
    case "content": {
      const parts = Array.isArray(output.value)
        ? (output.value as { type: string; text?: string }[])
        : [];
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      return {
        text,
        media: parts.filter((part) => part.type !== "text").length,
      };
    }
    default:
      return { text: "", media: 0 };
  }
}

function tokensOfMessage(message: Message): number {
  if (typeof message.content === "string")
    return estimateTokens(message.content);
  let tokens = 0;
  for (const part of message.content as Part[]) {
    const kind = (part as { type: string }).type;
    if (kind === "text" || kind === "reasoning")
      tokens += estimateTokens((part as { text: string }).text ?? "");
    else if (kind === "tool-call") {
      const call = part as { toolName: string; input: unknown };
      tokens += estimateTokens(
        `${call.toolName}${typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {})}`,
      );
    } else if (kind === "tool-result") {
      const view = viewOf((part as { output: Output }).output);
      tokens += resultTokens(view.text) + view.media * MEDIA_TOKENS;
    } else if (kind === "file") tokens += MEDIA_TOKENS;
  }
  return tokens;
}

function squeeze(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function tailOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `…${flat.slice(-max)}`;
}

/** 摘要里不留的字段：每个结果都有、没有信息量的（成功标记、耗时、命令回显，命令在调用参数里）。 */
const BRIEF_SKIP_KEYS = new Set([
  "untrusted",
  "ok",
  "elapsedMs",
  "command",
  "outputFile",
  "outputNote",
]);

/** 一个结果的要点：JSON 取几个短字段和最长那个字段的头尾，别的文字取头尾。`brief` 时更短。 */
function gistOf(text: string, brief = false): string {
  const head = brief ? 100 : 200;
  const tail = brief ? 50 : 100;
  const cap = brief ? 4 : 6;
  let parsed: unknown;
  if (text.startsWith("{")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const scalars: string[] = [];
    let bigKey: string | undefined;
    let big = "";
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "untrusted") continue;
      if (brief && BRIEF_SKIP_KEYS.has(key)) continue;
      // 简短摘要不留空字符串和 false：`stderr=`、`truncated=false` 没有信息。
      if (brief && (value === "" || value === false)) continue;
      if (typeof value === "string" && value.length > 200) {
        if (value.length > big.length) {
          bigKey = key;
          big = value;
        }
      } else if (
        (typeof value === "string" && value.length <= 80) ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        if (scalars.length < cap)
          scalars.push(`${key}=${squeeze(`${value}`, 80)}`);
      }
    }
    const body = bigKey
      ? `${bigKey}：${squeeze(big, head)}${big.length > head + tail + 20 ? ` … ${tailOf(big, tail)}` : ""}`
      : "";
    const joined = [scalars.join("，"), body].filter(Boolean).join("；");
    if (joined) return joined;
  }
  return `${squeeze(text, head)}${text.length > head + tail + 20 ? ` … ${tailOf(text, tail)}` : ""}`;
}

/** 折叠后的摘要：确定性的，同一个结果永远折成同一句。`brief` 为假时是原来的写法。 */
export function foldedSummary(
  toolName: string,
  text: string,
  brief = true,
): string {
  const saved = /tool-outputs\/[\w.-]+\.txt/.exec(text)?.[0];
  // 要点只取读得懂的部分：二进制数据换成一句说明，别把它的头尾当要点。
  const gist = gistOf(withoutBlobs(text), brief);
  if (brief)
    return `${FOLDED_PREFIX}${toolName} 工具输出 ${text.length} 字，${gist}。${
      saved
        ? `完整内容存在 ${saved}，用 computer_read_file 按行段读。`
        : "原文已不在上下文里，需要时重新调用工具。"
    }]`;
  return `${FOLDED_PREFIX}${toolName} 工具输出 ${text.length} 字，要点：${gist}。${
    saved
      ? `完整内容存在 ${saved}，需要细节时用 computer_read_file 按行段读，`
      : ""
  }原文不在上下文里了，需要时重新调用工具，或按行段读取。]`;
}

/** 参数里的大段文字可以折的工具和字段：写文件的内容、改文件的新旧段、长命令（整段脚本）。 */
const FOLDABLE_CALL_FIELDS: Record<string, { fields: string[]; done: string }> =
  {
    computer_write_file: { fields: ["contents"], done: "已写入文件" },
    computer_edit_file: {
      fields: ["old_string", "new_string"],
      done: "已用于改文件",
    },
    computer_run_command: { fields: ["command"], done: "已执行" },
  };

/** 一个调用参数折完的样子；没有可折的大段文字时答 undefined。 */
function foldedCallInput(
  toolName: string,
  input: unknown,
): { input: unknown; before: string; after: string } | undefined {
  const rule = FOLDABLE_CALL_FIELDS[toolName];
  if (!rule) return undefined;
  let object: Record<string, unknown> | undefined;
  try {
    const parsed = typeof input === "string" ? JSON.parse(input) : input;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      object = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!object) return undefined;
  const next: Record<string, unknown> = { ...object };
  let changed = false;
  for (const field of rule.fields) {
    const value = object[field];
    if (typeof value === "string" && value.length >= FOLD_MIN_CHARS) {
      next[field] =
        `${FOLDED_PREFIX}${value.length} 字，${rule.done}，不在上下文里了]`;
      changed = true;
    }
  }
  if (!changed) return undefined;
  const asText = (value: unknown) =>
    typeof input === "string" ? JSON.stringify(value) : value;
  return {
    input: asText(next),
    before: `${toolName}${typeof input === "string" ? input : JSON.stringify(input ?? {})}`,
    after: `${toolName}${JSON.stringify(next)}`,
  };
}

type Result = {
  message: number;
  part: number;
  round: number;
  toolName: string;
  text: string;
  tokens: number;
  summary: string;
  summaryTokens: number;
  /** 是调用参数里的大段文字而不是工具结果：折完替换的是参数。 */
  call?: unknown;
};

export type FoldOptions = {
  /** 模型窗口（token）。 */
  window: number;
  threshold?: number;
  keepSteps?: number;
  /** 绝对预算（token）：默认 {@link FOLD_BUDGET_TOKENS}；0 关掉，只按窗口比例。 */
  budget?: number;
  /** 摘要写短一点；默认看 `XIONGBAO_TURN_FOLD_BRIEF`。 */
  brief?: boolean;
  /** 也折较早的写文件、改文件、长命令的参数；默认看 `XIONGBAO_TURN_FOLD_CALLS`。 */
  calls?: boolean;
};

/**
 * 越过 `min(窗口 × 70%, 绝对预算)` 时折叠较早的工具结果；没有要折的时候原样返回同一个数组。见文件头的说明：
 * 从头重放，只看前缀。
 */
export function foldEarlyResults(
  prompt: Prompt,
  {
    window,
    threshold = FOLD_AT,
    keepSteps = FOLD_KEEP_STEPS,
    budget = FOLD_BUDGET_TOKENS,
    brief = foldBriefOn(),
    calls: foldCalls = foldCallsOn(),
  }: FoldOptions,
): Prompt {
  // 每个工具调用属于第几个带工具调用的回合。
  const roundOfCall = new Map<string, number>();
  const roundAt: number[] = [];
  let rounds = 0;
  const results: Result[] = [];
  const tokens = prompt.map((message, index) => {
    if (message.role === "assistant") {
      const calls = (message.content as Part[]).flatMap((part) =>
        (part as { type: string }).type === "tool-call"
          ? [(part as { toolCallId: string }).toolCallId]
          : [],
      );
      if (calls.length > 0) {
        for (const id of calls) roundOfCall.set(id, rounds);
        if (foldCalls)
          (message.content as Part[]).forEach((part, partIndex) => {
            const call = part as {
              type: string;
              toolName: string;
              input: unknown;
            };
            if (call.type !== "tool-call") return;
            const folded = foldedCallInput(call.toolName, call.input);
            if (!folded) return;
            results.push({
              message: index,
              part: partIndex,
              round: rounds,
              toolName: call.toolName,
              text: "",
              tokens: estimateTokens(folded.before),
              summary: "",
              summaryTokens: estimateTokens(folded.after),
              call: folded.input,
            });
          });
        rounds += 1;
      }
    }
    roundAt[index] = rounds;
    if (message.role === "tool")
      (message.content as Part[]).forEach((part, partIndex) => {
        const result = part as {
          type: string;
          toolCallId: string;
          toolName: string;
          output: Output;
        };
        if (result.type !== "tool-result") return;
        const view = viewOf(result.output);
        if (
          view.media > 0 ||
          view.text.length < FOLD_MIN_CHARS ||
          view.text.startsWith(FOLDED_PREFIX)
        )
          return;
        const summary = foldedSummary(result.toolName, view.text, brief);
        results.push({
          message: index,
          part: partIndex,
          round: roundOfCall.get(result.toolCallId) ?? -1,
          toolName: result.toolName,
          text: view.text,
          tokens: resultTokens(view.text),
          summary,
          summaryTokens: estimateTokens(summary),
        });
      });
    return tokensOfMessage(message);
  });

  const capped = budget > 0;
  const limit = capped
    ? Math.min(threshold * window, budget)
    : threshold * window;
  const regrow = capped
    ? Math.min(FOLD_REGROW * window, FOLD_REGROW_OF_BUDGET * budget)
    : FOLD_REGROW * window;
  const folded = new Set<Result>();
  let running = FIXED_PROMPT_TOKENS;
  let lastAfter = Number.NEGATIVE_INFINITY;
  for (let index = 0; index <= prompt.length; index += 1) {
    // 一次模型调用：看到的是 [0, index) 这段前缀。
    if (
      (index === prompt.length || prompt[index]?.role === "assistant") &&
      running > limit &&
      running >= lastAfter + regrow
    ) {
      const kept = (index === 0 ? 0 : (roundAt[index - 1] ?? 0)) - keepSteps;
      for (const result of results) {
        if (result.message >= index) break;
        if (folded.has(result) || result.round >= kept) continue;
        folded.add(result);
        running -= result.tokens - result.summaryTokens;
      }
      // 折完（或没有可折的）也记下，要再涨一截才轮到下一批。
      lastAfter = running;
    }
    if (index < prompt.length) running += tokens[index] ?? 0;
  }
  if (folded.size === 0) return prompt;

  const replaced = new Map<number, Map<number, Result>>();
  for (const result of folded) {
    const parts = replaced.get(result.message) ?? new Map<number, Result>();
    parts.set(result.part, result);
    replaced.set(result.message, parts);
  }
  return prompt.map((message, index) => {
    const parts = replaced.get(index);
    if (!parts) return message;
    return {
      ...message,
      content: (message.content as Part[]).map((part, partIndex) => {
        const result = parts.get(partIndex);
        if (!result) return part;
        return result.call !== undefined
          ? { ...part, input: result.call }
          : { ...part, output: { type: "text", value: result.summary } };
      }),
    } as Message;
  });
}

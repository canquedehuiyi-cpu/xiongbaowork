/**
 * 重复任务里「学没学到」的观测：一次运行前后各读一遍这位员工的自写技能和形成的记忆，差出来的就是这次运行
 * 学到的；两次之间等复盘有结论再开第二次（模拟「过一会儿再做同类任务」）。
 *
 * 纯函数和注入式的等待放在这里，`run-xiongbao.ts` 只负责接上数据库和服务器日志。评测不替熊宝侧开任何特殊开关、
 * 不降复盘门槛：产品默认值是什么就用什么。
 */

import { redactSecrets } from "./metrics";
import type { BackgroundCalls, RunLearning } from "./records";

/**
 * 第一次结束后最多等复盘多久；到了就照常开始第二次。用户 2026-11-22 批准：等到复盘出结论，最多 600 秒
 * （复盘模型调用 120 秒、超时重试一次，加追问快路径同样最多 240 秒，共约 480 秒 + 余量）。
 * 之前是 270 秒，评测 44986303220 第 3 对第一次的复盘 270 秒内没出结论，第二次就没技能可用。
 */
export const RETRO_WAIT_MS = 600_000;

/**
 * 第二次结束后最多等复盘多久（只为在记录里写下它的结论，之后才开对照运行）：保持 270 秒 = 两次复盘模型调用的超时
 * （各 120 秒；超时会自动再调一次，服务器 `retrospect.ts`）+ 30 秒余量。对照运行不等复盘。
 */
export const RETRO_WAIT_AFTER_SECOND_MS = 270_000;

/** 这次运行做完之后等复盘的上限：第一次之后要等到出结论才开第二次（{@link RETRO_WAIT_MS}），其余的用短的。 */
export function retroWaitFor(
  round: "first" | "second" | "control" | undefined,
) {
  return round === "first" ? RETRO_WAIT_MS : RETRO_WAIT_AFTER_SECOND_MS;
}

/** 某一刻这位员工的自写技能（命令名 -> 名字、使用次数）和形成的记忆条数。 */
export type LearnedState = {
  skills: Map<
    string,
    {
      title: string;
      useCount: number;
      /** 技能正文（存下的 `instructions`），评测报告摘它的前 800 字。读不到就没有。 */
      instructions?: string;
    }
  >;
  /** 复盘存了、但转待审没授予的技能（命令名 -> 名字）：在本人的待审清单里，不在自写技能账里。没读到就没有这一项。 */
  held?: Map<string, string>;
  memories: number;
};

/** 一次运行前后的差：新增的技能名、新增的待审技能名（有才带）、新增的记忆条数、使用次数涨了的技能名。 */
export function learningDiff(
  before: LearnedState,
  after: LearnedState,
): Pick<
  RunLearning,
  "newSkills" | "heldSkills" | "newMemories" | "usedSkills"
> {
  const newSkills: string[] = [];
  const usedSkills: string[] = [];
  for (const [slug, skill] of after.skills) {
    const was = before.skills.get(slug);
    if (!was) newSkills.push(skill.title);
    else if (skill.useCount > was.useCount) usedSkills.push(skill.title);
  }
  const heldSkills = [...(after.held ?? [])]
    .filter(([slug]) => !before.held?.has(slug))
    .map(([, title]) => title);
  return {
    newSkills,
    ...(heldSkills.length > 0 ? { heldSkills } : {}),
    newMemories: Math.max(0, after.memories - before.memories),
    usedSkills,
  };
}

/** 报告和日志里每条新技能的正文只放前这么多字。 */
export const SKILL_BODY_CHARS = 800;

/**
 * 第一次之后新存下的技能的正文，每条取前 {@link SKILL_BODY_CHARS} 字：看真跑时技能到底写了什么，第二次没变快
 * 时先看这里。只放技能正文，不放别的：复盘已经把个人数据换成了占位。没有正文的技能不列。
 */
export function newSkillBodies(
  before: LearnedState,
  after: LearnedState,
): { title: string; text: string }[] {
  const bodies: { title: string; text: string }[] = [];
  for (const [slug, skill] of after.skills) {
    if (before.skills.has(slug) || !skill.instructions?.trim()) continue;
    bodies.push({
      title: skill.title,
      text: skill.instructions.slice(0, SKILL_BODY_CHARS),
    });
  }
  return bodies;
}

/** 日志里打的那一份：一条技能一段，带技能名。没有就是空串。 */
export function skillBodyLog(
  bodies: readonly { title: string; text: string }[],
): string {
  return bodies
    .map(
      (body) =>
        `   skill 「${body.title}」 (first ${SKILL_BODY_CHARS} chars):\n${body.text}`,
    )
    .join("\n");
}

/** 服务器日志里复盘观察者写的一行（`learning/retrospect.ts` 的 `createRetroObserver`）。 */
export type RetroLine = {
  outcome: string;
  trigger?: string;
  steps?: number;
  /** 跳过的原因：`steps` 步数不够、`failed` 这一轮失败了、`card_done` 这张卡已经复盘过；没写就是冷却、额度、没开等。 */
  reason?: string;
  /** 这一行是哪张看板卡的复盘（卡的各轮合成的）；单独一轮的没有。 */
  cardId?: string;
  /** 存下复盘技能的同时，替换（移除）了几条员工这一轮自存的技能；日志里的 `replaced` 数组的长度，没替换就没有。 */
  replaced?: number;
  /** 转待审时同一轮另记的 `retrospect-held` 行里的原因（规则的名字和认出的网址）；没转待审时没有。 */
  heldReason?: string;
  /** 复盘出错时同一轮另记的 `retrospect-error` 行里的错误类型（只有类型，没有内容）；没出错时没有。 */
  error?: string;
  /** 草稿只有步骤、没有快路径，复盘又追问了一次快路径（日志里的 `askedFastPath`）。 */
  askedFastPath?: true;
  /** 追问之后用上的草稿带快路径（日志里的 `gotFastPath`）。 */
  gotFastPath?: true;
  /** 草稿只因破坏性命令要转待审，复盘让模型改写了一次（日志里的 `rewroteUnsafe`）。 */
  rewroteUnsafe?: true;
  /** 改写后的草稿过了安全检查、用上了（日志里的 `rewriteCleared`）。 */
  rewriteCleared?: true;
  /** 失败轮的诊断（日志里同名的项，不含内容）：第一个运行错误的错误码、事件里有没有 `deliver_task` 调用、库里有没有这一轮的交付行、事件数。 */
  runError?: string;
  /** 运行错误的类别（日志里的 `runErrorKind`：`ended_early` / `segment_limit` / `other`，不含原文）。 */
  runErrorKind?: string;
  /** 运行错误是不是出现在被接受的交付之后（日志里的 `runErrorAfterDelivery`）。 */
  runErrorAfterDelivery?: boolean;
  deliverSeen?: boolean;
  deliveredRow?: boolean;
  eventCount?: number;
  /** 这一轮带了失败标记（运行错误），但自己有一次交付成功，复盘照常跑了（日志里的 `failedButDelivered`）。 */
  failedButDelivered?: true;
  runId: string;
};

/** 从服务器日志的全文里挑出这几轮的复盘行；不是 JSON 的行、别的类型的行都跳过。 */
export function retroLinesOf(
  log: string,
  runIds: readonly string[],
): RetroLine[] {
  const wanted = new Set(runIds);
  const lines: RetroLine[] = [];
  const heldReasons = new Map<string, string>();
  const errors = new Map<string, string>();
  for (const raw of log.split("\n")) {
    if (raw.includes('"type":"retrospect-error"')) {
      try {
        const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as {
          error?: unknown;
          context?: { runId?: unknown };
        };
        const runId = String(parsed.context?.runId ?? "");
        if (wanted.has(runId) && typeof parsed.error === "string")
          errors.set(runId, parsed.error);
      } catch {
        // 读不懂就跳过。
      }
      continue;
    }
    if (raw.includes('"type":"retrospect-held"')) {
      try {
        const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<
          string,
          unknown
        >;
        const runId = String(parsed.runId ?? "");
        if (wanted.has(runId) && typeof parsed.reason === "string")
          heldReasons.set(runId, parsed.reason);
      } catch {
        // 读不懂就跳过。
      }
      continue;
    }
    if (!raw.includes('"type":"retrospect"')) continue;
    try {
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<
        string,
        unknown
      >;
      if (parsed.type !== "retrospect") continue;
      const runId = String(parsed.runId ?? "");
      if (!wanted.has(runId)) continue;
      lines.push({
        outcome: String(parsed.outcome ?? ""),
        ...(typeof parsed.trigger === "string"
          ? { trigger: parsed.trigger }
          : {}),
        ...(typeof parsed.steps === "number" ? { steps: parsed.steps } : {}),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        ...(typeof parsed.cardId === "string" ? { cardId: parsed.cardId } : {}),
        ...(parsed.askedFastPath === true
          ? { askedFastPath: true as const }
          : {}),
        ...(parsed.gotFastPath === true ? { gotFastPath: true as const } : {}),
        ...(parsed.rewroteUnsafe === true
          ? { rewroteUnsafe: true as const }
          : {}),
        ...(parsed.rewriteCleared === true
          ? { rewriteCleared: true as const }
          : {}),
        ...(typeof parsed.runError === "string"
          ? { runError: shortText(parsed.runError) }
          : {}),
        ...(RUN_ERROR_KINDS.has(String(parsed.runErrorKind))
          ? { runErrorKind: String(parsed.runErrorKind) }
          : {}),
        ...(typeof parsed.runErrorAfterDelivery === "boolean"
          ? { runErrorAfterDelivery: parsed.runErrorAfterDelivery }
          : {}),
        ...(typeof parsed.deliverSeen === "boolean"
          ? { deliverSeen: parsed.deliverSeen }
          : {}),
        ...(typeof parsed.deliveredRow === "boolean"
          ? { deliveredRow: parsed.deliveredRow }
          : {}),
        ...(typeof parsed.eventCount === "number"
          ? { eventCount: parsed.eventCount }
          : {}),
        ...(parsed.failedButDelivered === true
          ? { failedButDelivered: true as const }
          : {}),
        ...(Array.isArray(parsed.replaced) && parsed.replaced.length > 0
          ? { replaced: parsed.replaced.length }
          : {}),
        runId,
      });
    } catch {
      // 一行日志读不懂就跳过，不影响别的行。
    }
  }
  return lines.map((line) => {
    const heldReason =
      line.outcome === "held" ? heldReasons.get(line.runId) : undefined;
    const error =
      line.outcome === "skipped" ? errors.get(line.runId) : undefined;
    return {
      ...line,
      ...(heldReason ? { heldReason } : {}),
      ...(error ? { error } : {}),
    };
  });
}

/** 打进作业日志的服务器日志行里，行首的类型名：复盘相关的几种。 */
/** 日志里 `runErrorKind` 只认这三个值（类别，不是原文）。 */
const RUN_ERROR_KINDS: ReadonlySet<string> = new Set([
  "ended_early",
  "segment_limit",
  "other",
]);

const RETRO_LOG_TYPES = new Set([
  "retrospect",
  "retrospect-retry",
  "retrospect-held",
  "retrospect-refused",
  "retrospect-error",
]);

/** 一个值压成单行、打码、最多 120 字。 */
function shortText(value: unknown): string {
  return redactSecrets(String(value).replace(/\s+/g, " ").trim()).slice(0, 120);
}

/** 服务器日志的一行里 `{` 开头的 JSON；读不懂返回 undefined。 */
function jsonOfLine(raw: string): Record<string, unknown> | undefined {
  const at = raw.indexOf("{");
  if (at < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.slice(at));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 日志行属于哪一轮：顶层 `runId`，或 `context.runId`（`retrospect-error` 把它放在 context 里），或 `runRef` / `run`（停滞守卫的行）。 */
function runIdOfLog(parsed: Record<string, unknown>): string {
  const context = parsed.context;
  const nested =
    context && typeof context === "object"
      ? (context as { runId?: unknown }).runId
      : undefined;
  const value = parsed.runId ?? nested ?? parsed.runRef ?? parsed.run;
  return typeof value === "string" ? value : "";
}

/**
 * 这几轮在服务器日志里的复盘相关行，一行一条，写进作业日志：服务器日志不上传，作业日志里看不到复盘就没法查
 * 「为什么记成跳过」。只取不含内容的字段：type、outcome、trigger、steps、reason、失败轮的诊断（runError 错误码、runErrorKind、runErrorAfterDelivery、deliverSeen、deliveredRow、eventCount）、retried、askedFastPath、
 * gotFastPath、rewroteUnsafe、rewriteCleared、failedButDelivered、cardId 和运行号各前 8 位、时间戳；`error`（只有错误类型）和 `reason`
 * （规则名、网址）单行化、打码、各取前 120 字。技能正文、名称、步骤、轨迹一律不打。
 */
export function retroLogLines(
  log: string,
  runIds: readonly string[],
): string[] {
  const wanted = new Set(runIds);
  const out: string[] = [];
  for (const raw of log.split("\n")) {
    if (!raw.includes('"type":"retrospect')) continue;
    const parsed = jsonOfLine(raw);
    if (!parsed) continue;
    const type = String(parsed.type ?? "");
    if (!RETRO_LOG_TYPES.has(type)) continue;
    const runId = runIdOfLog(parsed);
    if (!wanted.has(runId)) continue;
    const fields: string[] = [type];
    const put = (name: string, value: unknown) => {
      if (value !== undefined && value !== null && value !== "")
        fields.push(`${name}=${shortText(value)}`);
    };
    put("outcome", parsed.outcome);
    put("trigger", parsed.trigger);
    put("steps", parsed.steps);
    put("reason", parsed.reason);
    put("runError", parsed.runError);
    if (RUN_ERROR_KINDS.has(String(parsed.runErrorKind)))
      put("runErrorKind", parsed.runErrorKind);
    put("runErrorAfterDelivery", parsed.runErrorAfterDelivery);
    put("deliverSeen", parsed.deliverSeen);
    put("deliveredRow", parsed.deliveredRow);
    put("eventCount", parsed.eventCount);
    for (const flag of [
      "retried",
      "askedFastPath",
      "gotFastPath",
      "rewroteUnsafe",
      "rewriteCleared",
      "failedButDelivered",
    ])
      if (parsed[flag] === true) fields.push(`${flag}=true`);
    if (typeof parsed.cardId === "string")
      fields.push(`cardId=${parsed.cardId.slice(0, 8)}`);
    fields.push(`run=${runId.slice(0, 8)}`);
    put("error", parsed.error);
    put("at", parsed.timestamp);
    out.push(`   retro-log ${fields.join(" ")}`);
  }
  return out;
}

/**
 * 服务器日志里带着这几轮运行号的非复盘行，按类型数个数（`run-model`、`agent-stream-stalled`、
 * `task-card-turn-ended-early`、`channel-dispatch-…` 等）：只有类型和个数，不含内容。下次能看出一轮为什么被复盘当成
 * 失败、步数为什么对不上。不带运行号的行（如 `postgres-runner` 的收尾，它不写 JSON 日志）看不到。
 */
export function logTypeCounts(
  log: string,
  runIds: readonly string[],
): Record<string, number> {
  const wanted = new Set(runIds.filter(Boolean));
  const counts: Record<string, number> = {};
  if (wanted.size === 0) return counts;
  const ids = [...wanted];
  for (const raw of log.split("\n")) {
    if (!ids.some((id) => raw.includes(id))) continue;
    const parsed = jsonOfLine(raw);
    if (!parsed) continue;
    const type = String(parsed.type ?? "");
    if (!type || RETRO_LOG_TYPES.has(type) || !wanted.has(runIdOfLog(parsed)))
      continue;
    const name = shortText(type);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** {@link logTypeCounts} 打成一行：`   server-log lines by run: run-model×3, …`；没有就是空串。 */
export function logTypeCountsLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}×${count}`);
  return parts.length > 0
    ? `   server-log lines by run: ${parts.join(", ")}`
    : "";
}

/**
 * 这一行是不是「这张卡的复盘」有了结论：
 * - 存了、模型认为不值得、近似、被拒：有结论，哪一轮的都算；
 * - 跳过但原因是步数不够：没结论。通用路径的 skipped 多半是这个，卡的复盘可能还在后面的轮里等着，
 *   把它当成结束会让第二次提前开跑；
 * - 跳过的是看板卡的复盘（冷却、额度用完、这张卡已经复盘过）：有结论；
 * - 跳过的是失败的轮：只有最后一轮才算（后面没有别的轮了），较早的失败轮后面还有轮要跑；
 * - 通用路径跳过、没写步数原因（冷却、没开）：只有最后一轮才算。复盘出错（两次模型调用都超时等，日志里的
 *   `retrospect-error`，这里在 `error` 里）也是这一条：服务器照常写一行 `retrospect`、结果记 skipped，最后一轮的
 *   出错就是结论，不必白等到上限。
 *
 * `card_turn`（看板卡派的一轮，这一轮没交付）走的是后两条，不和 `card_delivered` 一样算「这张卡有结论」：它只是这一轮
 * 自己的复盘，卡后面的轮还可能交付、按整张卡再复盘一次。步数不够的跳过照样「再等」，冷却等跳过只有最后一轮才算。
 */
export function concludesRetro(line: RetroLine, isLastRound: boolean): boolean {
  if (line.outcome !== "skipped") return true;
  if (line.reason === "steps") return false;
  if (line.reason === "failed") return isLastRound;
  if (line.trigger === "card_delivered" || line.trigger === "card_accepted")
    return true;
  return isLastRound;
}

/**
 * 轮询直到这张卡的复盘有结论（见 {@link concludesRetro}，各轮的日志行都看），或库里出现了新的自写技能，或到了
 * 上限。所有读都注入：测试里不起服务器。读失败当作「还没有」，不让评测因此中止。
 */
export async function waitForRetro(options: {
  /** 这次运行各轮的运行号，最后一个是最后一轮。 */
  runIds: readonly string[];
  /** 服务器日志的当前全文。 */
  readLog: () => string | Promise<string>;
  /** 这位员工现在的自写技能条数，和运行前比。 */
  skillCount: () => Promise<number>;
  skillsBefore: number;
  maxMs?: number;
  everyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<NonNullable<RunLearning["retro"]>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const started = now();
  const last = options.runIds.at(-1);
  const maxMs = options.maxMs ?? RETRO_WAIT_MS;
  const lines = async (): Promise<RetroLine[]> => {
    try {
      return retroLinesOf(await options.readLog(), options.runIds);
    } catch {
      return [];
    }
  };
  const shown = (line: RetroLine) => ({
    outcome: line.outcome,
    ...(line.trigger ? { trigger: line.trigger } : {}),
    ...(line.steps === undefined ? {} : { steps: line.steps }),
    ...(line.heldReason ? { heldReason: line.heldReason } : {}),
    ...(line.replaced ? { replaced: line.replaced } : {}),
    ...(line.reason ? { reason: line.reason } : {}),
    ...(line.error ? { error: line.error } : {}),
    ...(line.askedFastPath ? { askedFastPath: true as const } : {}),
    ...(line.gotFastPath ? { gotFastPath: true as const } : {}),
    ...(line.rewroteUnsafe ? { rewroteUnsafe: true as const } : {}),
    ...(line.rewriteCleared ? { rewriteCleared: true as const } : {}),
    ...(line.failedButDelivered ? { failedButDelivered: true as const } : {}),
  });
  for (;;) {
    const seen = await lines();
    const concluded = seen
      .filter((line) => concludesRetro(line, line.runId === last))
      .at(-1);
    const grew = await options
      .skillCount()
      .then((total) => total > options.skillsBefore)
      .catch(() => false);
    const waitedMs = now() - started;
    if (concluded) return { waitedMs, ended: "logged", ...shown(concluded) };
    if (grew) return { waitedMs, ended: "skill" };
    if (waitedMs >= maxMs) {
      const latest = seen.at(-1);
      return {
        waitedMs,
        ended: "timeout",
        ...(latest ? shown(latest) : {}),
      };
    }
    await sleep(options.everyMs ?? 1000);
  }
}

/** 轮外的背景调用（复盘、自动抽记忆）：几次、输入多少 token。 */
export function backgroundOf(
  rows: readonly { inputTokens: number | null }[],
): BackgroundCalls {
  return {
    count: rows.length,
    inputTokens: rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0),
  };
}

/** 一次运行的工具调用，一行一个：工具名和参数的前一段（换行压成空格）。重复任务看第二次照没照技能走用。 */
export function callTrace(
  calls: readonly { name: string; args: string; result?: string }[],
  argChars = 140,
): string[] {
  return calls.map((call, index) => {
    const args = call.args.replace(/\s+/g, " ").trim();
    const cut = args.length > argChars ? `${args.slice(0, argChars)}…` : args;
    // 参数和结果各多少字：看历史里堆的是什么（写文件的长参数、读文件和命令的长结果）。
    const sizes = ` [参数 ${call.args.length} 字${call.result === undefined ? "" : ` / 结果 ${call.result.length} 字`}]`;
    const line = `${String(index + 1).padStart(2, " ")}. ${call.name}${sizes} ${cut}`;
    // 被拒或被挡回的调用，行末带上结果的前 120 个字，看得出原因。
    const result = call.result ?? "";
    return /^(Refused\.|\[refused\])/.test(result) ||
      /bounced\\?"\s*:\s*true/.test(result)
      ? `${line} → ${result.replace(/\s+/g, " ").trim().slice(0, 120)}`
      : line;
  });
}

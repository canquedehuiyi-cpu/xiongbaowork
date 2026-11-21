/**
 * 重复任务里「学没学到」的观测：一次运行前后各读一遍这位员工的自写技能和形成的记忆，差出来的就是这次运行
 * 学到的；两次之间等复盘有结论再开第二次（模拟「过一会儿再做同类任务」）。
 *
 * 纯函数和注入式的等待放在这里，`run-xiongbao.ts` 只负责接上数据库和服务器日志。评测不替熊宝侧开任何特殊开关、
 * 不降复盘门槛：产品默认值是什么就用什么。
 */

import type { BackgroundCalls, RunLearning } from "./records";

/** 第一次结束后最多等复盘多久；到了就照常开始第二次。 */
export const RETRO_WAIT_MS = 90_000;

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
  /** 转待审时同一轮另记的 `retrospect-held` 行里的原因（规则的名字和认出的网址）；没转待审时没有。 */
  heldReason?: string;
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
  for (const raw of log.split("\n")) {
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
        runId,
      });
    } catch {
      // 一行日志读不懂就跳过，不影响别的行。
    }
  }
  return lines.map((line) => {
    const heldReason =
      line.outcome === "held" ? heldReasons.get(line.runId) : undefined;
    return heldReason ? { ...line, heldReason } : line;
  });
}

/**
 * 这一行是不是「这张卡的复盘」有了结论：
 * - 存了、模型认为不值得、近似、被拒：有结论，哪一轮的都算；
 * - 跳过但原因是步数不够：没结论。通用路径的 skipped 多半是这个，卡的复盘可能还在后面的轮里等着，
 *   把它当成结束会让第二次提前开跑；
 * - 跳过的是看板卡的复盘（冷却、额度用完、这张卡已经复盘过）：有结论；
 * - 跳过的是失败的轮：只有最后一轮才算（后面没有别的轮了），较早的失败轮后面还有轮要跑；
 * - 通用路径跳过、没写步数原因（冷却、没开）：只有最后一轮才算。
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
    return `${String(index + 1).padStart(2, " ")}. ${call.name}${sizes} ${cut}`;
  });
}

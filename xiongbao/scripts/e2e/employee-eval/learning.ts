/**
 * 重复任务里「学没学到」的观测：一次运行前后各读一遍这位员工的自写技能和形成的记忆，差出来的就是这次运行
 * 学到的；两次之间等复盘跑完再开第二次（模拟「过一会儿再做同类任务」）。
 *
 * 纯函数和注入式的等待放在这里，`run-xiongbao.ts` 只负责接上数据库和服务器日志。评测不替熊宝侧开任何特殊开关、
 * 不降复盘门槛：产品默认值是什么就用什么。
 */

import type { RunLearning } from "./records";

/** 第一次结束后最多等复盘多久；到了就照常开始第二次。 */
export const RETRO_WAIT_MS = 90_000;

/** 某一刻这位员工的自写技能（命令名 -> 名字、使用次数）和形成的记忆条数。 */
export type LearnedState = {
  skills: Map<string, { title: string; useCount: number }>;
  memories: number;
};

/** 一次运行前后的差：新增的技能名、新增的记忆条数、使用次数涨了的技能名。 */
export function learningDiff(
  before: LearnedState,
  after: LearnedState,
): Pick<RunLearning, "newSkills" | "newMemories" | "usedSkills"> {
  const newSkills: string[] = [];
  const usedSkills: string[] = [];
  for (const [slug, skill] of after.skills) {
    const was = before.skills.get(slug);
    if (!was) newSkills.push(skill.title);
    else if (skill.useCount > was.useCount) usedSkills.push(skill.title);
  }
  return {
    newSkills,
    newMemories: Math.max(0, after.memories - before.memories),
    usedSkills,
  };
}

/** 服务器日志里复盘观察者写的一行（`learning/retrospect.ts` 的 `createRetroObserver`）。 */
export type RetroLine = {
  outcome: string;
  trigger?: string;
  steps?: number;
  runId: string;
};

/** 从服务器日志的全文里挑出这几轮的复盘行；不是 JSON 的行、别的类型的行都跳过。 */
export function retroLinesOf(
  log: string,
  runIds: readonly string[],
): RetroLine[] {
  const wanted = new Set(runIds);
  const lines: RetroLine[] = [];
  for (const raw of log.split("\n")) {
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
        runId,
      });
    } catch {
      // 一行日志读不懂就跳过，不影响别的行。
    }
  }
  return lines;
}

/**
 * 轮询直到这次运行最后一轮的复盘行出现，或库里出现了新的自写技能，或到了上限。
 * 所有读都注入：测试里不起服务器。读失败当作「还没有」，不让评测因此中止。
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
  const result = async (): Promise<RetroLine | undefined> => {
    if (!last) return undefined;
    try {
      return retroLinesOf(await options.readLog(), [last]).at(-1);
    } catch {
      return undefined;
    }
  };
  for (;;) {
    const line = await result();
    const grew = await options
      .skillCount()
      .then((total) => total > options.skillsBefore)
      .catch(() => false);
    const waitedMs = now() - started;
    if (line)
      return {
        waitedMs,
        ended: "logged",
        outcome: line.outcome,
        ...(line.trigger ? { trigger: line.trigger } : {}),
        ...(line.steps === undefined ? {} : { steps: line.steps }),
      };
    if (grew) return { waitedMs, ended: "skill" };
    if (waitedMs >= maxMs) return { waitedMs, ended: "timeout" };
    await sleep(options.everyMs ?? 1000);
  }
}

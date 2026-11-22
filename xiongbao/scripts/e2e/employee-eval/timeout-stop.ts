/**
 * 运行超时（评测截止）就停掉服务器上还在跑的那一轮：评测在截止时间到了以后就往下走，服务器上那一轮还在跑，会和
 * 后面的运行抢模型，也会继续往工作区写东西（评测 44986303220 第 3 对对照 468 秒里 383 秒不是模型时间）。
 *
 * 停止走服务器现成的接口，就是对话里「停止」按钮用的那个：`POST …/agent/:员工/stop/:对话`（前缀和单聊的运行接口一样），请求体
 * `{ runId }`（`handle-stop.ts`，里面是 `runner.stop`）。看板派活的那一轮和单聊的一轮都跑在某段对话里，同一个接口
 * 都停得了；看板卡自己的取消（`POST /api/tasks/:id/cancel`）也调它，但还会把卡改成已取消，评测不要这个副作用。
 *
 * 这里只放纯逻辑和注入式的等待；`run-xiongbao.ts` 接上 HTTP 和数据库。失败都不抛错。
 */

import { RUN_PATH } from "../chat-client";

/** 对话的停止接口：和单聊的运行接口同一前缀，`/stop/:对话` 结尾。 */
export const stopPath = (agentId: string, threadId: string) =>
  RUN_PATH(agentId).replace(/\/run$/, `/stop/${encodeURIComponent(threadId)}`);

/** 一轮在库里的状态里「还在跑」的那一种（`thread_run_liveness.status`）。 */
const RUNNING = "running";

/** 哪些轮还要停：状态是 running 的；没有记录（undefined）和已结束的不用。保持传入顺序，去重。 */
export function runsToStop(
  states: readonly { runId: string; status: string | undefined }[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { runId, status } of states) {
    if (status !== RUNNING || seen.has(runId)) continue;
    seen.add(runId);
    ids.push(runId);
  }
  return ids;
}

/** 停了一遍之后的结果：找到还在跑的几轮，其中几轮在等待时间内停下了，几轮还在跑。 */
export type StopOutcome = {
  running: number;
  stopped: number;
  stillRunning: number;
};

/**
 * 对 `runIds` 里还在跑的每一轮调 `stop`（返回 false 或抛错只是这一轮没被接受，不影响别的轮），再每 `everyMs`
 * 看一次状态，等它们都变成非 running，最多 `maxMs`（默认 30 秒）。`statusOf` 读不到当作还在跑。
 */
export async function stopRunning(options: {
  runIds: readonly string[];
  statusOf: (runId: string) => Promise<string | undefined>;
  stop: (runId: string) => Promise<boolean>;
  maxMs?: number;
  everyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StopOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const states = async (ids: readonly string[]) =>
    Promise.all(
      ids.map(async (runId) => ({
        runId,
        status: await options.statusOf(runId).catch(() => RUNNING),
      })),
    );
  const targets = runsToStop(await states(options.runIds));
  if (targets.length === 0) return { running: 0, stopped: 0, stillRunning: 0 };
  await Promise.all(
    targets.map((runId) => options.stop(runId).catch(() => false)),
  );
  const started = now();
  let left = targets;
  for (;;) {
    left = runsToStop(await states(left));
    if (left.length === 0 || now() - started >= (options.maxMs ?? 30_000))
      break;
    await sleep(options.everyMs ?? 500);
  }
  return {
    running: targets.length,
    stopped: targets.length - left.length,
    stillRunning: left.length,
  };
}

/** 作业日志里这次超时停掉了什么的一行；服务器上没有还在跑的轮时也说一声。 */
export function stopLine(outcome: StopOutcome): string {
  if (outcome.running === 0) return "   超时：服务器上没有还在跑的轮";
  const head = `   超时：已停掉服务器上还在跑的 ${outcome.stopped} 轮`;
  return outcome.stillRunning > 0
    ? `${head}，另有 ${outcome.stillRunning} 轮 30 秒内没停下`
    : head;
}

/** 一次运行开始前，这位员工在服务器上还在跑的一轮（上一次的）。 */
export type EarlierRun = { runId: string; threadId: string };

/** {@link settleEarlierRuns} 的结果。 */
export type SettleOutcome = {
  /** 一开始找到几轮还在跑。 */
  found: number;
  /** 其中几轮在等待时间内自己结束了。 */
  endedOnTheirOwn: number;
  /** 等不及、被停掉并确实停下的几轮。 */
  stopped: number;
  /** 停了也还没停下的几轮。 */
  stillRunning: number;
  waitedMs: number;
};

/**
 * 一次运行开始之前，确认这位员工没有仍在跑的轮（上一次的）：有就先等它结束，最多 `waitMs`（默认 60 秒）；还不结束
 * 就走和超时一样的办法停掉（{@link stopRunning} 用的那个停止接口），再等它停下。不然上一次的轮会接着占模型、
 * 往工作区写东西，串进这一次（评测 45037964307 第 5 对第二次的 46 步就是这样）。读写失败都不抛错。
 */
export async function settleEarlierRuns(options: {
  running: () => Promise<readonly EarlierRun[]>;
  stop: (run: EarlierRun) => Promise<boolean>;
  waitMs?: number;
  everyMs?: number;
  stopMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SettleOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const read = async () => {
    try {
      return [...(await options.running())];
    } catch {
      return [];
    }
  };
  const started = now();
  const first = await read();
  if (first.length === 0)
    return {
      found: 0,
      endedOnTheirOwn: 0,
      stopped: 0,
      stillRunning: 0,
      waitedMs: 0,
    };
  let left = first;
  while (left.length > 0 && now() - started < (options.waitMs ?? 60_000)) {
    await sleep(options.everyMs ?? 1000);
    left = await read();
  }
  const endedOnTheirOwn = first.length - left.length;
  if (left.length > 0) {
    await Promise.all(left.map((run) => options.stop(run).catch(() => false)));
    const stopStarted = now();
    while (
      left.length > 0 &&
      now() - stopStarted < (options.stopMs ?? 30_000)
    ) {
      await sleep(options.everyMs ?? 500);
      left = await read();
    }
  }
  return {
    found: first.length,
    endedOnTheirOwn,
    stopped: first.length - endedOnTheirOwn - left.length,
    stillRunning: left.length,
    waitedMs: now() - started,
  };
}

/** 作业日志里这次开始前清理上一次的轮的一行；没有还在跑的轮就是空串（不打）。 */
export function settleLine(outcome: SettleOutcome): string {
  if (outcome.found === 0) return "";
  const waited = `${Math.round(outcome.waitedMs / 1000)} s`;
  if (outcome.stopped === 0 && outcome.stillRunning === 0)
    return `   开始前：这位员工上一次的 ${outcome.found} 轮还在跑，等了 ${waited} 自己结束了`;
  return `   开始前：这位员工上一次的 ${outcome.found} 轮还在跑，等了 ${waited}：自己结束 ${outcome.endedOnTheirOwn} 轮，已停掉 ${outcome.stopped} 轮${outcome.stillRunning > 0 ? `，另有 ${outcome.stillRunning} 轮没停下` : ""}`;
}

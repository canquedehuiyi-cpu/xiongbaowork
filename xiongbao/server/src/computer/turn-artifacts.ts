import { AsyncLocalStorage } from "node:async_hooks";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { defer, from, Observable, of } from "rxjs";
import { concatMap } from "rxjs/operators";
import {
  TURN_ARTIFACTS_EVENT,
  type TurnArtifactsValue,
} from "../../../shared/turn-artifacts";
import { withRunSideEvents } from "../threads/run-side-events";
import { type ComputerSeat, computerKeyText } from "./computer-key";
import type { ComputerGateway } from "./gateway";

/**
 * 每一轮首尾记员工电脑上的文件：一轮开始时让电脑记快照，结束时问它「这一轮新建、改过哪些文件」，
 * 有就在 `RUN_FINISHED` 前插一条给人看的 `CUSTOM` 事件，对话里据此画下载清单。
 *
 * 这是锦上添花：记快照、查变化出任何问题（电脑连不上、重启后快照丢了、设备上的电脑）都只打日志，
 * 这一轮照常结束，不多不少。
 */

export type TurnArtifactsTurn = {
  runId: string;
  botId: string;
  /** 这一轮用的电脑座位；没有（或设备上的电脑）答 null。 */
  seat: () => Promise<ComputerSeat | null>;
  /**
   * 一轮可能跨好几个 run：浏览器自己执行电脑工具时，每个工具调用都让 run 结束，页面带着结果再发下一个 run。
   * 给了它，这一轮的快照标记按 `key`（人、员工、对话）留在两个 run 之间，只在结束时不再有待执行工具调用的那个 run
   * 才比对并发事件；中间的 run 结束时标记不丢。`continues` 为真表示这个 run 接着上一个 run 的那一轮
   * （最后一条消息不是人说的话），为假表示新的一轮开始，旧的标记作废。
   */
  carry?: { key: string; continues: boolean };
  /**
   * 这条流本身就是完整的一轮（服务器分段执行工具，段与段之间的工具在流外跑）：它的 `RUN_FINISHED`
   * 一定是这一轮的结尾，不看有没有未答复的工具调用。流里面各段的观察由它代劳，见 `wholeTurnOf`。
   */
  wholeTurn?: boolean;
};

type TurnArtifactsGateway = Pick<ComputerGateway, "markTurn" | "turnChanges">;

/** 轮末等电脑列出文件最多等多久；超了就不列，这一轮照常结束。 */
export const TURN_ARTIFACTS_DEADLINE_MS = 15_000;

/**
 * 跨 run 的标记：key 是（人、员工、对话），值是这一轮第一个 run 登记的快照标记和它的座位。
 * 只存在内存里，和网关里的标记同寿；超出上限丢最旧的（对应的网关标记也会被它自己的上限淘汰）。
 */
const CARRIED_MAX = 500;
const carried = new Map<
  string,
  { markId: string; marked: Promise<ComputerSeat | null> }
>();

function carryOver(
  key: string,
  entry: { markId: string; marked: Promise<ComputerSeat | null> },
) {
  carried.delete(key);
  carried.set(key, entry);
  while (carried.size > CARRIED_MAX) {
    const oldest = carried.keys().next().value;
    if (oldest === undefined) break;
    carried.delete(oldest);
  }
}

/**
 * 整轮已经由外层的 `wholeTurn` 流观察时，里面每一段的观察要让位：段与段之间用同一个 `markId` 去
 * 记、去比对，会把外层的标记冲掉。按 run 号认，同一个 run 的各段才让位，别的 run（比如这一轮里
 * 叫来的另一位员工）仍各自观察。
 */
const wholeTurnOf = new AsyncLocalStorage<string>();

function warn(operation: string, runId: string, botId: string, error: unknown) {
  // 只记错误种类，不记抛出的内容：它可能带着连接信息。
  console.warn({
    warning: "turn_artifacts_failed",
    context: {
      operation,
      runId,
      botId,
      kind: error instanceof Error ? error.name : "unknown",
    },
    timestamp: new Date().toISOString(),
  });
}

export function withTurnArtifacts(
  stream: Observable<BaseEvent>,
  turn: TurnArtifactsTurn,
  gateway: TurnArtifactsGateway,
  /** 轮末等待的截止（毫秒），测试里调小。 */
  deadlineMs: number = TURN_ARTIFACTS_DEADLINE_MS,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const abort = new AbortController();
    const carry = turn.carry;
    const earlier = carry?.continues ? carried.get(carry.key) : undefined;
    // 同一个电脑可能被好几个座位共用，快照名必须全局唯一。接着上一个 run 的一轮，沿用那一轮的标记。
    const markId = earlier?.markId ?? `${turn.runId}:${turn.botId}`;
    /** 订阅时后台记快照，不挡第一个事件；成功答座位，失败或没有座位答 null。 */
    const marked: Promise<ComputerSeat | null> =
      earlier?.marked ??
      (async () => {
        try {
          const seat = await turn.seat();
          if (!seat) return null;
          await gateway.markTurn(seat, markId);
          return seat;
        } catch (error) {
          if (!abort.signal.aborted)
            warn("markTurn", turn.runId, turn.botId, error);
          return null;
        }
      })();
    if (carry && !earlier) carryOver(carry.key, { markId, marked });
    /** 这个 run 里开了头、还没有结果的工具调用：留到下一个 run 才有结果的，这一轮还没完。 */
    const unanswered = new Set<string>();

    const artifactsBefore = async (): Promise<BaseEvent[]> => {
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = AbortSignal.any([abort.signal, deadline]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("turn artifacts deadline")),
          deadlineMs,
        );
      });
      const work = async (): Promise<BaseEvent[]> => {
        const seat = await marked;
        if (!seat || abort.signal.aborted) return [];
        const changes = await gateway.turnChanges(seat, markId, signal);
        if (!changes || changes.files.length === 0) return [];
        const value: TurnArtifactsValue = {
          botId: turn.botId,
          seat: computerKeyText(seat.key),
          files: changes.files,
          scanned: changes.scanned,
          scanTruncated: changes.scanTruncated,
          omitted: changes.omitted,
        };
        return [
          {
            type: EventType.CUSTOM,
            name: TURN_ARTIFACTS_EVENT,
            value,
          } as BaseEvent,
        ];
      };
      try {
        // 整个等待限时：mark 挂着或查询挂着，都不能拖住 RUN_FINISHED。
        return await Promise.race([work(), late]);
      } catch (error) {
        if (!abort.signal.aborted)
          warn("turnChanges", turn.runId, turn.botId, error);
        return [];
      } finally {
        clearTimeout(timer);
      }
    };

    const track = (event: BaseEvent) => {
      const id = (event as unknown as { toolCallId?: unknown }).toolCallId;
      if (typeof id !== "string") return;
      if (event.type === EventType.TOOL_CALL_START) unanswered.add(id);
      else if (event.type === EventType.TOOL_CALL_RESULT) unanswered.delete(id);
    };
    const subscribeInside = () =>
      stream
        .pipe(
          concatMap((event) => {
            track(event);
            if (event.type !== EventType.RUN_FINISHED) return of(event);
            // 这个 run 停在待执行的工具调用上：页面执行完会再发一个 run，这一轮在那里结束。
            if (carry && !turn.wholeTurn && unanswered.size > 0)
              return of(event);
            return defer(async () => {
              const events = await artifactsBefore();
              if (carry && carried.get(carry.key)?.markId === markId)
                carried.delete(carry.key);
              return [...events, event];
            }).pipe(concatMap((events) => from(events)));
          }),
        )
        .subscribe(subscriber);
    const subscription = turn.wholeTurn
      ? wholeTurnOf.run(turn.runId, subscribeInside)
      : subscribeInside();
    return () => {
      abort.abort();
      subscription.unsubscribe();
    };
  });
}

type TurnArtifactsWiring = {
  gateway: TurnArtifactsGateway;
  /** 这个人用这位员工时的电脑座位；这位员工不能用电脑、或在设备上，答 null。 */
  seatOf: (botId: string, personId: string) => Promise<ComputerSeat | null>;
};

let wiring: TurnArtifactsWiring | undefined;

/** 启动时接上网关与取座位的函数；不接（没有电脑的部署）则每一轮原样通过。 */
export function configureTurnArtifacts(next: TurnArtifactsWiring | undefined) {
  wiring = next;
}

/**
 * 内置员工每一轮的流，加上首尾记产物。单聊、群聊、看板卡、例行任务都从这里过（`copilot.ts` 的 `observe`）。
 * `personId` 是这一轮的人，由调用处在运行开始时取（流结束时请求上下文可能已经没了）。
 */
export function withConfiguredTurnArtifacts(
  stream: Observable<BaseEvent>,
  turn: {
    runId: string;
    botId: string;
    personId: string | null;
    /** 对话号，和 `continues` 一起让一轮跨几个 run（浏览器自己执行电脑工具的单聊）时保住标记。 */
    threadId?: string;
    /** 这个 run 接着上一个 run 的那一轮：最后一条消息不是人说的话。 */
    continues?: boolean;
    /** 这条流是完整的一轮，里面各段的观察让位给它。 */
    wholeTurn?: boolean;
  },
): Observable<BaseEvent> {
  const current = wiring;
  const { personId } = turn;
  if (!current || !personId) return stream;
  if (!turn.wholeTurn && wholeTurnOf.getStore() === turn.runId) return stream;
  return withTurnArtifacts(
    stream,
    {
      runId: turn.runId,
      botId: turn.botId,
      seat: () => current.seatOf(turn.botId, personId),
      ...(turn.wholeTurn ? { wholeTurn: true } : {}),
      ...(turn.threadId !== undefined
        ? {
            carry: {
              key: `${personId}\u0000${turn.botId}\u0000${turn.threadId}`,
              continues: turn.continues === true,
            },
          }
        : {}),
    },
    current.gateway,
  );
}

/**
 * A built-in employee's run stream as the server sends it on: the agent's own stream cleaned of events
 * only the server may send and open to the events its tools add (`withRunSideEvents`), and then, outside
 * both, the turn's artifacts. The order matters: the artifacts event is the server's own and would be
 * dropped as a forgery if it passed through the cleaning, and one the agent's stream carried must not
 * survive it.
 *
 * One consequence of the order: the side-events stream ends with the agent's own stream, and the
 * artifacts wait (and with it RUN_FINISHED) comes after that. In that gap the run is no longer open to
 * `emitRunEvent`, which then returns false and the caller takes the fallback it already has for a run
 * that is not open; the same as for a tool that finishes after the run's stream has ended.
 */
export function withSideEventsThenArtifacts(
  stream: Observable<BaseEvent>,
  turn: Parameters<typeof withConfiguredTurnArtifacts>[1],
): Observable<BaseEvent> {
  return withConfiguredTurnArtifacts(
    withRunSideEvents(turn.runId, stream),
    turn,
  );
}

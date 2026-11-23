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
};

type TurnArtifactsGateway = Pick<ComputerGateway, "markTurn" | "turnChanges">;

/** 轮末等电脑列出文件最多等多久；超了就不列，这一轮照常结束。 */
export const TURN_ARTIFACTS_DEADLINE_MS = 15_000;

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
    // 同一个电脑可能被好几个座位共用，快照名必须全局唯一。
    const markId = `${turn.runId}:${turn.botId}`;
    /** 订阅时后台记快照，不挡第一个事件；成功答座位，失败或没有座位答 null。 */
    const marked: Promise<ComputerSeat | null> = (async () => {
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

    const subscription = stream
      .pipe(
        concatMap((event) =>
          event.type === EventType.RUN_FINISHED
            ? defer(async () => [...(await artifactsBefore()), event]).pipe(
                concatMap((events) => from(events)),
              )
            : of(event),
        ),
      )
      .subscribe(subscriber);
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
  turn: { runId: string; botId: string; personId: string | null },
): Observable<BaseEvent> {
  const current = wiring;
  const { personId } = turn;
  if (!current || !personId) return stream;
  return withTurnArtifacts(
    stream,
    {
      runId: turn.runId,
      botId: turn.botId,
      seat: () => current.seatOf(turn.botId, personId),
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
 */
export function withSideEventsThenArtifacts(
  stream: Observable<BaseEvent>,
  turn: { runId: string; botId: string; personId: string | null },
): Observable<BaseEvent> {
  return withConfiguredTurnArtifacts(
    withRunSideEvents(turn.runId, stream),
    turn,
  );
}

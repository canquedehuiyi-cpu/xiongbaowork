import { AsyncLocalStorage } from "node:async_hooks";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { concat, defer, EMPTY, from, Observable, of, throwError } from "rxjs";
import { catchError, concatMap } from "rxjs/operators";
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
 * 以 `RUN_ERROR` 收尾、流报错、流没有终止事件就结束（时限到点被停的轮，内层不发终止事件）的轮同样比对：
 * 文件已经写在电脑上，对话里没有清单就下载不到，用户再说「继续」是新一轮，补不回来。清单插在 `RUN_ERROR` 前，
 * `RUN_ERROR` 照常往后传。
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
   * 这条流本身就是一整轮里服务器执行的部分（服务器分段执行工具，段与段之间的工具在流外跑），
   * 流里面各段的观察由它代劳，见 `wholeTurnOf`。它同样可以带 `carry`：服务器执行电脑工具的单聊里，页面工具
   * 会让一轮跨几个 run。不带 `carry`（无人值守轮）则 `RUN_FINISHED` 一定是这一轮的结尾。
   */
  wholeTurn?: boolean;
};

type TurnArtifactsGateway = Pick<ComputerGateway, "markTurn" | "turnChanges"> &
  Partial<Pick<ComputerGateway, "forgetTurn">>;

const DELIVERED_EVENT = "delivery.delivered";

/** 轮末等电脑列出文件最多等多久；超了就不列，这一轮照常结束。 */
export const TURN_ARTIFACTS_DEADLINE_MS = 15_000;

/**
 * 跨 run 的标记：key 是（人、员工、对话），值是这一轮第一个 run 登记的快照标记和它的座位。
 * 只存在内存里，和网关里的标记同寿；超出上限丢最旧的。
 *
 * 丢下的轮（页面关了、出错、停在页面不会续跑的工具调用上）留在这里的标记不会自己消失：被同一对话的新一轮
 * 替换、被淘汰时，对应的网关标记一并忘掉，否则电脑下次被用到时要把它们一个个都记一遍快照，挤占这一轮
 * 自己的标记。过了 {@link CARRIED_TTL_MS} 的条目是惰性处理的：只在同一对话的下一个 run 到来时才被发现、
 * 当作新一轮并忘掉；对话不再有 run，它就留到被淘汰。
 */
const CARRIED_MAX = 500;
/**
 * 一轮的标记从最后一次推迟起最多留多久。人迟迟不答的页面工具会把时间窗拉长，窗内别人在同一台电脑上的
 * 改动也会被列进来；同一对话下一个 run 到来时发现超时的，当新一轮。
 */
export const CARRIED_TTL_MS = 30 * 60_000;
type Carried = {
  markId: string;
  marked: Promise<ComputerSeat | null>;
  at: number;
  forget: () => void;
};
const carried = new Map<string, Carried>();

function carryOver(key: string, entry: Carried) {
  carried.get(key)?.forget();
  carried.delete(key);
  carried.set(key, entry);
  while (carried.size > CARRIED_MAX) {
    const oldest = carried.entries().next().value;
    if (oldest === undefined) break;
    oldest[1].forget();
    carried.delete(oldest[0]);
  }
}

/**
 * 这个 run 是不是接着上一个 run 的那一轮：最后一条消息是工具的结果，或是一条还没人答复的工具调用。
 * 人说的话之后再追加的系统、助手文字不算续跑。
 */
export function continuesTurn(
  messages: readonly { role: string; toolCalls?: unknown }[],
): boolean {
  const last = messages.at(-1);
  if (!last) return false;
  if (last.role === "tool") return true;
  return (
    last.role === "assistant" &&
    Array.isArray(last.toolCalls) &&
    last.toolCalls.length > 0
  );
}

/** 终止事件是不是服务器自己接着办的等待（审批、提问、登录）：不经过页面，不会有页面续跑的 run。 */
function waitsOnServer(event: BaseEvent): boolean {
  const outcome = (event as unknown as { outcome?: unknown }).outcome as
    | {
        type?: unknown;
        interrupts?: { reason?: unknown }[];
      }
    | undefined;
  return (
    outcome?.type === "interrupt" &&
    // The server raises these with the reason "human_input" (the headless tools and the native approval).
    (outcome.interrupts ?? []).some(
      (interrupt) => interrupt.reason === "human_input",
    )
  );
}

/**
 * 整轮已经由外层的 `wholeTurn` 流观察时，里面每一段的观察要让位：段与段之间用同一个 `markId` 去
 * 记、去比对，会把外层的标记冲掉。按 run 号加员工认（`runId\0botId`），同一个 run 里同一位员工的各段才让位，
 * 别的 run、同一个 run 里别的员工仍各自观察。
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
    const known = carry ? carried.get(carry.key) : undefined;
    const earlier =
      carry?.continues && known && Date.now() - known.at < CARRIED_TTL_MS
        ? known
        : undefined;
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
    if (carry && !earlier)
      carryOver(carry.key, {
        markId,
        marked,
        at: Date.now(),
        forget: () => {
          void marked
            .then((seat) => seat && gateway.forgetTurn?.(seat, markId))
            .catch(() => undefined);
        },
      });
    /** 这个 run 里开了头、还没有结果的工具调用：留到下一个 run 才有结果的，这一轮还没完。 */
    const unanswered = new Set<string>();
    /** 这个 run 里本员工交了付：交付卡按这个 run 下载，清单必须在这个 run 上。 */
    let delivered = false;

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
      const named = event as unknown as {
        name?: unknown;
        value?: { agentId?: unknown };
      };
      if (
        event.type === EventType.CUSTOM &&
        named.name === DELIVERED_EVENT &&
        named.value?.agentId === turn.botId
      )
        delivered = true;
      const id = (event as unknown as { toolCallId?: unknown }).toolCallId;
      if (typeof id !== "string") return;
      if (event.type === EventType.TOOL_CALL_START) unanswered.add(id);
      else if (event.type === EventType.TOOL_CALL_RESULT) unanswered.delete(id);
    };
    /** 这一轮在这里结束了：比对，清掉跨 run 的标记，答要发的事件。 */
    const settle = async (): Promise<BaseEvent[]> => {
      const events = await artifactsBefore();
      if (carry && carried.get(carry.key)?.markId === markId)
        carried.delete(carry.key);
      return events;
    };
    /** 流已经给过终止事件（`RUN_FINISHED`，或已在 `RUN_ERROR` 上比对过）。 */
    let ended = false;
    const subscribeInside = () =>
      concat(
        stream.pipe(
          concatMap((event) => {
            track(event);
            if (event.type === EventType.RUN_ERROR) {
              // 出错的轮不会有页面续跑的 run，不推迟：文件已经在电脑上了。
              ended = true;
              return defer(settle).pipe(
                concatMap((events) => from([...events, event])),
              );
            }
            if (event.type !== EventType.RUN_FINISHED) return of(event);
            ended = true;
            /*
             * 这个 run 停在待执行的工具调用上：页面执行完会再发一个 run，这一轮在那里结束。服务器执行过的工具
             * 都有结果事件，剩下没答复的就是页面要执行的调用。服务器自己接着办的等待（审批）不会有页面续跑，
             * 当场比对。本员工在这个 run 里交了付也当场比对：交付卡下载只认交付所在的 run，等下一个 run
             * 就晚了，页面工具一直没人答时整轮更是永远没有清单。
             */
            if (
              carry &&
              unanswered.size > 0 &&
              !delivered &&
              !waitsOnServer(event)
            ) {
              // 又推迟了一次：时限从这一次起算，一轮在被等待时不会过期。
              const own = carried.get(carry.key);
              if (own?.markId === markId) own.at = Date.now();
              return of(event);
            }
            return defer(settle).pipe(
              concatMap((events) => from([...events, event])),
            );
          }),
          // 流报错（被时限停掉后下层抛出的「没答完就结束了」）：先列清单，错误照常往后传。
          catchError((error) =>
            ended
              ? throwError(() => error)
              : concat(
                  defer(settle).pipe(concatMap((events) => from(events))),
                  throwError(() => error),
                ),
          ),
        ),
        // 流没有终止事件就结束了：内层被时限 abort 时只是完成，不发 RUN_FINISHED。
        defer(() =>
          ended
            ? EMPTY
            : defer(settle).pipe(concatMap((events) => from(events))),
        ),
      ).subscribe(subscriber);
    const subscription = turn.wholeTurn
      ? wholeTurnOf.run(`${turn.runId}\u0000${turn.botId}`, subscribeInside)
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
  if (
    !turn.wholeTurn &&
    wholeTurnOf.getStore() === `${turn.runId}\u0000${turn.botId}`
  )
    return stream;
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

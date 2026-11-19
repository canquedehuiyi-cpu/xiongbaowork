import { EventType } from "@ag-ui/core";
import {
  INTERRUPTED_NOTICE,
  SEGMENTS_NOTICE,
  TURN_INTERRUPTED_EVENT,
  TURN_LIMIT_EVENT,
  TURN_TIME_LIMIT_MINUTES,
  type TurnLimitReason,
  timeUpNotice,
} from "../../../../shared/turn-notices";

/*
 * 一轮没做完就停下的三种情形（期九·四）：到点（`turn-limit` time）、工具轮数用完（`turn-limit` segments）、
 * 进程中途没了（`turn-interrupted`）。服务器在这一轮自己的事件流里、`RUN_FINISHED` 之前放一条 `CUSTOM`，
 * 并写一句中文说明；对话就在回答末尾给一行「…… · 继续」，样子和期一的「已用完 N 步 · 继续」一样。
 *
 * 只认**最后一轮**：新一轮的 `RUN_STARTED` 一来就清掉，所以回放到最后只剩最后一轮的。事件之外还认那句说明：
 * 对话是从存下的消息里恢复的、事件没有重放时，最后一条回答就是那句话，同样给「继续」。
 *
 * 按下「继续」后（`dismiss`）这一行马上收起；那一轮没发出去时 `undismiss` 放回来，前提是这中间没开过新的一轮。
 */

/** 停在哪一种情形：到点、轮数用完、被打断。 */
export type TurnStop = TurnLimitReason | "interrupted";

/** 这一行写什么：到点时写清是几分钟，不是笼统的「超时」。 */
export function turnStopWords(stop: TurnStop): string {
  switch (stop) {
    case "time":
      return `到 ${TURN_TIME_LIMIT_MINUTES} 分钟了`;
    case "segments":
      return "步数用完了";
    case "interrupted":
      return "这一轮被打断了";
  }
}

/** 事件里的情形；名字不对、形状不对的不认。 */
export function readTurnStop(name: unknown, value: unknown): TurnStop | null {
  if (name === TURN_INTERRUPTED_EVENT) return "interrupted";
  if (name !== TURN_LIMIT_EVENT || !value || typeof value !== "object")
    return null;
  const reason = (value as { reason?: unknown }).reason;
  return reason === "time" || reason === "segments" ? reason : null;
}

/** 最后一条回答是不是服务器写的那句说明；是就说出停在哪一种情形。 */
export function turnStopOfText(text: unknown): TurnStop | null {
  if (typeof text !== "string") return null;
  const said = text.trim();
  if (said === INTERRUPTED_NOTICE) return "interrupted";
  if (said === SEGMENTS_NOTICE) return "segments";
  // 到点那句带着这一轮跑的分钟数，部署改了时限也照样认。
  const minutes = /^这一轮已经跑满 (\d+) 分钟，/.exec(said)?.[1];
  return minutes !== undefined && said === timeUpNotice(Number(minutes))
    ? "time"
    : null;
}

type Event = {
  type?: unknown;
  name?: unknown;
  value?: unknown;
};
type SaidMessage = { id?: unknown; role?: unknown; content?: unknown };

/** 代理订阅者里用到的两样（见 `run-stage.ts` 为什么不引 `@ag-ui/client`）。 */
type AgentSubscriber = {
  onRunStartedEvent?: (params: { event: Event }) => void;
  onCustomEvent?: (params: { event: Event }) => void;
};

/** 收起时记下的：停在哪、开过几轮。 */
export type TurnStopToken = { stop: TurnStop; runs: number };

export type TurnStopTracker = {
  /** 交给 `agent.subscribe`：要在 `connect` 开始之前订阅，回放的历史才听得到。 */
  subscriber: AgentSubscriber;
  /** 最后一轮停在哪；没停、或已经按过「继续」时为 null。 */
  stop(): TurnStop | null;
  /** 喂一个事件：订阅收到的、测试造的都走这里。 */
  feed(event: Event): void;
  /**
   * 对话里现在的消息：事件没来、最后一条回答就是那句说明时，也认。只在这一行还没收起、
   * 也没有事件说过话的时候认，所以事件和说明不会各记一次。
   */
  sync(messages: readonly SaidMessage[]): void;
  /** 按下「继续」：收起这一行，给回一个放回去用的记号。 */
  dismiss(): TurnStopToken | null;
  /** 「继续」没发出去：这中间没开过新的一轮，就把那一行放回来。 */
  undismiss(token: TurnStopToken | null): void;
  listen(listener: () => void): () => void;
};

export function createTurnStopTracker(): TurnStopTracker {
  let stop: TurnStop | null = null;
  /** 开过几轮：`undismiss` 靠它认出「这中间有没有新的一轮」。 */
  let runs = 0;
  /** 在第几轮按的「继续」：这一轮的说明不再从消息里认回来，新一轮开了才重新认。 */
  let dismissedAt: number | null = null;
  /** 现在认的这一条是不是从最后一条消息认出来的（事件认的不是）。 */
  let fromMessage = false;
  const listeners = new Set<() => void>();
  const set = (next: TurnStop | null) => {
    if (next === stop) return;
    stop = next;
    for (const listener of listeners) listener();
  };

  const feed = (event: Event) => {
    if (event.type === EventType.RUN_STARTED) {
      runs += 1;
      fromMessage = false;
      set(null);
      return;
    }
    if (event.type !== EventType.CUSTOM) return;
    const found = readTurnStop(event.name, event.value);
    if (found !== null) {
      fromMessage = false;
      set(found);
    }
  };

  return {
    subscriber: {
      onRunStartedEvent: ({ event }) => feed(event),
      onCustomEvent: ({ event }) => feed(event),
    },
    stop: () => stop,
    feed,
    sync(messages) {
      const last = messages.at(-1);
      const found =
        last?.role === "assistant" ? turnStopOfText(last.content) : null;
      if (found === null) {
        // 说明不再是最后一条（人又说了话、新一轮开始了）：从说明认出来的那一行跟着收起。
        if (fromMessage) {
          fromMessage = false;
          set(null);
        }
        return;
      }
      if (stop !== null || dismissedAt === runs) return;
      fromMessage = true;
      set(found);
    },
    dismiss() {
      if (stop === null) return null;
      const token = { stop, runs };
      dismissedAt = runs;
      set(null);
      return token;
    },
    undismiss(token) {
      if (token !== null && token.runs === runs && stop === null) {
        dismissedAt = null;
        set(token.stop);
      }
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

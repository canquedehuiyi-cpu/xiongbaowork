import { EventType } from "@ag-ui/core";
import {
  STEP_LIMIT_EVENT,
  type StepLimitPayload,
} from "../../../../shared/step-limit";

/*
 * 员工这一轮跑满了步数、被强制收尾（期一）：服务器在这一轮的事件流里、`RUN_FINISHED` 之前放一条
 * `CUSTOM step-limit {steps}`（`shared/run-notices.ts`），对话就在回答末尾给一行「已用完 N 步 · 继续」。
 *
 * 只认**最后一轮**。这条事件随这一轮存进线程的事件里，连上对话时和别的轮一起回放，所以旧轮里的那一条
 * 一直都在；新一轮的 `RUN_STARTED` 一来就把记下的步数清掉，回放到最后剩下的就是最后一轮的。实时的一轮、
 * `connect` 回放的历史走同一个订阅（和交付卡、阶段进度一样），所以要在连上对话之前订阅。
 *
 * 按下「继续」后（`dismiss`）这一行马上收起；那一轮没发出去（员工还在忙、断了）时 `undismiss` 放回来，
 * 前提是这中间没开过新的一轮。
 */

/** 按「继续」发出去的那句话：以你的身份说的，员工读到就接着干。 */
export const CONTINUE_TEXT = "继续";

/** 事件里的步数；形状不对（不是正整数）的不认。 */
export function readStepLimit(name: unknown, value: unknown): number | null {
  if (name !== STEP_LIMIT_EVENT || !value || typeof value !== "object")
    return null;
  const steps = (value as Partial<StepLimitPayload>).steps;
  return typeof steps === "number" && Number.isInteger(steps) && steps > 0
    ? steps
    : null;
}

type StepLimitEvent = { type?: unknown; name?: unknown; value?: unknown };

/** 代理订阅者里用到的两样（见 `run-stage.ts` 为什么不引 `@ag-ui/client`）。 */
type AgentSubscriber = {
  onRunStartedEvent?: (params: { event: StepLimitEvent }) => void;
  onCustomEvent?: (params: { event: StepLimitEvent }) => void;
};

export type StepLimitTracker = {
  /** 交给 `agent.subscribe`：要在 `connect` 开始之前订阅，回放的历史才听得到。 */
  subscriber: AgentSubscriber;
  /** 最后一轮用完的步数；最后一轮没触顶、或已经按过「继续」时为 null。 */
  steps(): number | null;
  /** 喂一个事件：订阅收到的、测试造的都走这里。 */
  feed(event: StepLimitEvent): void;
  /** 按下「继续」：收起这一行，给回一个放回去用的记号。 */
  dismiss(): { steps: number; runs: number } | null;
  /** 「继续」没发出去：这中间没开过新的一轮，就把那一行放回来。 */
  undismiss(token: { steps: number; runs: number } | null): void;
  listen(listener: () => void): () => void;
};

export function createStepLimitTracker(): StepLimitTracker {
  let steps: number | null = null;
  /** 开过几轮：`undismiss` 靠它认出「这中间有没有新的一轮」。 */
  let runs = 0;
  const listeners = new Set<() => void>();
  const set = (next: number | null) => {
    if (next === steps) return;
    steps = next;
    for (const listener of listeners) listener();
  };

  const feed = (event: StepLimitEvent) => {
    if (event.type === EventType.RUN_STARTED) {
      runs += 1;
      set(null);
      return;
    }
    if (event.type !== EventType.CUSTOM) return;
    const found = readStepLimit(event.name, event.value);
    if (found !== null) set(found);
  };

  return {
    subscriber: {
      onRunStartedEvent: ({ event }) => feed(event),
      onCustomEvent: ({ event }) => feed(event),
    },
    steps: () => steps,
    feed,
    dismiss() {
      if (steps === null) return null;
      const token = { steps, runs };
      set(null);
      return token;
    },
    undismiss(token) {
      if (token !== null && token.runs === runs && steps === null)
        set(token.steps);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * 按下「继续」：这一行马上收起，以你的身份发出 {@link CONTINUE_TEXT}（`send` 是对话里发消息的那一个函数）。
 * 没发出去时把那一行放回来；发出去以后这一轮自己失败了，对话底下有它自己的那一行，不再放回。
 */
export async function continueAfterStepLimit(
  tracker: StepLimitTracker,
  send: (text: string) => Promise<unknown>,
): Promise<void> {
  const token = tracker.dismiss();
  if (token === null) return;
  try {
    await send(CONTINUE_TEXT);
  } catch {
    tracker.undismiss(token);
  }
}

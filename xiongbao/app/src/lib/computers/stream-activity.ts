import { EventType } from "@ag-ui/core";
import {
  reportComputerActivity,
  withdrawComputerActivity,
} from "@/lib/copilot/computer-activity";

/*
 * 实时画面按流里的工具事件自动弹出（期九·四）。
 *
 * 以前是页面替服务器转发每一次电脑调用，转发之前报一声「电脑在动」（`computers/call.ts`），画面面板就弹出来。
 * 服务器自己执行之后页面不再转发，没有那一声了；换成听这一轮的事件流：`computer_*` 工具开始（`TOOL_CALL_START`）
 * 就报同样的一声，面板按它原来的规矩弹（一轮弹一次、人关掉的这一轮不再弹，见 `use-auto-watch-screen.ts`）。
 *
 * 和以前一样的两条：
 *  - 不上屏的调用不报：读文件、写文件、跑命令发生在电脑里、不在屏幕上，为它们弹出一块没有变化的画面，和无缘无故
 *    弹出来分不出来。这是一份「例外清单」而不是「许可清单」，将来加的浏览器工具忘了写进来，结果是多弹一次，
 *    不是悄悄不弹；
 *  - 被拦下的调用收回：结果说它被策略、开关或网络规则拒绝了（`refused`），它没碰过屏幕，开出来的面板跟着收起。
 *
 * 回放不报。重新打开对话时，历史里每一次调用都会经过这里，一个个都弹一遍面板是荒唐的。页面说「回放完了」
 * （`live`）之后再开始的调用才算；回放结束时还有没答完的屏幕调用，说明这一轮正在跑，补报一声。
 */

/** 发生在电脑里、不在屏幕上的工具：不为它们弹出画面。 */
const OFF_SCREEN_TOOLS = new Set([
  "computer_list_files",
  "computer_read_file",
  "computer_write_file",
  "computer_edit_file",
  "computer_grep",
  "computer_glob",
  "computer_run_command",
]);

/** 这个工具开始时要不要弹出画面。 */
export function opensScreen(toolName: unknown): boolean {
  return (
    typeof toolName === "string" &&
    toolName.startsWith("computer_") &&
    !OFF_SCREEN_TOOLS.has(toolName)
  );
}

type StreamEvent = {
  type?: unknown;
  toolCallId?: unknown;
  toolCallName?: unknown;
  content?: unknown;
};

/** 代理订阅者里用到的两样（见 `run-stage.ts` 为什么不引 `@ag-ui/client`）。 */
type AgentSubscriber = {
  onToolCallStartEvent?: (params: { event: StreamEvent }) => void;
  onToolCallResultEvent?: (params: { event: StreamEvent }) => void;
};

export type StreamActivity = {
  /** 交给 `agent.subscribe`：要在 `connect` 开始之前订阅，回放的历史才经过这里（并被当作回放）。 */
  subscriber: AgentSubscriber;
  /** 喂一个事件：订阅收到的、测试造的都走这里。 */
  feed(event: StreamEvent): void;
  /** 页面说回放完了（或这一轮是自己发的）：之后的调用才算正在发生。 */
  live(): void;
};

/** 这一声的接收方，默认是页面共用的那一个；测试换成自己的。 */
type Announcer = {
  announce(botId: string): number;
  withdraw(botId: string, announcement: number): void;
};

const shared: Announcer = {
  announce: reportComputerActivity,
  withdraw: withdrawComputerActivity,
};

/** 一个结果是不是在说「被拒绝了」：服务器的拒绝带 `refused: true`。读不出来就当没拒绝。 */
function refusedBy(content: unknown): boolean {
  if (typeof content !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      (parsed as { refused?: unknown }).refused === true
    );
  } catch {
    return false;
  }
}

export function createStreamActivity(
  botId: string,
  announcer: Announcer = shared,
  /** 一开始就算正在发生：这一轮是自己发的，没有回放。 */
  startLive = false,
): StreamActivity {
  let isLive = startLive;
  /** 开着还没答的屏幕调用，和它们各自报的那一声（回放里的没报过就是 null）。 */
  const open = new Map<string, number | null>();

  const feed = (event: StreamEvent) => {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : null;
    if (id === null) return;
    if (event.type === EventType.TOOL_CALL_START) {
      if (!opensScreen(event.toolCallName)) return;
      open.set(id, isLive ? announcer.announce(botId) : null);
      return;
    }
    if (event.type === EventType.TOOL_CALL_RESULT) {
      const announced = open.get(id);
      open.delete(id);
      if (typeof announced === "number" && refusedBy(event.content))
        announcer.withdraw(botId, announced);
    }
  };

  return {
    subscriber: {
      onToolCallStartEvent: ({ event }) => feed(event),
      onToolCallResultEvent: ({ event }) => feed(event),
    },
    feed,
    live() {
      if (isLive) return;
      isLive = true;
      // 回放结束时还开着的调用：这一轮正在跑，说一声就够，不为每一个都说。
      const waiting = [...open].filter(([, announced]) => announced === null);
      const [first] = waiting;
      if (first === undefined) return;
      open.set(first[0], announcer.announce(botId));
    },
  };
}

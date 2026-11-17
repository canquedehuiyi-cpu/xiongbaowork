import { EventType } from "@ag-ui/core";

/*
 * 内置员工这一轮走到哪一段（阶段进度）。
 *
 * 2026-11-18 的口径改过一次：原先合同是「服务器在这一轮自己的事件流里补一条 `CUSTOM run.stage`」，写那条线的
 * 是 `server/src/threads/run-side-events.ts` 的 `withRunStages`。它一直没接线，因为接上就撞 main 里三条既有
 * 断言——它们把「一轮的 CUSTOM 事件」按名／按条数配平（`delivery-tools.integration.test.ts:566`、
 * `compaction.integration.test.ts:1149`、`acp-agent.test.ts:393`，合计 12 处用例），服务端已按裁决把那半摘掉，
 * 这个文件里也不再留 `run.stage` 这个名字（没有发射方的事件名留着只会让人以为流上会有它）。
 *
 * 现在这一段是从这一轮本来就有的事件里推出来的，四条边界都真在这条通道上：`RUN_STARTED`＝开始等模型（工具答
 * 完、结果交回模型时也是它），`TOOL_CALL_START`＝执行工具，`TEXT_MESSAGE_START`＝输出回答，工具结果全部回来＝
 * 又回到模型手上。「读上下文」不算一段——这一侧没有任何事件说得出提示词何时拼好，为它加一拍就成了心跳。事件名
 * 用 `@ag-ui/core` 的 `EventType`，不自己拼字符串；同一件事在 `shared/delivery-anchor.ts` 也是按这几个边界看的。
 *
 * 推的方式和听一条事件是一样的：实时的一轮、`connect` 重放的历史、半路接上的流都走这一个入口，所以不需要这里
 * 再猜。半路接上时先看到的换段事件（还没等到 `RUN_STARTED`）先搁着，等这一轮的 `RUN_STARTED` 认领而不丢掉——
 * 那一轮最该说的一句就是它当下在做什么。
 *
 * 这里只记「现在这一轮在哪一段」，不是一张 `runId → stage` 的表：一轮收尾（`RUN_FINISHED`／`RUN_ERROR`）就把
 * 记的段清空，免得下一轮开头还挂着上一轮的「正在执行工具」。
 *
 * 推不出段的时候——这轮之前的旧存档、没走这条流的通道——`stage()` 一直是 null，对话照旧画「思考中」／
 * 「<员工名> 正在输入」，不会因为这里没东西而空出一格。
 */

/** 一轮的哪一段。今天是 app 内部的说法：服务端不再报阶段事件，改这一份不必再去改别处。 */
export type RunStage = "model" | "tool" | "answer";

/**
 * 要说新话的段。「调用模型」这一件事实，这一格一直用「思考中」／「<员工名> 正在输入」说着，换段时不说
 * 两句；只有工具与回答是这一轮之前说不出来的。认不出的段不画，宁缺。
 */
const STAGE_WORDS: Partial<Record<RunStage, string>> = {
  tool: "正在执行工具",
  answer: "正在输出回答",
};

/** 这一段该说的话；没有新话可说（模型段）或认不出时给 undefined，画的人回落既有口径。 */
export function stageWords(
  stage: RunStage | null | undefined,
): string | undefined {
  if (stage === null || stage === undefined) return undefined;
  return STAGE_WORDS[stage];
}

/**
 * 推段只看这两样：事件的类型名，和工具调用那两样带的调用号（`TOOL_CALL_START`／`TOOL_CALL_RESULT` 才有）。
 * 读不出来的就当没有：类型不是字符串不认，工具事件没给号就不计数（宁可少一句，不误算在飞的那一步）。
 */
type StageEvent = { type?: unknown; toolCallId?: unknown };

/**
 * 代理订阅者里用到的几样（`agent.subscribe` 收的对象的一部分，见 `@ag-ui/client` 的 `AgentSubscriber`）。
 * 只写这几样，免得为了一个类型把 `@ag-ui/client` 拉进 app 的依赖里（它没这个包，只有 `@ag-ui/core`）。
 */
type AgentSubscriber = {
  onRunStartedEvent?: (params: { event: StageEvent }) => void;
  onToolCallStartEvent?: (params: { event: StageEvent }) => void;
  onToolCallResultEvent?: (params: { event: StageEvent }) => void;
  onTextMessageStartEvent?: (params: { event: StageEvent }) => void;
  onRunFinishedEvent?: (params: { event: StageEvent }) => void;
  onRunErrorEvent?: (params: { event: StageEvent }) => void;
};

export type RunStageTracker = {
  /** 交给 `agent.subscribe`：要在 `connect` 开始之前订阅，重放的历史才听得到。 */
  subscriber: AgentSubscriber;
  /** 现在这一轮在哪一段；推不出段时为 null。给 `useSyncExternalStore` 用，是个原始值。 */
  stage(): RunStage | null;
  /**
   * 这一轮说到第几条阶段了，从 1 起；换段才加，同一段再遇到不加，一轮收尾归 0。留着是为了对账：
   * 屏幕上说话的还是 `stage()`，这一条不驱动任何文案。
   */
  seq(): number;
  /** 段变了时通知（`useSyncExternalStore`）。 */
  listen(listener: () => void): () => void;
  /** 喂一个事件：`subscriber` 收到的、测试造的、重放补的都走这里，只有一条推法。 */
  feed(event: StageEvent): void;
  /** 一轮开始了（`RUN_STARTED`）：搁着的那一段归它，之后的换段直接改现在的。 */
  started(): void;
  /** 一轮收尾（正常或出错）：这一段跟着结束，在飞的工具调用一并忘掉，不带给下一轮。 */
  ended(): void;
};

/** 工具事件上的调用号；读不出就是 null（不计、也不删）。 */
const callIdOf = (event: StageEvent): string | null =>
  typeof event.toolCallId === "string" && event.toolCallId
    ? event.toolCallId
    : null;

export function createRunStageTracker(): RunStageTracker {
  /** 有没有一轮正在跑（`RUN_STARTED` 到收尾之间）。 */
  let open = false;
  /** 正在跑的这一轮在哪一段。 */
  let current: RunStage | null = null;
  /** 还没等到 `RUN_STARTED` 的那一段（半路接上的流），等这一轮认领。 */
  let pending: RunStage | null = null;
  /** 这一轮说到第几条段了；一轮收尾归 0。 */
  let marks = 0;
  /** 开了还没答完的工具调用号：空了才算回到模型手上。 */
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  /** 换段才说一句：同一段再遇到（哪怕又开了一个工具调用）不加条数、也不重画。 */
  const mark = (stage: RunStage) => {
    if (stage === current || (!open && pending === stage)) return;
    marks = open ? marks + 1 : 1;
    if (open) current = stage;
    else pending = stage;
    notify();
  };

  const started = () => {
    open = true;
    if (pending !== null) {
      // 半路接上的流：先看到的那一段就是这一轮的第一句，条数按一条算。
      current = pending;
      pending = null;
      marks = 1;
      notify();
      return;
    }
    marks = 0;
    mark("model");
  };

  const ended = () => {
    if (!open && current === null && pending === null) return;
    open = false;
    current = null;
    pending = null;
    marks = 0;
    inFlight.clear();
    notify();
  };

  const feed = (event: StageEvent) => {
    switch (event.type) {
      case EventType.RUN_STARTED:
        started();
        return;
      case EventType.TOOL_CALL_START: {
        const id = callIdOf(event);
        if (id !== null) inFlight.add(id);
        mark("tool");
        return;
      }
      case EventType.TOOL_CALL_RESULT: {
        const id = callIdOf(event);
        if (id !== null) inFlight.delete(id);
        // 还开着别的调用：这一轮仍在执行工具，不许落回模型。全答完了才交回模型手上。
        if (inFlight.size === 0) mark("model");
        return;
      }
      case EventType.TEXT_MESSAGE_START:
        mark("answer");
        return;
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        ended();
        return;
      // 消息内容、工具参数、状态事件、别家的 CUSTOM：一概不改这一段。
      default:
        return;
    }
  };

  return {
    subscriber: {
      onRunStartedEvent: ({ event }) => feed(event),
      onToolCallStartEvent: ({ event }) => feed(event),
      onToolCallResultEvent: ({ event }) => feed(event),
      onTextMessageStartEvent: ({ event }) => feed(event),
      onRunFinishedEvent: ({ event }) => feed(event),
      onRunErrorEvent: ({ event }) => feed(event),
    },
    stage: () => current,
    seq: () => marks,
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    feed,
    started,
    ended,
  };
}

/*
 * 内置员工这一轮走到哪一段（阶段进度）。
 *
 * 一轮的阶段边界有一种说法：服务器把它标成 `CUSTOM run.stage`，值 `{stage, seq}`，跟着这一轮自己的事件流
 * 说：`RUN_STARTED` 之后标「调用模型」，其后每次换段在它开始的那个事件前标一次。写这条线的人是
 * `server/src/threads/run-side-events.ts` 的 `withRunStages`；它现在还没接进任何一条流（接法与挡在前面的
 * 东西写在那个文件顶部），所以这一段今天是空的——下面的读法照合同写，接上就生效，这里不用再改。
 *
 * 标在事件流里，是为了实时的一轮、存进线程的一轮、重进对话时重放的一轮读到同一条事实，不需要这里再猜。
 *
 * 这里只记「现在这一轮在哪一段」，不是一张 `runId → stage` 的表：一轮结束（正常收尾或出错）就把它记的段
 * 清空，免得下一轮开头还挂着上一轮的「正在执行工具」。还没等到 `RUN_STARTED` 的标记先搁着，等下一条认领而
 * 不是丢掉——在半路接上的流上，那一轮最该说的一句就是它开头那一句。
 *
 * 收不到 `run.stage` 的地方——这轮之前的旧存档、没走这条流的通道——`stage()` 一直是 null，对话照旧画
 * 「思考中」/「<员工名> 正在输入」，不会因为这里没东西而空出一格。
 */

/** 一轮的哪一段，与服务器 `RunStage` 同一份枚举：改一边要改另一边。 */
export type RunStage = "model" | "tool" | "answer";

const STAGES = new Set<RunStage>(["model", "tool", "answer"]);

/**
 * 要说新话的段。「调用模型」这一件事实，这一格一直用「思考中」/「<员工名> 正在输入」说着，换段时不说
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

/** 代理报的 CUSTOM 事件里用到的两样（同上：只为一个类型不引运行时的包）。 */
type AgentCustomEvent = { name: string; value: unknown };

/**
 * 代理订阅者里用到的几样（`agent.subscribe` 收的对象的一部分）。只写这几样，免得为了一个类型再引一次
 * 运行时的包。
 */
type AgentSubscriber = {
  onRunStartedEvent?: () => void;
  onRunFinishedEvent?: () => void;
  onRunErrorEvent?: () => void;
  onCustomEvent?: (params: { event: AgentCustomEvent }) => void;
};

export type RunStageTracker = {
  /** 交给 `agent.subscribe`：要在 `connect` 开始之前订阅，重放的历史才听得到。 */
  subscriber: AgentSubscriber;
  /** 现在这一轮在哪一段；没有阶段事件时为 null。给 `useSyncExternalStore` 用，是个原始值。 */
  stage(): RunStage | null;
  /** 段变了时通知（`useSyncExternalStore`）。 */
  listen(listener: () => void): () => void;
  /** 直接喂一个 CUSTOM 事件的名字和值：测试和重放都用得上。 */
  take(name: string, value: unknown): void;
  /** 一轮开始了：搁着的那条标记归它，之后的标记直接换段。`subscriber` 也走这里。 */
  started(): void;
  /** 一轮收尾（正常或出错）：这一段跟着结束，不带给下一轮。 */
  ended(): void;
};

/** 阶段事件的名字，服务器那边写在 `withRunStages` 里。 */
const STAGE_EVENT = "run.stage";

/** 读得出的一段，读不懂就没有（值不是对象、段不在枚举里、干脆没给）。 */
function stageOf(value: unknown): RunStage | null {
  const stage =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { stage?: unknown }).stage
      : undefined;
  return typeof stage === "string" && STAGES.has(stage as RunStage)
    ? (stage as RunStage)
    : null;
}

export function createRunStageTracker(): RunStageTracker {
  /** 有没有一轮正在跑（RUN_STARTED 到收尾之间）。 */
  let open = false;
  /** 正在跑的这一轮在哪一段。 */
  let current: RunStage | null = null;
  /** 还没等到 RUN_STARTED 的那条标记（半路接上的流），等下一轮认领。 */
  let pending: RunStage | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  /** 一个 CUSTOM 事件落在身上：只有阶段事件改得出什么，别的名字一概不动。 */
  const apply = (name: string, value: unknown) => {
    if (name !== STAGE_EVENT) return;
    const stage = stageOf(value);
    if (stage === null || (!open && pending === stage) || stage === current)
      return;
    if (open) current = stage;
    else pending = stage;
    notify();
  };

  const started = () => {
    open = true;
    if (pending === null) return;
    current = pending;
    pending = null;
    notify();
  };

  const ended = () => {
    if (!open && current === null && pending === null) return;
    open = false;
    current = null;
    pending = null;
    notify();
  };

  return {
    subscriber: {
      onRunStartedEvent: started,
      onRunFinishedEvent: ended,
      onRunErrorEvent: ended,
      onCustomEvent: ({ event }) => apply(event.name, event.value),
    },
    stage: () => current,
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take: apply,
    started,
    ended,
  };
}

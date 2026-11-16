import { nextNoteOrder } from "./note-order";

/*
 * 外部员工一轮里的进度、改动和中断（外部员工 Task 12）。
 *
 * 服务器把外部智能体说的话翻成对话线程本来就讲的事件（`server/src/agents/acp/translate.ts`），其中三样不是
 * 消息，而是 `CUSTOM` 事件，消息列表里没有它们：
 *
 * - `acp.plan`：智能体这一轮的计划，值是 ACP 的 `entries`（`{content, status, priority}[]`），每次都是整份；
 * - `acp.diff`：一个工具调用改了哪些文件，`{toolCallId, files: {path, added, removed}[], status?}`，同一个调用
 *   往前走时会再报一次；`status` 是带着它的那次更新里调用的状态。先报了改动、后来才结束的调用，结束时
 *   （`completed`、`failed`）再补一条 `{toolCallId, files: [], status}`；
 * - `acp.interrupted`：电脑关机、这一轮中断了，`{turnId, prompt}`，`prompt` 是这一轮派的原话。
 *
 * 这里听代理的事件流（实时的一轮，和进入对话时 `connect` 重放的历史都走这条），按轮次记下这三样，每样记在
 * 它第一次出现时对话里最后那条消息后面（`anchor`），对话里就画在那一行下面。同一轮再来的计划换掉旧的，
 * 改动按「工具调用 + 文件」只留最新的一份再按文件加总，并且只算最后一次报的状态是 `completed` 的调用：
 * 失败了的、没做完这一轮就收了的，报的是它想写的改动，其实什么也没写（和任务看板、交付证据的口径一样，
 * 服务器 `server/src/tasks/diff-summary.ts` 的 `editedFiles`）。
 * 重放同一段历史得到的还是同样几张卡。
 */

export type AcpPlanStatus = "pending" | "in_progress" | "completed";
export type AcpPlanEntry = { content: string; status: AcpPlanStatus };
export type AcpDiffFile = { path: string; added: number; removed: number };

type CardBase = {
  /** 轮次 + 种类，同一轮的同一种卡只有一张。 */
  key: string;
  /** 第一次出现的先后（`note-order.ts`），和交付卡画在同一行下面时按它排。 */
  order: number;
  runId: string;
  /** 第一次出现时对话里最后那条消息的 id；那时还一条消息都没有时为 null。 */
  anchor: string | null;
};

export type AcpCard =
  | (CardBase & { kind: "plan"; entries: AcpPlanEntry[] })
  | (CardBase & { kind: "diff"; files: AcpDiffFile[] })
  | (CardBase & {
      kind: "interrupted";
      turnId: string | null;
      prompt: string;
      /**
       * 这一轮之后对话里又开始过别的轮次（重新派过，或者又说了别的）：只有最后一轮的中断卡能「重新派」，
       * 重放历史时也一样，免得几天前的活被再派一遍。
       */
      superseded: boolean;
    });

/** 还没取号的卡：`put` 第一次见到它时取号。 */
type Unordered<T> = T extends unknown ? Omit<T, "order"> : never;

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;

const STATUSES = new Set<AcpPlanStatus>([
  "pending",
  "in_progress",
  "completed",
]);

/** ACP 的计划条目，读不懂的条目不要；状态不认识的按「还没开始」画。 */
export function planEntriesOf(value: unknown): AcpPlanEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    const content =
      typeof entry?.content === "string" ? entry.content.trim() : "";
    if (!content) return [];
    const status = STATUSES.has(entry?.status as AcpPlanStatus)
      ? (entry?.status as AcpPlanStatus)
      : "pending";
    return [{ content, status }];
  });
}

function diffFilesOf(value: unknown): AcpDiffFile[] {
  const files = record(value)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((item) => {
    const file = record(item);
    return typeof file?.path === "string" &&
      file.path !== "" &&
      typeof file.added === "number" &&
      typeof file.removed === "number"
      ? [{ path: file.path, added: file.added, removed: file.removed }]
      : [];
  });
}

/** 一轮里的改动：「工具调用 + 文件」→ 最新一份，工具调用 → 它最后一次报的状态。 */
type RunEdits = {
  files: Map<string, AcpDiffFile & { call: string }>;
  status: Map<string, unknown>;
};

/** 按文件加总：每个「工具调用 + 文件」只算最新那份，只算做完了（`completed`）的调用。 */
function summed({ files: edits, status }: RunEdits): AcpDiffFile[] {
  const files = new Map<string, AcpDiffFile>();
  for (const { call, path, added, removed } of edits.values()) {
    if (status.get(call) !== "completed") continue;
    const file = files.get(path) ?? { path, added: 0, removed: 0 };
    file.added += added;
    file.removed += removed;
    files.set(path, file);
  }
  return [...files.values()];
}

/**
 * 代理订阅者里用到的两样（`agent.subscribe` 收的对象的一部分）。只写这两样，免得为了一个类型再引一次运行时的包。
 */
type AgentSubscriber = {
  onRunStartedEvent?: (params: { event: { runId: string } }) => void;
  onCustomEvent?: (params: {
    event: { name: string; value: unknown };
    messages: ReadonlyArray<{ id: string }>;
  }) => void;
};

export type AcpCardTracker = {
  /** 交给 `agent.subscribe`：要在 `connect` 开始之前订阅，重放的历史才听得到。 */
  subscriber: AgentSubscriber;
  /** 现在的卡片，按第一次出现的先后；没有变化时是同一个数组。 */
  cards(): readonly AcpCard[];
  /** 卡片变了时通知（`useSyncExternalStore`）。 */
  listen(listener: () => void): () => void;
  /** 一轮开始了（`subscriber` 收到 RUN_STARTED 时也是走这里）。 */
  started(runId: string): void;
  /** 直接喂一个事件；`subscriber` 也是走这里。测试和重放都用得上。 */
  take(input: {
    runId: string;
    name: string;
    value: unknown;
    anchor: string | null;
  }): void;
};

export function createAcpCardTracker(): AcpCardTracker {
  let runId = "";
  let cards: readonly AcpCard[] = [];
  /** 轮次 → 它的改动和各调用的状态。 */
  const edits = new Map<string, RunEdits>();
  /** 改动卡第一次出现的位置：卡撤掉（改动都没做成）又回来时，还画在原来那里。 */
  const diffAnchors = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  /** 每张卡（按 `key`）第一次出现时取的号。 */
  const orders = new Map<string, number>();

  const put = (unordered: Unordered<AcpCard>) => {
    const order = orders.get(unordered.key) ?? nextNoteOrder();
    orders.set(unordered.key, order);
    const card = { ...unordered, order } as AcpCard;
    const at = cards.findIndex((existing) => existing.key === card.key);
    if (at < 0) cards = [...cards, card];
    else {
      const next = [...cards];
      // 位置和先后跟着第一次出现，内容换成最新的。
      next[at] = { ...card, anchor: cards[at]?.anchor ?? card.anchor };
      cards = next;
    }
    for (const listener of listeners) listener();
  };

  const drop = (key: string) => {
    if (!cards.some((card) => card.key === key)) return;
    cards = cards.filter((card) => card.key !== key);
    for (const listener of listeners) listener();
  };

  /** 一轮开始了：它之前的中断卡都有了后续。 */
  const supersede = (started: string) => {
    let changed = false;
    const next = cards.map((card) => {
      if (card.kind !== "interrupted" || card.superseded) return card;
      if (card.runId === started) return card;
      changed = true;
      return { ...card, superseded: true };
    });
    if (!changed) return;
    cards = next;
    for (const listener of listeners) listener();
  };

  const take: AcpCardTracker["take"] = ({
    runId: run,
    name,
    value,
    anchor,
  }) => {
    if (name === "acp.plan") {
      put({
        kind: "plan",
        key: `${run}:plan`,
        runId: run,
        anchor,
        entries: planEntriesOf(value),
      });
      return;
    }
    if (name === "acp.diff") {
      const body = record(value);
      if (!body) return;
      const toolCallId = String(body.toolCallId ?? "");
      const ofRun = edits.get(run) ?? { files: new Map(), status: new Map() };
      edits.set(run, ofRun);
      // 文件列表为空的那条（调用结束时补的）只改状态：`failed` 就撤掉它先前报的改动。
      ofRun.status.set(toolCallId, body.status);
      for (const file of diffFilesOf(value))
        ofRun.files.set(JSON.stringify([toolCallId, file.path]), {
          ...file,
          call: toolCallId,
        });
      const key = `${run}:diff`;
      const files = summed(ofRun);
      if (files.length === 0) {
        drop(key);
        return;
      }
      if (!diffAnchors.has(key)) diffAnchors.set(key, anchor);
      put({
        kind: "diff",
        key,
        runId: run,
        anchor: diffAnchors.get(key) ?? anchor,
        files,
      });
      return;
    }
    if (name === "acp.interrupted") {
      const body = record(value);
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
      put({
        kind: "interrupted",
        key: `${run}:interrupted`,
        runId: run,
        anchor,
        turnId: typeof body?.turnId === "string" ? body.turnId : null,
        prompt,
        superseded: false,
      });
    }
  };

  return {
    subscriber: {
      onRunStartedEvent: ({ event }) => {
        runId = event.runId;
        supersede(runId);
      },
      onCustomEvent: ({ event, messages }) => {
        if (typeof event.name !== "string" || !event.name.startsWith("acp."))
          return;
        take({
          runId,
          name: event.name,
          value: event.value,
          anchor: messages.at(-1)?.id ?? null,
        });
      },
    },
    cards: () => cards,
    started(started) {
      runId = started;
      supersede(started);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take,
  };
}

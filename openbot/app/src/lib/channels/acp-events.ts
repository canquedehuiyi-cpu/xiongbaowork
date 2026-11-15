/*
 * 外部员工一轮里的进度、改动和中断（外部员工 Task 12）。
 *
 * 服务器把外部智能体说的话翻成对话线程本来就讲的事件（`server/src/agents/acp/translate.ts`），其中三样不是
 * 消息，而是 `CUSTOM` 事件，消息列表里没有它们：
 *
 * - `acp.plan`：智能体这一轮的计划，值是 ACP 的 `entries`（`{content, status, priority}[]`），每次都是整份；
 * - `acp.diff`：一个工具调用改了哪些文件，`{toolCallId, files: {path, added, removed}[]}`，同一个调用往前走
 *   时会再报一次；
 * - `acp.interrupted`：电脑关机、这一轮中断了，`{turnId, prompt}`，`prompt` 是这一轮派的原话。
 *
 * 这里听代理的事件流（实时的一轮，和进入对话时 `connect` 重放的历史都走这条），按轮次记下这三样，每样记在
 * 它第一次出现时对话里最后那条消息后面（`anchor`），对话里就画在那一行下面。同一轮再来的计划换掉旧的，
 * 改动按「工具调用 + 文件」只留最新的一份再按文件加总（和任务看板 `tasks/projector.ts` 的口径一样）。
 * 重放同一段历史得到的还是同样几张卡。
 */

export type AcpPlanStatus = "pending" | "in_progress" | "completed";
export type AcpPlanEntry = { content: string; status: AcpPlanStatus };
export type AcpDiffFile = { path: string; added: number; removed: number };

type CardBase = {
  /** 轮次 + 种类，同一轮的同一种卡只有一张。 */
  key: string;
  runId: string;
  /** 第一次出现时对话里最后那条消息的 id；那时还一条消息都没有时为 null。 */
  anchor: string | null;
};

export type AcpCard =
  | (CardBase & { kind: "plan"; entries: AcpPlanEntry[] })
  | (CardBase & { kind: "diff"; files: AcpDiffFile[] })
  | (CardBase & { kind: "interrupted"; turnId: string | null; prompt: string });

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

/** 按文件加总：每个「工具调用 + 文件」只算最新那份。 */
function summed(edits: ReadonlyMap<string, AcpDiffFile>): AcpDiffFile[] {
  const files = new Map<string, AcpDiffFile>();
  for (const { path, added, removed } of edits.values()) {
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
  /** 轮次 → 「工具调用 + 文件」→ 最新一份改动。 */
  const edits = new Map<string, Map<string, AcpDiffFile>>();
  const listeners = new Set<() => void>();

  const put = (card: AcpCard) => {
    const at = cards.findIndex((existing) => existing.key === card.key);
    if (at < 0) cards = [...cards, card];
    else {
      const next = [...cards];
      // 位置跟着第一次出现，内容换成最新的。
      next[at] = { ...card, anchor: cards[at]?.anchor ?? card.anchor };
      cards = next;
    }
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
      const files = diffFilesOf(value);
      if (files.length === 0) return;
      const toolCallId = String(record(value)?.toolCallId ?? "");
      const ofRun = edits.get(run) ?? new Map<string, AcpDiffFile>();
      edits.set(run, ofRun);
      for (const file of files)
        ofRun.set(JSON.stringify([toolCallId, file.path]), file);
      put({
        kind: "diff",
        key: `${run}:diff`,
        runId: run,
        anchor,
        files: summed(ofRun),
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
      });
    }
  };

  return {
    subscriber: {
      onRunStartedEvent: ({ event }) => {
        runId = event.runId;
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
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take,
  };
}

/**
 * 每道题的墙钟拆分（熊宝侧）：模型时间 / 工具时间 / 其余。只读评测已有的库数据，不改产品行为。
 *
 * 数据口径：
 *  - 模型时间 = 每次模型调用从发出请求（`model_token_calls.started_at`）到流读完并记下用量
 *    （`observed_at`）的时长之和；并行的调用（主员工和子代理同时在等模型）按区间并集算，不重复计。有任何一次调用
 *    没有 `observed_at`（没结束、被中断）就不给这一项，写「—」，不拿别的数凑。
 *  - 工具时间 = 各工具调用的执行区间的并集：区间从 `TOOL_CALL_END`（参数发完、开始执行）到 `TOOL_CALL_RESULT`，
 *    用事件 JSON 里的 `timestamp`；`TOOL_CALL_END` 没有时间戳时退回 `TOOL_CALL_START`（这时区间会把模型流出参数的
 *    那一小段算进来，所以再减掉和模型区间重叠的部分）。同一步并行的几个调用按并集算。只要有一个调用缺时间戳，
 *    整题不给工具时间（「—」）：事件库表的 `created_at` 是写库时间，不是事件发生的时间，不能拿来凑。
 *  - 其余 = 墙钟 − 模型 − 工具：服务器写库、续接、评测脚本追「继续」的等待、事件流重连等。工具时间拿不到时，其余 =
 *    墙钟 − 模型（含工具执行，日志里标「其余（含工具）」），至少分得出模型和非模型；模型拿不到就不算。
 */

export type Span = { start: number; end: number };

export type WallSplit = {
  /** 模型时间（毫秒）；拿不到可靠数据时 null。 */
  modelMs: number | null;
  /** 工具时间（毫秒）；拿不到可靠时间戳时 null。 */
  toolMs: number | null;
  /** 其余（毫秒）；工具时间拿不到时含工具执行；模型拿不到时 null。 */
  otherMs: number | null;
};

/** 把时间戳读成毫秒：数字（毫秒）或能解析的时间字符串；读不出来是 undefined。 */
export function stampMs(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 区间并集：排序后合并相交或相接的区间；长度非正的丢掉。 */
export function unionOf(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .map((span) => ({ ...span }))
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }
  return merged;
}

const lengthOf = (spans: readonly Span[]) =>
  spans.reduce((total, span) => total + (span.end - span.start), 0);

/** 两组（各自已是并集的）区间重叠的总长。 */
function overlapOf(a: readonly Span[], b: readonly Span[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] as Span;
    const right = b[j] as Span;
    total += Math.max(
      0,
      Math.min(left.end, right.end) - Math.max(left.start, right.start),
    );
    if (left.end < right.end) i++;
    else j++;
  }
  return total;
}

type CallRow = { startedAt: Date | string; observedAt?: Date | string | null };

/** 模型调用的区间；有一次没有结束时刻（或读不出）就是 undefined（整项不可靠）。 */
export function modelSpans(rows: readonly CallRow[]): Span[] | undefined {
  if (rows.length === 0) return undefined;
  const spans: Span[] = [];
  for (const row of rows) {
    const start = stampMs(row.startedAt);
    const end = stampMs(row.observedAt);
    if (start === undefined || end === undefined || end < start)
      return undefined;
    spans.push({ start, end });
  }
  return spans;
}

type Event = Record<string, unknown> & { type?: string };

/**
 * 工具调用的执行区间，从运行事件读。每个调用要有「开始执行」（`TOOL_CALL_END`，没有就用 `TOOL_CALL_START`）和
 * `TOOL_CALL_RESULT` 两个时间戳；任何一个调用缺了，整题返回 undefined。没有工具调用是空数组（工具时间 0）。
 * `exact`：每个调用都是用 `TOOL_CALL_END` 量的（区间不含模型流出参数的那段）。
 */
export function toolSpans(
  events: readonly Event[],
): { spans: Span[]; exact: boolean } | undefined {
  const calls = new Map<
    string,
    { start?: number; end?: number; result?: number }
  >();
  for (const event of events) {
    const id = String(event.toolCallId ?? "");
    if (!id) continue;
    const at = stampMs(event.timestamp);
    const slot = (key: "start" | "end" | "result") =>
      calls.set(id, {
        ...(calls.get(id) ?? {}),
        ...(at === undefined ? {} : { [key]: at }),
      });
    if (event.type === "TOOL_CALL_START") slot("start");
    else if (event.type === "TOOL_CALL_END") slot("end");
    else if (event.type === "TOOL_CALL_RESULT") slot("result");
  }
  const spans: Span[] = [];
  let exact = true;
  for (const call of calls.values()) {
    const start = call.end ?? call.start;
    if (start === undefined || call.result === undefined) return undefined;
    if (call.end === undefined) exact = false;
    spans.push({ start, end: Math.max(start, call.result) });
  }
  return { spans, exact };
}

/**
 * 一道题的墙钟拆分。`model` / `tools` 是 {@link modelSpans} / {@link toolSpans} 的结果（undefined = 拿不到可靠数据）。
 * 工具区间和模型区间重叠的部分只算模型（不重复计）。其余不会是负数（并行、时钟误差时夹到 0）。
 */
export function wallSplit(input: {
  wallMs: number;
  model: readonly Span[] | undefined;
  tools: readonly Span[] | undefined;
}): WallSplit {
  const modelUnion = input.model ? unionOf(input.model) : undefined;
  const toolUnion = input.tools ? unionOf(input.tools) : undefined;
  const modelMs = modelUnion ? lengthOf(modelUnion) : null;
  const toolMs = toolUnion
    ? lengthOf(toolUnion) - (modelUnion ? overlapOf(toolUnion, modelUnion) : 0)
    : null;
  const otherMs =
    modelMs !== null
      ? Math.max(0, input.wallMs - modelMs - (toolMs ?? 0))
      : null;
  return { modelMs, toolMs, otherMs };
}

const secondsText = (ms: number | null) =>
  ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;

/** 日志里 `== 题目` 段的一行。 */
export function wallSplitLine(
  split: WallSplit,
  wallMs: number,
  steps: number | null,
): string {
  const rest = split.toolMs === null ? "其余（含工具）" : "其余";
  return `墙钟拆分：总 ${secondsText(wallMs)} = 模型 ${secondsText(split.modelMs)} + 工具 ${secondsText(split.toolMs)} + ${rest} ${secondsText(split.otherMs)}，步数 ${steps ?? "—"}`;
}

/** 两段（重复任务的第一次和第二次）相加；任一段的某项拿不到，合计也拿不到。 */
export function addWallSplits(a: WallSplit, b: WallSplit): WallSplit {
  const add = (x: number | null, y: number | null) =>
    x === null || y === null ? null : x + y;
  return {
    modelMs: add(a.modelMs, b.modelMs),
    toolMs: add(a.toolMs, b.toolMs),
    otherMs: add(a.otherMs, b.otherMs),
  };
}

export const secondsCell = secondsText;

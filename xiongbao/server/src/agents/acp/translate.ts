import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";

/**
 * What an external employee's agent says (`session/update`, carried up in `acp.update`), as the
 * events every conversation thread already speaks, so the transcript, the typing indicator, the
 * board card and its deliverable read an external employee's turn with the code they read every
 * other turn with.
 *
 * - `agent_message_chunk` (text) → one assistant text message per run of chunks: START, a CONTENT
 *   per chunk, END once something else comes or the turn closes.
 * - `tool_call` / `tool_call_update` → a tool call named `acp/<kind>` (`read`, `edit`, `execute`, …;
 *   anything unknown is `acp/other`): START, ARGS (its title, kind, locations and raw input as JSON; a
 *   raw input over `RAW_INPUT_LIMIT` is left out whole and marked `rawInputTruncated`, with
 *   `rawInputLength` for the length it had), END at once, then one RESULT when it is `completed` or
 *   `failed`. A call the turn closes on without one gets a result anyway, so no browser ever takes it
 *   for a tool of its own to run.
 * - `plan` → `CUSTOM acp.plan` with the plan's entries.
 * Tool call ids are the agent's, prefixed with the run's (`<runId>:<id>`), like the message ids.
 * - a diff in a tool call's content (`edit`, mostly) → `CUSTOM acp.diff` `{toolCallId, files: {path,
 *   added, removed}[], status?}`, `status` being the call's status in the update that carried it. A
 *   call whose diff came before it ended gets one more, `{toolCallId, files: [], status}`, when it
 *   ends (`completed`, `failed`) with a status other than its last diff's. Only the diffs of a call
 *   that `completed` are a change (`tasks/diff-summary.ts` `editedFiles`): the board's deliverable
 *   sums those per file (`deliverableFromEvents`), and an external employee hands in those.
 * - a call that ends (`completed`, `failed`) with a duration in its raw output (`rawOutput.elapsedMs`,
 *   a number the device measured) → one `CUSTOM acp.elapsed` `{toolCallId, elapsedMs}`, just before
 *   its RESULT. What the agent did not report is not sent: nothing here stops a clock, and a call with
 *   no duration to report has no event of its own — the transcript draws no time for it.
 *
 * Everything else (thoughts, mode and command updates, a stub cut down to its ids) says nothing.
 * Raw agent content may carry the paths the agent itself printed; nothing here adds any.
 */

export type AcpTranslator = {
  /** The events for one update, in order. */
  update(update: unknown): BaseEvent[];
  /** Ends the message still open and answers every tool call still waiting: the turn is over. */
  close(): BaseEvent[];
  /** Ends the message still open, so something else can be said mid-turn; the next chunk opens another. */
  pause(): BaseEvent[];
};

export type AcpDiffFile = { path: string; added: number; removed: number };

/** A tool result is clipped to this many characters: the transcript is not the device's disk. */
const RESULT_LIMIT = 4000;
/** A tool call's raw input is sent with its arguments only when it serializes this small. */
const RAW_INPUT_LIMIT = 8000;
/** Above this many line pairs a diff is counted by multiset, not by longest common subsequence. */
const LCS_CELLS = 4_000_000;

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text;

function kindOf(value: unknown): string {
  const kind = typeof value === "string" ? value : "";
  return /^[a-z_]{1,32}$/.test(kind) ? kind : "other";
}

const lines = (text: string): string[] => {
  if (text === "") return [];
  const split = text.split("\n");
  // A trailing newline ends the last line rather than starting an empty one.
  if (split[split.length - 1] === "") split.pop();
  return split;
};

/**
 * Lines added and removed going from `oldText` to `newText`, as a unified diff counts them: the
 * common head and tail are dropped, the rest is aligned by longest common subsequence, or, past
 * `LCS_CELLS`, counted as the lines of each side the other lacks.
 */
export function diffCounts(
  oldText: string | null,
  newText: string,
): { added: number; removed: number } {
  const before = lines(oldText ?? "");
  const after = lines(newText);
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  if (a.length === 0 || b.length === 0)
    return { added: b.length, removed: a.length };
  let common: number;
  if (a.length * b.length <= LCS_CELLS) {
    let previous = new Uint32Array(b.length + 1);
    let current = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1)
        current[j] =
          a[i - 1] === b[j - 1]
            ? (previous[j - 1] as number) + 1
            : Math.max(previous[j] as number, current[j - 1] as number);
      [previous, current] = [current, previous];
    }
    common = previous[b.length] as number;
  } else {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    common = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        common += 1;
      }
    }
  }
  return { added: b.length - common, removed: a.length - common };
}

/** The diffs in a tool call's content, one entry per file. */
function diffsIn(content: unknown): AcpDiffFile[] {
  if (!Array.isArray(content)) return [];
  const files: AcpDiffFile[] = [];
  for (const item of content) {
    const entry = record(item);
    if (entry?.type !== "diff") continue;
    const path = str(entry.path);
    if (!path || typeof entry.newText !== "string") continue;
    const oldText = typeof entry.oldText === "string" ? entry.oldText : null;
    files.push({ path, ...diffCounts(oldText, entry.newText) });
  }
  return files;
}

/** What a finished tool call reports, as one string for its RESULT. */
function resultText(call: Loose, failed: boolean): string {
  const parts: string[] = [];
  if (Array.isArray(call.content)) {
    for (const item of call.content) {
      const entry = record(item);
      if (!entry) continue;
      if (entry.type === "content") {
        const block = record(entry.content);
        const text = block?.type === "text" ? str(block.text) : null;
        if (text) parts.push(text);
      } else if (entry.type === "diff") {
        const [file] = diffsIn([entry]);
        if (file)
          parts.push(`改动 ${file.path}（+${file.added} −${file.removed}）`);
      } else if (entry.type === "terminal") {
        parts.push("（在终端里运行）");
      }
    }
  }
  if (parts.length === 0 && call.rawOutput !== undefined) {
    const raw =
      typeof call.rawOutput === "string"
        ? call.rawOutput
        : JSON.stringify(call.rawOutput);
    if (raw) parts.push(raw);
  }
  const body = clip(parts.join("\n\n"), RESULT_LIMIT);
  if (failed) return body ? `失败：${body}` : "失败。";
  return body || "完成。";
}

/**
 * 这一步跑了多久，毫秒——只有设备自己在 `rawOutput.elapsedMs` 里写了才作数。
 *
 * 这里不掐表：外部件干了多少时间是它报的，报不出来就是报不出来。字符串的 rawOutput（多数代理给的是
 * 一段文字）、缺字段、负数、`NaN`、`Infinity` 一律当作没有——前端宁可什么都不显示，也不要看到一个
 * `0.0s` 以为是读数。
 */
function elapsedOf(update: Loose): number | undefined {
  const raw = record(update.rawOutput);
  const value = raw?.elapsedMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function argsOf(call: Loose): string {
  const args: Loose = {
    title: str(call.title) ?? "",
    kind: kindOf(call.kind),
  };
  if (Array.isArray(call.locations)) args.locations = call.locations;
  if (call.rawInput !== undefined) {
    const raw = JSON.stringify(call.rawInput);
    if (raw !== undefined && raw.length <= RAW_INPUT_LIMIT)
      args.rawInput = call.rawInput;
    // 截断时把原来的长度一起给出：前端能说实话（「共 8123 字」），不必编一个。
    else {
      args.rawInputTruncated = true;
      if (raw !== undefined) args.rawInputLength = raw.length;
    }
  }
  return JSON.stringify(args);
}

export function createAcpTranslator(
  options: { idPrefix?: string } = {},
): AcpTranslator {
  const prefix = options.idPrefix ?? randomUUID();
  let messages = 0;
  let open: string | null = null;
  /** toolCallId → whether its RESULT went out. */
  const calls = new Map<string, boolean>();
  /** toolCallId → the status its latest `acp.diff` said, for a call that reported a diff. */
  const diffed = new Map<string, string | null>();

  const endMessage = (): BaseEvent[] => {
    if (!open) return [];
    const messageId = open;
    open = null;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent];
  };

  const result = (toolCallId: string, content: string): BaseEvent => {
    calls.set(toolCallId, true);
    return {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${prefix}-tool-${toolCallId}`,
      toolCallId,
      content,
      role: "tool",
    } as BaseEvent;
  };

  function toolCall(update: Loose): BaseEvent[] {
    const agentCallId = str(update.toolCallId);
    if (!agentCallId) return [];
    // The agent's id is unique only within its session, and an adapter that restarted starts a new
    // one: the run's prefix keeps two turns' calls apart in the thread's history.
    const toolCallId = `${prefix}:${agentCallId}`;
    const events: BaseEvent[] = [];
    if (!calls.has(toolCallId)) {
      events.push(...endMessage());
      calls.set(toolCallId, false);
      events.push(
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: `acp/${kindOf(update.kind)}`,
        } as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: argsOf(update),
        } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent,
      );
    }
    const status = str(update.status);
    const files = diffsIn(update.content);
    if (files.length > 0) {
      diffed.set(toolCallId, status);
      events.push({
        type: EventType.CUSTOM,
        name: "acp.diff",
        value: { toolCallId, files, ...(status ? { status } : {}) },
      } as BaseEvent);
    }
    if (
      (status === "completed" || status === "failed") &&
      !calls.get(toolCallId)
    ) {
      // Its diff came while it ran: how the call ended decides whether that diff is a change.
      if (diffed.has(toolCallId) && diffed.get(toolCallId) !== status) {
        diffed.set(toolCallId, status);
        events.push({
          type: EventType.CUSTOM,
          name: "acp.diff",
          value: { toolCallId, files: [], status },
        } as BaseEvent);
      }
      // 设备报了耗时才带这一条，和它前面的 diff 一样按 `toolCallId` 对上那一步。
      const elapsedMs = elapsedOf(update);
      if (elapsedMs !== undefined)
        events.push({
          type: EventType.CUSTOM,
          name: "acp.elapsed",
          value: { toolCallId, elapsedMs },
        } as BaseEvent);
      events.push(result(toolCallId, resultText(update, status === "failed")));
    }
    return events;
  }

  return {
    update(raw) {
      const update = record(raw);
      if (!update) return [];
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const content = record(update.content);
          const delta = content?.type === "text" ? str(content.text) : null;
          if (!delta) return [];
          const events: BaseEvent[] = [];
          if (!open) {
            messages += 1;
            open = `${prefix}-message-${messages}`;
            events.push({
              type: EventType.TEXT_MESSAGE_START,
              messageId: open,
              role: "assistant",
            } as BaseEvent);
          }
          events.push({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: open,
            delta,
          } as BaseEvent);
          return events;
        }
        case "tool_call":
        case "tool_call_update":
          return toolCall(update);
        case "plan":
          return [
            ...endMessage(),
            {
              type: EventType.CUSTOM,
              name: "acp.plan",
              value: Array.isArray(update.entries) ? update.entries : [],
            } as BaseEvent,
          ];
        default:
          return [];
      }
    },
    pause: endMessage,
    close() {
      const events = endMessage();
      for (const [toolCallId, answered] of calls)
        if (!answered) events.push(result(toolCallId, "（这一步没有结果。）"));
      return events;
    },
  };
}

/**
 * The events for one update. With a translator, a step of its stream (a message may stay open for
 * the next chunk); without one, a whole on its own (whatever it opened is closed).
 */
export function translateUpdate(
  update: unknown,
  translator?: AcpTranslator,
): BaseEvent[] {
  if (translator) return translator.update(update);
  const alone = createAcpTranslator();
  return [...alone.update(update), ...alone.close()];
}

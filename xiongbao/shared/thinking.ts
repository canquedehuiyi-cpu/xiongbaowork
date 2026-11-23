/**
 * 员工的「思考模式」（期三，规格 docs/specs/2026-11-19-codex-grade-employee.md §2）。
 *
 * 用 DeepSeek 时，员工先想再做：模型的推理内容作为 AG-UI 的推理事件（`REASONING_*`）流出，随这一轮的其它
 * 事件一起存库，刷新后回放。所有员工一律开着，没有每员工的开关；只有部署级的 `DEEPSEEK_THINKING=disabled`
 * 能全部关掉（运维应急，界面不显示）。别的模型不受影响。
 */

/**
 * 推理内容在流里的 AG-UI 事件，按出现的顺序。界面据此画可折叠的「思考」块：`REASONING_MESSAGE_CONTENT`
 * 的 `delta` 是一段段推理文字，同一段的事件共用一个 `messageId`。
 */
export const REASONING_EVENTS = [
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_END",
] as const;

export type ReasoningEventType = (typeof REASONING_EVENTS)[number];

/**
 * 群聊回复行上记的思考（期三）：员工这一轮各段推理连在一起，最长这么多字，超过就截断并注明（`truncated`）。
 * 群回复行存在库里、群里每个人都会读到，一轮想得再久也不让它无限长。
 */
export const REASONING_TEXT_LIMIT = 8000;

/** 截断时接在思考后面的一句说明。 */
export const REASONING_TRUNCATED_NOTE = `（思考内容较长，只保留了前 ${REASONING_TEXT_LIMIT} 字。）`;

/** 记在回复行 `details.reasoning` 上的思考：文字、各段加起来想了多久（每段都量到才有），以及是否截断过。 */
export type StoredReasoning = { text: string; ms?: number; truncated?: true };

/**
 * 一轮里的各段思考连成一份：空的不算，各段之间空一行；每段都带时长才给总时长，少一段就不编；长了截断。
 * 没有思考时给 null。
 */
export function joinReasoning(
  pieces: readonly { text: string; ms?: number; truncated?: boolean }[],
): StoredReasoning | null {
  const kept = pieces.filter((piece) => piece.text.trim());
  if (kept.length === 0) return null;
  const text = kept.map((piece) => piece.text.trim()).join("\n\n");
  const characters = [...text];
  const truncated =
    characters.length > REASONING_TEXT_LIMIT ||
    kept.some((piece) => piece.truncated === true);
  const timed = kept.every(
    (piece) => typeof piece.ms === "number" && piece.ms >= 0,
  );
  const ms = timed
    ? kept.reduce((total, piece) => total + (piece.ms ?? 0), 0)
    : undefined;
  return {
    text:
      characters.length > REASONING_TEXT_LIMIT
        ? characters.slice(0, REASONING_TEXT_LIMIT).join("")
        : text,
    ...(ms === undefined ? {} : { ms }),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** 回复行上记的思考，按结构认一遍：形状不对（旧行、别处写进来的）就当没有。 */
export function readStoredReasoning(value: unknown): StoredReasoning | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { text?: unknown; ms?: unknown; truncated?: unknown };
  if (typeof record.text !== "string" || !record.text.trim()) return null;
  const ms =
    typeof record.ms === "number" &&
    Number.isFinite(record.ms) &&
    record.ms >= 0
      ? record.ms
      : undefined;
  return {
    text: record.text,
    ...(ms === undefined ? {} : { ms }),
    ...(record.truncated === true ? { truncated: true as const } : {}),
  };
}

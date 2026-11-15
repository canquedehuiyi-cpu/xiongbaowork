import { type BaseEvent, EventType } from "@ag-ui/client";

/**
 * An external employee's changes as the board and the delivery loop read them: the `CUSTOM acp.diff`
 * events its turns carry (`agents/acp/translate.ts` writes them, `{toolCallId, files: {path, added,
 * removed}[]}`). Pure functions, kept here with the tasks that read them.
 */

/** One file a turn changed: lines added and removed. */
export type DiffFile = { path: string; added: number; removed: number };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * What a turn changed, summed per file from its `acp.diff` events: a tool call reports the same diff
 * again as it progresses, so only its latest count of each file is kept, then each file's counts are
 * added up over the turn's tool calls. What the board's deliverable shows (`deliverableFromEvents`)
 * and what an external employee hands in (`DeliverableRef.diffs`, `diffSummary`).
 */
export function editedFiles(events: readonly BaseEvent[]): DiffFile[] {
  /** Per tool call and file, its latest count. */
  const edits = new Map<string, DiffFile>();
  for (const event of events) {
    if (event.type !== EventType.CUSTOM) continue;
    const { name, value } = event as BaseEvent & {
      name?: unknown;
      value?: unknown;
    };
    if (name !== "acp.diff") continue;
    const { toolCallId, files } = (record(value) ?? {}) as {
      toolCallId?: unknown;
      files?: unknown;
    };
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const { path, added, removed } = record(file) ?? {};
      if (
        typeof path !== "string" ||
        !path ||
        typeof added !== "number" ||
        typeof removed !== "number"
      )
        continue;
      edits.set(JSON.stringify([String(toolCallId ?? ""), path]), {
        path,
        added,
        removed,
      });
    }
  }
  const files = new Map<string, DiffFile>();
  for (const { path, added, removed } of edits.values()) {
    const file = files.get(path) ?? { path, added: 0, removed: 0 };
    file.added += added;
    file.removed += removed;
    files.set(path, file);
  }
  return [...files.values()];
}

/** A turn's change in one entry, as a hand-in's `diffs` holds it: how many files, lines added, removed. */
export function diffSummary(files: readonly DiffFile[]): {
  files: number;
  added: number;
  removed: number;
} {
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

/**
 * The change in the words a hand-in shows it in until the external employees' own interface lands
 * (spec 2026-11-15-delivery-loop §9): 「改动 N 个文件 · +x −y」.
 */
export function diffTitle(summary: {
  files: number;
  added: number;
  removed: number;
}): string {
  return `改动 ${summary.files} 个文件 · +${summary.added} −${summary.removed}`;
}

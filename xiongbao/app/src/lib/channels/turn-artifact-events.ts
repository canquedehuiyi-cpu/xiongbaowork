import type { Message } from "@ag-ui/core";
import {
  TURN_ARTIFACTS_EVENT,
  type TurnArtifact,
  type TurnArtifactsValue,
} from "../../../../shared/turn-artifacts";

/*
 * 本轮产物事件：服务器在每次 run 收尾前插的 `CUSTOM computer.turn_artifacts`。
 *
 * 这种事件不是消息，消息列表里没有它，所以和外部员工的卡一样，从代理的事件流里记下来（对话页把
 * `subscriber` 交给 `agent.subscribe`，要在 `connect` 之前订阅，重放的历史才听得到）。每条事件记下
 * 它所在的 run：下载路由只认「列出这个路径的那条事件所在的 run」，链接必须带各自的 runId。
 */

/** 清单要用的部分：`seat` 只有服务器自己用（下载路由从 run 的事件里还原），对话里不需要。 */
export type TurnArtifactsBody = Omit<TurnArtifactsValue, "seat">;

/** 记下的一条事件。 */
export type TrackedTurnArtifacts = {
  runId: string;
  /** 事件到时最后一条消息的 id：用来判断它属于哪一轮。 */
  anchor: string | null;
  value: TurnArtifactsBody;
};

/** 一位员工本轮合并后的清单。 */
export type TurnArtifactGroup = {
  botId: string;
  files: { path: string; bytes: number; runId: string }[];
  omitted: number;
  scanTruncated: boolean;
};

function readFile(raw: unknown): TurnArtifact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as Record<string, unknown>;
  if (typeof file.path !== "string" || file.path === "") return null;
  return {
    path: file.path,
    bytes:
      typeof file.bytes === "number" && Number.isFinite(file.bytes)
        ? file.bytes
        : 0,
    modifiedMs:
      typeof file.modifiedMs === "number" && Number.isFinite(file.modifiedMs)
        ? file.modifiedMs
        : 0,
    change: file.change === "modified" ? "modified" : "new",
  };
}

/** 事件的内容：字段不全（没有员工、不是清单）为 null。 */
export function readTurnArtifactsValue(
  value: unknown,
): TurnArtifactsBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.botId !== "string" || body.botId.trim() === "") return null;
  if (!Array.isArray(body.files)) return null;
  const files = body.files.flatMap((raw) => {
    const file = readFile(raw);
    return file ? [file] : [];
  });
  return {
    botId: body.botId,
    files,
    scanned: typeof body.scanned === "number" ? body.scanned : 0,
    scanTruncated: body.scanTruncated === true,
    omitted:
      typeof body.omitted === "number" &&
      Number.isFinite(body.omitted) &&
      body.omitted > 0
        ? body.omitted
        : 0,
  };
}

type Subscriber = {
  onRunStartedEvent?: (params: { event: { runId: string } }) => void;
  onCustomEvent?: (params: {
    event: { name: string; value: unknown };
    messages: ReadonlyArray<{ id: string }>;
  }) => void;
};

export type TurnArtifactTracker = {
  /** 交给 `agent.subscribe`。 */
  subscriber: Subscriber;
  /** 记下的事件，按到达先后；没有变化时是同一个数组。 */
  events(): readonly TrackedTurnArtifacts[];
  listen(listener: () => void): () => void;
  take(input: { runId: string; anchor: string | null; value: unknown }): void;
};

export function createTurnArtifactTracker(): TurnArtifactTracker {
  let runId = "";
  let events: readonly TrackedTurnArtifacts[] = [];
  const listeners = new Set<() => void>();
  const take: TurnArtifactTracker["take"] = (input) => {
    const value = readTurnArtifactsValue(input.value);
    if (value === null || input.runId === "") return;
    // 重新连上对话会把历史再放一遍：同一 run 里同样的一条只记一次。
    const same = events.some(
      (seen) =>
        seen.runId === input.runId &&
        seen.value.botId === value.botId &&
        JSON.stringify(seen.value.files) === JSON.stringify(value.files),
    );
    if (same) return;
    events = [...events, { runId: input.runId, anchor: input.anchor, value }];
    for (const listener of listeners) listener();
  };
  return {
    subscriber: {
      onRunStartedEvent: ({ event }) => {
        runId = event.runId;
      },
      onCustomEvent: ({ event, messages }) => {
        if (event.name !== TURN_ARTIFACTS_EVENT) return;
        take({
          runId,
          anchor: messages.at(-1)?.id ?? null,
          value: event.value,
        });
      },
    },
    events: () => events,
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take,
  };
}

/**
 * 当前这一轮的事件：事件到时最后一条消息，在最后一条用户消息（含）之后。
 *
 * 「一轮」沿用 `writtenPathsInTurn` 的口径：最后一条用户消息之后的一切。一轮被切成多次 run
 * （后台长跑）时，每次 run 一条事件，都在这一段里。
 */
export function turnArtifactEvents(
  tracked: readonly TrackedTurnArtifacts[],
  messages: ReadonlyArray<Readonly<Message>>,
): TrackedTurnArtifacts[] {
  let turn = -1;
  for (let index = 0; index < messages.length; index++)
    if (messages[index]?.role === "user") turn = index;
  return tracked.filter((event) => {
    if (event.anchor === null) return turn < 0;
    const at = messages.findIndex((message) => message.id === event.anchor);
    return at >= 0 && at >= turn;
  });
}

/**
 * 同一员工本轮的多条事件合并成一份清单：按路径去重，留 modifiedMs 最大的（相同则后到的），链接用那条
 * 事件的 runId；`omitted` 相加，任一条被截断就算截断。员工按第一次出现的先后。
 */
export function mergedTurnArtifacts(
  events: readonly TrackedTurnArtifacts[],
): TurnArtifactGroup[] {
  const groups = new Map<
    string,
    {
      files: Map<string, { bytes: number; runId: string; modifiedMs: number }>;
      omitted: number;
      scanTruncated: boolean;
    }
  >();
  for (const { runId, value } of events) {
    let group = groups.get(value.botId);
    if (!group) {
      group = { files: new Map(), omitted: 0, scanTruncated: false };
      groups.set(value.botId, group);
    }
    group.omitted += value.omitted;
    if (value.scanTruncated) group.scanTruncated = true;
    for (const file of value.files) {
      const seen = group.files.get(file.path);
      if (seen && seen.modifiedMs > file.modifiedMs) continue;
      group.files.set(file.path, {
        bytes: file.bytes,
        runId,
        modifiedMs: file.modifiedMs,
      });
    }
  }
  return [...groups].map(([botId, group]) => ({
    botId,
    files: [...group.files].map(([path, file]) => ({
      path,
      bytes: file.bytes,
      runId: file.runId,
    })),
    omitted: group.omitted,
    scanTruncated: group.scanTruncated,
  }));
}

/**
 * 群转录里这一轮的事件：最后一条人发的消息之后，各条员工回复行 `turnArtifacts` 里记的。
 * 服务器写进去的东西按结构再判一次，不认的整条丢掉。
 */
export function groupTurnArtifactEvents(
  messages: ReadonlyArray<{
    agentId: string | null;
    turnArtifacts?: readonly { runId: string; value: unknown }[];
  }>,
): TrackedTurnArtifacts[] {
  let turn = 0;
  for (let index = 0; index < messages.length; index++)
    if (messages[index]?.agentId === null) turn = index + 1;
  const events: TrackedTurnArtifacts[] = [];
  for (const message of messages.slice(turn))
    for (const item of message.turnArtifacts ?? []) {
      const value = readTurnArtifactsValue(item.value);
      if (value && typeof item.runId === "string" && item.runId !== "")
        events.push({ runId: item.runId, anchor: null, value });
    }
  return events;
}

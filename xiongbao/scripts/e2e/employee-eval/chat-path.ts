/**
 * 评测的单聊执行路径（`EVAL_PATH=chat`）和后台长跑冒烟（`disconnect` / `reconnect`）里不依赖服务器的部分：
 * 路径和结果文件的选择、一轮怎么算结束、要不要追「继续」、断开 / 重连后的各项判断。都是纯函数，单测在
 * `chat-path.test.ts`；起服务器、发请求、读库的部分在 `run-xiongbao.ts`。
 *
 * 两条路径的区别只在「怎么把话交给员工、怎么知道这一轮结束」：
 *  - board：`POST /api/channels/:id/dispatch`，服务器上的无人值守轮，看运行事件和看板卡；
 *  - chat：单聊的运行接口 `POST …/agent/:id/run`，带 `forwardedProps.computerTools = "server"`，电脑工具由服务器
 *    执行，客户端是 HTTP，读事件流到结束，不开浏览器；
 *  - group：新建一个含这位员工的 shared 群聊（`POST /api/groups`），在群里点名发题（`POST /api/groups/:id`），
 *    读群聊记录里这位员工那一行直到它不再 queued / running；员工在群里的那一轮是服务器后台跑的，结果归一成和
 *    chat 同一个结构（`GroupDriven`，对应 run-xiongbao 的 `Driven`）。
 * 拷产物、判分、算指标两条路径用同一套代码。
 */

import {
  digest,
  type StoredMessage,
  type Streamed,
  toolResultsOf,
} from "../chat-client";
import { type Check, check } from "./lib";
import type { EvalPath, Suite } from "./records";

// ---------------------------------------------------------------------------------------------
// 路径和结果文件
// ---------------------------------------------------------------------------------------------

export const EVAL_PATHS: readonly EvalPath[] = ["board", "chat", "group"];

/** `EVAL_PATH`：空是 board（原来的做法）；不认识的值直接报错，免得悄悄跑错路径。 */
export function parseEvalPath(spec: string | undefined): EvalPath {
  const text = (spec ?? "").trim();
  if (!text) return "board";
  if ((EVAL_PATHS as readonly string[]).includes(text)) return text as EvalPath;
  throw new Error(
    `不认识的执行路径「${text}」，可选：${EVAL_PATHS.join("、")}`,
  );
}

/**
 * 结果文件名：看板路径沿用原来的名字（`xiongbao.json`、`smoke.json`），单聊路径加 `-chat`，两条路径的结果
 * 放在同一个目录里互不覆盖，`report.ts` 一起读。
 */
export function resultFileName(suite: Suite, path: EvalPath): string {
  const base = suite === "smoke" ? "smoke" : "xiongbao";
  return path === "board" ? `${base}.json` : `${base}-${path}.json`;
}

/** 产物拷到哪个子目录（结果目录下）。 */
export function artifactDirName(suite: Suite, path: EvalPath): string {
  const base = suite === "smoke" ? "smoke" : "xiongbao";
  return path === "board" ? base : `${base}-${path}`;
}

/** 服务器和电脑的日志文件名，两条路径各一份。 */
export function logFileName(kind: "server" | "computer", path: EvalPath) {
  return path === "board" ? `${kind}.log` : `${kind}-${path}.log`;
}

export const RUNNER_LABEL: Record<EvalPath, string> = {
  board: "看板派活（服务器上的无人值守轮，电脑工具由服务器执行）",
  chat: "单聊接口（forwardedProps.computerTools=server，电脑工具由服务器执行，HTTP 读事件流，不开浏览器）",
  group:
    "群聊（新建含这位员工的 shared 群聊，在群里点名发题，读群聊记录到这位员工的回复结束，电脑工具由服务器执行）",
};

/** 结果文件里写的执行路径说明；看板路径的冒烟里夹着单聊场景（disconnect / reconnect）时，把这一点写明。 */
export function runnerLabel(
  path: EvalPath,
  recordPaths: readonly (EvalPath | undefined)[],
): string {
  return path === "board" && recordPaths.includes("chat")
    ? `${RUNNER_LABEL.board}；后台长跑场景（disconnect / reconnect）走${RUNNER_LABEL.chat}`
    : RUNNER_LABEL[path];
}

// ---------------------------------------------------------------------------------------------
// 一轮怎么算结束，要不要追「继续」
// ---------------------------------------------------------------------------------------------

/*
 * 事件名照服务器的：`step-limit` 在 shared/run-notices.ts，`turn-limit` 在 threads/chat-server-tools.ts，
 * `turn-interrupted` 在 recovery/interrupted-runs.ts。这里不引服务器的模块，只认名字。
 */
const LIMIT_EVENTS: readonly string[] = ["step-limit", "turn-limit"];
const INTERRUPTED_EVENT = "turn-interrupted";

export type RoundEvent = Record<string, unknown> & { type?: string };

/** 一轮的事件读出来的结局。 */
export type RoundState = {
  /** 流里有 RUN_FINISHED 或 RUN_ERROR：服务器说这一轮结束了。 */
  ended: boolean;
  failed: boolean;
  /** 停在时间或段数的上限。 */
  limited: boolean;
  /** 在等人（审批、登录、接管）：RUN_FINISHED 带着 interrupt。 */
  waiting: boolean;
  /** 重启把这一轮标为被打断。 */
  interrupted: boolean;
};

export function roundState(events: readonly RoundEvent[]): RoundState {
  const finished = events.filter((event) => event.type === "RUN_FINISHED");
  return {
    ended: finished.length > 0 || events.some((e) => e.type === "RUN_ERROR"),
    failed: events.some((event) => event.type === "RUN_ERROR"),
    limited: events.some(
      (event) =>
        event.type === "CUSTOM" && LIMIT_EVENTS.includes(String(event.name)),
    ),
    waiting: finished.some(
      (event) =>
        (event.outcome as { type?: unknown } | undefined)?.type === "interrupt",
    ),
    interrupted: events.some(
      (event) => event.type === "CUSTOM" && event.name === INTERRUPTED_EVENT,
    ),
  };
}

/** 停在上限的轮数：每个 `step-limit` / `turn-limit` 事件算一次。 */
export function limitStops(events: readonly RoundEvent[]): number {
  return events.filter(
    (event) =>
      event.type === "CUSTOM" && LIMIT_EVENTS.includes(String(event.name)),
  ).length;
}

/**
 * 一轮结束后做什么，规则和看板路径的循环一样：产物齐了、没出错、没触顶 → 做完；离墙钟只剩不到 30 秒 → 停，
 * 产物没齐算超时；其余追一句「继续」。
 */
export function afterRound(input: {
  state: Pick<RoundState, "failed" | "limited">;
  outputsReady: boolean;
  msLeft: number;
}): { action: "done" | "stop" | "nudge"; timedOut: boolean } {
  if (input.outputsReady && !input.state.failed && !input.state.limited)
    return { action: "done", timedOut: false };
  if (input.msLeft < 30_000)
    return { action: "stop", timedOut: !input.outputsReady };
  return { action: "nudge", timedOut: false };
}

/**
 * 下一轮请求里的整段对话：库里存着的消息，加上这一句话（页面发下一轮时带的就是整段对话）。
 * 对话接口读回来的助手消息里，工具调用是 `{ id, name, args }`，而运行接口要的是 AG-UI 的
 * `{ id, type: "function", function: { name, arguments } }`，所以改回去。
 */
export function conversationWith(
  stored: readonly StoredMessage[],
  text: string,
  id: string,
): { id?: string; role: string; content?: string }[] {
  const history = stored.map((message) =>
    message.toolCalls
      ? {
          ...message,
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.function?.name ?? call.name ?? "",
              arguments: call.function?.arguments ?? call.args ?? "",
            },
          })),
        }
      : message,
  );
  return [...history, { id, role: "user", content: text }];
}

// ---------------------------------------------------------------------------------------------
// 办公题：看板卡那一条只在看板路径查
// ---------------------------------------------------------------------------------------------

export const OFFICE_CARD_CHECK = "任务卡进入等验收且带 workspace_file 证据";

/** 看板路径：卡进入等验收且带证据才算过；单聊路径没有这张卡，标不适用，不算失败。 */
export function officeCardCheck(
  path: EvalPath,
  board: { delivered: boolean; detail: string },
): Check {
  if (path !== "board")
    return check(
      `${OFFICE_CARD_CHECK}（不适用）`,
      true,
      `不适用：${path === "group" ? "群聊" : "单聊"}路径没有看板卡`,
    );
  return check(
    `${OFFICE_CARD_CHECK}（看板路径）`,
    board.delivered,
    board.detail,
  );
}

// ---------------------------------------------------------------------------------------------
// disconnect / reconnect 的各项判断
// ---------------------------------------------------------------------------------------------

export const NOT_RUN = "没有执行";

/**
 * 线程里的调用和结果：每个工具调用都有结果，没有一条结果写着「没有执行」，断开之后这一轮又做了事
 * （调用数比断开时流里见过的多）。
 */
export function transcriptChecks(
  messages: readonly StoredMessage[],
  callsSeenBeforeHangUp: number,
): Check[] {
  const calls = messages.flatMap((message) => message.toolCalls ?? []);
  const results = toolResultsOf([...messages]);
  const answered = new Set(results.map((message) => message.toolCallId));
  const unanswered = calls.filter((call) => !answered.has(call.id));
  const notRun = results.filter((message) =>
    String(message.content ?? "").includes(NOT_RUN),
  );
  return [
    check(
      "线程里每个工具调用都有结果",
      calls.length > 0 && unanswered.length === 0,
      `${calls.length} 个调用，${results.length} 条结果，${unanswered.length} 个没有结果`,
    ),
    check(
      "没有哪条结果写着「没有执行」",
      notRun.length === 0,
      `${notRun.length} 条`,
    ),
    check(
      "断开之后这一轮又调用了工具",
      calls.length > callsSeenBeforeHangUp,
      `断开时流里见过 ${callsSeenBeforeHangUp} 个，线程里共 ${calls.length} 个`,
    ),
  ];
}

/** 这一轮以完成结束：活性行是 finished，事件里有 RUN_FINISHED，没有出错、触顶、等人、被打断。 */
export function finishedCheck(
  liveness: string | undefined,
  events: readonly RoundEvent[],
): Check {
  const state = roundState(events);
  const finished = events.some((event) => event.type === "RUN_FINISHED");
  const flaws = [
    ...(liveness === "finished" ? [] : [`活性 ${liveness ?? "无"}`]),
    ...(finished ? [] : ["没有 RUN_FINISHED"]),
    ...(state.failed ? ["出错"] : []),
    ...(state.limited ? ["停在上限"] : []),
    ...(state.waiting ? ["在等人"] : []),
    ...(state.interrupted ? ["被重启打断"] : []),
  ];
  return check(
    "这一轮以完成结束",
    flaws.length === 0,
    flaws.length ? flaws.join("、") : "活性 finished，RUN_FINISHED",
  );
}

/** 一条发件箱记录（`delivery_outbox`）里判断完成通知要用的几列。 */
export type OutboxRow = { dedupeKey: string; kind: string; state?: string };

/**
 * 九·五的完成通知记录：这一轮结束时没人在看，服务器给本人的每个推送设备记了一条 `reply` 发件箱行，
 * 去重键是 `reply:turn-end:<runId>:…`。
 */
export function noticeCheck(
  rows: readonly OutboxRow[],
  runIds: readonly string[],
): Check {
  const mine = rows.filter(
    (row) =>
      row.kind === "reply" &&
      runIds.some((runId) =>
        row.dedupeKey.startsWith(`reply:turn-end:${runId}:`),
      ),
  );
  return check(
    "线程所属人有一条完成通知记录",
    mine.length > 0,
    `${mine.length} 条（${mine.map((row) => row.state ?? "?").join("、") || "无"}）`,
  );
}

/**
 * 重连：重连后收到后续事件，直到运行结束；重连拿到的流里的调用、结果、回答，和结束后再回放一次的一致。
 * `seenBeforeHangUp` 是断开时第一条流里见过的调用数，`runningAtReconnect` 是重连那一刻这一轮是不是还在跑。
 */
export function replayChecks(input: {
  joined: readonly Streamed[];
  replay: readonly Streamed[];
  seenBeforeHangUp: number;
  runningAtReconnect: boolean;
}): Check[] {
  const joined = digest([...input.joined]);
  const replay = digest([...input.replay]);
  const state = roundState(input.joined);
  return [
    check(
      "重连时这一轮还在跑",
      input.runningAtReconnect,
      input.runningAtReconnect ? "还在跑" : "已经结束，后面是回放不是直播",
    ),
    check(
      "重连后收到后续事件",
      joined.calls.length > input.seenBeforeHangUp,
      `断开时见过 ${input.seenBeforeHangUp} 个调用，重连的流里共 ${joined.calls.length} 个`,
    ),
    check(
      "重连的流以运行结束收尾",
      state.ended && !state.failed,
      state.failed
        ? "流里有 RUN_ERROR"
        : state.ended
          ? "RUN_FINISHED"
          : "流断了",
    ),
    check(
      "重连拿到的调用与结束后回放一致",
      sameList(joined.calls, replay.calls),
      `${joined.calls.length} 对 ${replay.calls.length}`,
    ),
    check(
      "重连拿到的结果与结束后回放一致",
      sameList(joined.results, replay.results),
      `${joined.results.length} 对 ${replay.results.length}`,
    ),
    check(
      "重连拿到的回答与结束后回放一致",
      joined.said === replay.said,
      `${joined.said.length} 字对 ${replay.said.length} 字`,
    ),
  ];
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

// ---------------------------------------------------------------------------------------------
// 群聊路径：HTTP 建群、发题、读群聊记录
// ---------------------------------------------------------------------------------------------

/** 群聊记录里一条消息（`GET /api/groups/:id` 的 `messages` 里这位员工那一行用到的几列）。 */
export type GroupRow = {
  id: string;
  agentId?: string | null;
  threadId?: string | null;
  text?: string;
  status?: string;
  stepLimit?: unknown;
  turnArtifacts?: { runId: string; value: { files: { path: string }[] } }[];
};

/** 一轮群聊里这位员工的回复，读到不再 queued / running 为止。 */
export type GroupReply = {
  id: string;
  threadId: string | undefined;
  status: string;
  text: string;
  limited: boolean;
  /** 这一轮电脑上留下的文件所在的运行号（下载路由的范围用）。 */
  artifactRuns: string[];
};

const groupFetch = async (
  origin: string,
  cookie: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) => {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
};

/** 新建 shared 群聊（服务器要求至少两位员工），返回群聊 id。 */
export async function createSharedGroup(
  origin: string,
  cookie: string,
  agentIds: readonly string[],
): Promise<string> {
  const made = await groupFetch(origin, cookie, "/api/groups", {
    method: "POST",
    body: { agentIds },
  });
  const id = (made.body as { channel?: { id?: unknown } } | null)?.channel?.id;
  if (made.status !== 201 || typeof id !== "string")
    throw new Error(
      `create group answered ${made.status}: ${JSON.stringify(made.body).slice(0, 300)}`,
    );
  return id;
}

/** 在群里点名一位员工发一句话（只有它答）。 */
export async function sendGroupMessage(
  origin: string,
  cookie: string,
  channelId: string,
  message: { id: string; text: string; agentId: string },
): Promise<void> {
  const sent = await groupFetch(origin, cookie, `/api/groups/${channelId}`, {
    method: "POST",
    body: message,
  });
  if (sent.status !== 202)
    throw new Error(
      `send to group answered ${sent.status}: ${JSON.stringify(sent.body).slice(0, 300)}`,
    );
}

/** 读群聊记录里这句话下面、这位员工的那一行。还没有（没排上）返回 undefined。 */
export async function readGroupRow(
  origin: string,
  cookie: string,
  channelId: string,
  messageId: string,
  agentId: string,
): Promise<GroupRow | undefined> {
  const listed = await groupFetch(origin, cookie, `/api/groups/${channelId}`);
  if (listed.status !== 200)
    throw new Error(
      `group transcript answered ${listed.status}: ${JSON.stringify(listed.body).slice(0, 300)}`,
    );
  const messages =
    (listed.body as { messages?: GroupRow[] } | null)?.messages ?? [];
  // 回复行的 id 是 `<这句话的 id>:<员工 id>`（服务器按这个规则建行）。
  return messages.find((row) => row.id === `${messageId}:${agentId}`);
}

/**
 * 读群聊里这位员工的回复到它不再排队 / 在跑：`completed`、`failed`、`waiting`（等人）都算这一轮结束。
 * 读到墙钟上限还没结束返回 undefined（服务器上的这一轮不受影响）。
 */
export async function readGroupReply(input: {
  origin: string;
  cookie: string;
  channelId: string;
  messageId: string;
  agentId: string;
  deadline: number;
  pollMs?: number;
}): Promise<GroupReply | undefined> {
  const pollMs = input.pollMs ?? 1000;
  for (;;) {
    const row = await readGroupRow(
      input.origin,
      input.cookie,
      input.channelId,
      input.messageId,
      input.agentId,
    );
    if (row && row.status !== "queued" && row.status !== "running")
      return {
        id: row.id,
        threadId: row.threadId ?? undefined,
        status: row.status ?? "completed",
        text: row.text ?? "",
        limited: row.stepLimit !== undefined && row.stepLimit !== null,
        artifactRuns: [
          ...new Set((row.turnArtifacts ?? []).map((item) => item.runId)),
        ],
      };
    if (Date.now() + pollMs > input.deadline) return undefined;
    await Bun.sleep(pollMs);
  }
}

/** 群聊路径一道题的结果：字段和 `run-xiongbao.ts` 的 `Driven` 对齐，那边直接并进同一套判分和记录。 */
export type GroupDriven = {
  /** 这位员工在群里的对话 id：运行号从这里读（同单聊路径）。 */
  threadId?: string;
  channelId: string;
  nudges: number;
  timedOut: boolean;
  error?: string;
  /** 发出去的话数（每句一轮）。 */
  sent: number;
  /** 各轮里这位员工的回复，按先后。 */
  replies: GroupReply[];
};

/**
 * 群聊路径：新建含这位员工和另一位同伴的 shared 群聊（群至少两位员工），点名这位员工发题，读到它的回复结束；
 * 产物没齐、没出错、没触顶之外的情况在同一个群里点名发「继续」，规则同单聊（`afterRound`）。
 */
export async function driveGroup(input: {
  origin: string;
  cookie: string;
  agentId: string;
  peerId: string;
  prompt: string;
  nudge: string;
  deadline: number;
  maxNudges: number;
  outputsReady: () => boolean;
  newId: () => string;
  pollMs?: number;
}): Promise<GroupDriven> {
  const out: GroupDriven = {
    channelId: "",
    nudges: 0,
    timedOut: false,
    sent: 0,
    replies: [],
  };
  try {
    out.channelId = await createSharedGroup(input.origin, input.cookie, [
      input.agentId,
      input.peerId,
    ]);
    for (let round = 0; round <= input.maxNudges; round += 1) {
      const messageId = input.newId();
      await sendGroupMessage(input.origin, input.cookie, out.channelId, {
        id: messageId,
        text: round === 0 ? input.prompt : input.nudge,
        agentId: input.agentId,
      });
      out.sent += 1;
      if (round > 0) out.nudges += 1;
      const reply = await readGroupReply({
        origin: input.origin,
        cookie: input.cookie,
        channelId: out.channelId,
        messageId,
        agentId: input.agentId,
        deadline: input.deadline,
        ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }),
      });
      if (!reply) {
        out.timedOut = true;
        break;
      }
      out.replies.push(reply);
      if (reply.threadId) out.threadId = reply.threadId;
      const next = afterRound({
        state: { failed: reply.status === "failed", limited: reply.limited },
        outputsReady: input.outputsReady(),
        msLeft: input.deadline - Date.now(),
      });
      if (next.action !== "nudge") {
        out.timedOut = next.timedOut;
        break;
      }
    }
  } catch (thrown) {
    out.error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  return out;
}

import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import {
  IconFileText,
  IconFolder,
  IconPlug,
  IconSearch,
  IconSubtask,
  IconTool,
  IconWorld,
} from "@tabler/icons-react";
import { outcomeForPerson } from "@xiongbao/shared/approval-outcomes";
import {
  readConnectPrompt,
  SHOW_APP_ACCESS_TOOL,
} from "@xiongbao/shared/connect-prompt";
import { researchRoleOfTool } from "@xiongbao/shared/research";
import {
  readSubagentResult,
  SUBAGENT_TOOL,
  type SubagentResult,
} from "@xiongbao/shared/subagent";
import {
  answersTheModel,
  connectorName,
  ownToolAttempt,
  readToolName,
} from "@xiongbao/shared/tool-name";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Streamdown } from "streamdown";
import { PendingApprovals } from "@/components/approvals/inline-approval";
import { acpStepDetail } from "@/lib/channels/acp-args";
import { type RunStage, stageWords } from "@/lib/channels/run-stage";
import { readOutcome } from "@/lib/computers/activity";
import { codingLook, foreignCodingCall } from "@/lib/copilot/coding-calls";
import {
  type FolderNames,
  FolderNamesContext,
  folderStepBody,
  folderStepSubject,
} from "@/lib/folders/folder-steps";
import { markdownComponents, markdownPlugins } from "@/lib/markdown";
import {
  RESEARCH_RESULTS_LABELS,
  type ResearchSource,
  readResearchSources,
} from "@/lib/plugins/research-results";
import {
  asText,
  forDisplay,
  REFUSAL_MARKER,
  refusalOf,
  toolResultFailed,
  UNOFFERED_TOOL_SENTENCE,
  unofferedTool,
} from "@/lib/plugins/tool-result";
import { elapsedSuffix } from "@/lib/spent-of";
import { readTeamBotConsent } from "@/lib/team-bots";
import { isStaffingProposalTool } from "../../../../shared/staffing-proposal";
import {
  awaitingFreshLook,
  browserStepDetails,
  isBrowserStep,
} from "./browser-activity";
import type { VisibleChatItem } from "./chat-messages";
import { codingOutcome, lookStep } from "./coding-tool-cards";
import { ResearchResults } from "./research-results";
import { SubtaskStep } from "./subtask-step";
import { elapsedWords, failureWords, ToolLine } from "./tool-line";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/** Adjacent things a Bot did, drawn as one line that opens to each of them. */
export type ToolGroup = {
  kind: "tools";
  id: string;
  steps: ToolItem[];
};
export type TranscriptItem = VisibleChatItem | ToolGroup;

/**
 * Fold adjacent tool calls into one row, so a reply that searched, read two pages and checked Drive
 * reads as one thing the Bot did rather than four lines before the answer.
 *
 * Only calls drawn as a plain line are folded: browser steps, connector (MCP) tools, and any other
 * tool the app has no component for, such as an external agent's `run_command`. A tool the app draws
 * itself, a chart or a request for help, stays where it is, and so does a refusal that asks the
 * person to connect their own account, because a question for the person must never sit behind a
 * disclosure.
 *
 * A coding harness's reads and searches fold too, though the app draws them, because Claude Code
 * folds them: a run of Read, Grep, Glob and plain `ls`, `cat` or `grep` commands is one line saying
 * "Read 3 files and searched for 2 patterns" (its changelog, 2.1.0 to 2.1.89). Its edits, writes,
 * other commands and plan keep their own rows, as they do there. A single call on its own keeps its own line; one browser step is still a group, as it
 * always was, so the row does not change shape when the second step arrives.
 *
 * `isDrawn` says which tools the app draws itself; the transcript reads it from `useDrawnTool`.
 *
 * EVERY RUN IS A GROUP, A RUN OF ONE INCLUDED, AND KEEPS ITS ROW ID FOR ITS WHOLE LIFE. A lone call
 * used to be its own `tool` row and became a `tools` row when a second call arrived, under the same
 * key but a different tree, so React tore the row down and rebuilt it and its entrance replayed. A
 * group took its first step's id, so when that step turned out to ask the person something and left,
 * the group's id changed and it was rebuilt again. Now the transcript draws a group of one as the
 * line it always was, inside the one row type, and `rowIds` remembers which row each step was drawn
 * in: a run reuses the row of the first of its steps no earlier run in this pass has claimed. Group
 * ids carry a `group:` prefix, so they can never collide with a single row's id.
 */
export function groupToolSteps(
  items: readonly VisibleChatItem[],
  isDrawn: (name: string) => boolean,
  rowIds: Map<string, string> = new Map(),
): TranscriptItem[] {
  const segments: (VisibleChatItem | ToolItem[])[] = [];
  let run: ToolItem[] = [];
  const close = () => {
    if (run.length > 0) segments.push(run);
    run = [];
  };
  for (const item of items) {
    // Nothing happened, and the Bot looks and goes again: not a step to show (`awaitingFreshLook`).
    if (item.kind === "tool" && awaitingFreshLook(item)) continue;
    if (item.kind === "tool" && foldable(item, isDrawn)) {
      run.push(item);
      continue;
    }
    close();
    segments.push(item);
  }
  close();

  // Runs claim their rows first, so a group keeps its row when its first step leaves it...
  const claimed = new Set<string>();
  const runIds = new Map<ToolItem[], string>();
  for (const segment of segments) {
    if (!Array.isArray(segment)) continue;
    const [first] = segment;
    if (!first) continue;
    const kept = segment
      .map((step) => rowIds.get(step.id))
      .find((id) => id !== undefined && !claimed.has(id));
    const id = kept ?? `group:${first.id}`;
    claimed.add(id);
    runIds.set(segment, id);
    for (const step of segment) rowIds.set(step.id, id);
  }

  // ...and a lone call that stops folding (its answer asks the person) keeps the row it had.
  return segments.map((segment): TranscriptItem => {
    if (Array.isArray(segment)) {
      return {
        kind: "tools",
        id: runIds.get(segment) ?? "",
        steps: segment,
      };
    }
    if (segment.kind !== "tool") return segment;
    const previous = rowIds.get(segment.id);
    if (previous === undefined || claimed.has(previous)) return segment;
    claimed.add(previous);
    return { ...segment, id: previous };
  });
}

function foldable(item: ToolItem, isDrawn: (name: string) => boolean): boolean {
  if (isBrowserStep(item)) return true;
  const name = item.toolCall.function.name;
  const args = item.toolCall.function.arguments;
  if (codingLook(name, args) !== null) return true;
  /*
   * A subtask is a card of its own again (期四): the Bots now share work out on purpose, several parts
   * at once, and a person wants to see each part, how far it got and what it handed back, without
   * opening a line. It still gathers with the work beside it, so the row keeps its shape, but the
   * group draws it apart from that work: one card per subtask, side by side (`SubtaskCards`), and the
   * folded line counts only the searches and pages, so nothing is drawn twice.
   */
  if (name === SUBAGENT_TOOL) return true;
  // Another harness's tool under one of Claude Code's names is not drawn as Claude Code's.
  if (
    !name.startsWith("mcp__") &&
    isDrawn(name) &&
    !foreignCodingCall(name, args)
  )
    return false;
  /*
   * The app-access card is drawn from a server tool's answer, so no renderer registers it and the
   * registry cannot say so. Never folded — not even while its answer is still on the way, or the
   * card would land inside a group and then jump out of it.
   */
  if (name === SHOW_APP_ACCESS_TOOL) return false;
  // 招聘与组群的起草也画成一张等人确认的卡片，同样不折进「用了几个工具」，答复还没回来时也不折。
  if (isStaffingProposalTool(name)) return false;
  return !asksThePerson(item.result);
}

const NOTHING_DRAWN: readonly { name: string }[] = [];

/**
 * Whether the app draws a tool itself, read from CopilotKit's own renderer registry.
 *
 * Read from the registry rather than kept as a list here, because every `useRenderTool` and
 * `useFrontendTool` already registers its name there, and a list would fall behind the first tool
 * added without it. Taken from the context directly, not through `useCopilotKit`, because that
 * throws outside a provider and the transcript is drawn without one in places. With no provider
 * nothing is drawn. A `*` renderer draws every tool it is asked about, so nothing outside MCP folds.
 */
export function useDrawnTool(): (name: string) => boolean {
  const copilotkit = useContext(CopilotKitContext)?.copilotkit;
  const subscribe = useCallback(
    (onChange: () => void) =>
      copilotkit
        ? copilotkit.subscribe({ onRenderToolCallsChanged: onChange })
            .unsubscribe
        : () => {},
    [copilotkit],
  );
  const renderers = useSyncExternalStore(
    subscribe,
    () => copilotkit?.renderToolCalls ?? NOTHING_DRAWN,
  );
  return useMemo(() => {
    const names = new Set(renderers.map((renderer) => renderer.name));
    return names.has("*") ? () => true : (name) => names.has(name);
  }, [renderers]);
}

/**
 * Whether this refusal is a question for the person rather than a line about what a Bot did.
 *
 * Both of these draw a card with something to press — a Team Bot asking to act as them, and an app
 * they cannot use yet (not connected, lost at the vendor, or a team account nobody connected) — and neither may sit behind a disclosure for the same reason: a question
 * nobody can see is a conversation that has stopped without saying so.
 */
function asksThePerson(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  if (!answer.startsWith(REFUSAL_MARKER)) return false;
  const body = answer.slice(REFUSAL_MARKER.length).trim();
  return readTeamBotConsent(body) !== null || readConnectPrompt(body) !== null;
}

/** The app a tool item draws a card for, or null when it draws none. */
function cardApp(item: ToolItem): string | null {
  if (item.result === undefined) return null;
  const answer = asText(item.result);
  const prompt = answer.startsWith(REFUSAL_MARKER)
    ? readConnectPrompt(answer.slice(REFUSAL_MARKER.length).trim())
    : item.toolCall.function.name === SHOW_APP_ACCESS_TOOL
      ? readConnectPrompt(answer)
      : null;
  return prompt?.serverId ?? null;
}

/**
 * One card per app per turn.
 *
 * A refused call already draws the app's card, and a Bot told to show the card for an app it cannot
 * use often calls `show_app_access` for the same app straight after, which drew the same card again.
 * The refused call is kept, because it is what the Bot did; a later `show_app_access` for an app
 * whose card that turn already drew is dropped. A person's next message starts a new turn.
 */
export function dropRepeatedAppCards(
  items: readonly VisibleChatItem[],
): VisibleChatItem[] {
  const drawn = new Set<string>();
  return items.filter((item) => {
    if (item.kind === "text" && item.role === "user") drawn.clear();
    if (item.kind !== "tool") return true;
    const app = cardApp(item);
    if (app === null) return true;
    const repeat =
      drawn.has(app) && item.toolCall.function.name === SHOW_APP_ACCESS_TOOL;
    drawn.add(app);
    return !repeat;
  });
}

type StepKind =
  | "search"
  | "fetch"
  | "browser"
  | "connector"
  | "tool"
  // A coding harness's reads and searches, counted as Claude Code counts them.
  | "file"
  | "pattern"
  | "directory"
  // Part of the work given to a subagent: a fresh run of the same Bot. See `SubtaskStep`.
  | "subtask";

export type StepDetails = {
  id: string;
  kind: StepKind;
  label: string;
  /** What it was done to: a query, a page, a connector. Muted beside the label. */
  detail?: string;
  href?: string;
  pending: boolean;
  failed: boolean;
  refused: boolean;
  reason?: string;
  /** Pages a browser step opened, or a fetch read; zero for anything else. */
  pages: number;
  /** The connector a connector step reached, said the way a person would. */
  connector?: string;
  inputs: [string, string][];
  output?: string;
  /** The output is a file, a command's output or a search's matches: drawn as it came, not as markdown. */
  verbatim?: boolean;
  /**
   * The pages a web search found or a page read returned, read out of the provider's answer. When
   * set, the step opens to these and nothing else: its inputs were the model's (an objective, a
   * session id) and its output was the provider's JSON.
   */
  sources?: ResearchSource[];
  /**
   * 这一步跑了多久，毫秒。结果自己带了才填，行上才写；没带就没有这个字段，也就一个字不多。
   * 见 `ToolLine` 的 `elapsed` 和 `elapsedWords`。
   */
  elapsedMs?: number;
  /**
   * 失败那一步的退出码，结果自己带了才有。命令类工具给的是进程的退出状态，别的工具没有这个
   * 字段，也就不会凭空出现「退出码 0」。
   */
  exitCode?: number;
  /**
   * 失败那一步的原因，来自结果里 `error` 那一句（没有它时是 stderr 的第一行），不是这里编的。
   * 没有退出码可报时行上用它，说得长时截到行放得下的宽度（`failureWords`）；两个都没有，行上就只有
   * 原来那句「没成功」。
   */
  failure?: string;
  /** A subtask's own facts, which its row reads to find and draw the steps it took. */
  subtask?: {
    toolCallId: string;
    task?: string;
    /** Null while it works, after a turn that stopped before it answered, or when it was refused. */
    result: SubagentResult | null;
  };
};

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const found = value.find(
        (entry): entry is string => typeof entry === "string" && !!entry.trim(),
      );
      if (found) return found.trim();
    }
  }
  return undefined;
}

/**
 * 结果里带了耗时才写这一件，带了失败的原因才写那一件：两个都不是这里编出来的。命令没写 `error`
 * 时它的原因就是 stderr 的第一行（`error` 优先，因为那是工具自己总结的一句）。
 */
function failureLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.split("\n").find((entry) => entry.trim());
  return line?.trim();
}

/**
 * 结果里那两个事实：这一步跑了多久，失败那一步的退出码或原因。
 *
 * 导出给单工具行（`chat-transcript.tsx` 的 `ServerToolLine`）共用：同一条结果在分组行与单行上
 * 说的是同一件事，不再各算各的（WP-3.2 S0）。
 *
 * 命令、浏览器动作和读文件都以一个 JSON 对象回答，`elapsedMs` 是 shell 那边量的
 * （`agent-computer/src/shell.ts`），`exitCode` 是进程给的；一个用文字回答的工具两个都没有。读法走
 * Activity 面板那一份 `readOutcome`——两处读同一个结果，就不要各写一套解析，以前正是各写一套让同一
 * 步在行上和面板上说了两样。这里只搬结果自己写了的字段：读不出对象的、值不是有限非负数的、退出码
 * 不是整数的，一律什么都不返回。行上宁可少说一件事，也不要造一个 `0.0s` 或 `退出码 0`。
 */
export function resultFacts(result: string | undefined): {
  elapsedMs?: number;
  exitCode?: number;
  failure?: string;
} {
  const outcome = (readOutcome(result) ?? {}) as Record<string, unknown>;
  const { elapsedMs, exitCode, error, stderr } = outcome;
  const facts: { elapsedMs?: number; exitCode?: number; failure?: string } = {};
  if (
    typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0
  )
    facts.elapsedMs = elapsedMs;
  if (typeof exitCode === "number" && Number.isInteger(exitCode))
    facts.exitCode = exitCode;
  const reason = failureLine(error) ?? failureLine(stderr);
  if (reason) facts.failure = reason;
  return facts;
}

function urlsOf(args: Record<string, unknown>): string[] {
  const urls = Array.isArray(args.urls) ? args.urls : [args.url];
  return urls.filter(
    (url): url is string => typeof url === "string" && !!url.trim(),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A value from a tool's arguments, short enough for one line. */
function inputValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * The arguments a step lists when it is opened, as a person reads them.
 *
 * A folder step's `grantId` is the id XiongBao gave the folder grant ("host-grant-74138-…"), written
 * for the model; the line already names the file, and Settings > Computer the folder. Listed, an
 * opened "Save a file" read "grantId  host-grant-74138-1794115092137885000" above the file's path.
 */
function readableInputs(
  name: string,
  args: Record<string, unknown>,
): [string, string][] {
  return Object.entries(args)
    .filter(([key]) => !(name.startsWith("host_") && key === "grantId"))
    .map(([key, value]) => [key, inputValue(value)] as [string, string]);
}

export function stepDetails(step: ToolItem): StepDetails {
  return detailsOf(step, new Map());
}

/** `stepDetails`, naming a folder step's folder from the conversation's folder names. */
export function stepDetailsIn(
  folders: FolderNames,
): (step: ToolItem) => StepDetails {
  return (step) => detailsOf(step, folders);
}

function detailsOf(step: ToolItem, folders: FolderNames): StepDetails {
  const args = objectOf(step.toolCall.function.arguments);
  const inputs = readableInputs(step.toolCall.function.name, args);
  // 耗时和退出码都在结果里，谁回答谁带；没有带的分支下面也就一个字段都不多。
  const facts = resultFacts(step.result);
  if (isBrowserStep(step)) {
    const browser = browserStepDetails(step);
    return {
      ...facts,
      id: step.id,
      kind: "browser",
      label: browser.label ?? "用了浏览器",
      ...(browser.title ? { detail: browser.title } : {}),
      ...(browser.href ? { href: browser.href } : {}),
      pending: browser.pending,
      failed: browser.failed,
      refused: false,
      ...(browser.reason ? { reason: browser.reason } : {}),
      pages: browser.visited ? 1 : 0,
      inputs,
    };
  }

  const name = step.toolCall.function.name;
  if (name === SUBAGENT_TOOL) return subtaskDetails(step, args);
  const look = codingLook(name, step.toolCall.function.arguments);
  if (look !== null) {
    // Running whenever it has no result: whether the turn still is, the step's status says.
    const outcome = codingOutcome(step.result, true);
    const { label, detail } = lookStep(name, args, look, outcome);
    const output = outcome.text.replace(/\s+$/, "");
    return {
      ...facts,
      id: step.id,
      kind: look,
      label,
      ...(detail ? { detail } : {}),
      pending: step.result === undefined,
      failed: outcome.state === "failed",
      refused: false,
      pages: 0,
      inputs: [],
      ...(output ? { output, verbatim: true } : {}),
    };
  }
  const answer = step.result === undefined ? undefined : asText(step.result);
  // Behind the marker, or a step the person declined on the conversation's card. See `refusalOf`.
  const reason = refusalOf(answer);
  const refused = reason !== undefined;
  // A refusal is said in the person's words, never in the sentence written for the Bot.
  const body = refused ? outcomeForPerson(reason.reason) : answer;
  // A tool whose answer is for the model, not the person; see `ServerToolLine`.
  const own = answersTheModel(name);
  // A tool the Bot was never offered: the runtime's answer lists every tool it has, for the model.
  const unoffered = unofferedTool(step.result);
  const outcome = {
    ...facts,
    id: step.id,
    pending: step.result === undefined,
    failed: !refused && (unoffered || toolResultFailed(step.result)),
    refused,
    // Neither what it was given nor what it said: both were for the model (a tool search's query
    // and limit), so the line says what it did and does not open.
    inputs: own ? [] : inputs,
    ...(body && !own && folderStepBody(name, body)
      ? {
          output: unoffered
            ? UNOFFERED_TOOL_SENTENCE
            : (folderStepBody(name, body) ?? ""),
        }
      : {}),
  };
  // A folder step names its file and folder ("todo.txt in share"), never a grant id.
  const folderSubject = folderStepSubject(name, args, folders);
  /*
   * 外部员工报的一步：它自己给这一步起的标题、它说要动哪些文件、参数有没有长到没往下发——同一句话在
   * 对话里单独成行的那一支也是这么说的（`chat-transcript` 走同一个 `acpStepDetail`），两处不会说岔。
   */
  const subject = name.startsWith("acp/")
    ? (folderSubject ?? acpStepDetail(args))
    : folderSubject;
  // Not a connector: one of this deployment's own tools, or one an external agent runs itself.
  // Named in words, never as an identifier.
  if (!name.startsWith("mcp__"))
    return {
      ...outcome,
      kind: "tool",
      // Beside "Blocked", what was tried: "Save a file", not "Saved a file", which did not happen.
      label:
        (refused ? ownToolAttempt(name) : null) ??
        readToolName(name, outcome.pending).label,
      ...(subject ? { detail: subject } : {}),
      pages: 0,
    };

  const [, server = "", ...rest] = name.split("__");
  const role = researchRoleOfTool(server, rest.join("__"));
  const { label, detail } = readToolName(name);
  const urls = role === "fetch" ? urlsOf(args) : [];
  const sources =
    role && !outcome.failed && !refused && body
      ? readResearchSources(body)
      : null;
  const base = { ...outcome, label, ...(sources ? { sources } : {}) };
  if (role === "search") {
    const query = firstString(
      args.query,
      args.objective,
      args.search_queries,
      args.queries,
    );
    return {
      ...base,
      kind: "search",
      ...(query ? { detail: query } : {}),
      pages: 0,
    };
  }
  if (role === "fetch") {
    const [first, ...more] = urls;
    const href = first && /^https?:\/\//.test(first) ? first : undefined;
    return {
      ...base,
      kind: "fetch",
      ...(first
        ? {
            detail: more.length
              ? `${hostOf(first)} and ${more.length} more`
              : hostOf(first),
          }
        : {}),
      ...(href && !more.length ? { href } : {}),
      pages: Math.max(urls.length, 1),
    };
  }
  return {
    ...base,
    kind: "connector",
    ...(detail ? { detail } : {}),
    pages: 0,
    connector: connectorName(server),
  };
}

/*
 * The sentences a subtask's server writes for the BOT, as the words the PERSON reads.
 *
 * They are written for the Bot because they are its instructions: the cap sentence tells it to do
 * the part itself, the stopped ones tell it what ended the run. The server cannot answer with two
 * texts, and those sentences are pinned by the server's own tests, so they stay as they are and this
 * table translates the copy on screen — the same way `shared/approval-outcomes.ts` translates the
 * approval sentences a step is answered with, for the steps that are not subtasks.
 *
 * MATCHED AT THE START, NEVER IN FULL: every number in these sentences is the deployment's (how many
 * subagents one run may start, how long a turn may take), and the reason after a stopped run is the
 * provider's own text. Pinning a whole sentence would break the day somebody changes the limit, and
 * would say "5" where the server said something else. What no row recognises is returned as it came:
 * a person reading one sentence in English is worse than a person reading a wrong number.
 */
const SUBTASK_SENTENCES: [RegExp, (matched: RegExpExecArray) => string][] = [
  [
    /^No subagent was started: one answer can start up to (\d+) subagents/,
    (matched) =>
      `一次运行最多启动 ${matched[1]} 个子任务，这一次已经用完了，所以这一个没有开始。`,
  ],
  [
    /^No subagent was started: in a task from a check-in/,
    () => "这个任务里每一步都要在这段对话里问你，所以这一个没有开始。",
  ],
  [
    /^No subagent was started: say what the task is/,
    () => "没有说清任务和要回来的答案，所以这一个没有开始。",
  ],
  [
    /^The subagent did not finish: The routine's turn was stopped after (\d+)s/,
    (matched) => `它运行了 ${matched[1]} 秒后被停下来，没能给出答案。`,
  ],
  [
    /^The subagent did not finish: The headless tool continuation limit/,
    () => "它连续调用工具的轮数到了上限，被停下来，没能给出答案。",
  ],
  [
    /^The subagent did not finish: The headless turn was cancelled/,
    () => "这次运行被取消了，没能给出答案。",
  ],
  [
    /^The subagent did not finish: The Bot stopped before it finished/,
    () => "它在给出答案之前停了下来。",
  ],
  [
    /^The subagent did not finish: The turn finished without saying anything/,
    () => "它跑完了，但没有给出答案。",
  ],
  [
    /^The subagent did not finish: The turn stopped to ask a question/,
    () => "它停下来想问一个问题，可子任务里没有人在，它没有得到回答。",
  ],
  [
    /^The subagent did not finish: ([\s\S]+)$/,
    (matched) => `它没能完成：${matched[1]}`,
  ],
  [/^This action is waiting for your approval\.$/, () => "这一步在等你批准。"],
  [
    /^This needs you: ([\s\S]*?)(?: Do it yourself,[\s\S]*)?$/,
    (matched) => `这一步需要你亲自去做：${matched[1]}`,
  ],
];

/** 子任务卡上的一句话：认得出的换成中文，认不出的原样给出。 */
export function subtaskWordsFor(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const [sentence, words] of SUBTASK_SENTENCES) {
    const matched = sentence.exec(text);
    if (matched) return words(matched);
  }
  return text;
}

/**
 * A subtask as a step: what it was asked to do, and how it ended.
 *
 * Stopping before an action that needs approval is not a failure. Nothing was done, and the Bot that
 * started it does that action itself, in the conversation, where the person is asked. So the row
 * says it was handed back and nothing more urgent: the approval card, when there is one, is the
 * Bot's own, further down.
 */
function subtaskDetails(
  step: ToolItem,
  args: Record<string, unknown>,
): StepDetails {
  const task =
    typeof args.task === "string" && args.task.trim()
      ? args.task.trim()
      : undefined;
  const answer = step.result === undefined ? undefined : asText(step.result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  const result =
    answer === undefined || refused ? null : readSubagentResult(answer);
  const output = refused
    ? subtaskWordsFor(answer?.slice(REFUSAL_MARKER.length).trim())
    : result && "answer" in result
      ? result.answer
      : result && "error" in result
        ? subtaskWordsFor(result.error)
        : undefined;
  return {
    id: step.id,
    kind: "subtask",
    label: "子任务",
    ...(task ? { detail: task } : {}),
    pending: answer === undefined,
    failed:
      !refused &&
      answer !== undefined &&
      (result === null || "error" in result),
    refused,
    pages: 0,
    inputs: [],
    ...(output ? { output } : {}),
    subtask: {
      toolCallId: step.toolCall.id,
      ...(task ? { task } : {}),
      result,
    },
  };
}

function joinPhrases(phrases: string[]): string {
  return phrases.join("，");
}

/** The site a page is on, as people say it: the host without `www.`. Empty when the address is not one. */
function siteOf(href: string | undefined): string {
  if (!href) return "";
  try {
    const { hostname, protocol } = new URL(href);
    if (protocol !== "http:" && protocol !== "https:") return "";
    return hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * What a group of steps did, as one phrase: "Searched the web and read 2 pages".
 *
 * Counted by kind rather than listed, because the list is what the line opens to. Research is
 * never attributed to a provider; a connector is named, because which system was reached is the
 * person's own fact.
 */
export function summarise(steps: readonly StepDetails[]): string {
  const of = (kind: StepKind) => steps.filter((step) => step.kind === kind);
  const phrases: string[] = [];
  // Claude Code's own words for a run of reads and searches.
  const files = of("file").length;
  if (files) phrases.push(`读了 ${files} 个文件`);
  const patterns = of("pattern").length;
  if (patterns) phrases.push(`搜索了 ${patterns} 个模式`);
  const directories = of("directory").length;
  if (directories) phrases.push(`列出了 ${directories} 个目录`);
  if (of("search").length) phrases.push("搜索了网络");
  const read = of("fetch").reduce((sum, step) => sum + step.pages, 0);
  if (read) phrases.push(`读了 ${read} 个网页`);
  const browser = of("browser");
  const browsed = browser.reduce((sum, step) => sum + step.pages, 0);
  // One site is named, as a person would say where they went: "Browsed example.com", "Browsed 3 pages on gov.uk".
  const sites = [
    ...new Set(
      browser.filter((step) => step.pages > 0).map((step) => siteOf(step.href)),
    ),
  ];
  const site = sites.length === 1 ? sites[0] : undefined;
  if (browsed && site)
    phrases.push(
      browsed === 1
        ? `浏览了 ${site}`
        : `在 ${site} 上浏览了 ${browsed} 个网页`,
    );
  else if (browsed) phrases.push(`浏览了 ${browsed} 个网页`);
  else if (browser.length) phrases.push("用了浏览器");
  const connectors = [
    ...new Set(of("connector").map((step) => step.connector ?? "")),
  ].filter(Boolean);
  if (connectors.length === 1) phrases.push(`用了 ${connectors[0]}`);
  else if (connectors.length > 1)
    phrases.push(`用了 ${connectors.length} 个连接器`);
  const subtasks = of("subtask").length;
  if (subtasks)
    phrases.push(
      subtasks === 1 ? "执行了一个子任务" : `执行了 ${subtasks} 个子任务`,
    );
  const tools = of("tool").length;
  if (tools) phrases.push(`用了 ${tools} 个工具`);
  return joinPhrases(phrases);
}

const KIND_ICONS = {
  search: IconSearch,
  fetch: IconFileText,
  browser: IconWorld,
  connector: IconPlug,
  tool: IconTool,
  file: IconFileText,
  pattern: IconSearch,
  directory: IconFolder,
  subtask: IconSubtask,
} as const;

export function StepIcon({
  kind,
  size = "size-4",
}: {
  kind: StepKind;
  size?: string;
}) {
  const Icon = KIND_ICONS[kind];
  return <Icon aria-hidden className={`${size} shrink-0`} stroke={2} />;
}

/**
 * One small icon per kind of step, overlapped, in the order they first happened.
 *
 * The first is drawn on top. Drawn the other way, each circle's ring cuts into the icon before it,
 * and a magnifying glass with its handle cut off reads as the letter C.
 */
function IconStack({ kinds }: { kinds: StepKind[] }) {
  return (
    <span aria-hidden className="flex items-center">
      {kinds.map((kind, index) => (
        <span
          key={kind}
          style={{ zIndex: kinds.length - index }}
          className={`relative flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background ${
            index > 0 ? "-ml-1.5" : ""
          }`}
        >
          <StepIcon kind={kind} size="size-4" />
        </span>
      ))}
    </span>
  );
}

export function StepStatus({
  step,
  active,
}: {
  step: StepDetails;
  active: boolean;
}) {
  if (step.pending)
    return (
      <span className="shrink-0 text-muted-foreground">
        {active ? "进行中" : "未完成"}
      </span>
    );
  if (step.refused)
    return <span className="shrink-0 text-destructive">已拦下</span>;
  if (step.failed)
    return (
      <span className="shrink-0 text-amber-600 dark:text-amber-500">
        没成功
      </span>
    );
  return null;
}

/**
 * 同一步派出的子任务（期四）：上面一行说一共几个、还有几个在做（和折起的工具行同一套说法），下面一个子任务一张卡，
 * 排在一起，一眼看得出是并行的。卡本身是 `SubtaskStep`。
 */
function SubtaskCards({
  steps,
  active,
  running,
  label,
}: {
  steps: StepDetails[];
  active: boolean;
  running: boolean;
  label: string;
}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2">
      <p className="m-0 flex items-center gap-2 text-muted-foreground text-sm">
        <IconStack kinds={["subtask"]} />
        <span className={running ? "tool-line-running" : undefined}>
          {label}
        </span>
      </p>
      <ol
        className="m-0 flex min-w-0 list-none flex-col gap-2 p-0"
        data-subagent-cards=""
      >
        {steps.map((step) => (
          <SubtaskStep active={active} key={step.id} step={step} />
        ))}
      </ol>
    </section>
  );
}

/** One step, as a folded line opens to it. Also how a subtask's card lists the steps it took. */
export function StepRow({
  step,
  active,
}: {
  step: StepDetails;
  active: boolean;
}) {
  if (step.kind === "subtask")
    return <SubtaskStep active={active} step={step} />;
  /*
   * The step still working shimmers, as the group's own line does while it runs. "In progress" in
   * muted text beside a label drawn exactly like the finished steps above it read as one more static
   * row: a person watching four "Fetch emails" lines and a fifth with no result took the Bot for dead.
   */
  const running = active && step.pending;
  /*
   * 结果里带了耗时才写这一件，带了失败的原因才写那一件：两个都不是这里编出来的，也没有值时行上
   * 和以前一个字都不差。浏览器这一步的失败原因说在行下面那句话里（见 `reason`），行上不再说第二遍。
   */
  const spent = elapsedWords(step.elapsedMs);
  const why =
    step.kind === "browser"
      ? ""
      : failureWords(step.failed, step.exitCode, step.failure);
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <StepIcon kind={step.kind} />
      <span className={running ? "shrink-0 tool-line-running" : "shrink-0"}>
        {step.label}
      </span>
      {step.href ? (
        <a
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
        >
          {step.detail ?? step.href}
        </a>
      ) : step.detail ? (
        <span className="truncate text-muted-foreground">{step.detail}</span>
      ) : null}
      {spent ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {spent}
        </span>
      ) : null}
      <StepStatus step={step} active={active} />
      {why ? (
        <span className="min-w-0 shrink truncate text-muted-foreground">
          {why}
        </span>
      ) : null}
    </span>
  );
  const reason =
    step.failed && step.kind === "browser" ? (
      <p className="mt-0.5 pl-6 text-destructive">
        {step.reason ?? "这一步没能完成。"}
      </p>
    ) : null;
  // A browser step says everything it has in its line. Anything else opens to what it was given
  // and what came back, which no other place in the transcript shows.
  if (step.kind === "browser" || (!step.inputs.length && !step.output))
    return (
      <li className="min-w-0">
        {line}
        {reason}
      </li>
    );
  return (
    <li className="min-w-0">
      <details className="tool-line min-w-0">
        <summary className="flex cursor-pointer list-none items-center gap-1.5">
          <span
            aria-hidden
            className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
          >
            ▸
          </span>
          {line}
        </summary>
        <div className="mt-1.5 space-y-2 pl-5">
          {step.sources ? (
            <ResearchResults
              label={
                RESEARCH_RESULTS_LABELS[
                  step.kind === "search" ? "search" : "fetch"
                ]
              }
              sources={step.sources}
            />
          ) : null}
          {step.inputs.length && !step.sources ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              {step.inputs.map(([key, value]) => (
                <div className="contents" key={key}>
                  <dt>{key}</dt>
                  <dd className="min-w-0 break-words text-foreground/80">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {step.output && !step.sources ? (
            <StepOutput output={step.output} verbatim={step.verbatim} />
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * What a step got back, in a soft box cut to a few lines and faded at the foot, with Show all to
 * read the rest. Not a scrolling box: inside the group's own list, a second scrollbar beside the
 * first was the hardest thing on the screen to read past.
 */
export function StepOutput({
  output,
  verbatim,
}: {
  output: string;
  verbatim?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (element) setLong(element.scrollHeight > element.clientHeight + 1);
  }, []);
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <div
        className={`relative ${open ? "" : "max-h-40 overflow-hidden"}`}
        ref={measure}
      >
        {verbatim ? (
          <pre className="font-mono whitespace-pre-wrap break-words">
            {output}
          </pre>
        ) : (
          <div className="[&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
            <Streamdown
              components={markdownComponents}
              plugins={markdownPlugins}
            >
              {forDisplay(output)}
            </Streamdown>
          </div>
        )}
        {long && !open ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted to-transparent" />
        ) : null}
      </div>
      {long ? (
        <button
          className="mt-1 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? "收起" : "全部显示"}
        </button>
      ) : null}
    </div>
  );
}

export function ToolActivity({
  group,
  active,
  stage,
  elapsed,
  observed,
}: {
  group: ToolGroup;
  /** This is the newest row of a turn still in flight, so a step without a result is running. */
  active: boolean;
  /**
   * 这一轮走到哪一段（段由这一轮自己的事件推出来，见 `lib/channels/run-stage.ts`）。
   *
   * 只有正在跑的这一行、只有「执行工具」这一段说在这儿：那是一段活儿真的在做、折起来的那行只说得出一个
   * 名字的时候。等模型那一段对话底下那一格一直有话说（「思考中」/「<员工名> 正在输入」），开始写回答则
   * 是眼睛正在看着的事，两处都再说一遍是吵。推不出段（这一轮之前的存档、没有这条流的通道）时这里
   * 少一行，那一格照旧，不会出现空着的一格。
   */
  stage?: RunStage | null;
  /**
   * 这一轮从被看见起跑了多少毫秒（WP-3.2 S1a）。只给正在跑的最后一行，历史行不给：
   * 秒针每秒走一格，不能拖着整段历史一起重画（见 chat-transcript.tsx 的 sameToolRow）。
   */
  elapsed?: number;
  /** 起点是半路看见的（没赶上 RUN_STARTED），措辞用「已进行」而不是「已跑」。 */
  observed?: boolean;
}) {
  const folders = useContext(FolderNamesContext);
  const all = group.steps.map(stepDetailsIn(folders));
  // 子任务各画一张卡（`SubtaskCards`），折起的这一行只数其余的，不画两遍。
  const subtasks = all.filter((step) => step.kind === "subtask");
  const steps = all.filter((step) => step.kind !== "subtask");
  const subtasksRunning = active && subtasks.some((step) => step.pending);
  const working = subtasks.filter((step) => step.pending).length;
  const running = active && steps.some((step) => step.pending);
  const current = steps.find((step) => step.pending);
  const issues = steps.filter((step) => step.failed || step.refused).length;
  const kinds = [...new Set(steps.map((step) => step.kind))];
  const stageLine = active && stage === "tool" ? stageWords(stage) : undefined;
  // 工具一跑就是几十秒，等模型那一格这时不画（见 chat-transcript.tsx 的 waitingOnTheModel），
  // 秒数挂在这条阶段行上，长工具窗口才不会一片空白。原有文字一个字不动，秒数是旁边的兄弟节点。
  const suffix = elapsedSuffix(elapsed, observed);
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      {stageLine ? (
        <p
          className="tool-line-running text-muted-foreground text-xs"
          data-run-stage="tool"
          // 是进度，不是打断：读屏的人跟着听见这一行，和「思考中」那一格一样。
          role="status"
        >
          {stageLine}
          {suffix ? (
            <span className="tabular-nums opacity-70">{` · ${suffix}`}</span>
          ) : null}
        </p>
      ) : null}
      {steps.length > 0 ? (
        <ToolLine
          bare
          icon={<IconStack kinds={kinds} />}
          label={running && current ? `${current.label}…` : summarise(steps)}
          detail={issues ? `${issues} 个问题` : undefined}
          running={running}
        >
          <ol className="space-y-2 py-1">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} active={active} />
            ))}
          </ol>
        </ToolLine>
      ) : null}
      {subtasks.length > 0 ? (
        <SubtaskCards
          active={active}
          label={
            subtasksRunning && working
              ? working === 1
                ? "正在处理一个子任务…"
                : `正在处理 ${working} 个子任务…`
              : summarise(subtasks)
          }
          running={subtasksRunning}
          steps={subtasks}
        />
      ) : null}
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}

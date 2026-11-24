/**
 * Pilot (XIONGBAO_PILOT_PLAN_APPROVAL): a coding card is reviewed before it is handed in.
 *
 * A read-only subagent goes down a fixed checklist and its opinion is attached to the hand-in as a
 * note. It only gives an opinion: the hand-in goes through whatever it says, and a review that could
 * not run says so in the same place instead of holding the card.
 *
 * WHAT A CODING CARD IS. The board has no type or label on a card, so the rule is on what is handed
 * in: a change summary (`diff` item), a source file among the workspace files, or, when the hand-in
 * names nothing of the kind, the card's own title or acceptance criteria speaking of code. Written
 * as a function so the rule is tested and can be changed in one place.
 *
 * WHAT THE REVIEWER SEES. It cannot see the conversation, and it may run no command (a command is a
 * change as far as the gate is concerned), so it is handed what the server holds: the card, the
 * hand-in, and the calls this round made, edits and commands with their arguments.
 */
import {
  readSubagentResult,
  type SubagentResult,
} from "../../../shared/subagent";
import type { GrantedTool } from "../plugins/tools";

/** What the reviewer is asked, in order. The wording is what it works from. */
export const REVIEW_CHECKLIST = [
  {
    id: "tests",
    ask: "测试是否跑过：这一轮的操作记录里，有没有运行测试的命令，结果是通过还是失败；交付自查里写的测试是否真的跑过。",
  },
  {
    id: "scope",
    ask: "改动是否超出卡片范围：改过的文件和功能，是否都在卡片标题与验收标准要求之内；有没有顺手改了无关的东西。",
  },
  {
    id: "assertions",
    ask: "有无删除既有断言：操作记录里对测试文件的修改，有没有删掉、注释掉、跳过或放宽原有的断言（expect、assert、期望值）。",
  },
] as const;

/** The label the attached opinion starts with. */
export const REVIEW_NOTE_LABEL = "交付前评审（只出意见，不挡交付）";

/** How long the opinion attached to a hand-in may be, label included. */
export const REVIEW_NOTE_LIMIT = 1000;

/** How long a review may take before it is given up, and what is kept back of the round's time. */
export const REVIEW_TIMEOUT_MS = 120_000;
export const REVIEW_RESERVE_MS = 15_000;

/** What the hand-in says when the review did not finish in time. */
export const REVIEW_TIMED_OUT = `${REVIEW_NOTE_LABEL}：评审超时，未附意见。`;

const SOURCE_FILE =
  /(?:\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|swift|sh|sql|vue|svelte|css|scss|ya?ml|json|toml)|(?:^|\/)Dockerfile[^/]*)$/i;
const CODE_WORDS =
  /代码|编码|编程|重构|修复|bug|缺陷|函数|接口|单元测试|提交|合并请求|\bPR\b|\bcommit\b|\bfix\b|\brefactor\b/i;

/** Whether this hand-in is a coding card's. */
export function isCodingCard(input: {
  title?: string | null;
  criteria?: string | null;
  items: readonly { kind: string; ref?: string }[];
}): boolean {
  if (input.items.some((item) => item.kind === "diff")) return true;
  if (
    input.items.some(
      (item) =>
        item.kind === "workspace_file" &&
        SOURCE_FILE.test(item.ref?.trim() ?? ""),
    )
  )
    return true;
  // Files named, none of them code: a report or a sheet, whatever the title says.
  if (input.items.some((item) => item.kind === "workspace_file")) return false;
  return CODE_WORDS.test(`${input.title ?? ""} ${input.criteria ?? ""}`);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const clip = (text: string, limit: number) =>
  [...text.replace(/\s+/g, " ").trim()].slice(0, limit).join("");

/**
 * The calls this round made, one line each: those after the person's last message, so what was said
 * and done in earlier rounds of a long conversation is not sent to the reviewer.
 */
export function roundCalls(
  messages: readonly unknown[],
  limit = 60,
  argLimit = 300,
): string[] {
  let from = 0;
  messages.forEach((message, index) => {
    if (record(message).role === "user") from = index + 1;
  });
  const lines: string[] = [];
  for (const message of messages.slice(from)) {
    const calls = record(message).toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const fn = record(record(call).function);
      if (typeof fn.name !== "string") continue;
      lines.push(`${fn.name} ${clip(String(fn.arguments ?? ""), argLimit)}`);
    }
  }
  return lines.slice(-limit);
}

/** The brief the reviewer is given: the card, the hand-in, the calls, and the checklist. */
export function reviewBrief(input: {
  title?: string | null;
  criteria?: string | null;
  items: readonly { kind: string; ref?: string; title?: string }[];
  checks: readonly string[];
  calls: readonly string[];
}) {
  const items = input.items.map((item) =>
    `- ${item.kind} ${item.title ?? ""} ${item.ref ?? ""}`.trim(),
  );
  const task = [
    "你来评审一件编码类的活，只出意见。你没有改动任何东西的权限，也不能运行命令；需要时用只读工具读文件。回答里不要引用文件原文、密钥或令牌，只写结论和依据所在的位置。",
    `卡片标题：${input.title || "（无）"}`,
    `验收标准：${input.criteria || "（无）"}`,
    `交付物：\n${items.join("\n") || "（无）"}`,
    `员工写的自查：\n${input.checks.map((check) => `- ${check}`).join("\n") || "（无）"}`,
    `这一轮的操作记录（最近的在后）：\n${input.calls.join("\n") || "（无）"}`,
    `按下面几条逐条评审：\n${REVIEW_CHECKLIST.map((item, index) => `${index + 1}. ${item.ask}`).join("\n")}`,
  ].join("\n\n");
  const answer =
    "每一条一行，写「通过」「有疑问」或「看不出」，后面跟一句依据；最后一行写总的一句话意见。";
  return { task, answer };
}

/** The opinion as it is attached to the hand-in. */
export function reviewNote(result: SubagentResult | null): string {
  const room = REVIEW_NOTE_LIMIT - REVIEW_NOTE_LABEL.length - 1;
  const text =
    result && "answer" in result
      ? clip(result.answer, room)
      : result && "error" in result
        ? `没跑成：${clip(result.error, 200)}`
        : "没跑成：评审没有交回结果";
  return `${REVIEW_NOTE_LABEL}：${text}`;
}

/** What `deliver_task` is given when the pilot is on. */
export type DeliveryReview = (input: {
  actorId: string;
  botId: string;
  card: { title?: string | null; criteria?: string | null };
  items: readonly { kind: string; ref?: string; title?: string }[];
  checks: readonly string[];
  messages: readonly unknown[];
  runId: string;
  threadId: string;
}) => Promise<string | undefined>;

export function createDeliveryReview(deps: {
  declared(actorId: string, botId: string): Promise<boolean>;
  /** The subagent tool of this run, held to reads (`agents/subagent.ts`). */
  reviewer(parent: {
    actorId: string;
    botId: string;
    runId: string;
    threadId: string;
  }): GrantedTool;
  /** How much of the round is left, when it is known; a review is cut short to leave the hand-in room. */
  remainingMs?: (run: {
    actorId: string;
    runId: string;
  }) => Promise<number | undefined>;
  timeoutMs?: number;
}): DeliveryReview {
  return async (input) => {
    if (!isCodingCard({ ...input.card, items: input.items })) return undefined;
    if (!(await deps.declared(input.actorId, input.botId))) return undefined;
    const brief = reviewBrief({
      ...input.card,
      items: input.items,
      checks: input.checks,
      calls: roundCalls(input.messages),
    });
    const left = await deps.remainingMs?.(input).catch(() => undefined);
    const limit = Math.min(
      deps.timeoutMs ?? REVIEW_TIMEOUT_MS,
      left === undefined ? Number.POSITIVE_INFINITY : left - REVIEW_RESERVE_MS,
    );
    if (limit <= 0) return REVIEW_TIMED_OUT;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve("late");
      }, limit);
    });
    const ran = deps
      .reviewer(input)
      .execute(brief, {
        toolCallId: `review:${input.runId}`,
        signal: stop.signal,
      })
      .then((text) => reviewNote(readSubagentResult(text)))
      .catch((error) =>
        reviewNote({
          error: error instanceof Error ? error.message : String(error),
          threadId: "",
          steps: 0,
        }),
      );
    try {
      const outcome = await Promise.race([ran, late]);
      return outcome === "late" ? REVIEW_TIMED_OUT : outcome;
    } finally {
      clearTimeout(timer);
    }
  };
}

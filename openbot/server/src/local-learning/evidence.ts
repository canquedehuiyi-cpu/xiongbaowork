import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { threadRunEvents, threadRuns, threads } from "../db/schema";

/**
 * 一位员工最近的一段对话，作为本地学习的证据。
 *
 * 只在这个人自己的租户帧里读（行级安全挡住别人的），也只读到内存里交给模型：不写进任何表，
 * 候选里只记 `threadId` 和 `runId`。
 */
export type EvidenceThread = {
  threadId: string;
  /** 这条线程最近一次完成的运行。 */
  runId: string;
  agentId: string;
  at: Date;
  name: string | null;
  /** 已脱敏、截短的对话文字，按顺序一行一句。 */
  transcript: string;
};

/** 一次最多读多少次运行。读不完的留给下一次，游标只推进到读过的地方。 */
export const MAX_RUNS_PER_PASS = 60;
/** 一句话最多留多少字。 */
const MAX_MESSAGE_CHARS = 500;
/** 一条线程最多留多少字。 */
const MAX_THREAD_CHARS = 4_000;

/**
 * 游标之后完成的运行，按线程合并成证据。
 *
 * 不要：失败的运行（流里有 `RUN_ERROR`）、还在进行的续跑（`ap-local-` 开头且没有事件）、没有一句
 * 人话的线程（只有员工自己说话的无人值守回合，看不出这个人要什么）。
 *
 * 返回读到的最晚时间作为新游标，即使其中一些被丢掉了：丢掉的下次也不会变得有用。
 */
export async function collectEvidence(
  database: Database,
  input: { since: Date | null; now: Date; lookbackDays?: number },
): Promise<{
  threads: EvidenceThread[];
  runsRead: number;
  cursor: Date | null;
}> {
  const floor =
    input.since ??
    new Date(input.now.getTime() - (input.lookbackDays ?? 14) * 86_400_000);
  const runs = await database
    .select({
      id: threadRuns.id,
      threadId: threadRuns.threadId,
      agentId: threadRuns.agentId,
      eventCount: threadRuns.eventCount,
      createdAt: threadRuns.createdAt,
    })
    .from(threadRuns)
    .where(gt(threadRuns.createdAt, floor))
    .orderBy(asc(threadRuns.createdAt))
    .limit(MAX_RUNS_PER_PASS);
  if (runs.length === 0)
    return { threads: [], runsRead: 0, cursor: input.since };

  const cursor = runs[runs.length - 1]?.createdAt ?? input.since;
  const finished = runs.filter(
    (run) => !(run.id.startsWith("ap-local-") && run.eventCount === 0),
  );
  const failed = new Set(
    finished.length === 0
      ? []
      : (
          await database
            .selectDistinct({ runId: threadRunEvents.runId })
            .from(threadRunEvents)
            .where(
              and(
                inArray(
                  threadRunEvents.runId,
                  finished.map((run) => run.id),
                ),
                // 运行事件列是 drizzle 自带的 jsonb，存进去的是 JSON 字符串（双重编码），两种都认。
                sql`(CASE WHEN jsonb_typeof(${threadRunEvents.event}) = 'string' THEN (${threadRunEvents.event} #>> '{}')::jsonb ELSE ${threadRunEvents.event} END)->>'type' = 'RUN_ERROR'`,
              ),
            )
        ).map((row) => row.runId),
  );

  // 每条线程留最近一次成功的运行。
  const latest = new Map<string, (typeof finished)[number]>();
  for (const run of finished) {
    if (failed.has(run.id)) continue;
    latest.set(run.threadId, run);
  }
  if (latest.size === 0) return { threads: [], runsRead: runs.length, cursor };

  const rows = await database
    .select({
      id: threads.id,
      name: threads.name,
      agentId: threads.agentId,
      messages: threads.messagesSnapshot,
    })
    .from(threads)
    .where(inArray(threads.id, [...latest.keys()]));

  const evidence: EvidenceThread[] = [];
  for (const row of rows) {
    const run = latest.get(row.id);
    if (!run) continue;
    const transcript = transcriptOf(row.messages);
    if (!transcript) continue;
    evidence.push({
      threadId: row.id,
      runId: run.id,
      agentId: run.agentId ?? row.agentId,
      at: run.createdAt,
      name: row.name,
      transcript,
    });
  }
  evidence.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { threads: evidence, runsRead: runs.length, cursor };
}

/** 一条线程是不是这个人的：行级安全之外再确认一次，读的是本人帧。 */
export async function threadExists(
  database: Database,
  threadId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: threads.id })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row !== undefined;
}

type MessageLike = {
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
};

/**
 * AG-UI 消息变成给模型读的几行英文标记的字（模型读的文字一律英文）：人说的、员工说的、员工用了哪些工具（只有名字）。
 *
 * 工具的参数和返回不进来：那里最可能有文件内容、网页原文和别人的数据，而学一项技能只需要知道
 * 这件事是怎么一步步做的。没有一句人话的线程返回空串。
 */
export function transcriptOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  let heardPerson = false;
  for (const raw of messages as MessageLike[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.role === "user") {
      const text = clip(mask(textOf(raw.content)));
      if (!text) continue;
      heardPerson = true;
      lines.push(`Person: ${text}`);
    } else if (raw.role === "assistant") {
      const text = clip(mask(textOf(raw.content)));
      const tools = toolNamesOf(raw.toolCalls);
      if (text) lines.push(`Bot: ${text}`);
      if (tools.length > 0) lines.push(`(Bot used tools: ${tools.join(", ")})`);
    }
  }
  if (!heardPerson) return "";
  let transcript = lines.join("\n");
  if (transcript.length > MAX_THREAD_CHARS)
    transcript = `${transcript.slice(0, MAX_THREAD_CHARS)}\n(rest omitted)`;
  return transcript;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function toolNamesOf(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  const names: string[] = [];
  for (const call of calls) {
    const name = (call as { function?: { name?: unknown } })?.function?.name;
    if (typeof name === "string" && name && !names.includes(name))
      names.push(name);
  }
  return names;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_CHARS
    ? `${flat.slice(0, MAX_MESSAGE_CHARS)}…`
    : flat;
}

/**
 * 去掉一眼就能认出的个人信息和凭据：邮箱、电话和长数字（证件号、卡号、验证码）、看起来像密钥的串、
 * 网址的查询参数。不是完备的脱敏，只是让送去模型的文字里少一点不该有的东西；模型本来就是这个人
 * 自己的员工在用的那一个。
 */
export function mask(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(
      /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g,
      "[key]",
    )
    .replace(
      /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
      "[key]",
    )
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, "$1")
    .replace(/\+?\d[\d -]{6,}\d/g, "[number]");
}

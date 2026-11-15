import { type Persona, personaGuidance } from "../../../../shared/persona";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { tasks, threads } from "../../db/schema";
import { shortName } from "../../brand";
import { runAsTenant } from "../../tenant/context";

/**
 * What an external employee is told about XiongBao's side when its agent starts a NEW session for
 * a thread (spec §3, 对话上下文): one that could not be `session/load`ed has none of the thread's
 * earlier conversation, so its first turn carries, ahead of the person's words, who it is in the
 * team (persona), the thread's latest messages (at most `RECENT_LIMIT`) and the task card this turn
 * is filed under. A session that was reused or loaded already has all of it and gets none.
 */

export const RECENT_LIMIT = 20;

/** One message of the thread, as plain text. */
export type AcpRecentMessage = { role: string; text: string };

const SPEAKER: Record<string, string> = {
  user: "用户",
  assistant: "你",
};

/** One message is clipped to this many characters: a pasted log is not context. */
const MESSAGE_LIMIT = 2000;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text;

/** The context blocks (ACP `ContentBlock`s) a new session's first turn starts with. */
export function buildFirstTurnContext(input: {
  persona: string;
  recent: AcpRecentMessage[];
  taskCard: string | null;
}): unknown[] {
  const recent = input.recent
    .filter((message) => message.text.trim() !== "")
    .slice(-RECENT_LIMIT);
  const sections = [`【${shortName()}这边的背景，供你参考；要做的事在后面】`];
  if (input.persona.trim())
    sections.push(`你的身份：\n${input.persona.trim()}`);
  if (recent.length > 0)
    sections.push(
      [
        `这个对话最近的 ${recent.length} 条消息（从旧到新）：`,
        ...recent.map(
          (message) =>
            `${SPEAKER[message.role] ?? message.role}：${clip(message.text.trim(), MESSAGE_LIMIT)}`,
        ),
      ].join("\n"),
    );
  if (input.taskCard?.trim())
    sections.push(`当前任务卡：${input.taskCard.trim()}`);
  return [{ type: "text", text: sections.join("\n\n") }];
}

/** Who the employee is in the team, in the words its owner wrote, for `buildFirstTurnContext`. */
export function acpPersonaText(profile: {
  name: string;
  title?: string | null;
  roleDescription?: string | null;
  persona?: Persona | null;
  bible?: string | null;
}): string {
  const title = profile.title?.trim();
  return [
    `你是${shortName()}团队里的员工「${profile.name}」${title ? `，${title}` : ""}。`,
    profile.roleDescription?.trim() ?? "",
    personaGuidance(profile.persona) ?? "",
    profile.bible?.trim() ? `你的工作手册：\n${profile.bible.trim()}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The text of an AG-UI message: its string content, or its text parts joined. */
export function messageText(content: unknown): string {
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
    .filter((text) => text !== "")
    .join("\n");
}

const STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  needs_action: "需要操作",
};

export type AcpContextLoader = (input: {
  tenantId: string;
  agentId: string;
  threadId: string;
  /** The run this turn is, whose board card is "the current task card" when it has one. */
  runId?: string;
  persona: string;
}) => Promise<unknown[]>;

/**
 * The context of a thread, read from the database in the tenant's frame: its stored messages (the
 * snapshot written when its last run ended, so the turn being started is not among them) and the
 * card of this run, else the thread's latest open card.
 */
export function createAcpContextLoader(database: Database): AcpContextLoader {
  return ({ tenantId, threadId, runId, persona }) =>
    runAsTenant(tenantId, async () => {
      const [thread] = await database
        .select({ messages: threads.messagesSnapshot })
        .from(threads)
        .where(and(eq(threads.tenantId, tenantId), eq(threads.id, threadId)))
        .limit(1);
      const recent: AcpRecentMessage[] = [];
      for (const message of thread?.messages ?? []) {
        const { role, content } = (message ?? {}) as {
          role?: unknown;
          content?: unknown;
        };
        if (role !== "user" && role !== "assistant") continue;
        const text = messageText(content);
        if (text.trim()) recent.push({ role, text });
      }
      const cardWhere = async (where: ReturnType<typeof and>) =>
        (
          await database
            .select({ title: tasks.title, status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.tenantId, tenantId), where))
            .orderBy(desc(tasks.createdAt))
            .limit(1)
        )[0];
      const card =
        (runId ? await cardWhere(eq(tasks.runRef, runId)) : undefined) ??
        (await cardWhere(
          and(
            eq(tasks.channelRef, threadId),
            inArray(tasks.status, ["running", "needs_action"]),
          ),
        ));
      const taskCard = card
        ? `${card.title}${STATUS_LABEL[card.status] ? `（${STATUS_LABEL[card.status]}）` : ""}`
        : null;
      return buildFirstTurnContext({ persona, recent, taskCard });
    });
}

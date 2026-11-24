/**
 * Notes on an item waiting in a person's inbox (XIONGBAO_PILOT_INBOX_NOTES).
 *
 * A plan, a hand-in or a question can collect several notes, each optionally quoting a passage of
 * the item. Sending puts all of them into one message and queues it as the next turn of the
 * conversation that raised the item, through the same `person.response` queue a question's answer
 * takes (`person-response-sweep.ts`). The item itself stays open: notes are not an answer.
 *
 * Notes are kept in a `work_items` row of their own kind, one per item, so no table is added. The
 * row is written in the person's own tenant frame, so row-level security keeps people apart; the
 * owner is checked as well, since every read below is the answering permission's own.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { groupSourceForRun, submitGroupTurn } from "../channels/group";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import { WORK_OFFERED_TOPIC } from "../work/queue";
import { type GuidedReview, guidedReview } from "./guided-review";
import {
  type PersonQuestion,
  personQuestionSchema,
  questionConversationBot,
} from "./questions";
import {
  ApprovalNotFoundError,
  type ApprovalRecord,
  ApprovalRefusedError,
} from "./types";

export const INBOX_NOTES_KIND = "inbox.notes";
export const NOTE_ITEM_KINDS = ["question", "approval"] as const;
export type NoteItemKind = (typeof NOTE_ITEM_KINDS)[number];

export const NOTE_LIMITS = {
  /** Notes waiting to be sent, per item. */
  notes: 20,
  /** One note's own words. */
  text: 2000,
  /** The quoted passage. */
  quote: 1000,
  /**
   * Everything one send carries, notes and quotes together. The queued message may hold 6000
   * characters (`person-response-sweep.ts`), and its framing takes under 500 of them.
   */
  batch: 5000,
} as const;

const quoteSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(NOTE_LIMITS.quote),
    /** Where the passage starts and ends in the item's own text. */
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .refine((quote) => quote.end > quote.start, "A quote ends after it starts.");
export const noteInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(NOTE_LIMITS.text),
  quote: quoteSchema.optional(),
});
export type NoteInput = z.infer<typeof noteInputSchema>;

export type InboxNote = NoteInput & { id: string; at: string };

type NotesPayload = {
  ownerUserId: string;
  itemKind: NoteItemKind;
  itemId: string;
  notes: InboxNote[];
  /** How many sends there have been; the next one is queued under this number plus one. */
  sent: number;
};

const weight = (note: NoteInput) =>
  note.text.length + (note.quote?.text.length ?? 0);

/** The message the Bot reads: every note in order, each with the passage it quotes. */
export function composeNotes(title: string, notes: readonly NoteInput[]) {
  const head = title.length > 80 ? `${title.slice(0, 80)}…` : title;
  const lines = notes.map((note, index) =>
    [
      `${index + 1}. ${note.quote ? `引用：「${note.quote.text}」\n   ` : ""}批注：${note.text}`,
    ].join(""),
  );
  return [
    `关于「${head}」，我写了 ${notes.length} 条批注。请逐条看，该改的改，该回答的回答，不用停下手上的事等我。`,
    "",
    ...lines,
  ].join("\n");
}

/** What an item is, as far as notes need: its words, and the conversation it belongs to. */
type Item = {
  title: string;
  /** The conversation the notes go back to, in the shape the answer queue resumes. */
  question: PersonQuestion;
  files: string[];
  /** Questions asked in a group are answered in that group. */
  group: boolean;
};

export function createInboxNotes(deps: {
  database: Database;
  /** The check an answer to a question passes before it is queued: the Bot and the conversation are still there. */
  authorise: (question: PersonQuestion) => Promise<unknown>;
  /** One approval request of this person's; throws when it is not theirs. */
  approval: (owner: string, id: string) => Promise<ApprovalRecord>;
}) {
  const { database } = deps;
  const noteKey = (kind: NoteItemKind, id: string) => `${kind}:${id}`;
  const notesRow = (owner: string, kind: NoteItemKind, id: string) =>
    and(
      eq(workItems.kind, INBOX_NOTES_KIND),
      eq(workItems.key, noteKey(kind, id)),
      sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
    );

  /** The item, if it is this person's and still waiting. Anything else is not found. */
  async function item(
    owner: string,
    kind: NoteItemKind,
    id: string,
  ): Promise<Item> {
    if (kind === "question") {
      const [row] = await database
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            eq(workItems.key, id),
            sql`${workItems.payload}->>'actorId' = ${owner}`,
          ),
        )
        .limit(1);
      if (!row || row.finishedAt) throw new ApprovalNotFoundError();
      const parsed = personQuestionSchema.safeParse(row.payload);
      if (!parsed.success)
        throw new ApprovalRefusedError(
          "This question has no completed conversation to continue.",
        );
      return {
        title: parsed.data.question,
        question: parsed.data,
        files: [],
        group: true,
      };
    }
    const record = await deps.approval(owner, id);
    if (record.ownerUserId !== owner) throw new ApprovalNotFoundError();
    if (record.status !== "pending")
      throw new ApprovalRefusedError("This request was already decided.");
    const target = record.action.target as
      | { acp?: { action?: unknown; files?: unknown } }
      | undefined;
    const files = Array.isArray(target?.acp?.files)
      ? target.acp.files.filter(
          (file): file is string => typeof file === "string",
        )
      : [];
    const title =
      typeof target?.acp?.action === "string" && target.acp.action
        ? target.acp.action
        : record.action.toolRef;
    return {
      title,
      files,
      group: false,
      question: {
        actorId: owner,
        botId: record.action.botId,
        threadId: record.action.threadId,
        runId: record.action.runId,
        question: title,
        mode: "completed_question",
      },
    };
  }

  async function held(owner: string, kind: NoteItemKind, id: string) {
    const [row] = await database
      .select()
      .from(workItems)
      .where(notesRow(owner, kind, id))
      .limit(1);
    return (row?.payload as NotesPayload | undefined)?.notes ?? [];
  }

  /** Change the notes held for an item under a row lock, so two writes at once both land. */
  async function change<T>(
    owner: string,
    kind: NoteItemKind,
    id: string,
    edit: (payload: NotesPayload) => T | Promise<T>,
    tx?: Parameters<Parameters<Database["transaction"]>[0]>[0],
  ): Promise<T> {
    const run = async (
      scope: Parameters<Parameters<Database["transaction"]>[0]>[0],
    ) => {
      await scope
        .insert(workItems)
        .values({
          kind: INBOX_NOTES_KIND,
          key: noteKey(kind, id),
          payload: {
            ownerUserId: owner,
            itemKind: kind,
            itemId: id,
            notes: [],
            sent: 0,
          } satisfies NotesPayload,
        })
        .onConflictDoNothing();
      const [row] = await scope
        .select()
        .from(workItems)
        .where(notesRow(owner, kind, id))
        .for("update")
        .limit(1);
      if (!row) throw new ApprovalNotFoundError();
      const payload = structuredClone(row.payload as NotesPayload);
      const result = await edit(payload);
      await scope
        .update(workItems)
        .set({ payload, updatedAt: sql`now()` })
        .where(notesRow(owner, kind, id));
      return result;
    };
    return tx ? run(tx) : database.transaction(run);
  }

  return {
    async list(owner: string, kind: NoteItemKind, id: string) {
      const one = await item(owner, kind, id);
      return {
        notes: await held(owner, kind, id),
        review: guidedReview(one.files) as GuidedReview | null,
      };
    },

    async add(owner: string, kind: NoteItemKind, id: string, input: unknown) {
      const note = noteInputSchema.parse(input);
      await item(owner, kind, id);
      return change(owner, kind, id, (payload) => {
        if (payload.notes.length >= NOTE_LIMITS.notes)
          throw new ApprovalRefusedError(
            "一次最多写 20 条批注，先发送再接着写。",
          );
        if (
          [...payload.notes, note].reduce((sum, one) => sum + weight(one), 0) >
          NOTE_LIMITS.batch
        )
          throw new ApprovalRefusedError(
            "批注加起来太长了，先发送已有的，再接着写。",
          );
        const saved: InboxNote = {
          ...note,
          id: randomUUID(),
          at: new Date().toISOString(),
        };
        payload.notes.push(saved);
        return saved;
      });
    },

    async remove(
      owner: string,
      kind: NoteItemKind,
      id: string,
      noteId: string,
    ) {
      await item(owner, kind, id);
      await change(owner, kind, id, (payload) => {
        payload.notes = payload.notes.filter((note) => note.id !== noteId);
      });
      return { removed: true };
    },

    /**
     * Send every note held for the item as one message to the conversation that raised it. Checked
     * as an answer is (the Bot and the conversation must still be there), and nothing is cleared when
     * that check fails.
     */
    async send(owner: string, kind: NoteItemKind, id: string) {
      const one = await item(owner, kind, id);
      await deps.authorise(one.question);
      const group =
        one.group && kind === "question"
          ? await groupSourceForRun(database, {
              threadId: one.question.threadId,
              actorId: owner,
              botId: questionConversationBot(one.question),
            })
          : null;
      return database.transaction(async (tx) =>
        change(
          owner,
          kind,
          id,
          async (payload) => {
            if (payload.notes.length === 0)
              throw new ApprovalRefusedError("还没有批注可以发送。");
            const count = payload.notes.length;
            const text = composeNotes(one.title, payload.notes);
            const number = payload.sent + 1;
            const key = `${noteKey(kind, id)}:${number}`;
            if (group) {
              await submitGroupTurn(tx, {
                ownerUserId: owner,
                channelId: group.channelId,
                messageId: `inbox-notes:${key}`,
                agentIds: [group.botId],
                text,
                inResponseTo: one.question.question,
              });
            } else {
              await tx
                .insert(workItems)
                .values({
                  kind: "person.response",
                  key: `inbox-notes:${key}`,
                  payload: {
                    ownerUserId: owner,
                    question: one.question,
                    response: text,
                    notes: true,
                  },
                })
                .onConflictDoNothing();
              await tx.execute(
                sql`select pg_notify(${WORK_OFFERED_TOPIC}, 'person.response')`,
              );
            }
            payload.notes = [];
            payload.sent = number;
            return { id, sent: count };
          },
          tx,
        ),
      );
    },
  };
}
export type InboxNotes = ReturnType<typeof createInboxNotes>;

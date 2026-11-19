import { and, eq, sql } from "drizzle-orm";
import { HeadlessToolSuspension } from "../../../toolkit/src/headless-tools";
import {
  type ApprovalContinuation,
  parseApprovalContinuation,
} from "../approvals/types";
import type { Database } from "../db/client";
import { intelligenceChannelMappings, routineRuns } from "../db/schema";
import { responsibilityRuns } from "../db/schema/responsibilities";
import type { DeliveryScope } from "../delivery/types";
import { signInToolResult } from "./service";
import type { SignInRequestRecord } from "./types";

/**
 * What a turn that waited on a person's answer at the computer does once it comes (期九·三), whichever
 * answer it was: a sign-in request's, or a takeover or a secret that outlived the wait the tool made.
 *
 * The same two paths an approval takes (index.ts, the approval sweep): a responsibility run that is
 * waiting on this is re-queued with the outcome as its tool result, and any other headless turn is
 * continued from the snapshot the tool saved, with its reply written to the conversation. A group's
 * turn is continued through the group (`continueTurn` is given the key it waits on), so the reply lands
 * in the shared transcript on the row that was waiting. A turn that stops again, on another approval or
 * another wait, has ended where it should: that stop is recorded as the conversation's last line and is
 * not a failure to be tried again.
 *
 * `key` is the field of the suspension that names the wait (`signInRequestId`, `waitId`), which is what
 * a responsibility run, a routine run and a group's waiting row were stored under.
 */
export type WaitAnswer = {
  key: "signInRequestId" | "waitId";
  id: string;
  ownerUserId: string;
  botId: string;
  continuation: Record<string, unknown>;
  /** The tool's result. Built from the outcome and never from a credential. */
  content: string;
  /** The id of the message the result is written under; the same for a retry, so a retry adds nothing. */
  messageId: (snapshot: ApprovalContinuation) => string;
};

export function createWaitResumer(deps: {
  database: Database;
  resumeResponsibility(
    ownerUserId: string,
    runId: string,
    result: string,
  ): Promise<unknown>;
  continueTurn(input: {
    ownerUserId: string;
    botId: string;
    snapshot: ApprovalContinuation;
    result: { content: string };
    messageId: string;
    /** What the turn waited on, for a group to find the row that waits. */
    waitKey: string;
  }): Promise<{ replyText?: string }>;
  recordReply(input: {
    ownerUserId: string;
    channelId: string;
    botId: string;
    text: string;
    messageId: string;
  }): Promise<void>;
}) {
  return async (answer: WaitAnswer) => {
    const [waitingRun] = await deps.database
      .select({ id: responsibilityRuns.id })
      .from(responsibilityRuns)
      .where(
        and(
          eq(responsibilityRuns.status, "waiting"),
          sql`${responsibilityRuns.waiting}->>${answer.key} = ${answer.id}`,
        ),
      )
      .limit(1);
    if (waitingRun) {
      await deps.resumeResponsibility(
        answer.ownerUserId,
        waitingRun.id,
        answer.content,
      );
      return;
    }
    const snapshot = parseApprovalContinuation(answer.continuation);
    const messageId = answer.messageId(snapshot);
    let outcome: { replyText?: string } = {};
    let stoppedAgain: string | undefined;
    try {
      outcome = await deps.continueTurn({
        ownerUserId: answer.ownerUserId,
        botId: answer.botId,
        snapshot,
        result: { content: answer.content },
        messageId,
        waitKey: answer.id,
      });
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
      stoppedAgain = error.message;
    }
    const channelId = await channelFor(
      deps.database,
      answer.ownerUserId,
      snapshot.threadId,
    );
    if (channelId && outcome.replyText)
      await deps.recordReply({
        ownerUserId: answer.ownerUserId,
        channelId,
        botId: answer.botId,
        text: outcome.replyText,
        messageId,
      });
    // The conversation's last line says what it waits on now.
    if (channelId && stoppedAgain)
      await deps.recordReply({
        ownerUserId: answer.ownerUserId,
        channelId,
        botId: answer.botId,
        text: stoppedAgain,
        messageId: `${messageId}:waiting`,
      });
    // A routine firing that was waiting on this is finished now, as after an approval.
    await deps.database
      .update(routineRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        error: null,
        waiting: null,
      })
      .where(
        and(
          eq(routineRuns.status, "waiting"),
          sql`${routineRuns.waiting}->>${answer.key} = ${answer.id}`,
        ),
      );
  };
}

/**
 * What happens to an unattended turn once its sign-in request is answered.
 *
 * The same two paths an approval takes (index.ts, the approval sweep): a responsibility run that is
 * waiting on this request is re-queued with the outcome as its tool result, and any other headless
 * turn is continued from the snapshot the tool saved, with its reply written to the conversation.
 * A request opened by the open chat has no continuation; that chat is polling and needs nothing here.
 * So has a request whose turn waited for the answer in the tool (期九·三): the tool takes the answer
 * itself, and hangs the turn on the request only when it stops waiting.
 *
 * The tool result is `signInToolResult`, which is built from the row and carries no credential.
 */
export function createSignInResumer(
  deps: Parameters<typeof createWaitResumer>[0],
) {
  const resume = createWaitResumer(deps);
  return async (request: SignInRequestRecord) => {
    if (!request.continuation) return;
    await resume({
      key: "signInRequestId",
      id: request.id,
      ownerUserId: request.ownerUserId,
      botId: request.botId,
      continuation: request.continuation,
      content: JSON.stringify(signInToolResult(request)),
      messageId: (snapshot) =>
        `sign-in-result:${request.id}:${snapshot.toolCallId}`,
    });
  };
}

async function channelFor(
  database: Database,
  ownerUserId: string,
  threadId: string,
) {
  const [source] = await database
    .select({ channelId: intelligenceChannelMappings.channelId })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.userId, ownerUserId),
        eq(intelligenceChannelMappings.threadId, threadId),
      ),
    )
    .limit(1);
  return source?.channelId;
}

/**
 * Tell the owner a sign-in is waiting, on the channels this conversation is delivered to.
 *
 * Uses delivery's exported notify, which fans out to every binding (Slack, SMS) and every push device
 * the owner has. The message carries a link to the private form and nothing else: a credential must
 * never be answered in a chat reply, and the text says so.
 */
export function createSignInNotifier(deps: {
  database: Database;
  appUrl: string | undefined;
  notify(
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: "reply" | "question" | "approval";
      requestId?: string;
    },
  ): Promise<unknown>;
}) {
  return async (request: SignInRequestRecord) => {
    if (!request.threadId) return;
    const channelId = await channelFor(
      deps.database,
      request.ownerUserId,
      request.threadId,
    );
    if (!channelId) return;
    const link = deps.appUrl
      ? `${deps.appUrl.replace(/\/$/, "")}/sign-in/${request.id}`
      : `/sign-in/${request.id}`;
    await deps.notify(
      {
        ownerUserId: request.ownerUserId,
        channelId,
        agentId: request.botId,
        threadId: request.threadId,
      },
      {
        id: `sign-in:${request.id}`,
        kind: "question",
        requestId: request.id,
        text: `Your Bot needs you to sign in to ${request.origin}${request.reason ? ` (${request.reason})` : ""}. Open the private sign-in form: ${link}\nDo not reply with a password here.`,
      },
    );
  };
}

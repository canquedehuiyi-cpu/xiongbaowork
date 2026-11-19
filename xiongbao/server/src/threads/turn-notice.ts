import { and, eq } from "drizzle-orm";
import type { RunEndNoticePreferences } from "../../../shared/user-preferences";
import { productName } from "../brand";
import type { RunNoticeWire } from "../channels/events";
import type { Database } from "../db/client";
import {
  channelAgents,
  intelligenceChannelMappings,
  tasks,
  threadRuns,
} from "../db/schema";
import type { DeliveryScope } from "../delivery/types";
import { firstSentenceOf } from "../tasks/delivery";
import { runAsTenant } from "../tenant/context";

/**
 * Telling a person that a chat turn ended while they were not looking (期九·五).
 *
 * With the server running a chat's computer tools, a person can start a long piece of work, close the
 * page and go. The turn then ends with nobody on the stream, and the only way they learn of it is to
 * come back and look. This is the other way: when a turn of a one-to-one conversation ends -- done, failed,
 * waiting on them, stopped at its clock or its rounds, or cut off by a restart -- and no page is
 * watching that conversation, they are told, in as many as three places, each of which they can switch
 * off (`RunEndNoticePreferences`):
 *
 *  - `push`: their phone, as a `reply` (a tap opens the conversation);
 *  - `im`: the chat platforms they bound (WeChat and the like), by the routing they set there;
 *  - `desktop`: an event on the roster's socket that an open page of the app, in a browser or in the
 *    desktop app, shows as a system notification.
 *
 * WHO IS WATCHING is the number of streams held open on the thread (`thread-viewers.ts`). A turn that
 * ends with a page still on its stream says nothing: that page shows it.
 *
 * WHAT IS NOT SAID HERE. A group's turn, a board card's and a routine's have their own notices and are
 * not one-to-one conversations. A turn that waits on an approval or a sign-in already told the person
 * when the request opened. A turn the person stopped themselves needs no telling.
 *
 * ONCE A MINUTE per conversation, by default: turns that end one after another (a person firing off
 * several short asks) say it once, not once each. The window is {@link TurnNoticeDeps.windowMs}.
 */

/** How a turn ended, as far as telling a person goes. */
export type TurnEnd =
  | { kind: "finished"; text: string }
  | { kind: "failed" }
  | {
      kind: "needs-you";
      /** What it waits on (the suspension's `kind`), for the words and for what was already told. */
      waiting?: string;
    }
  | { kind: "limit"; reason: "time" | "segments"; minutes?: number }
  | { kind: "interrupted" };

/** Waits whose request already told the person when it opened (approvals, sign-ins). */
const TOLD_WHEN_OPENED: ReadonlySet<string> = new Set([
  "approval",
  "computer_sign_in",
]);

/** How long a notice stands in for the turns that end right after it. */
export const DEFAULT_TURN_NOTICE_WINDOW_MS = 60_000;

/** The longest first sentence a notice carries. */
const SENTENCE_CHARS = 80;

/** "18 分钟", "45 秒", "1 小时 5 分钟": how long a turn ran, to the precision a person reads. */
export function elapsedWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

const WAITING_WORDS: Record<string, string> = {
  computer_handoff: "需要你接管一下浏览器",
  computer_secret: "需要你填一个值",
};

/**
 * The words of one notice. `name` is the employee's; `speaker` is false for a chat platform that
 * already shows the employee's name (it posts as them), where the name is left out.
 */
export function turnNoticeText(input: {
  name: string;
  end: TurnEnd;
  elapsedMs: number;
  speaker?: boolean;
}): string {
  const { end } = input;
  const took = `用时 ${elapsedWords(input.elapsedMs)}`;
  const body = (() => {
    switch (end.kind) {
      case "finished": {
        const first = firstSentenceOf(end.text);
        const sentence = first
          ? Array.from(first).slice(0, SENTENCE_CHARS).join("")
          : "这一轮做完了";
        return `${sentence}（${took}）`;
      }
      case "failed":
        return `这一轮出错停下了，回到对话里看看（${took}）`;
      case "needs-you":
        return `${
          (end.waiting ? WAITING_WORDS[end.waiting] : undefined) ??
          "需要你来处理"
        }，这一轮先停在这里（${took}）`;
      case "limit":
        return end.reason === "time"
          ? `这一轮已经跑满 ${end.minutes ?? Math.max(1, Math.round(input.elapsedMs / 60_000))} 分钟，先停下了，回复「继续」接着做`
          : `这一轮连续调用工具的次数到了上限，先停下了，回复「继续」接着做（${took}）`;
      case "interrupted":
        return `服务重启，这一轮在中途被打断了，回复「继续」接着做（已跑 ${elapsedWords(input.elapsedMs)}）`;
    }
  })();
  return input.speaker === false ? body : `${input.name}：${body}`;
}

/** What an open page shows: a system notification that opens the conversation. */
export type RunNotice = RunNoticeWire;

export type TurnNoticeDeps = {
  /** How many streams are watching the thread now. */
  viewers: (ownerUserId: string, threadId: string) => number;
  /** The person's switches. A read that fails reads as everything on. */
  preferences: (ownerUserId: string) => Promise<RunEndNoticePreferences>;
  /** The one-to-one conversation this thread is the person's, with this employee; null for any other. */
  conversation: (input: {
    ownerUserId: string;
    threadId: string;
    agentId: string;
  }) => Promise<{ channelId: string } | null>;
  /** The employee's name, or undefined when it cannot be read. */
  botName: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<string | undefined>;
  /**
   * The delivery router's `notify`, called in the person's frame: a `reply` that carries the person's
   * switches for the phone and the chat platforms. `text` is the full line; `chatText` is the same
   * without the employee's name, for a platform that already posts as that employee.
   */
  notify: (
    scope: DeliveryScope,
    input: {
      id: string;
      kind: "reply";
      text: string;
      away: { push: boolean; chat: boolean; chatText: string };
    },
  ) => Promise<void>;
  /** Announce the notice to the person's open pages (the roster socket). */
  announce: (ownerUserId: string, notice: RunNotice) => Promise<void>;
  /** The merge window. Zero or less says every turn. */
  windowMs?: number;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

export type TurnEndedInput = {
  ownerUserId: string;
  agentId: string;
  threadId: string;
  runId: string;
  /** When the turn began, as `Date.now()` read it. */
  startedAt: number;
  end: TurnEnd;
};

/** Why a turn's end said nothing, or `sent` with the places it was told. */
export type TurnNoticeResult =
  | { sent: true; channels: ("push" | "im" | "desktop")[] }
  | {
      sent: false;
      why:
        | "watched"
        | "told-already"
        | "not-one-to-one"
        | "switched-off"
        | "merged"
        | "failed";
    };

export type TurnNotifier = {
  /** Never rejects: a notice that cannot be sent is logged and the turn is none the worse. */
  ended(input: TurnEndedInput): Promise<TurnNoticeResult>;
};

export function createTurnNotifier(deps: TurnNoticeDeps): TurnNotifier {
  const windowMs = deps.windowMs ?? DEFAULT_TURN_NOTICE_WINDOW_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((event) => console.error(JSON.stringify(event)));
  /** When each conversation was last told, by person and thread. */
  const lastTold = new Map<string, number>();
  const prune = (at: number) => {
    if (lastTold.size < 1000) return;
    for (const [key, told] of lastTold)
      if (at - told >= windowMs) lastTold.delete(key);
  };

  return {
    async ended(input) {
      try {
        const { ownerUserId, agentId, threadId, runId, end } = input;
        if (deps.viewers(ownerUserId, threadId) > 0)
          return { sent: false, why: "watched" };
        if (
          end.kind === "needs-you" &&
          end.waiting &&
          TOLD_WHEN_OPENED.has(end.waiting)
        )
          return { sent: false, why: "told-already" };
        const conversation = await deps.conversation({
          ownerUserId,
          threadId,
          agentId,
        });
        if (!conversation) return { sent: false, why: "not-one-to-one" };
        const switches = await deps.preferences(ownerUserId).catch(
          (): RunEndNoticePreferences => ({
            push: true,
            im: true,
            desktop: true,
          }),
        );
        if (!switches.push && !switches.im && !switches.desktop)
          return { sent: false, why: "switched-off" };
        const name =
          (await deps.botName(ownerUserId, agentId).catch(() => undefined)) ??
          "你的员工";
        // Read again after the awaits: somebody may have opened the page while the person's rows loaded.
        if (deps.viewers(ownerUserId, threadId) > 0)
          return { sent: false, why: "watched" };
        // Checked and taken in one step, so two turns ending together are one notice.
        const at = now();
        const key = `${ownerUserId}\u0000${threadId}`;
        const told = lastTold.get(key);
        if (windowMs > 0 && told !== undefined && at - told < windowMs)
          return { sent: false, why: "merged" };
        lastTold.set(key, at);
        prune(at);

        const elapsedMs = Math.max(0, at - input.startedAt);
        const text = turnNoticeText({ name, end, elapsedMs });
        const channels: ("push" | "im" | "desktop")[] = [];
        const failures: unknown[] = [];
        if (switches.push || switches.im) {
          try {
            await deps.notify(
              {
                ownerUserId,
                channelId: conversation.channelId,
                agentId,
                threadId,
              },
              {
                id: `turn-end:${runId}`,
                kind: "reply",
                text,
                away: {
                  push: switches.push,
                  chat: switches.im,
                  chatText: turnNoticeText({
                    name,
                    end,
                    elapsedMs,
                    speaker: false,
                  }),
                },
              },
            );
            if (switches.push) channels.push("push");
            if (switches.im) channels.push("im");
          } catch (error) {
            failures.push(error);
          }
        }
        if (switches.desktop) {
          try {
            await deps.announce(ownerUserId, {
              channelId: conversation.channelId,
              title: productName(),
              body: text,
              tag: `xiongbao-${conversation.channelId}`,
              path: `/channel/${encodeURIComponent(conversation.channelId)}`,
            });
            channels.push("desktop");
          } catch (error) {
            failures.push(error);
          }
        }
        for (const error of failures)
          log({
            type: "turn-notice-failed",
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        // Nothing got through: the next turn may try again rather than be merged into a silence.
        if (channels.length === 0) {
          if (lastTold.get(key) === at) lastTold.delete(key);
          return { sent: false, why: "failed" };
        }
        return { sent: true, channels };
      } catch (error) {
        log({
          type: "turn-notice-failed",
          runId: input.runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { sent: false, why: "failed" };
      }
    },
  };
}

/**
 * The one-to-one conversation a thread is, for the person it is the thread of: the channel their thread
 * maps to, when that channel has this employee and no one else. A group, a team channel and a thread
 * that belongs to no conversation of theirs are not. Read in the person's own frame, so another
 * person's thread is not there to be found.
 */
export function oneToOneConversation(database: Database) {
  return async (input: {
    ownerUserId: string;
    threadId: string;
    agentId: string;
  }): Promise<{ channelId: string } | null> =>
    runAsTenant(input.ownerUserId, async () => {
      const [mapped] = await database
        .select({ channelId: intelligenceChannelMappings.channelId })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.userId, input.ownerUserId),
            eq(intelligenceChannelMappings.threadId, input.threadId),
          ),
        )
        .limit(1);
      if (!mapped) return null;
      const agents = await database
        .select({ agentId: channelAgents.agentId })
        .from(channelAgents)
        .where(eq(channelAgents.channelId, mapped.channelId));
      return agents.length === 1 && agents[0]?.agentId === input.agentId
        ? { channelId: mapped.channelId }
        : null;
    });
}

/**
 * The turn a restart cut off, when it was a person's own chat turn: which employee ran it and when it
 * began. The board filed that turn as a `chat` card under the run's id (`threads/postgres-runner.ts`),
 * which a group's turn, a dispatched task and a routine's firing do not carry, so any other turn is
 * null and says nothing. Read in the person's frame.
 */
export function interruptedChatTurn(database: Database) {
  return async (run: {
    tenantId: string;
    runId: string;
  }): Promise<{ agentId: string; startedAt: number } | null> =>
    runAsTenant(run.tenantId, async () => {
      const [found] = await database
        .select({
          agentId: threadRuns.agentId,
          startedAt: threadRuns.createdAt,
        })
        .from(threadRuns)
        .innerJoin(tasks, eq(tasks.runRef, threadRuns.id))
        .where(and(eq(threadRuns.id, run.runId), eq(tasks.source, "chat")))
        .limit(1);
      return found
        ? { agentId: found.agentId, startedAt: found.startedAt.getTime() }
        : null;
    });
}

/**
 * What the restart sweep does once it has closed a turn: if it was a person's own chat turn, tell them
 * it was cut off (`recovery/interrupted-runs.ts` calls it as `closed`). Nobody is on the stream of a turn
 * whose process is gone, so the only question is whether it was a one-to-one chat turn at all.
 * `notifier` is asked when the turn is told, not when this is built, because delivery is assembled
 * after the sweep is.
 */
export function interruptedTurnTeller(deps: {
  lookup: ReturnType<typeof interruptedChatTurn>;
  notifier: () => TurnNotifier | undefined;
}) {
  return async (run: {
    tenantId: string;
    threadId: string;
    runId: string;
  }): Promise<void> => {
    const turn = await deps.lookup(run);
    if (!turn) return;
    await runAsTenant(run.tenantId, async () => {
      await deps.notifier()?.ended({
        ownerUserId: run.tenantId,
        agentId: turn.agentId,
        threadId: run.threadId,
        runId: run.runId,
        startedAt: turn.startedAt,
        end: { kind: "interrupted" },
      });
    });
  };
}

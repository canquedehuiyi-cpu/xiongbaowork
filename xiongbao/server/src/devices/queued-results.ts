import { createHash, randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { Observable } from "rxjs";
import type { Database } from "../db/client";
import { threadRuns, threads } from "../db/schema";
import { scrubCommand } from "../telemetry/scrub";
import { runAsTenant } from "../tenant/context";
import { suppressRunnerCard } from "../threads/unattended-card";
import type { DispatchTarget } from "./channel";
import type { DeviceQueue, QueuedNotice, QueuedOrigin } from "./queue";

/**
 * The outcome of an action that waited for the person's machine, told to the conversation that asked.
 *
 * A Bot whose machine is away is answered "queued" and its turn ends there. The action runs later,
 * when the runner reconnects, and its receipt is stored on the queue row; without this nothing ever
 * tells the person what happened, so they ask again and a second action runs. This posts one short
 * message, in the Bot's voice, into the conversation the action was queued from, once its receipt is
 * final: the exit code and a clipped, scrubbed stdout/stderr, or that it was refused, or that its
 * outcome is unknown and the device is paused until somebody checks.
 *
 * ONCE. The queue row carries a leased `notice` marker (see `DeviceQueue.claimNotices`), so a second
 * flush, a second replica or a retried drain finds nothing to tell; the message's run id is derived
 * from the row, so a process that died after posting and before settling finds its own message on
 * the thread and does not post it again. Nothing here runs or re-runs the action.
 */

/** What posting answered: on the thread, the thread is mid-run, or there is no such conversation. */
export type QueuedResultPost = (input: {
  tenantId: string;
  origin: QueuedOrigin;
  runId: string;
  text: string;
}) => Promise<"posted" | "busy" | "gone">;

const OUTPUT_LIMIT = 1500;
const COMMAND_LIMIT = 300;
const RETRY_MS = 15_000;
const RETRY_LIMIT = 20;
const NOTICE_BATCH = 25;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit
    ? `${trimmed.slice(0, limit)}\n…（已截断）`
    : trimmed;
}

/** Scrubbed, clipped, and fenced so outside output cannot close the block it is shown in. */
function block(text: string, limit = OUTPUT_LIMIT): string {
  return `\`\`\`\n${clip(scrubCommand(text), limit).replace(/`{3,}/g, "ˋˋˋ")}\n\`\`\``;
}

function commandOf(payload: unknown): string | null {
  const command =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).command
      : undefined;
  return typeof command === "string" && command.trim()
    ? clip(scrubCommand(command), COMMAND_LIMIT).replace(/`/g, "ˋ")
    : null;
}

function pathOf(payload: unknown): string | null {
  const path =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).path
      : undefined;
  return typeof path === "string" && path.trim()
    ? clip(scrubCommand(path), COMMAND_LIMIT).replace(/`/g, "ˋ")
    : null;
}

/** The message, in Chinese, for one concluded queued action. Never carries the output unscrubbed. */
export function queuedResultText(notice: QueuedNotice): string {
  const command = notice.action === "exec" ? commandOf(notice.payload) : null;
  const path = notice.action === "exec" ? null : pathOf(notice.payload);
  const what = command
    ? `之前排队的命令 \`${command}\``
    : path
      ? `之前排队的操作（${notice.action}，\`${path}\`）`
      : `之前排队的操作（${notice.action}）`;
  if (notice.receipt.state === "failed")
    return `${what}被设备拒绝，没有执行。需要的话可以让我重新发起。`;
  if (notice.receipt.state !== "completed")
    return `${what}在设备重新连上后已发出，但没有收到确认结果：它可能已经执行，也可能没有。为避免重复执行，这台设备已暂停接收新操作，请先在设备上检查，再到设备页确认这条操作的结果。`;
  const output = notice.receipt.output;
  if (notice.action !== "exec" || !output || typeof output !== "object")
    return `${what}已在设备重新连上后执行完成。`;
  const result = output as Record<string, unknown>;
  const lines = [
    typeof result.exitCode === "number"
      ? `${what}已在设备重新连上后执行完成，退出码 ${result.exitCode}${result.timedOut === true ? "（已超时被终止）" : ""}。`
      : `${what}已在设备重新连上后执行完成${result.timedOut === true ? "（已超时被终止）" : ""}。`,
  ];
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stdout) lines.push(`输出：\n${block(stdout)}`);
  if (stderr) lines.push(`错误输出：\n${block(stderr)}`);
  if (!stdout && !stderr) lines.push("没有输出。");
  if (result.truncated === true) lines.push("（设备上的输出本身已被截断。）");
  return lines.join("\n\n");
}

/** One run id per queue row, so a post that landed is recognised on the thread rather than repeated. */
export function queuedResultRunId(target: DispatchTarget, key: string): string {
  const digest = createHash("sha256")
    .update(`${target.tenantId}\n${target.deviceId}\n${key}`)
    .digest("hex")
    .slice(0, 32);
  return `device-result-${digest}`;
}

export function createQueuedResultNotices(options: {
  queue: DeviceQueue;
  post: QueuedResultPost;
  retryMs?: number;
}) {
  const { queue, post } = options;
  const retryMs = options.retryMs ?? RETRY_MS;
  const retries = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (target: DispatchTarget, delayMs: number) => {
    const id = `${target.tenantId}/${target.deviceId}`;
    if (timers.has(id)) return;
    const timer = setTimeout(() => {
      timers.delete(id);
      void announce(target).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    timers.set(id, timer);
  };

  async function announce(target: DispatchTarget): Promise<number> {
    const owner = randomUUID();
    const due = await queue.claimNotices(target, owner);
    let posted = 0;
    let deferred = false;
    for (const notice of due) {
      let outcome: "posted" | "busy" | "gone";
      try {
        outcome = await post({
          tenantId: target.tenantId,
          origin: notice.origin,
          runId: queuedResultRunId(target, notice.key),
          text: queuedResultText(notice),
        });
      } catch (error) {
        console.warn(
          "[devices] a queued action's result could not be posted yet:",
          error instanceof Error ? error.message : error,
        );
        outcome = "busy";
      }
      if (outcome === "busy") deferred = true;
      await queue
        .settleNotice(
          target,
          notice.key,
          owner,
          outcome === "busy" ? null : outcome === "posted" ? "posted" : "skipped",
        )
        .catch(() => undefined);
      if (outcome === "posted") posted += 1;
    }
    /*
     * A conversation mid-run is not interrupted for this: the notice goes back and is tried again
     * shortly, a bounded number of times (the machine's next reconnect tries it again as well). A
     * full batch means more may be owed, so the next batch follows at once.
     */
    const id = `${target.tenantId}/${target.deviceId}`;
    if (deferred) {
      const attempt = (retries.get(id) ?? 0) + 1;
      if (attempt <= RETRY_LIMIT) {
        retries.set(id, attempt);
        schedule(target, retryMs);
      } else retries.delete(id);
    } else {
      retries.delete(id);
      if (due.length >= NOTICE_BATCH) schedule(target, 0);
    }
    return posted;
  }
  return { announce };
}

/** Just enough of the deployment's thread runner (`threads/postgres-runner.ts`) to post one reply. */
export type NoticeRunner = {
  hydrate: () => Promise<void>;
  isRunning: (request: { threadId: string }) => Promise<boolean>;
  getThreadMessages: (threadId: string) => Message[];
  run: (request: {
    threadId: string;
    agent: AbstractAgent;
    input: {
      threadId: string;
      runId: string;
      messages: Message[];
      tools: [];
      context: [];
      state: Record<string, never>;
      forwardedProps: Record<string, never>;
    };
  }) => Observable<BaseEvent>;
};

/** The Bot saying one fixed thing: no model, no tools, the same events a short answer produces. */
class FixedReply extends AbstractAgent {
  constructor(
    agentId: string,
    private readonly text: string,
  ) {
    super({ agentId });
  }

  run(input: { threadId: string; runId: string }): Observable<BaseEvent> {
    const messageId = `${input.runId}-message`;
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: this.text,
      } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
    ];
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/**
 * Post through the same runner a person's turn runs through, so the message is in the transcript, in
 * the history the next turn reads, and in PostgreSQL, exactly like any other answer of that Bot.
 *
 * In the person's own tenant frame. The thread has to be that tenant's and that Bot's own: a thread
 * id that reads as another tenant's or another Bot's is a conversation this notice does not belong
 * in, and is skipped rather than written. A thread with a run in flight is left alone (the runner
 * would supersede the person's own turn), and the notice is tried again later.
 */
export function createThreadResultPoster(options: {
  database: Database;
  runner: NoticeRunner;
  /** Bump the conversation in the roster once the message is on record. Best effort. */
  announce?: (input: {
    tenantId: string;
    origin: QueuedOrigin;
    text: string;
  }) => Promise<void>;
}): QueuedResultPost {
  const { database, runner } = options;
  return ({ tenantId, origin, runId, text }) =>
    runAsTenant(tenantId, async () => {
      const [thread] = await database
        .select({ agentId: threads.agentId, tenantId: threads.tenantId })
        .from(threads)
        .where(eq(threads.id, origin.threadId))
        .limit(1);
      if (
        !thread ||
        thread.tenantId !== tenantId ||
        thread.agentId !== origin.botId
      )
        return "gone";
      const [already] = await database
        .select({ id: threadRuns.id })
        .from(threadRuns)
        .where(eq(threadRuns.id, runId))
        .limit(1);
      if (already) return "posted";
      await runner.hydrate();
      if (await runner.isRunning({ threadId: origin.threadId })) return "busy";
      const history = runner.getThreadMessages(origin.threadId);
      const agent = new FixedReply(origin.botId, text);
      agent.threadId = origin.threadId;
      agent.setMessages(history);
      await suppressRunnerCard(
        () =>
          new Promise<void>((resolve, reject) => {
            runner
              .run({
                threadId: origin.threadId,
                agent,
                input: {
                  threadId: origin.threadId,
                  runId,
                  messages: history,
                  tools: [],
                  context: [],
                  state: {},
                  forwardedProps: {},
                },
              })
              .subscribe({ error: reject, complete: resolve });
          }),
      );
      await options
        .announce?.({ tenantId, origin, text })
        .catch(() => undefined);
      return "posted";
    });
}

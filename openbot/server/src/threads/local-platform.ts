import type { Message } from "@ag-ui/client";
import type {
  CopilotKitIntelligence,
  ThreadSummary,
} from "@copilotkit/runtime/v2";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { threads } from "../db/schema";
import type { ThreadReader } from "../channels/thread-routes";
import type { PostgresAgentRunner } from "./postgres-runner";

/**
 * The platform surface a headless turn and a hop are driven through, taken from the client's own
 * method types rather than restated.
 *
 * `routines/run-turn.ts` restates these shapes by hand (they are not exported by the package), and a
 * restatement is a second authority: a field renamed upstream still typechecks against it and is
 * silently dropped on the wire. Deriving the type from `CopilotKitIntelligence` here means the local
 * stand-in below is checked against the vendor's real signature, so the two cannot disagree about
 * what a thread's history looks like.
 */
export type ThreadPlatform = Pick<
  CopilotKitIntelligence,
  | "getOrCreateThread"
  | "getThreadMessages"
  | "ɵacquireThreadLock"
  | "ɵrenewThreadLock"
  | "ɵcleanupThreadLock"
>;

type PlatformMessageRow = Awaited<
  ReturnType<CopilotKitIntelligence["getThreadMessages"]>
>["messages"][number];

/**
 * One stored AG-UI message, expressed as the platform expresses a row of history.
 *
 * A headless turn converts what it reads into AG-UI messages (`run-turn.ts:toAgentMessage`), and it
 * does that against the platform's FLAT tool-call form (`{id, name, args}`). This store keeps AG-UI's
 * NESTED form (`{id, type: "function", function: {name, arguments}}`), so handing the turn the raw
 * snapshot would seed every tool call in the conversation with an empty name and empty arguments.
 * The conversion is here, in one place, and it accepts either form so a row that is already
 * platform-shaped passes through unchanged.
 */
function toPlatformRow(message: Message): PlatformMessageRow {
  const row = message as Message & {
    activityType?: string;
    toolCallId?: string;
    toolCalls?: {
      id: string;
      name?: string;
      args?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  const calls = (row.toolCalls ?? []).map((call) => ({
    id: call.id,
    name: call.name ?? call.function?.name ?? "",
    args: call.args ?? call.function?.arguments ?? "",
  }));
  return {
    id: row.id,
    role: row.role,
    // The platform omits `content` on a tool-call-only assistant row and AG-UI requires the field,
    // so a stored message always has one; `?? ""` covers a row written by an older build.
    content: row.content ?? "",
    ...(row.activityType ? { activityType: row.activityType } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
  };
}

/**
 * The local-mode stand-in for the platform client.
 *
 * A headless turn (a routine, a responsibility) and a hop ask the platform five things before they
 * run: make sure the conversation exists, read it, and take / renew / give back its run lock. In
 * managed mode those are REST calls into a service that streams the events to every other replica.
 * In local mode there is no service: the conversation is this process's runner and this deployment's
 * tables, and one process has nobody to lock against.
 *
 * So the five answers are: existence is written by the run itself (`postgres-runner.ts` persists the
 * `threads` row when a run finalizes, which is the same moment the platform would have created it);
 * history is read out of the runner, which is tenant-guarded at the store level; and the lock is a
 * no-op that succeeds, because `InMemoryAgentRunner` already arbitrates concurrent runs on a thread
 * in-process (`onConcurrentRun: "supersede"`). Callers keep their shape: `run-turn.ts` awaits the
 * lock and never reads a field of it, and a caller that DID read one would get this process's own
 * identifiers back rather than a platform-issued join token — which is exactly why `joinToken` is
 * empty and named here rather than invented.
 */
export function createLocalThreadPlatform(
  runner: PostgresAgentRunner,
): ThreadPlatform {
  return {
    getOrCreateThread: async ({ threadId, agentId, name }) => {
      const stored = await runner.storedThread(threadId);
      const summary: ThreadSummary = {
        id: threadId,
        name: name ?? stored?.name ?? null,
        agentId,
        createdAt: (stored?.createdAt ?? new Date()).toISOString(),
      };
      return { thread: summary, created: stored === null };
    },
    getThreadMessages: async ({ threadId }) => ({
      messages: runner.getThreadMessages(threadId).map(toPlatformRow),
    }),
    "ɵacquireThreadLock": async ({ threadId, runId }) => ({
      threadId,
      runId,
      joinToken: "",
    }),
    "ɵrenewThreadLock": async ({ ttlSeconds }) => ({ ttlSeconds }),
    "ɵcleanupThreadLock": async () => {},
  };
}

/**
 * Does this deployment hold the thread? The local answer to the question
 * `channels/thread-status.ts` asks Intelligence.
 *
 * `userId` is not consulted, deliberately: the person is who the request is running as, and that is
 * already the tenant the row-level policy compares against on this very query. A check written
 * against the id here would be a second, weaker copy of a rule the database enforces — and threads
 * in local mode are scoped per tenant, not per person, because the runtime's own thread endpoints
 * address them by id alone.
 */
export function createLocalThreadReader(database: Database): ThreadReader {
  return async (threadId) => {
    const found = await database
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    return found.length > 0 ? "known" : "unknown";
  };
}

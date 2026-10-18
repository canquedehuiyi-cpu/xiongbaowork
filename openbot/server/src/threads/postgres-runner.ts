import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
  type InMemoryThread,
  ɵGLOBAL_STORE,
} from "@copilotkit/runtime/v2";
import { asc, eq } from "drizzle-orm";
import { from, Observable, type Subscription, switchMap, tap } from "rxjs";
import type { Database } from "../db/client";
import { threadRunEvents, threadRuns, threads } from "../db/schema";
import { SYSTEM_TENANT } from "../db/schema/tenant";
import type { QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import { currentTenant, runAsTenant } from "../tenant/context";
import { runnerCardSuppressed } from "./unattended-card";

/**
 * Which tenant owns a thread id, as this process has learned it.
 *
 * The store behind {@link InMemoryAgentRunner} is a process singleton (`ɵGLOBAL_STORE`), so one
 * runner's threads are every tenant's threads as far as the runtime's local thread endpoints can
 * tell. Row-level security guards the database, and this guards the mirror of it in memory: a thread
 * this process has never written or hydrated for the calling tenant is not listed and not read.
 * Fail-closed — another tenant's conversation reads as one that does not exist.
 *
 * Module-level rather than per-instance because what it indexes is module-level too: two runners
 * over one store need one ownership table.
 */
const threadOwners = new Map<string, string>();

function ownedBy(threadId: string, tenant: string): boolean {
  const owner = threadOwners.get(threadId);
  return owner === tenant || owner === SYSTEM_TENANT;
}

/**
 * Whether the turn failed, as the stream itself said it did.
 *
 * `RUN_ERROR` is written by a run that could not carry on — the stall watchdog, an unreachable
 * coworker, a model that refused — and the stream then closes normally, so the observable reports a
 * completion. A branch that only asks which way the stream ended calls every one of those a success.
 */
function carriedFailure(events: readonly BaseEvent[]): boolean {
  return events.some((event) => event.type === EventType.RUN_ERROR);
}

/**
 * Local-mode thread persistence (`INTELLIGENCE_MODE=local`).
 *
 * The in-memory runner keeps live run semantics (SSE mode, local thread
 * endpoints); this subclass writes every finalized run through to PostgreSQL
 * and replays stored threads back into the shared store at boot, so a restart
 * loses nothing. `ɵGLOBAL_STORE` is the same bounded store the parent commits
 * finalized runs to, and `appendRun` is how a finished run enters it.
 */
export class PostgresAgentRunner extends InMemoryAgentRunner {
  private hydration: Promise<void> | null = null;

  constructor(
    private readonly database: Database,
    private readonly board?: TaskProjector,
    /** The tenant's monthly ceiling, checked before a turn starts (ticket 022). */
    private readonly quota?: QuotaService,
    /**
     * Which machine this coworker's work will be carried out on, for the board's filter (ticket 017).
     *
     * Asked, never insisted on: a turn that cannot name a machine still runs — in cloud mode there is
     * none — so the answer here is a label for the card rather than a gate. The gate is the dispatch.
     */
    private readonly deviceOf?: (agentId: string) => Promise<string | null>,
  ) {
    super({ onConcurrentRun: "supersede" });
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const tenant = currentTenant();
    const quota = this.quota;
    /*
     * Asked once, here, and passed down as a value — see `threads/unattended-card.ts`. An entry that
     * opened its own card has already met the ceiling (`routines/runner.ts` asks before it fires), so
     * this turn neither re-asks it nor files a second row.
     */
    const cardIsTaken = runnerCardSuppressed();
    if (!quota || cardIsTaken) return this.stream(request, tenant, cardIsTaken);
    /*
     * The month is asked about before the model is called, not after.
     *
     * A turn that runs and is then refused leaves a person charged for work they got and a task card
     * that never appeared; the ceiling on tasks per month only means something if the fifty-first
     * conversation does not happen at all. Deferred rather than awaited because a runner answers with
     * a stream, and the refusal has to arrive as that stream failing — which is how the browser
     * already shows a run that could not start.
     */
    return new Observable<BaseEvent>((subscriber) => {
      let inner: Subscription | undefined;
      void quota.assertCapacity(tenant, "tasksPerMonth").then(
        () => {
          inner = this.stream(request, tenant, false).subscribe(subscriber);
        },
        (thrown: unknown) => subscriber.error(thrown),
      );
      return () => inner?.unsubscribe();
    });
  }

  /** The turn itself, once the plan has admitted it. */
  private stream(
    request: AgentRunnerRunRequest,
    /** The tenant the plan was checked against, carried in rather than re-read. */
    tenant: string,
    /** Filed by the caller's own card, so this turn writes the thread and nothing else. */
    cardIsTaken: boolean,
  ): Observable<BaseEvent> {
    const { threadId } = request;
    const runId = request.input.runId;
    // `RunAgentInput` carries no agent id, so the agent instance is the only place it lives; the
    // fallback is honest about a caller that ran an anonymous agent rather than inventing one.
    const agentId = request.agent.agentId ?? "unknown";
    const startedAt = Date.now();
    const events: BaseEvent[] = [];
    // The board's chat lane: one task per turn, titled by what the person asked.
    const lastUser = [...request.input.messages]
      .reverse()
      .find((message) => message.role === "user");
    const title =
      typeof lastUser?.content === "string" && lastUser.content.trim()
        ? lastUser.content.trim()
        : "对话任务";
    /*
     * THE CARD IS OPENED FIRST, AND EVERY LATER PROJECTION WAITS ON THAT WRITE.
     *
     * Both halves are fire-and-forget on purpose — a board write must never hold up somebody's answer —
     * but fire-and-forget twice is a race, and the loser is a card stranded at `running` for good. The
     * fast failure is the common case rather than the rare one: a refused connection lands in
     * single-digit milliseconds while `opened` is still behind a device lookup and an INSERT, so its
     * `finished` UPDATE matches no row. Nothing corrects it later, because the turn is already over.
     */
    const card =
      this.board && !cardIsTaken
        ? Promise.resolve(this.deviceOf?.(agentId))
            .catch(() => null)
            .then((deviceId) =>
              // biome-ignore lint/style/noNonNullAssertion: a board is set before any run is accepted here
              this.board!.opened({
                tenantId: tenant,
                title,
                executorAgentId: agentId,
                source: "chat",
                channelRef: threadId,
                runRef: runId,
                deviceId: deviceId ?? null,
              }),
            )
            .catch((error) => {
              if (this.quota) throw error;
              console.error("task projection failed", error);
              return null;
            })
        : undefined;
    const finish = (failed: boolean) => {
      if (!card) return;
      void card
        .then(() =>
          // biome-ignore lint/style/noNonNullAssertion: a board is set before any run is accepted here
          this.board!.finished({ tenantId: tenant, runRef: runId, failed }),
        )
        .catch((error) => console.error("task projection failed", error));
    };
    const stream = () =>
      super.run(request).pipe(
        tap({
          next: (event) => events.push(event),
          complete: () => {
            /*
             * Which branch the stream took says nothing about whether the turn answered. A run can fail
             * INSIDE a stream that then closes cleanly — the stall watchdog and an unreachable coworker
             * both write a `RUN_ERROR` event and end it (server/src/channels/stall-guard.ts) — so the
             * event is what has to be read. Reporting that as a success asks the person to review a
             * deliverable that was never produced.
             */
            finish(carriedFailure(events));
            // The parent commits the run during teardown; one macrotask later
            // the snapshot is readable and goes to PostgreSQL.
            setTimeout(() => {
              void this.persist(
                tenant,
                threadId,
                runId,
                agentId,
                events,
                startedAt,
              );
            }, 0);
          },
          error: () => {
            finish(true);
          },
        }),
      );
    return card ? from(card).pipe(switchMap(stream)) : stream();
  }

  private async persist(
    tenant: string,
    threadId: string,
    runId: string,
    agentId: string,
    events: BaseEvent[],
    startedAt: number,
  ): Promise<void> {
    // The macrotask that lands this write has no async-local-storage frame of the request that
    // produced it, so the tenant captured at run() time is re-entered here by hand. Without it the
    // connection runs as `system`, RLS filters the row out of its own UPDATE, and the snapshot is
    // silently never written — a run that persists its header and loses its messages.
    await runAsTenant(tenant, async () => {
      try {
        threadOwners.set(threadId, tenant);
        const snapshot = this.peekMessages(threadId);
        await this.database
          .insert(threads)
          .values({
            id: threadId,
            tenantId: tenant,
            agentId,
            createdAt: new Date(startedAt),
          })
          .onConflictDoNothing();
        await this.database
          .update(threads)
          .set({ messagesSnapshot: snapshot, updatedAt: new Date() })
          .where(eq(threads.id, threadId));
        await this.database
          .insert(threadRuns)
          .values({ id: runId, threadId, agentId, eventCount: events.length })
          .onConflictDoNothing();
        if (events.length > 0) {
          await this.database
            .insert(threadRunEvents)
            .values(
              events.map((event, seq) => ({ threadId, runId, seq, event })),
            )
            .onConflictDoNothing();
        }
      } catch (error) {
        console.error("thread persistence failed", threadId, error);
      }
    });
  }

  /**
   * The thread's messages, unguarded by tenancy.
   *
   * `getThreadMessages` below is the guard, and a write-through belongs on the other side of it:
   * this reads the store the parent just committed to, for the tenant that owns it.
   */
  private peekMessages(threadId: string): Message[] {
    return super.getThreadMessages(threadId);
  }

  /**
   * Load stored threads back into the live store. Lazy and idempotent: the
   * wiring calls it once before the first request is served.
   *
   * Scoped to the caller's tenant — the same `threads` read every other query takes, so row-level
   * security decides what is replayed and a hydration run as the wrong tenant loads nothing.
   */
  hydrate(): Promise<void> {
    this.hydration ??= this.loadStored();
    return this.hydration;
  }

  private async loadStored(): Promise<void> {
    try {
      const stored = await this.database
        .select({
          id: threads.id,
          tenantId: threads.tenantId,
          agentId: threads.agentId,
          name: threads.name,
          createdAt: threads.createdAt,
        })
        .from(threads)
        .orderBy(asc(threads.createdAt))
        .limit(500);
      for (const thread of stored) {
        threadOwners.set(thread.id, thread.tenantId);
        const runs = await this.database
          .select({
            id: threadRuns.id,
            agentId: threadRuns.agentId,
            createdAt: threadRuns.createdAt,
          })
          .from(threadRuns)
          .where(eq(threadRuns.threadId, thread.id))
          .orderBy(asc(threadRuns.createdAt));
        const eventRows = await this.database
          .select({
            runId: threadRunEvents.runId,
            event: threadRunEvents.event,
          })
          .from(threadRunEvents)
          .where(eq(threadRunEvents.threadId, thread.id))
          .orderBy(asc(threadRunEvents.runId), asc(threadRunEvents.seq));
        const byRun = new Map<string, BaseEvent[]>();
        for (const row of eventRows) {
          const list = byRun.get(row.runId) ?? [];
          list.push(row.event as BaseEvent);
          byRun.set(row.runId, list);
        }
        const [meta] = await this.database
          .select({ messages: threads.messagesSnapshot })
          .from(threads)
          .where(eq(threads.id, thread.id))
          .limit(1);
        const snapshot = (meta?.messages as Message[] | undefined) ?? [];
        runs.forEach((run, index) => {
          ɵGLOBAL_STORE.appendRun(thread.id, {
            threadId: thread.id,
            runId: run.id,
            agentId: run.agentId,
            parentRunId: null,
            events: byRun.get(run.id) ?? [],
            // appendRun hoists the LAST run's messages to the thread level;
            // earlier runs carry none, matching how a live run commits.
            messages: index === runs.length - 1 ? snapshot : [],
            createdAt: run.createdAt.getTime(),
          });
        });
      }
    } catch (error) {
      console.error("thread hydration failed", error);
    }
  }

  /**
   * The thread's stored header, or null when this tenant holds no such thread.
   *
   * A database read rather than the in-memory store, because "does this conversation exist" is
   * asked across a restart: the store is cold until a run or a hydration puts the thread in it, while
   * the row is the record. Row-level security is the scope, so another tenant's thread answers null.
   */
  async storedThread(
    threadId: string,
  ): Promise<{ name: string | null; createdAt: Date } | null> {
    const [row] = await this.database
      .select({ name: threads.name, createdAt: threads.createdAt })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    return row ? { name: row.name, createdAt: row.createdAt } : null;
  }

  /**
   * The runtime's local thread endpoints read these three synchronously, straight out of the shared
   * store. Each is filtered through the ownership index above, so what one tenant can list or open
   * in local mode is what that tenant's own runs and hydrations put there.
   */
  override listThreads(): InMemoryThread[] {
    const tenant = currentTenant();
    return super.listThreads().filter((thread) => ownedBy(thread.id, tenant));
  }

  override getThreadMessages(threadId: string): Message[] {
    if (!ownedBy(threadId, currentTenant())) return [];
    return super.getThreadMessages(threadId);
  }

  override getThreadEvents(threadId: string): BaseEvent[] {
    if (!ownedBy(threadId, currentTenant())) return [];
    return super.getThreadEvents(threadId);
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  InMemoryAgentRunner,
  type InMemoryThread,
  ɵGLOBAL_STORE,
} from "@copilotkit/runtime/v2";
import { asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  EMPTY,
  from,
  Observable,
  type Subscription,
  switchMap,
  tap,
} from "rxjs";
import type { Database } from "../db/client";
import {
  takeLocalRunTicket,
  localDigest,
  localRunPlan,
  type LocalReceipt,
  type LocalRunTicket,
} from "../approvals/continuation-target-local";
import { threadRunEvents, threadRuns, threads } from "../db/schema";
import { SYSTEM_TENANT } from "../db/schema/tenant";
import type { QuotaService } from "../quota/limits";
import { deliverableFromEvents, type TaskProjector } from "../tasks/projector";
import {
  currentTenant,
  isPersonTenant,
  isTenantFramed,
  runAsTenant,
} from "../tenant/context";
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

/**
 * Per tenant, the one load of that tenant's stored threads into the store (G01-E P18).
 *
 * After a restart the store and the index above are empty while the rows are not, so every thread
 * read would answer as if the person had never talked to anybody. Each tenant's rows are loaded the
 * first time that tenant reaches a thread, in that tenant's own frame, and once: every later access
 * (and every concurrent first one) awaits the same promise. Module-level for the reason the index is.
 */
const tenantLoads = new Map<string, Promise<void>>();

/** How many of one tenant's threads a load brings back: the newest, its own ahead of `system`'s. */
const LOAD_LIMIT = 500;
/** Threads read per round trip while loading, so one tenant's history is never one huge result. */
const LOAD_CHUNK = 50;

function ownedBy(threadId: string, tenant: string): boolean {
  const owner = threadOwners.get(threadId);
  return owner === tenant || owner === SYSTEM_TENANT;
}

/**
 * Why a run on somebody else's thread id did not happen.
 *
 * The same words whether the id is another tenant's or `system`'s, and no owner named: the refusal
 * says this caller may not continue that id, never whose it is.
 */
export class ThreadUnavailableError extends Error {
  override readonly name = "ThreadUnavailableError";
  constructor() {
    super("This conversation is not available.");
  }
}

/**
 * A trusted continuation's run header whose terminal is not written yet (G01-E P20).
 *
 * The local continuation reserves its `thread_runs` row (`ap-local-…`, no events) before it enters
 * the runtime, and its events and count land together with its terminal. Until then the header is a
 * continuation still running — one running in this process enters the store itself, live, as it
 * finishes, so loading the empty header too would show it twice — or one whose outcome was never
 * recorded, which has nothing to replay. Ordinary runs cannot carry that prefix (`run` refuses it).
 */
function continuationInFlight(run: {
  id: string;
  eventCount: number;
}): boolean {
  return run.id.startsWith("ap-local-") && run.eventCount === 0;
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
 * The lane an unattended turn's RUNNER-filed card belongs on, for an entry that owns no card of its own.
 *
 * A follow-up a Bot scheduled for itself (`agents/wake-up.ts`) opens no card first, so this runner files
 * and charges its one card exactly as it does for any entry that is not `suppressRunnerCard`ed — but
 * nobody typed the turn, and filing it as `chat` put it under 对话触发 and outside the board's 无人值守
 * filter (story C2). This says which lane and trigger to write instead; the card's lifecycle, its charge
 * and its run ref stay the runner's. Proactive research is not here because it files its own card.
 *
 * Async local storage for the reason `threads/unattended-card.ts` gives: only server code that imports
 * it can set it, so nothing a browser sends can move a person's conversation off the 对话触发 lane, and
 * every turn accepted outside the frame — every person's own turn — files `chat` with no trigger.
 */
export type RunnerCardLane = { source: "routine"; triggerSource: "wake_up" };

const runnerLane = new AsyncLocalStorage<RunnerCardLane>();

/**
 * Run `body`, and let the turns it starts file their runner card on `lane` rather than `chat`. Like
 * `suppressRunnerCard`, wrap the region that subscribes to the run: the card is opened at subscribe time.
 */
export function fileRunnerCardAs<T>(lane: RunnerCardLane, body: () => T): T {
  return runnerLane.run(lane, body);
}

/**
 * Local-mode thread persistence (`INTELLIGENCE_MODE=local`).
 *
 * The in-memory runner keeps live run semantics (SSE mode, local thread
 * endpoints); this subclass writes every finalized run through to PostgreSQL
 * and replays a tenant's stored threads back into the shared store the first
 * time that tenant reaches one (see {@link PostgresAgentRunner.hydrate}), so a
 * restart loses nothing. `ɵGLOBAL_STORE` is the same bounded store the parent
 * commits finalized runs to, and `appendRun` is how a finished run enters it.
 */
export class PostgresAgentRunner extends InMemoryAgentRunner {
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
    private readonly deviceOf?: (
      agentId: string,
      taskRef?: string,
    ) => Promise<string | null>,
  ) {
    super({ onConcurrentRun: "supersede" });
  }

  /** Trusted AP entry only: reserve/start CAS happens before the runtime; a
   * complete stream is not success until the terminal transaction is acknowledged.
   * The ordinary SSE path below is intentionally unchanged apart from its reserved ID guard. */
  async runContinuation(
    ticket: LocalRunTicket,
    request: AgentRunnerRunRequest,
    signal?: AbortSignal,
  ): Promise<LocalReceipt> {
    // The AP factory supplies the existing trusted lifecycle guard's signal;
    // neither a request flag nor an omitted signal authorizes this entry.
    if (!signal) throw new Error("local_target_guard_signal_required");
    let cancelled = false;
    const checkCancellation = () => {
      if (cancelled || signal.aborted)
        throw new Error("local_target_cancelled");
    };
    checkCancellation();
    const tenant = currentTenant();
    const agent = request.agent;
    const verifyAgentInput = () => {
      if (
        request.agent !== agent ||
        agent.threadId !== request.threadId ||
        localDigest(agent.messages) !== localDigest(request.input.messages) ||
        localDigest(agent.state) !== localDigest(request.input.state)
      )
        throw new Error("local_target_agent_input_mismatch");
    };
    verifyAgentInput();
    /*
     * The tenant's stored threads go into the store before this run is appended after them (G01-E
     * P20), as `run` does. The load is once per tenant and never appends to a thread already holding
     * runs, so a continuation that reached a cold thread first would be all that thread ever showed.
     * It yields, so it is here, ahead of admission and of the await-free window below, and the
     * trusted signal is checked again after it. A failed load is logged and retried on the next
     * access, exactly as for `run`; it does not refuse the continuation.
     */
    await this.hydrate();
    checkCancellation();
    // Capacity may yield; recheck the trusted signal before the admission CAS.
    if (this.quota) await this.quota.assertCapacity(tenant, "tasksPerMonth");
    checkCancellation();
    const admitted = await takeLocalRunTicket(ticket, request, tenant);
    checkCancellation();
    verifyAgentInput();
    if (tenant !== admitted.plan.tenantId)
      throw new Error("local_target_tenant_mismatch");
    const events: BaseEvent[] = [];
    const prior = new Set(request.input.messages.map((message) => message.id));
    let failed = false;
    let captureFailed = false;
    let runtimeEntered = false;
    let subscription: Subscription | undefined;
    let rejectStream: ((error: Error) => void) | undefined;
    let stopPromise: Promise<boolean | undefined> | undefined;
    const cancel = () => {
      if (cancelled) return;
      // Set first: abortRun/stop can synchronously re-enter through the stream.
      cancelled = true;
      if (runtimeEntered) {
        try {
          agent.abortRun();
        } catch {
          /* Still stop this exact run below. */
        }
        try {
          stopPromise = this.stop({
            threadId: admitted.plan.threadId,
            runId: admitted.plan.runId,
          }).catch(() => undefined);
        } catch {
          stopPromise = Promise.resolve(undefined);
        }
        try {
          subscription?.unsubscribe();
        } catch {
          // Teardown is not authoritative completion. Always settle cancelled
          // below, without exposing SDK/driver error details.
        }
      }
      rejectStream?.(new Error("local_target_cancelled"));
    };
    signal.addEventListener("abort", cancel);
    try {
      checkCancellation();
      // FINAL full input check after the helper's async return. Promise's
      // executor and continuationStream execute synchronously below: NO await
      // separates this digest (including tools/context/forwarded/persisted
      // input messages) from the runtime entry.
      localRunPlan(admitted.plan, request);
      try {
        await new Promise<void>((resolve, reject) => {
          rejectStream = reject;
          checkCancellation();
          runtimeEntered = true;
          const stream = this.continuationStream(request);
          if (cancelled || signal.aborted) {
            cancel();
            reject(new Error("local_target_cancelled"));
            return;
          }
          subscription = stream.subscribe({
            next: (event) => {
              try {
                events.push(structuredClone(event));
              } catch {
                captureFailed = true;
              }
            },
            error: reject,
            complete: resolve,
          });
          // Covers a synchronous abort during subscribe before assignment.
          if (cancelled) subscription.unsubscribe();
        });
      } catch {
        // A cancelled/partial stream has no authoritative complete journal.
        // Leave its durable admission unresolved; never save a success receipt.
        checkCancellation();
        failed = true;
        events.push({
          type: EventType.RUN_ERROR,
          message: "Local continuation stream failed.",
          code: "OPENBOT_AP_LOCAL_STREAM_ERROR",
        });
      }
      checkCancellation();
      if (captureFailed) throw new Error("local_target_event_capture_unknown");
      const last = events.at(-1);
      if (
        !last ||
        (last.type !== EventType.RUN_FINISHED &&
          last.type !== EventType.RUN_ERROR)
      ) {
        failed = true;
        events.push({
          type: EventType.RUN_ERROR,
          message: "Local continuation has no terminal event.",
          code: "OPENBOT_AP_LOCAL_TERMINAL_MISSING",
        });
      }
      const messages = structuredClone(agent.messages);
      const replyText = messages
        .filter(
          (message) => !prior.has(message.id) && message.role === "assistant",
        )
        .flatMap((message) =>
          typeof message.content === "string" && message.content
            ? [message.content]
            : [],
        )
        .join("\n\n");
      failed ||=
        carriedFailure(events) ||
        agent.pendingInterrupts.length > 0 ||
        !replyText.trim();
      const receipt = await admitted.persist({
        events,
        messages,
        replyText,
        failed,
      });
      checkCancellation();
      threadOwners.set(request.threadId, tenant);
      return receipt;
    } finally {
      signal.removeEventListener("abort", cancel);
      rejectStream = undefined;
      try {
        subscription?.unsubscribe();
      } catch {
        // Cleanup errors cannot replace the safe cancellation/unknown outcome.
      } finally {
        await stopPromise;
      }
    }
  }

  /** Narrow CPU seam; production always invokes the real local SDK here. */
  protected continuationStream(
    request: AgentRunnerRunRequest,
  ): Observable<BaseEvent> {
    return super.run(request);
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (request.input.runId.startsWith("ap-local-"))
      return new Observable((subscriber) =>
        subscriber.error(new Error("local_target_trusted_entry_required")),
      );
    const tenant = currentTenant();
    const quota = this.quota;
    /*
     * Asked once, here, and passed down as a value — see `threads/unattended-card.ts`. An entry that
     * opened its own card has already met the ceiling (`routines/runner.ts` asks before it fires), so
     * this turn neither re-asks it nor files a second row.
     */
    const cardIsTaken = runnerCardSuppressed();
    // Read in the same breath and for the same reason: unset for every turn a person sends.
    const lane = runnerLane.getStore();
    /*
     * A thread id another tenant holds here is refused before anything else is asked: the parent's
     * `run` would supersede that tenant's live turn, append this run to their history, and the
     * write-through would then index the thread as this caller's.
     */
    const owner = threadOwners.get(request.threadId);
    if (owner !== undefined && owner !== tenant)
      return new Observable((subscriber) =>
        subscriber.error(new ThreadUnavailableError()),
      );
    const ceiling = cardIsTaken ? undefined : quota;
    /*
     * Two questions before the model is called, each deferred rather than awaited because a runner
     * answers with a stream, and a refusal has to arrive as that stream failing — which is how the
     * browser already shows a run that could not start.
     *
     * The month comes first. A turn that runs and is then refused leaves a person charged for work
     * they got and a task card that never appeared; the ceiling on tasks per month only means
     * something if the fifty-first conversation does not happen at all. Then the thread: see `claim`.
     */
    return new Observable<BaseEvent>((subscriber) => {
      let inner: Subscription | undefined;
      let closed = false;
      void (async () => {
        if (ceiling) await ceiling.assertCapacity(tenant, "tasksPerMonth");
        // The thread's stored history goes into the store before this run is appended after it.
        await this.hydrate();
        await this.claim(request, tenant);
      })().then(
        () => {
          if (closed) return;
          inner = this.stream(request, tenant, cardIsTaken, lane).subscribe(
            subscriber,
          );
        },
        (thrown: unknown) => subscriber.error(thrown),
      );
      return () => {
        closed = true;
        inner?.unsubscribe();
      };
    });
  }

  /**
   * Make the thread this tenant's before a turn runs on it, or refuse the turn.
   *
   * The row is the record (`threads.tenant_id`, under row-level security), and the ownership index
   * is this process's mirror of it. A thread id the index already gives this tenant needs no read. One
   * it knows nothing about is claimed by writing the header row in the caller's own frame: a new id
   * becomes theirs there and then, and an id that already has a row is theirs only if the row reads
   * back with their stamp. Another tenant's row is invisible to this frame, and `system`'s is visible
   * but outside the write scope (0072), so both read as not-the-caller's and the run is refused.
   *
   * Indexed before the parent's `run` starts rather than when the write-through lands, so the
   * owner's own reconnect during a first turn finds the thread, and nobody else's run can take the
   * id in between.
   */
  private async claim(
    request: AgentRunnerRunRequest,
    tenant: string,
  ): Promise<void> {
    const { threadId } = request;
    const known = threadOwners.get(threadId);
    if (known === tenant) return;
    if (known !== undefined) throw new ThreadUnavailableError();
    const created = await this.database
      .insert(threads)
      .values({
        id: threadId,
        tenantId: tenant,
        agentId: request.agent.agentId ?? "unknown",
      })
      .onConflictDoNothing()
      .returning({ id: threads.id });
    if (created.length === 0) {
      const [row] = await this.database
        .select({ tenantId: threads.tenantId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (row?.tenantId !== tenant) throw new ThreadUnavailableError();
    }
    // Asked again: another of this tenant's requests, or another tenant's, may have landed first.
    const now = threadOwners.get(threadId);
    if (now !== undefined && now !== tenant) throw new ThreadUnavailableError();
    threadOwners.set(threadId, tenant);
  }

  /** The turn itself, once the plan has admitted it. */
  private stream(
    request: AgentRunnerRunRequest,
    /** The tenant the plan was checked against, carried in rather than re-read. */
    tenant: string,
    /** Filed by the caller's own card, so this turn writes the thread and nothing else. */
    cardIsTaken: boolean,
    /** An unattended entry's lane for the card filed here; absent is a person's `chat` turn. */
    lane?: RunnerCardLane,
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
        ? Promise.resolve(this.deviceOf?.(agentId, runId))
            .catch(() => null)
            .then((deviceId) =>
              // biome-ignore lint/style/noNonNullAssertion: a board is set before any run is accepted here
              this.board!.opened({
                tenantId: tenant,
                title,
                executorAgentId: agentId,
                source: lane?.source ?? "chat",
                triggerSource: lane?.triggerSource ?? null,
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
      /*
       * What the turn produced rides on the card (spec A9), read from the stream before it is handed
       * on. A failed turn's half-drawn output is not something to review, so it carries none.
       */
      const produced = () => {
        // Read inside the stream's `complete`: a throw here would skip the transcript's write below.
        try {
          return deliverableFromEvents(
            events,
            new Set(request.input.messages.map((message) => message.id)),
          );
        } catch (error) {
          console.error("task deliverable unreadable", error);
          return undefined;
        }
      };
      const deliverableRef = failed ? undefined : produced();
      void card
        .then(() =>
          // biome-ignore lint/style/noNonNullAssertion: a board is set before any run is accepted here
          this.board!.finished({
            tenantId: tenant,
            runRef: runId,
            failed,
            deliverableRef,
          }),
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
   * Load the calling tenant's stored threads back into the live store, once per tenant per process.
   *
   * Nothing calls this at boot: there is no frame at boot, and no single tenant whose threads they
   * are. It is awaited wherever a tenant first reaches a thread — every signed-in runtime request
   * (`mountCopilotRuntime`), a run, a trusted local continuation (`runContinuation`) and the local
   * platform's history read — in that tenant's frame, and the reads below are re-entered in that
   * frame explicitly. Row-level security decides what loads, and the query asks for the caller's own
   * stamp and `system`'s besides, so even a frame that reads across tenants (`platform`) could not
   * load somebody else's here; a frame that is not a person's loads nothing at all.
   *
   * Idempotent per tenant and safe under concurrent first requests: the promise is shared, so a
   * tenant's rows are read once. A load that fails is forgotten, so the next access tries again, and
   * a thread already holding runs in the store is never appended to a second time.
   */
  hydrate(): Promise<void> {
    const tenant = currentTenant();
    if (!isPersonTenant(tenant)) return Promise.resolve();
    const pending = tenantLoads.get(tenant);
    if (pending) return pending;
    const load: Promise<void> = runAsTenant(tenant, () =>
      this.loadStored(tenant),
    ).catch((error: unknown) => {
      if (tenantLoads.get(tenant) === load) tenantLoads.delete(tenant);
      console.error("thread hydration failed", error);
    });
    tenantLoads.set(tenant, load);
    return load;
  }

  private async loadStored(tenant: string): Promise<void> {
    const stored = await this.database
      .select({
        id: threads.id,
        tenantId: threads.tenantId,
        messages: threads.messagesSnapshot,
      })
      .from(threads)
      .where(
        or(eq(threads.tenantId, tenant), eq(threads.tenantId, SYSTEM_TENANT)),
      )
      .orderBy(
        desc(sql`${threads.tenantId} = ${tenant}`),
        desc(threads.updatedAt),
      )
      .limit(LOAD_LIMIT);
    // Oldest first into the store, so its LRU order ends with the conversations used last.
    const loadable = stored
      .filter(
        (row) => row.tenantId === tenant || row.tenantId === SYSTEM_TENANT,
      )
      .reverse();
    for (let at = 0; at < loadable.length; at += LOAD_CHUNK) {
      const chunk = loadable.slice(at, at + LOAD_CHUNK);
      const ids = chunk.map((row) => row.id);
      const runs = await this.database
        .select({
          id: threadRuns.id,
          threadId: threadRuns.threadId,
          agentId: threadRuns.agentId,
          eventCount: threadRuns.eventCount,
          createdAt: threadRuns.createdAt,
        })
        .from(threadRuns)
        .where(inArray(threadRuns.threadId, ids))
        .orderBy(asc(threadRuns.createdAt), asc(threadRuns.id));
      const eventRows = await this.database
        .select({
          runId: threadRunEvents.runId,
          event: threadRunEvents.event,
        })
        .from(threadRunEvents)
        .where(inArray(threadRunEvents.threadId, ids))
        .orderBy(asc(threadRunEvents.runId), asc(threadRunEvents.seq));
      const eventsOf = new Map<string, BaseEvent[]>();
      for (const row of eventRows) {
        const list = eventsOf.get(row.runId) ?? [];
        list.push(row.event as BaseEvent);
        eventsOf.set(row.runId, list);
      }
      const runsOf = new Map<string, typeof runs>();
      for (const run of runs) {
        if (continuationInFlight(run)) continue;
        const list = runsOf.get(run.threadId) ?? [];
        list.push(run);
        runsOf.set(run.threadId, list);
      }
      // No await from here to the end of the chunk: each thread is checked and filled in one go.
      for (const thread of chunk)
        this.replay(thread, runsOf.get(thread.id) ?? [], eventsOf);
    }
  }

  /**
   * One stored thread into the store and the index, unless this process already holds it.
   *
   * The entry is created before the runs are appended: the store's `appendRun` drops a run for a
   * thread it holds no entry for. A thread already holding runs (another tenant's load brought a
   * `system` thread in, or a turn landed first) is left as it is, so nothing is ever appended twice;
   * and one the index gives somebody else is not touched.
   */
  private replay(
    thread: { id: string; tenantId: string; messages: unknown[] },
    runs: readonly { id: string; agentId: string; createdAt: Date }[],
    eventsOf: ReadonlyMap<string, BaseEvent[]>,
  ): void {
    const owner = threadOwners.get(thread.id);
    if (owner !== undefined && owner !== thread.tenantId) return;
    threadOwners.set(thread.id, thread.tenantId);
    if (runs.length === 0) return;
    if ((ɵGLOBAL_STORE.peek(thread.id)?.historicRuns.length ?? 0) > 0) return;
    ɵGLOBAL_STORE.getOrCreate(thread.id);
    const snapshot = thread.messages as Message[];
    runs.forEach((run, index) => {
      ɵGLOBAL_STORE.appendRun(thread.id, {
        threadId: thread.id,
        runId: run.id,
        agentId: run.agentId,
        parentRunId: runs[index - 1]?.id ?? null,
        events: eventsOf.get(run.id) ?? [],
        // appendRun hoists the LAST run's messages to the thread level;
        // earlier runs carry none, matching how a live run commits.
        messages: index === runs.length - 1 ? snapshot : [],
        createdAt: run.createdAt.getTime(),
      });
    });
  }

  /**
   * The thread's stored header, or null when this tenant holds no such thread.
   *
   * A database read rather than the in-memory store, because "does this conversation exist" is
   * asked across a restart: the store is cold until a run or the tenant's first access (`hydrate`)
   * puts the thread in it, while the row is the record. Row-level security is the scope, so another
   * tenant's thread answers null.
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

  /**
   * `/agent/:id/connect` replays a thread straight out of the shared store, by thread id alone — the
   * Bot in the path is not the thread's. Guarded the way the three reads above are: a thread this
   * tenant does not hold answers what an id nobody ever ran answers, a stream that completes empty.
   */
  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    if (!ownedBy(request.threadId, currentTenant())) return EMPTY;
    return super.connect(request);
  }

  /** Whether somebody else's thread is mid-turn is not this caller's to learn. */
  override isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    if (!ownedBy(request.threadId, currentTenant()))
      return Promise.resolve(false);
    return super.isRunning(request);
  }

  /**
   * Stopping a turn is a write on the thread, so it takes the write scope: a thread the index gives
   * another tenant (`system` included), or asked outside any frame, answers "no active run", as an
   * unknown one does. A thread the index does not know yet is left to the parent, which is what a
   * local continuation's own cancellation stops before its write-through lands.
   */
  override stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const owner = threadOwners.get(request.threadId);
    if (owner !== undefined && (!isTenantFramed() || owner !== currentTenant()))
      return Promise.resolve(false);
    return super.stop(request);
  }
  /**
   * `/threads/clear`: the caller's own conversations out of the in-memory store, and nobody else's.
   *
   * The inherited method empties the whole process-wide store — every tenant's live history and
   * connect replay, for whoever pressed Clear. Like it, this touches memory only (the stored rows
   * are the record and stay), and takes the write scope: a thread the index gives exactly this
   * tenant, not `system`'s. The ownership entries stay, so a cleared id is still this tenant's and
   * nobody else can take it. Outside a frame nothing is cleared.
   */
  override clearThreads(): void {
    if (!isTenantFramed()) return;
    const tenant = currentTenant();
    // The store's own removal, so its byte accounting stays right. Private in its typings; a
    // runtime without it clears nothing rather than everything.
    const store = ɵGLOBAL_STORE as unknown as {
      peek(threadId: string): object | undefined;
      removeThread?: (threadId: string, entry: object) => void;
    };
    if (typeof store.removeThread !== "function") return;
    for (const [threadId, owner] of threadOwners) {
      if (owner !== tenant) continue;
      const entry = store.peek(threadId);
      if (entry) store.removeThread(threadId, entry);
    }
  }
}

import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvalContinuations as ledger,
  approvalContinuationSteps as steps,
} from "../db/schema/approvals";
import { threadRunEvents, threadRuns, threads } from "../db/schema/threads";
import { runAsTenant } from "../tenant/context";
import type {
  ContinuationLease,
  ContinuationReceipt,
  DispatchIntent,
  NeverAdmittedProof,
} from "./continuation-protocol";
import {
  isLocalReceipt,
  localDigest,
  localProofId,
  localReceipt,
  localRunId,
  sameLocalIdentity,
  terminalObservation,
  type LocalReceipt,
  type LocalRunPlan,
  type LocalTargetPersistence,
  type LocalTerminal,
} from "./continuation-target-local";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const STEP = "local_run";
const TABLES = [
  "approval_requests",
  "approval_continuations",
  "approval_continuation_steps",
  "threads",
  "thread_runs",
  "thread_run_events",
];
export type LocalReleaseFacts = {
  databaseName: string;
  role: string;
  catalogDigest: string;
};
/** Supplied only by Root's trusted release verifier, NOT HTTP/config/user input.
 * No default authority exists. Canonical migration/RLS and Root release pending
 * means this adapter remains disabled. The attestation binds actual PG catalogs.
 * This package does not invent a Root release storage table or bypass C3 roles. */
export type LocalReleaseAuthority = {
  readVerifiedRelease(facts: LocalReleaseFacts): Promise<{
    lineage: "recovery-20261018-v1";
    releaseId: string;
    databaseName: string;
    catalogDigest: string;
    feature: "approval-local-target-v1";
  } | null>;
};
export class LocalTargetConflict extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LocalTargetConflict";
  }
}

/** Real PG admission + run header reservation, then terminal journal + receipt.
 * authorityDatabase MUST be a separate pool: AP-store verifies receipt while
 * holding its primary transaction/row lock. Verification uses plain committed
 * reads on this pool, never FOR UPDATE, avoiding a max=1 callback deadlock. */
export function createLocalTargetStore(
  database: Database,
  authorityDatabase: Database,
  suppliedPlan: LocalRunPlan,
  options: { release?: LocalReleaseAuthority } = {},
) {
  if (database === authorityDatabase)
    throw new LocalTargetConflict("independent_authority_pool_required");
  const plan: LocalRunPlan = Object.freeze({ ...suppliedPlan });
  if (
    !Object.values(plan).every(
      (value) => typeof value === "string" && value.trim(),
    ) ||
    plan.runId !== localRunId(plan)
  )
    throw new LocalTargetConflict("invalid_local_plan");
  let released = false;
  let releaseReason = "root_release_not_attested";
  const scope = (table: typeof ledger | typeof steps) =>
    and(
      eq(table.approvalId, plan.approvalId),
      eq(table.tenantId, plan.tenantId),
      eq(table.ownerId, plan.ownerId),
      eq(table.inputDigest, plan.inputDigest),
      eq(table.admissionId, plan.admissionId),
    );
  const stepScope = () => and(scope(steps), eq(steps.stepKey, STEP));
  const leaseScope = (lease: ContinuationLease) =>
    and(
      scope(ledger),
      eq(ledger.claimOwner, lease.workerId),
      eq(ledger.fence, lease.fence),
      sql`${ledger.leaseUntil} > clock_timestamp()`,
      sql`${ledger.state} <> 'completed'`,
    );
  async function gate(tx: Transaction) {
    if (!options.release)
      throw new LocalTargetConflict("root_release_not_attested");
    const result = await tx.execute(sql`
      select current_database() as database_name, current_user as role,
        r.rolsuper as super, r.rolbypassrls as bypass,
        (select jsonb_agg(jsonb_build_object('name', c.relname, 'rls', c.relrowsecurity,
          'force', c.relforcerowsecurity, 'owner', pg_get_userbyid(c.relowner),
          'acl', c.relacl::text,
          'columns', (select jsonb_agg(jsonb_build_object('name', a.attname,
            'type', format_type(a.atttypid,a.atttypmod), 'nn', a.attnotnull, 'acl', a.attacl::text,
            'default', pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
            from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
            where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
          'constraints', (select jsonb_agg(jsonb_build_object('name', q.conname,
            'def', pg_get_constraintdef(q.oid), 'validated', q.convalidated) order by q.conname)
            from pg_constraint q where q.conrelid=c.oid),
          'policies', (select jsonb_agg(jsonb_build_object('name', p.polname, 'command', p.polcmd,
            'roles', p.polroles::text, 'using', pg_get_expr(p.polqual,p.polrelid),
            'check', pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname)
            from pg_policy p where p.polrelid=c.oid),
          'triggers', (select jsonb_agg(jsonb_build_object('name', t.tgname, 'enabled', t.tgenabled,
            'internal', t.tgisinternal, 'def', pg_get_triggerdef(t.oid)) order by t.tgname)
            from pg_trigger t where t.tgrelid=c.oid)) order by c.relname)
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname in (${sql.join(
            TABLES.map((name) => sql`${name}`),
            sql`, `,
          )})) as tables
      from pg_roles r where r.rolname=current_user`);
    const row = result[0];
    if (
      !row ||
      typeof row.database_name !== "string" ||
      typeof row.role !== "string" ||
      row.super !== false ||
      row.bypass !== false ||
      !Array.isArray(row.tables) ||
      row.tables.length !== TABLES.length
    )
      throw new LocalTargetConflict("local_role_or_catalog_unverified");
    for (const table of row.tables) {
      if (
        !table ||
        typeof table !== "object" ||
        !("rls" in table) ||
        table.rls !== true ||
        !("force" in table) ||
        table.force !== true ||
        !("owner" in table) ||
        table.owner === row.role
      )
        throw new LocalTargetConflict("local_force_rls_required");
    }
    const facts: LocalReleaseFacts = {
      databaseName: row.database_name,
      role: row.role,
      catalogDigest: localDigest(row.tables),
    };
    const release = await options.release.readVerifiedRelease(facts);
    if (
      release?.lineage !== "recovery-20261018-v1" ||
      release.feature !== "approval-local-target-v1" ||
      !release.releaseId.trim() ||
      release.databaseName !== facts.databaseName ||
      release.catalogDigest !== facts.catalogDigest
    )
      throw new LocalTargetConflict("root_release_not_attested");
  }
  async function transaction<T>(
    db: Database,
    fn: (tx: Transaction) => Promise<T>,
  ) {
    if (!released) throw new LocalTargetConflict("root_release_not_attested");
    return runAsTenant(plan.tenantId, () =>
      db.transaction(async (tx) => {
        try {
          await gate(tx);
        } catch (error) {
          released = false;
          releaseReason = "release_revalidation_failed";
          throw error;
        }
        return fn(tx);
      }),
    );
  }
  function binding(lease: ContinuationLease) {
    if (
      !sameLocalIdentity(plan, lease) ||
      !lease.workerId.trim() ||
      lease.fence <= 0n
    )
      throw new LocalTargetConflict("local_identity_conflict");
  }
  async function parent(
    tx: Transaction,
    lease: ContinuationLease,
    lock: boolean,
  ) {
    const query = tx
      .select({
        ...getTableColumns(ledger),
        live: sql<boolean>`coalesce(${ledger.leaseUntil} > clock_timestamp(),false)`,
      })
      .from(ledger)
      .where(scope(ledger));
    const [row] = await (lock ? query.for("update") : query);
    if (
      row?.branchKind !== "thread" ||
      row.branchTargetId !== plan.threadId ||
      row.origin !== "current"
    )
      throw new LocalTargetConflict("local_branch_or_provenance_conflict");
    if (
      lock &&
      (!row.live ||
        row.fence !== lease.fence ||
        row.claimOwner !== lease.workerId ||
        row.state === "completed")
    )
      throw new LocalTargetConflict("local_fence_lost");
    return row;
  }
  async function liveEnd(tx: Transaction, lease: ContinuationLease) {
    const [row] = await tx
      .select({ id: ledger.approvalId })
      .from(ledger)
      .where(leaseScope(lease));
    if (!row) throw new LocalTargetConflict("local_fence_lost");
  }
  function intentMatches(
    row: typeof ledger.$inferSelect,
    intent: DispatchIntent,
  ) {
    if (
      row.state !== "dispatched" ||
      row.intentFence !== intent.fence ||
      row.intentId !== intent.intentId ||
      row.proofId !== intent.proofId ||
      intent.proofId !== localProofId(intent) ||
      !intent.intentId.trim()
    )
      throw new LocalTargetConflict("local_durable_intent_required");
  }
  async function step(tx: Transaction) {
    // Look up the PK first: a mismatched tenant/owner/digest must not look absent.
    const [row] = await tx
      .select()
      .from(steps)
      .where(
        and(eq(steps.approvalId, plan.approvalId), eq(steps.stepKey, STEP)),
      );
    if (
      row &&
      !sameLocalIdentity({ ...row, admissionId: row.admissionId ?? "" }, plan)
    )
      throw new LocalTargetConflict("local_step_binding_conflict");
    return row;
  }
  async function readTerminal(tx: Transaction): Promise<LocalReceipt | null> {
    const saved = await step(tx);
    if (
      saved?.state !== "completed" ||
      !saved.receipt ||
      !isLocalReceipt(saved.receipt) ||
      !saved.completedAt
    )
      return null;
    const receipt = saved.receipt;
    if (
      !sameLocalIdentity(receipt, plan) ||
      receipt.threadId !== plan.threadId ||
      receipt.runId !== plan.runId ||
      receipt.agentId !== plan.agentId ||
      receipt.admittedFence !== saved.fence.toString()
    )
      throw new LocalTargetConflict("local_receipt_binding_conflict");
    const [run] = await tx
      .select()
      .from(threadRuns)
      .where(
        and(
          eq(threadRuns.id, plan.runId),
          eq(threadRuns.threadId, plan.threadId),
          eq(threadRuns.tenantId, plan.tenantId),
          eq(threadRuns.agentId, plan.agentId),
        ),
      );
    const events = await tx
      .select({ event: threadRunEvents.event, seq: threadRunEvents.seq })
      .from(threadRunEvents)
      .where(
        and(
          eq(threadRunEvents.runId, plan.runId),
          eq(threadRunEvents.threadId, plan.threadId),
          eq(threadRunEvents.tenantId, plan.tenantId),
        ),
      )
      .orderBy(asc(threadRunEvents.seq));
    if (
      !run ||
      run.eventCount !== events.length ||
      !events.length ||
      events.some((x, i) => x.seq !== i)
    )
      throw new LocalTargetConflict("local_terminal_journal_incomplete");
    // Snapshot at this run's terminal is in its terminal CUSTOM event, not the
    // thread's latest mutable snapshot (a subsequent ordinary turn may update it).
    const last = events.at(-1)?.event;
    if (
      !last ||
      typeof last !== "object" ||
      !("type" in last) ||
      last.type !== EventType.CUSTOM ||
      !("name" in last) ||
      last.name !== "openbot.ap.local-terminal.v1" ||
      !("value" in last) ||
      !last.value ||
      typeof last.value !== "object" ||
      !("messages" in last.value) ||
      !Array.isArray(last.value.messages)
    )
      throw new LocalTargetConflict("local_terminal_marker_missing");
    // JSONB is unknown at runtime; validate via AG-UI's exported schemas below.
    const terminal = decodeTerminal(
      events.slice(0, -1).map((x) => x.event),
      last.value.messages,
      receipt,
    );
    const expected = localReceipt(plan, saved.fence, terminal);
    if (localDigest(expected) !== localDigest(receipt))
      throw new LocalTargetConflict("local_receipt_digest_conflict");
    return receipt;
  }
  const persistence: LocalTargetPersistence = {
    plan,
    get enabled() {
      return released;
    },
    async observe(lease) {
      binding(lease);
      return transaction(database, async (tx) => {
        await parent(tx, lease, false);
        const prior = await step(tx);
        if (prior) {
          const receipt = await readTerminal(tx);
          return receipt ? terminalObservation(receipt) : { kind: "unknown" };
        }
        // Lock only the absence path and re-read after acquiring it: read ->
        // lock can race another replica's committed reservation.
        await parent(tx, lease, true);
        if (await step(tx)) {
          const receipt = await readTerminal(tx);
          return receipt ? terminalObservation(receipt) : { kind: "unknown" };
        }
        const [run] = await tx
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(eq(threadRuns.id, plan.runId));
        if (run) return { kind: "unknown" };
        await liveEnd(tx, lease);
        // Only an authoritative, gated, post-cutover locked absence can issue
        // this proof. A fixed run ID or ordinary 404 is insufficient.
        return {
          kind: "never_admitted",
          proof: { ...lease, proofId: localProofId(lease) },
        };
      });
    },
    async reserve(intent) {
      binding(intent);
      return transaction(database, async (tx) => {
        const row = await parent(tx, intent, true);
        intentMatches(row, intent);
        if (await step(tx)) return "unknown";
        const [priorRun] = await tx
          .select({ id: threadRuns.id })
          .from(threadRuns)
          .where(eq(threadRuns.id, plan.runId));
        if (priorRun) return "unknown";
        await tx
          .insert(threads)
          .values({
            id: plan.threadId,
            tenantId: plan.tenantId,
            agentId: plan.agentId,
          })
          .onConflictDoNothing();
        const [thread] = await tx
          .select()
          .from(threads)
          .where(
            and(
              eq(threads.id, plan.threadId),
              eq(threads.tenantId, plan.tenantId),
            ),
          )
          .for("update");
        if (!thread || thread.agentId !== plan.agentId)
          throw new LocalTargetConflict("local_thread_binding_conflict");
        await tx.insert(threadRuns).values({
          id: plan.runId,
          tenantId: plan.tenantId,
          threadId: plan.threadId,
          agentId: plan.agentId,
          eventCount: 0,
        });
        await tx.insert(steps).values({
          approvalId: plan.approvalId,
          stepKey: STEP,
          tenantId: plan.tenantId,
          ownerId: plan.ownerId,
          inputDigest: plan.inputDigest,
          admissionId: plan.admissionId,
          state: "reserved",
          fence: intent.fence,
        });
        await liveEnd(tx, intent);
        return "reserved";
      });
    },
    async begin(intent) {
      binding(intent);
      return transaction(database, async (tx) => {
        const row = await parent(tx, intent, true);
        intentMatches(row, intent);
        const prior = await step(tx);
        if (prior?.state !== "reserved" || prior.fence !== intent.fence)
          return false;
        const changed = await tx
          .update(steps)
          .set({ state: "running" })
          .where(
            and(
              stepScope(),
              eq(steps.fence, intent.fence),
              eq(steps.state, "reserved"),
            ),
          )
          .returning();
        await liveEnd(tx, intent);
        return changed.length === 1;
      });
    },
    async saveTerminal(intent, terminal) {
      binding(intent);
      return transaction(database, async (tx) => {
        const row = await parent(tx, intent, true);
        intentMatches(row, intent);
        const prior = await step(tx);
        if (prior?.state !== "running" || prior.fence !== intent.fence)
          throw new LocalTargetConflict("local_terminal_fence_conflict");
        // Validate even the typed writer boundary, before any terminal writes.
        const verified = decodeTerminal(
          terminal.events,
          terminal.messages,
          terminal,
        );
        const end = verified.events.at(-1);
        if (
          end?.type === EventType.RUN_FINISHED &&
          (!("runId" in end) ||
            end.runId !== plan.runId ||
            !("threadId" in end) ||
            end.threadId !== plan.threadId)
        )
          throw new LocalTargetConflict("local_terminal_run_binding_conflict");
        const receipt = localReceipt(plan, intent.fence, verified);
        const marker: BaseEvent = {
          type: EventType.CUSTOM,
          name: "openbot.ap.local-terminal.v1",
          value: { messages: verified.messages },
        };
        const events = [...verified.events, marker];
        const [run] = await tx
          .select()
          .from(threadRuns)
          .where(
            and(
              eq(threadRuns.id, plan.runId),
              eq(threadRuns.tenantId, plan.tenantId),
              eq(threadRuns.threadId, plan.threadId),
            ),
          )
          .for("update");
        if (!run || run.agentId !== plan.agentId || run.eventCount !== 0)
          throw new LocalTargetConflict("local_run_header_conflict");
        await tx.insert(threadRunEvents).values(
          events.map((event, seq) => ({
            tenantId: plan.tenantId,
            threadId: plan.threadId,
            runId: plan.runId,
            seq,
            event: sql`${JSON.stringify(event)}::jsonb`,
          })),
        );
        const headers = await tx
          .update(threadRuns)
          .set({ eventCount: events.length })
          .where(
            and(
              eq(threadRuns.id, plan.runId),
              eq(threadRuns.tenantId, plan.tenantId),
              eq(threadRuns.eventCount, 0),
            ),
          )
          .returning();
        const snapshots = await tx
          .update(threads)
          .set({
            messagesSnapshot: sql`${JSON.stringify(verified.messages)}::jsonb`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(threads.id, plan.threadId),
              eq(threads.tenantId, plan.tenantId),
              eq(threads.agentId, plan.agentId),
            ),
          )
          .returning();
        const completed = await tx
          .update(steps)
          .set({
            state: "completed",
            receipt,
            completedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              stepScope(),
              eq(steps.state, "running"),
              eq(steps.fence, intent.fence),
            ),
          )
          .returning();
        if (
          headers.length !== 1 ||
          snapshots.length !== 1 ||
          completed.length !== 1
        )
          throw new LocalTargetConflict("local_terminal_write_conflict");
        await liveEnd(tx, intent);
        return receipt;
      });
    },
  };
  return {
    ...persistence,
    get enabled() {
      return released;
    },
    get releaseReason() {
      return releaseReason;
    },
    /** Read-only gate before advertising capabilities. Revalidated in every
     * write/read transaction; missing or unknown release never opens effects. */
    async authorizeRelease(): Promise<boolean> {
      if (!options.release) return false;
      try {
        await runAsTenant(plan.tenantId, () =>
          database.transaction(async (tx) => {
            await gate(tx);
          }),
        );
        released = true;
        releaseReason = "released";
        return true;
      } catch (error) {
        released = false;
        releaseReason =
          error instanceof LocalTargetConflict
            ? error.message
            : "release_verification_unknown";
        return false;
      }
    },
    async verifyNeverAdmittedProof(
      proof: NeverAdmittedProof,
    ): Promise<boolean> {
      if (!released || proof.proofId !== localProofId(proof)) return false;
      const observed = await persistence.observe(proof);
      return (
        observed.kind === "never_admitted" &&
        observed.proof.proofId === proof.proofId
      );
    },
    async verifyReceipt(receipt: ContinuationReceipt): Promise<boolean> {
      if (
        !released ||
        !sameLocalIdentity(receipt, plan) ||
        !isLocalReceipt(receipt) ||
        receipt.failed
      )
        return false;
      return transaction(authorityDatabase, async (tx) => {
        const [row] = await tx.select().from(ledger).where(scope(ledger));
        if (
          row?.origin !== "current" ||
          row.branchKind !== "thread" ||
          row.branchTargetId !== plan.threadId
        )
          return false;
        const authoritative = await readTerminal(tx);
        return (
          authoritative !== null &&
          localDigest(authoritative) === localDigest(receipt)
        );
      });
    },
  };
}

// Parsing actual JSONB is essential: a TS $type does not validate database data.
import { BaseEventSchema, MessageSchema } from "@ag-ui/client";
function decodeTerminal(
  events: unknown[],
  messages: unknown[],
  result: { replyText: string; failed: boolean },
): LocalTerminal {
  const parsedEvents: BaseEvent[] = events.map((event) =>
    BaseEventSchema.passthrough().parse(event),
  );
  const parsedMessages: Message[] = messages.map((message) => {
    if (!MessageSchema.safeParse(message).success)
      throw new LocalTargetConflict("local_invalid_message");
    return message as Message;
  });
  const last = parsedEvents.at(-1);
  if (
    !last ||
    (last.type !== EventType.RUN_FINISHED &&
      last.type !== EventType.RUN_ERROR) ||
    typeof result.replyText !== "string" ||
    typeof result.failed !== "boolean" ||
    (!result.failed &&
      (!result.replyText.trim() ||
        parsedEvents.some((e) => e.type === EventType.RUN_ERROR)))
  )
    throw new LocalTargetConflict("local_invalid_terminal");
  return {
    events: parsedEvents,
    messages: parsedMessages,
    replyText: result.replyText,
    failed: result.failed,
  };
}

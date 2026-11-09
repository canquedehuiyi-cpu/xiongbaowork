/**
 * Suspending computers nobody is using.
 *
 * A `Sandbox` has `shutdownTime`, an absolute expiry, which is not the question anybody is asking:
 * "nobody has touched this for thirty minutes" is. So this asks that one, and it has to survive the
 * replica that started it, which is why the work is claimed and leased out of PostgreSQL rather than
 * held in a timer.
 *
 * NOTHING HERE TOUCHES A BROWSER. Deciding whether a computer is idle by dialling it would wake the
 * computer, so every idle Bot anything asked about would come back up and the bill would never fall.
 * That is the known, invisible way to lose scale-to-zero: everything works, nothing ever suspends.
 * Idleness is read from the audit trail, which is a record of what a Bot did rather than a question
 * put to the thing that did it.
 */
import { and, inArray, like, sql } from "drizzle-orm";
import { ownerTenantsOfBots } from "../agents/bot-owner";
import {
  type ComputerKey,
  computerKeyText,
  parseComputerKey,
} from "../computer/computer-key";
import type { ComputerProvider } from "../computer/provider";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";
import {
  isPersonTenant,
  runAsClaimedTenant,
  runAsTenant,
} from "../tenant/context";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "./queue";

export const CULL_KIND = "computer.suspend";

export type CullerOptions = {
  database: Database;
  queue: WorkQueue;
  provider: ComputerProvider;
  /** A computer untouched for this long is idle. */
  idleAfterMs: number;
  /** Who this replica is, for the lease. */
  owner: string;
  leaseMs?: number;
  /** How many goes an item gets before it stops being offered. */
  maxAttempts?: number;
  now?: () => Date;
};

export type CullReport = {
  considered: number;
  /** The computers suspended, as `person:<id>` or `bot:<id>`. */
  suspended: string[];
  skipped: { computer: string; reason: string }[];
};

/**
 * When each computer was last asked to do anything, keyed by `person:<id>` or `bot:<id>`.
 *
 * The audit trail is the source: every acting call writes a row before the computer is touched, so
 * "last used" is already recorded, server-side, and survives a restart. A computer that has never
 * acted has no row and reads as idle since it started, which is the answer wanted.
 *
 * BY COMPUTER, NOT BY BOT. A person's computer carries every Bot they use, so it is in use while any
 * of them is: grouping by Bot would put it to sleep under one Bot because another had gone quiet.
 * Each row names its computer; a row from before computers were per person names only its Bot, and
 * that Bot had a computer of its own, which is what `bot:<id>` means.
 *
 * Exported for the inactive-computer stop in admin/controls.ts, which asks the same question.
 */
export async function lastUsedByComputer(
  database: Database,
  computers: string[],
): Promise<Map<string, Date>> {
  if (computers.length === 0) return new Map();
  /*
   * The computer is in the payload rather than in a column, so the grouping key is an expression.
   * Written through the query builder rather than as one raw string, because a list parameter has
   * to be bound as a list: handed to `= any($1)` as a JavaScript array it arrives as one opaque value
   * and the query fails rather than matching nothing, which at least says so.
   */
  const computer = sql<string>`coalesce(${auditEvents.payload}->>'computer', 'bot:' || (${auditEvents.payload}->>'bot'))`;
  /*
   * As `platform`, because this is the culler's question and not a person's: "when was each of these
   * computers last used", asked about computers from every tenant at once. From the cron job's own
   * context the answer is no rows at all, and the caller then has nothing to measure idleness with —
   * every running computer looks either brand new or unknowable, and the deployment never scales to
   * zero. That is the failure this file warns about two comments earlier, arriving from the other
   * direction: not a wake-up, but a bill that quietly stops ever falling.
   */
  const rows = await runAsTenant("platform", () =>
    database
      .select({ computer, last: sql<string>`max(${auditEvents.createdAt})` })
      .from(auditEvents)
      .where(
        and(
          like(auditEvents.eventType, "computer.%"),
          inArray(computer, computers),
        ),
      )
      .groupBy(computer),
  );

  return new Map(
    rows
      .filter((row) => row.computer)
      .map((row) => [row.computer, new Date(row.last)] as const),
  );
}

/**
 * The running computers, one entry each.
 *
 * The shared computer lists a person's seats on it rather than computers, so a person with three
 * Bots there would otherwise be three entries for the one thing that is stopped.
 */
export function runningComputers(
  computers: { key: ComputerKey; status: string; startedAt?: string }[],
): { key: ComputerKey; computer: string; startedAt?: string }[] {
  const seen = new Map<
    string,
    { key: ComputerKey; computer: string; startedAt?: string }
  >();
  for (const entry of computers) {
    if (entry.status !== "running") continue;
    const computer = computerKeyText(entry.key);
    const held = seen.get(computer);
    // The earliest start stands for the computer: it has been up at least that long.
    if (
      !held ||
      (entry.startedAt && (!held.startedAt || entry.startedAt < held.startedAt))
    ) {
      seen.set(computer, {
        key: entry.key,
        computer,
        ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      });
    }
  }
  return [...seen.values()];
}

/**
 * Whose each computer is (G01, G01-E), keyed by its text: a person's computer is that person's; an
 * isolated Bot's (`bot:<id>`) is that Bot's owner's — the tenant stamped on its own `agents` row, or
 * for a team Bot (stamped `team`, which is nobody) the person its profile names. See
 * `agents/bot-owner.ts`.
 *
 * The suspension is that owner's business, so the work item is offered and later carried out in
 * that tenant — never in the culler's, which is nobody's. Read as `platform` because the question
 * spans every tenant. A computer with no person behind it (a Bot with no row, or one that is
 * nobody's: `system`, `platform`, empty, or a team Bot whose profile names no person) is null; it is
 * still suspended, under the platform rule below, because a computer left running costs money and
 * stopping one touches no person's data.
 */
async function computerTenants(
  database: Database,
  keys: ComputerKey[],
): Promise<Map<string, string | null>> {
  const bots = await ownerTenantsOfBots(
    database,
    keys.flatMap((key) => (key.kind === "bot" ? [key.botId] : [])),
  );
  return new Map(
    keys.map((key) => {
      const tenant =
        key.kind === "person" ? key.personId : (bots.get(key.botId) ?? null);
      return [computerKeyText(key), isPersonTenant(tenant) ? tenant : null];
    }),
  );
}

/**
 * THE PLATFORM RULE (G01). A computer with no person behind it — an isolated Bot with no `agents`
 * row (deleted while its computer ran) or whose row is stamped as nobody's (`system`, `platform`,
 * empty — the shared catalogue Bots) — has no person to act as. It is offered and suspended as
 * `platform` all the same: suspending is a `provider.stop` keyed by the computer plus queue
 * bookkeeping, and the idleness read is already platform, so the platform frame reads and writes no
 * person's rows on the way. Refusing would only leave the computer running forever, since nothing
 * else stops an orphan. A platform-stamped item is acted on only while its computer is still
 * nobody's (or its Bot gone): once a person owns it, only that person's frame may suspend it, and the
 * platform item is ended unacted.
 */
function isPlatformCull(owner: string | null | undefined): boolean {
  return owner == null || !isPersonTenant(owner);
}

/**
 * Offer every idle computer for suspension.
 *
 * Offering rather than suspending: the decision and the act are separated so that whichever replica
 * runs this does not have to be the one that carries it out, and so a suspension that fails halfway
 * is retried by whoever picks the item up next rather than lost with the process that noticed.
 */
export async function offerIdleComputers(
  options: CullerOptions,
): Promise<{ offered: string[]; offeredAsPlatform: string[] }> {
  const now = options.now?.() ?? new Date();
  const running = runningComputers(await options.provider.list());
  const used = await lastUsedByComputer(
    options.database,
    running.map((computer) => computer.computer),
  );
  const tenants = await computerTenants(
    options.database,
    running.map((computer) => computer.key),
  );

  const offered: string[] = [];
  const offeredAsPlatform: string[] = [];
  for (const computer of running) {
    const since =
      used.get(computer.computer) ??
      (computer.startedAt ? new Date(computer.startedAt) : undefined);
    // No row and no start time means nothing is known about it, and suspending on no evidence is
    // how somebody's session disappears mid-task. Left alone.
    if (!since) continue;
    if (now.getTime() - since.getTime() < options.idleAfterMs) continue;
    const tenant = tenants.get(computer.computer);
    // Offered in the owner's own tenant, or as the platform under the platform rule: the stamp on
    // the item is what the claiming replica acts as.
    const frame = isPersonTenant(tenant) ? tenant : "platform";
    await runAsTenant(frame, () =>
      options.queue.offer({
        kind: CULL_KIND,
        key: computer.computer,
        payload: {
          computer: computer.computer,
          idleSince: since.toISOString(),
        },
      }),
    );
    offered.push(computer.computer);
    if (frame === "platform") offeredAsPlatform.push(computer.computer);
  }
  // Counted once per sweep rather than warned once per computer: how many computers nobody owns.
  if (offeredAsPlatform.length > 0)
    console.info(
      JSON.stringify({
        type: "computer-cull-offered-as-platform",
        count: offeredAsPlatform.length,
        computers: offeredAsPlatform,
      }),
    );
  return { offered, offeredAsPlatform };
}

/**
 * Carry out whatever suspensions this replica can claim.
 *
 * Re-checked at the moment of acting, because the decision was made by another replica at another
 * time and a person may have started working in between. Suspending a computer somebody is using is
 * worse than leaving an idle one running for another five minutes.
 */
export async function suspendClaimedComputers(
  options: CullerOptions,
): Promise<CullReport> {
  const leaseMs = options.leaseMs ?? 60_000;
  const claimed = await options.queue.claim({
    kind: CULL_KIND,
    owner: options.owner,
    leaseMs,
    limit: 20,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });

  const report: CullReport = {
    considered: claimed.length,
    suspended: [],
    skipped: [],
  };

  for (const item of claimed) {
    /*
     * Whose computer. An item offered before computers were per person carries only its Bot, which
     * then had a computer of its own: `bot:<id>`.
     */
    const computer =
      typeof item.payload.computer === "string"
        ? item.payload.computer
        : typeof item.payload.botId === "string"
          ? `bot:${item.payload.botId}`
          : item.key;
    const key = parseComputerKey(computer);
    /*
     * Renewed before each one, because the batch is twenty and the lease is one.
     *
     * Twenty suspensions is twenty calls to an API server, and nothing renewed while they ran: on a
     * slow cluster the lease expired part-way down the list and another replica claimed the tail
     * this one was still working through. A lease nobody renews is a timer, and a timer is what this
     * queue exists not to be.
     *
     * False means it is already somebody else's. Stopping is then the correct answer, not an error:
     * the item is being handled, just not here.
     */
    if (
      !(await options.queue.renew({
        kind: CULL_KIND,
        key: item.key,
        owner: options.owner,
        leaseMs,
      }))
    ) {
      report.skipped.push({
        computer,
        reason: "the lease went to another replica",
      });
      continue;
    }
    try {
      if (!key) throw new Error(`${computer} does not name a computer`);
      /*
       * As the tenant stamped on the claimed item, which must still be the computer's owner (G01).
       * An item stamped as nobody's is acted on as `platform` only under the platform rule — its
       * computer is still nobody's, or its Bot gone. Any other mismatch (a person's item whose Bot is
       * gone or now someone else's, a platform item for a person's computer) is ended without
       * touching any computer: retrying cannot make it trustworthy.
       */
      const owner = (await computerTenants(options.database, [key])).get(
        computer,
      );
      const act = async () => {
        const now = options.now?.() ?? new Date();
        const used = await lastUsedByComputer(options.database, [computer]);
        const since = used.get(computer);
        if (since && now.getTime() - since.getTime() < options.idleAfterMs) {
          // Somebody came back. Drop the item rather than releasing it, because the next sweep will
          // offer it again if it goes quiet, and a released one would just be reclaimed and re-checked.
          await options.queue.finish({
            kind: CULL_KIND,
            key: item.key,
            owner: options.owner,
          });
          return "used again before it was suspended" as const;
        }

        await options.provider.stop({ key });
        await options.queue.finish({
          kind: CULL_KIND,
          key: item.key,
          owner: options.owner,
        });
        return null;
      };
      const outcome =
        !isPersonTenant(item.tenantId) && isPlatformCull(owner)
          ? { ran: true as const, value: await runAsTenant("platform", act) }
          : await runAsClaimedTenant(item, owner, act);
      if (!outcome.ran) {
        await options.queue.finish({
          kind: CULL_KIND,
          key: item.key,
          owner: options.owner,
        });
        console.warn(
          JSON.stringify({
            type: "computer-cull-tenant-unresolved",
            computer,
            reason: outcome.reason,
          }),
        );
        report.skipped.push({
          computer,
          reason: `tenant unresolved: ${outcome.reason}`,
        });
        continue;
      }
      if (outcome.value) {
        report.skipped.push({ computer, reason: outcome.value });
        continue;
      }
      report.suspended.push(computer);
    } catch (error) {
      /*
       * Released rather than dropped, and pushed out rather than retried immediately: a cluster that
       * refused this once will probably refuse it again in the next second, and a computer left
       * running costs money rather than losing anything.
       */
      const reason =
        error instanceof Error ? error.message : "could not be suspended";
      await options.queue.release({
        kind: CULL_KIND,
        key: item.key,
        owner: options.owner,
        delayMs: 5 * 60_000,
        reason,
      });
      /*
       * Said out loud when it gives up, because otherwise it stops silently.
       *
       * At the cap the item is no longer claimed, so this loop simply never sees that computer again and
       * every sweep looks clean while one computer stays awake indefinitely. The row carries the
       * count and the reason for anybody who queries it; this is for the person reading the logs.
       */
      if (item.attempts >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        console.warn(
          JSON.stringify({
            type: "computer-cull-gave-up",
            computer,
            attempts: item.attempts,
            reason,
          }),
        );
      }
      report.skipped.push({ computer, reason });
    }
  }

  return report;
}

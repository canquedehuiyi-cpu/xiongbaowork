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
import { ownerTenantOfBot, ownerTenantsOfBots } from "../agents/bot-owner";
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
  suspended: string[];
  skipped: { botId: string; reason: string }[];
};

/**
 * Which Bots have a computer running, and when each was last asked to do anything.
 *
 * The audit trail is the source: every acting call writes a row before the computer is touched, so
 * "last used" is already recorded, server-side, and survives a restart. A computer that has never
 * acted has no row and reads as idle since it started, which is the answer wanted.
 */
async function lastActedAt(
  database: Database,
  botIds: string[],
): Promise<Map<string, Date>> {
  if (botIds.length === 0) return new Map();
  /*
   * The Bot is in the payload rather than in a column, so the grouping key is an expression. Written
   * through the query builder rather than as one raw string, because a list parameter has to be
   * bound as a list: handed to `= any($1)` as a JavaScript array it arrives as one opaque value and
   * the query fails rather than matching nothing, which at least says so.
   */
  const bot = sql<string>`${auditEvents.payload}->>'bot'`;
  /*
   * As `platform`, because this is the culler's question and not a person's: "when did each of these
   * Bots last do something", asked about Bots from every tenant at once. From the cron job's own
   * context the answer is no rows at all, and the caller then has nothing to measure idleness with —
   * every running computer looks either brand new or unknowable, and the deployment never scales to
   * zero. That is the failure this file warns about two comments earlier, arriving from the other
   * direction: not a wake-up, but a bill that quietly stops ever falling.
   */
  const rows = await runAsTenant("platform", () =>
    database
      .select({ bot, last: sql<string>`max(${auditEvents.createdAt})` })
      .from(auditEvents)
      .where(
        and(like(auditEvents.eventType, "computer.%"), inArray(bot, botIds)),
      )
      .groupBy(bot),
  );

  return new Map(
    rows
      .filter((row) => row.bot)
      .map((row) => [row.bot, new Date(row.last)] as const),
  );
}

/**
 * Whose each Bot is: its owner (G01, G01-E) — the tenant stamped on its own `agents` row, or for a
 * team Bot (stamped `team`, which is nobody) the person its profile names. See `agents/bot-owner.ts`.
 *
 * A computer is a Bot's, and the suspension is that Bot's owner's business, so the work item is
 * offered and later carried out in that tenant — never in the culler's, which is nobody's. Read as
 * `platform` because the question spans every tenant. A Bot with no row, or one that is nobody's
 * (`system`, `platform`, empty, or a team Bot whose profile names no person), has no person to act
 * as; its computer is still suspended, under the platform rule below, because a computer left
 * running costs money and stopping one touches no person's data.
 */
async function botTenants(
  database: Database,
  botIds: string[],
): Promise<Map<string, string | null>> {
  return ownerTenantsOfBots(database, botIds);
}

async function botTenant(
  database: Database,
  botId: string,
): Promise<string | null> {
  return ownerTenantOfBot(database, botId);
}

/**
 * THE PLATFORM RULE (G01). A computer whose Bot has no `agents` row (deleted while its computer ran)
 * or whose row is stamped as nobody's (`system`, `platform`, empty — the shared catalogue Bots) has
 * no person to act as. It is offered and suspended as `platform` all the same: suspending is a
 * `provider.stop` keyed by Bot id plus queue bookkeeping, and the idleness read is already platform,
 * so the platform frame reads and writes no person's rows on the way. Refusing would only leave the
 * computer running forever, since nothing else stops an orphan. A platform-stamped item is acted on
 * only while its Bot is still nobody's (or gone): once a person owns the Bot, only that person's
 * frame may suspend it, and the platform item is ended unacted.
 */
function isPlatformCull(botTenant: string | null | undefined): boolean {
  return botTenant == null || !isPersonTenant(botTenant);
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
  const computers = await options.provider.list();
  const running = computers.filter((computer) => computer.status === "running");
  const used = await lastActedAt(
    options.database,
    running.map((computer) => computer.botId),
  );
  const tenants = await botTenants(
    options.database,
    running.map((computer) => computer.botId),
  );

  const offered: string[] = [];
  const offeredAsPlatform: string[] = [];
  for (const computer of running) {
    const since =
      used.get(computer.botId) ??
      (computer.startedAt ? new Date(computer.startedAt) : undefined);
    // No row and no start time means nothing is known about it, and suspending on no evidence is
    // how somebody's session disappears mid-task. Left alone.
    if (!since) continue;
    if (now.getTime() - since.getTime() < options.idleAfterMs) continue;
    const tenant = tenants.get(computer.botId);
    // Offered in the Bot's own tenant, or as the platform under the platform rule: the stamp on the
    // item is what the claiming replica acts as.
    const frame = isPersonTenant(tenant) ? tenant : "platform";
    await runAsTenant(frame, () =>
      options.queue.offer({
        kind: CULL_KIND,
        key: computer.botId,
        payload: { botId: computer.botId, idleSince: since.toISOString() },
      }),
    );
    offered.push(computer.botId);
    if (frame === "platform") offeredAsPlatform.push(computer.botId);
  }
  // Counted once per sweep rather than warned once per Bot: how many computers nobody owns.
  if (offeredAsPlatform.length > 0)
    console.info(
      JSON.stringify({
        type: "computer-cull-offered-as-platform",
        count: offeredAsPlatform.length,
        botIds: offeredAsPlatform,
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
    const botId = String(item.payload.botId ?? item.key);
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
        botId,
        reason: "the lease went to another replica",
      });
      continue;
    }
    try {
      /*
       * As the tenant stamped on the claimed item, which must still be the Bot's own (G01). An item
       * stamped as nobody's is acted on as `platform` only under the platform rule — its Bot is
       * still nobody's, or gone. Any other mismatch (a person's item whose Bot is gone or now someone
       * else's, a platform item for a person's Bot) is ended without touching any computer:
       * retrying cannot make it trustworthy.
       */
      const owner = await botTenant(options.database, botId);
      const act = async () => {
        const now = options.now?.() ?? new Date();
        const used = await lastActedAt(options.database, [botId]);
        const since = used.get(botId);
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

        await options.provider.stop(botId);
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
            botId,
            reason: outcome.reason,
          }),
        );
        report.skipped.push({
          botId,
          reason: `tenant unresolved: ${outcome.reason}`,
        });
        continue;
      }
      if (outcome.value) {
        report.skipped.push({ botId, reason: outcome.value });
        continue;
      }
      report.suspended.push(botId);
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
       * At the cap the item is no longer claimed, so this loop simply never sees that Bot again and
       * every sweep looks clean while one computer stays awake indefinitely. The row carries the
       * count and the reason for anybody who queries it; this is for the person reading the logs.
       */
      if (item.attempts >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        console.warn(
          JSON.stringify({
            type: "computer-cull-gave-up",
            botId,
            attempts: item.attempts,
            reason,
          }),
        );
      }
      report.skipped.push({ botId, reason });
    }
  }

  return report;
}

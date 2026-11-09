/**
 * Proactive check-ins: a Bot looking through its owner's connected apps in the background, quietly,
 * and reaching out only when something needs them.
 *
 * NOT A NEW ORCHESTRATOR. Due settings are offered to the existing work queue and each check-in is
 * an ordinary headless AG-UI turn through the same turn runner routines use, so governance, audit and
 * Automatic Learning apply unchanged. The restriction is the initiator (see `restriction.ts`), which
 * the turn runner's `buildAgentFor` narrows on; this module adds three tools of its own and nothing
 * that can write outside OpenBot.
 *
 * A CHECK-IN IS USUALLY SILENT. It reads only what is new (`window.ts`) in a thread of its own, and
 * most end with nothing raised: one ledger row, no message, no second turn. Before any of that, the
 * gates that would make it pointless are read without the model: the person turned check-ins off,
 * paused the Bot, an admin turned them off, the Bot used its day's runs, the conversation is gone,
 * or the Bot can read nothing the person connected with their own account (`scope.ts`). Each writes
 * a `skipped` row saying which.
 *
 * WHAT IT RAISES IS AN ITEM, NOT A MESSAGE. An item needs a source the check-in actually read, and
 * is refused if it repeats something open, something the person already has a task for, or something
 * they hid in the last thirty days, from any of their Bots: the same request is raised once for the
 * person, whichever Bot finds it first. Open items stay until the person starts or hides one, or a
 * later check-in clears it as no longer needed. They reach the person through the ping (`ping.ts`):
 * at most one an hour per person, every Bot's waiting items folded into it, and in the app at once.
 *
 * STARTED WORK IS A TASK, in a conversation of its own (`tasks/*`). This engine marks the item
 * started and hands it over; it runs no task turns of its own.
 */

import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { EmptyTurnError, type TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import { recordHeadlessUsage } from "../admin/controls";
import type { AuditInitiator } from "../audit";
import type { MemoryStore } from "../memory/store";
import { REFUSAL_MARKER } from "../plugins/tools";
import { QuotaExceeded, type QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import {
  assertPersonTenant,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import type { WorkQueue } from "../work/queue";
import type {
  AttentionDelivery,
  AttentionPing,
  ProactiveAdmin,
  ProactiveRunTrigger,
  ProactiveSkipReason,
  RunNowResponse,
  TaskService,
} from "./contracts";
import {
  proactiveInitiator,
  proactiveRunIdOf,
  refusalsFor,
} from "./restriction";
import type { CheckInApp } from "./scope";
import {
  PROACTIVE_RUN_KIND,
  type PriorItems,
  type ProactiveRead,
  type ProactiveStore,
  STOPPED_BEFORE_FINISHING,
  type StampedProactiveSetting,
  unreachedError,
} from "./store";
import {
  clearInputSchema,
  MAX_MEMORIES_PER_RUN,
  MAX_SUGGESTIONS_PER_RUN,
  ProactiveNotFoundError,
  ProactiveRefusedError,
  type ProactiveSetting,
  proactiveMemoryInputSchema,
  SKIPPED_BECAUSE,
  sameThing,
  suggestionInputSchema,
} from "./types";
import {
  type CheckInContext,
  checkInWindow,
  researchInstruction,
} from "./window";

export { PROACTIVE_RUN_KIND };

/**
 * How long a check-in may hold its queue item and its `running` row. A turn is cut off at three
 * minutes, so anything still running at ten belongs to a replica that stopped.
 */
const RUN_LEASE_MS = 10 * 60_000;
/** A person pressing "Run now" twice in a minute gets one run. */
const RUN_NOW_GAP_MS = 10 * 60_000;
/** Said on a queue row that was ended because nobody trusted could be found to run it for. */
export const PROACTIVE_TENANT_UNRESOLVED = "tenant_unresolved";

/**
 * WHOSE RESEARCH THIS IS comes from the setting's own row (G01): the tenant the database stamped on
 * it when its person created it, which the owner on the same row may only agree with. A setting
 * stamped as nobody's (`system`, `platform`), or one that names somebody other than the tenant it
 * is filed under, has no person to read apps for, and running it would file the turn, the
 * suggestions and the memories where the wrong people can read them.
 */
function settingTenant(setting: {
  tenantId?: unknown;
  ownerUserId: string;
}): string {
  return assertPersonTenant(setting.tenantId, setting.ownerUserId);
}
/**
 * How long a ping may sit written but not offered before the ping pass offers it again: long enough
 * that the replica which wrote it is plainly not about to.
 */
const UNOFFERED_AFTER_MS = 60_000;
/** How many people one ping pass pings at most, so a backlog drains over a few sweeps. */
const PINGS_PER_PASS = 20;
/** How many of its own open items, tasks and hidden items a check-in is told of, newest first. */
const OWN_LISTED = 50;
/** Check-ins one Bot may run for one person in a day, until an admin says otherwise: hourly. */
export const DEFAULT_DAILY_RUNS = 24;

export type ProactiveScope = {
  ownerUserId: string;
  channelId: string;
  agentId: string;
  threadId: string;
};

export type ProactiveEngineDeps = {
  store: ProactiveStore;
  /**
   * Where a check-in's `form_memory` writes. Absent in an edition without memory
   * (`editionHasMemory`), and then a check-in is offered no `form_memory` and told nothing about it.
   */
  memory?: Pick<MemoryStore, "formMemory">;
  queue: WorkQueue;
  owner: string;
  runTurn: TurnRunner;
  /**
   * The task board (story C2). A check-in files a card, as `routine` with trigger source `proactive`,
   * ONLY WHEN IT RAISED SOMETHING: a quiet hourly check-in is no task of the person's, so it leaves no
   * card and is not counted against the month (product decision, M3). The card is opened and closed
   * once the run is over, and the turn runner files none of its own either way. Absent, the turn
   * runner's own card is the run's only mark, as before.
   */
  board?: Pick<TaskProjector, "opened" | "finished">;
  /**
   * The month's task ceiling. Asked before a check-in goes to the model, so a person at the ceiling is
   * not researched for at all (the card a raised check-in files counts against it). Absent, no ceiling.
   */
  quota?: Pick<QuotaService, "assertCapacity">;
  /** The person's conversation with this Bot, or null when they can no longer reach either. */
  resolveScope(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<ProactiveScope | null>;
  /** Delivery of a ping to the person's push devices, Slack and Teams (`delivery/*`). */
  attention: AttentionDelivery;
  /** The admin's switch and daily cap (`admin/*`). Without it, on for everyone and 24 a day. */
  admin?: ProactiveAdmin;
  /** Opens a task for an item the person started (`tasks/*`). Without it, Start is refused. */
  tasks?: Pick<TaskService, "startFromItem">;
  /**
   * The apps this person connected with their own account that this Bot can read, with the reads
   * in each (see `scope.ts`). Empty means a check-in could find nothing, so none is run; otherwise
   * the instruction names them. Without it, every check-in goes to the model and names none.
   */
  readableApps?(ownerUserId: string, agentId: string): Promise<CheckInApp[]>;
  catalogue: {
    listServers(): Promise<
      { id: string; title: string; tools: { ref: string }[] }[]
    >;
  };
  /** Names of the Bot's granted tools that are not reads, answered with a refusal if called. */
  deniedToolNames?(ownerUserId: string, agentId: string): Promise<string[]>;
  mintThreadId(): string;
  now?: () => Date;
};

/**
 * Why a new item repeats one the person already has, or null. Compared by normalized title and by
 * source link (`sameThing`), against every one of their Bots: the same request is one thing to them
 * whichever Bot found it, so it is raised once, and what they hid stays hidden from all of them.
 *
 * Another Bot's item is never quoted back. This Bot may not be able to read what that one read, and
 * a title is written from somebody's mail.
 */
export function repeatOf(
  prior: PriorItems,
  input: { agentId: string; title: string; sourceLink?: string | null },
): string | null {
  const same = (item: { title: string; sourceLink: string | null }) =>
    sameThing(input, item);
  const open = prior.open.find(same);
  if (open)
    return open.agentId === input.agentId
      ? `"${open.title}" is already raised and still open. Do not raise it again.`
      : "Another of their Bots already raised this, and it is still open. Do not raise it again.";
  const task = prior.tasks.find(same);
  if (task)
    return task.agentId === input.agentId
      ? `They already have a task for "${task.title}". Do not raise it again.`
      : "They already have a task for this from another of their Bots. Do not raise it again.";
  const hidden = prior.hidden.find(same);
  if (hidden)
    return hidden.agentId === input.agentId
      ? `They hid "${hidden.title}". Do not raise it, or anything like it, again.`
      : "They hid this when another of their Bots raised it. Do not raise it, or anything like it, again.";
  return null;
}

/**
 * What the check-in is told of the past, from what the repeat check reads: this Bot's own items and
 * tasks only. Another Bot's are kept from it for the reason {@link repeatOf} never quotes them.
 */
function contextOf(prior: PriorItems, agentId: string): CheckInContext {
  const own = <T extends { agentId: string }>(items: T[]) =>
    items.filter((item) => item.agentId === agentId);
  return {
    open: own(prior.open)
      .slice(0, OWN_LISTED)
      .map(({ id, title }) => ({ id, title })),
    tasks: own(prior.tasks)
      .slice(0, OWN_LISTED)
      .map((task) => task.title),
    hidden: own(prior.hidden)
      .slice(0, OWN_LISTED)
      .map(({ title, sourceApp }) => ({ title, sourceApp })),
    started: prior.started.map((item) => item.title),
  };
}

/**
 * How a check-in ended, from how its turn ended, what it raised, and what the audit trail says it
 * read: the outcome its ledger row records, and the error with it.
 *
 * - A turn that broke off failed, whatever it read.
 * - An app it could not reach, with nothing raised, is a failure too, never quiet: the person would
 *   read "nothing needed you" about an app nobody could open. Its error names the apps, which is the
 *   reason they read (`unreachedError`).
 * - A turn that read and said nothing ended as the instruction allows: most check-ins should record
 *   nothing, and a model that found nothing often adds no closing line either. That is quiet, or
 *   raised when it raised something. One that said nothing and read nothing is still a failure.
 * - Raised with an app it could not reach is raised, and keeps that error, so the next check-in's
 *   window opens from before it (`windowStart`) and reads what that app had meanwhile.
 */
function outcomeOf(input: {
  thrown: unknown;
  raised: number;
  reads: number;
  unreached: readonly string[];
}): { outcome: "quiet" | "raised" | "failed"; error: string | null } {
  const silent = input.thrown instanceof EmptyTurnError;
  if (input.thrown && !silent)
    return {
      outcome: "failed",
      error:
        input.thrown instanceof Error
          ? input.thrown.message
          : "The check-in failed.",
    };
  const missed =
    input.unreached.length > 0 ? unreachedError(input.unreached) : null;
  if (missed && input.raised === 0) return { outcome: "failed", error: missed };
  if (silent && input.reads === 0)
    return { outcome: "failed", error: (input.thrown as Error).message };
  return input.raised > 0
    ? { outcome: "raised", error: missed }
    : { outcome: "quiet", error: null };
}

const logged = (type: string) => (error: unknown) =>
  console.error(
    JSON.stringify({
      type,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );

export function createProactiveEngine(deps: ProactiveEngineDeps) {
  const now = deps.now ?? (() => new Date());
  const allowed = (ownerUserId: string) =>
    deps.admin
      ? deps.admin.proactiveAllowed(ownerUserId)
      : Promise.resolve(true);
  const dailyRuns = (agentId: string) =>
    deps.admin
      ? deps.admin.proactiveDailyRuns(agentId)
      : Promise.resolve(DEFAULT_DAILY_RUNS);
  /**
   * Which setting a run belongs to, for the run's own tools, and whether its turn got as far as
   * asking for them. Local: the turn runs in this process.
   */
  const running = new Map<
    string,
    { setting: ProactiveSetting; reached: boolean; catalogue: Catalogue }
  >();

  /**
   * The deployment's apps, listed once for one check-in however many it names: each item raised,
   * each memory and each app it couldn't reach. A listing that failed is not kept, so the next name
   * asks again.
   */
  type Catalogue = () => ReturnType<
    ProactiveEngineDeps["catalogue"]["listServers"]
  >;
  function catalogueOnce(): Catalogue {
    let listed: ReturnType<Catalogue> | undefined;
    return () => {
      listed ??= deps.catalogue.listServers().catch((error: unknown) => {
        listed = undefined;
        throw error;
      });
      return listed;
    };
  }
  async function serverFor(catalogue: Catalogue, ref: string) {
    return (await catalogue()).find((server) =>
      server.tools.some((tool) => tool.ref === ref),
    );
  }
  /** The app a tool belongs to, by the name the person knows it by. */
  async function appOf(catalogue: Catalogue, ref: string) {
    return (await serverFor(catalogue, ref))?.title ?? ref.split("/")[0] ?? ref;
  }
  /**
   * The apps this run tried to read and could not: every call to them failed, and none answered.
   * One that answered once was reached, so a lookup that came back "not found" after a listing, or
   * a call that worked when the model tried it again, is not an app that was down.
   */
  async function unreached(
    reads: ProactiveRead[],
    runId: string,
    catalogue: Catalogue,
  ) {
    const serverOf = (ref: string) => ref.split("/")[0] ?? ref;
    const answered = new Set(reads.map((read) => serverOf(read.ref)));
    const failed = new Map<string, string>();
    for (const ref of await deps.store.failedReadsFor(runId))
      if (!answered.has(serverOf(ref)) && !failed.has(serverOf(ref)))
        failed.set(serverOf(ref), ref);
    return [
      ...new Set(
        await Promise.all(
          [...failed.values()].map((ref) => appOf(catalogue, ref)),
        ),
      ),
    ].sort();
  }
  /** A read this run actually made, matched by ref or by the model-facing tool name. */
  function readMatching(reads: ProactiveRead[], named: string) {
    const spelled = named.startsWith("mcp__")
      ? named.slice(5).replace("__", "/")
      : named;
    return reads.find((read) => read.ref === named || read.ref === spelled);
  }

  function toolsForRun(
    setting: ProactiveSetting,
    runId: string,
    catalogue: Catalogue,
  ): HeadlessTool[] {
    const tool = <T>(
      name: string,
      description: string,
      schema: z.ZodType<T>,
      run: (input: T) => Promise<unknown>,
    ): HeadlessTool => ({
      definition: {
        name,
        description,
        parameters: z.toJSONSchema(schema) as Record<string, unknown>,
      },
      async execute(args) {
        const parsed = schema.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} ${parsed.error.issues[0]?.message ?? "Invalid arguments."}`;
        try {
          return JSON.stringify(await run(parsed.data));
        } catch (error) {
          if (error instanceof ProactiveRefusedError)
            return `${REFUSAL_MARKER} ${error.message}`;
          if (error instanceof Error && error.name.startsWith("Memory"))
            return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    let memories = 0;
    const memory = deps.memory;
    return [
      tool(
        "suggest_next_step",
        "Raise one next step for the person, from something new you read in this check-in. They can start it as a task or hide it.",
        suggestionInputSchema,
        async (input) => {
          if (
            (await deps.store.countSuggestions(runId)) >=
            MAX_SUGGESTIONS_PER_RUN
          )
            throw new ProactiveRefusedError(
              `This check-in already raised ${MAX_SUGGESTIONS_PER_RUN} next steps.`,
            );
          // Every item says where it came from, and only from what this check-in itself read.
          const read = readMatching(
            await deps.store.readsFor(runId),
            input.sourceTool,
          );
          if (!read)
            throw new ProactiveRefusedError(
              "Name a tool you successfully read with in this check-in as sourceTool. A next step needs a source.",
            );
          const sourceApp = await appOf(catalogue, read.ref);
          // Refused if any of the person's Bots already has it, checked and written under one lock.
          const row = await deps.store.raise(
            {
              ownerUserId: setting.ownerUserId,
              agentId: setting.agentId,
              settingId: setting.id,
              runId,
              title: input.title,
              detail: input.detail,
              sourceApp,
              sourceRef: read.ref,
              sourceLink: input.sourceLink ?? null,
            },
            (prior) => repeatOf(prior, { ...input, agentId: setting.agentId }),
          );
          return { suggested: row.id };
        },
      ),
      tool(
        "clear_next_step",
        "Clear one of your earlier next steps, listed as still open, that no longer needs the person: it was answered, done or cancelled.",
        clearInputSchema,
        async (input) => {
          const cleared = await deps.store.clearSuggestion(
            setting.id,
            input.suggestionId,
          );
          if (!cleared)
            throw new ProactiveRefusedError(
              "That is not one of your next steps still open. Clear only an id listed as still open.",
            );
          return { cleared: cleared.id };
        },
      ),
      ...(memory
        ? [
            tool(
              "form_memory",
              "Remember a durable fact about the person or their work that you read in this run. Provenance is recorded from the read itself and the person reviews it.",
              proactiveMemoryInputSchema,
              async (input) => {
                if (memories >= MAX_MEMORIES_PER_RUN)
                  throw new ProactiveRefusedError(
                    `This run already formed ${MAX_MEMORIES_PER_RUN} memories.`,
                  );
                const read = readMatching(
                  await deps.store.readsFor(runId),
                  input.sourceTool,
                );
                if (!read)
                  throw new ProactiveRefusedError(
                    "A memory needs a source: name a tool you successfully read with in this run.",
                  );
                const server = await serverFor(catalogue, read.ref);
                memories += 1;
                return memory.formMemory(setting.ownerUserId, {
                  agentId: setting.agentId,
                  content: input.content,
                  sourceApp:
                    server?.title ?? read.ref.split("/")[0] ?? read.ref,
                  sourceRef: read.ref,
                  ...(input.sourceLink ? { sourceLink: input.sourceLink } : {}),
                  observedAt: read.at,
                });
              },
            ),
          ]
        : []),
    ];
  }

  /**
   * Work done for one person found by a cross-tenant read, in that person's own tenant (tenant ==
   * user id). Somebody who is no person (`system`, `platform`, `team`, empty) is refused, as a
   * rejection the caller logs, before anything runs.
   */
  async function asPerson<T>(ownerUserId: string, work: () => Promise<T>) {
    return runAsTenant(assertPersonTenant(ownerUserId), work);
  }

  /** Offer a written ping to delivery, then record that it was. Delivery dedupes a second offer. */
  async function offer(ping: AttentionPing) {
    await deps.attention.notifyAttention(ping);
    await deps.store.pings.markOffered(ping.pingId);
  }

  /** Ping this person if their hour allows and something waits. */
  async function ping(ownerUserId: string) {
    const written = await deps.store.pings.take(ownerUserId);
    if (written) await offer(written);
    return written;
  }
  /**
   * The same, unless an admin turned check-ins off for them: that stops the pings too, not only the
   * runs.
   */
  async function tryPing(ownerUserId: string) {
    if (!(await allowed(ownerUserId))) return null;
    return ping(ownerUserId);
  }

  /**
   * The ping pass, every sweep: offer pings a stopped replica wrote but never offered, then ping
   * each person whose items waited for their hour to pass, up to {@link PINGS_PER_PASS} of them.
   * One person's failure is logged and the rest still go.
   *
   * IT PAGES PAST WHOEVER IT MAY NOT PING. A person an admin turned check-ins off for keeps the
   * items raised before the switch, oldest first in the queue, and is refused every pass. Taking
   * one page and stopping meant a page of them was all any pass ever saw, and nobody behind them was
   * pinged again. The admin's switch is resolved from roles and groups in code, so it is asked per
   * person here rather than written into the query; each person is asked once a pass.
   *
   * WHO IS WAITING IS EVERYBODY'S QUESTION, so it is asked as the platform, which sees every
   * person's items. Each person's own step (the admin's answer, their slot, their items, delivery to
   * their devices and chats) then runs in that person's tenant, as their check-ins do.
   */
  async function pingPass() {
    const unoffered = await runAsTenant("platform", () =>
      deps.store.pings.unoffered(UNOFFERED_AFTER_MS),
    );
    for (const ping of unoffered)
      await asPerson(ping.ownerUserId, () => offer(ping)).catch(
        logged("proactive-ping-error"),
      );
    const tried: string[] = [];
    let pinged = 0;
    while (pinged < PINGS_PER_PASS) {
      const people = await runAsTenant("platform", () =>
        deps.store.pings.waiting(PINGS_PER_PASS, tried),
      );
      if (people.length === 0) return;
      for (const ownerUserId of people) {
        tried.push(ownerUserId);
        const may = await asPerson(ownerUserId, () =>
          allowed(ownerUserId),
        ).catch((error: unknown) => {
          logged("proactive-ping-error")(error);
          return false;
        });
        if (!may) continue;
        pinged += 1;
        await asPerson(ownerUserId, () => ping(ownerUserId)).catch(
          logged("proactive-ping-error"),
        );
        if (pinged >= PINGS_PER_PASS) return;
      }
    }
  }

  /**
   * Why a check-in for this setting would find nothing, or the apps it can read when it may go to
   * the model. The gates, cheapest first, none of them a model call. Asked by the run itself, and by
   * Run now before it queues one, so the person hears at once why it can't.
   */
  async function gateOf(
    setting: ProactiveSetting,
  ): Promise<{ skip: ProactiveSkipReason } | { apps: CheckInApp[] }> {
    if (await deps.store.personOff(setting.ownerUserId))
      return { skip: "off_person" };
    if (await deps.store.paused(setting.ownerUserId, setting.agentId))
      return { skip: "paused" };
    if (!(await allowed(setting.ownerUserId))) return { skip: "off_admin" };
    if (deps.quota)
      try {
        await deps.quota.assertCapacity(setting.ownerUserId, "tasksPerMonth");
      } catch (error) {
        if (error instanceof QuotaExceeded) return { skip: "quota" };
        throw error;
      }
    if (
      (await deps.store.runsToday(setting.ownerUserId, setting.agentId)) >=
      (await dailyRuns(setting.agentId))
    )
      return { skip: "capped" };
    if (
      !(await deps.resolveScope(
        setting.ownerUserId,
        setting.channelId,
        setting.agentId,
      ))
    )
      return { skip: "unreachable" };
    if (!deps.readableApps) return { apps: [] };
    // Nothing the person connected that this Bot can read: there is nothing for a check-in to find.
    const apps = await deps.readableApps(setting.ownerUserId, setting.agentId);
    return apps.length === 0 ? { skip: "no_sources" } : { apps };
  }

  /** A check-in a gate stopped, in the ledger with its reason, where the Bot's check-ins read it. */
  async function skip(
    setting: ProactiveSetting,
    runId: string,
    trigger: ProactiveRunTrigger,
    reason: ProactiveSkipReason,
  ) {
    if (reason === "unreachable")
      await deps.store.recordRun(
        setting.id,
        "error",
        "This Bot or its conversation is no longer available to you, so it didn't check in.",
      );
    await deps.store.skipRun({ id: runId, setting, trigger, reason });
  }

  async function run(
    tenant: string,
    settingId: string,
    runId: string,
    trigger: ProactiveRunTrigger,
    signal: AbortSignal,
  ) {
    // Read in the item's own tenant, so another person's setting is not even visible from here.
    const setting = await deps.store.byId(settingId);
    if (!setting?.enabled) return;
    // A `system` row is still visible from a person's frame; it is not theirs to run.
    if (settingTenant(setting) !== tenant)
      throw new TenantContextError("setting/tenant mismatch");
    const gate = await gateOf(setting);
    if ("skip" in gate) return skip(setting, runId, trigger, gate.skip);
    // Read before this run is in the ledger, so the window opens at a check-in before it.
    const lastRead = await deps.store.windowStart(setting.id);
    const threadId = deps.mintThreadId();
    const admitted = await deps.store.beginRun({
      id: runId,
      setting,
      trigger,
      threadId,
      dailyLimit: await dailyRuns(setting.agentId),
    });
    if (admitted !== true)
      return skip(
        setting,
        runId,
        trigger,
        admitted === "capped" ? "capped" : "busy",
      );
    /*
     * FROM HERE THE RUN IS IN THE LEDGER AS RUNNING, and every step until it is closed can fail on
     * its own: a database call that drops its connection is enough. Left running, the row would make
     * the next scheduled check-in skip as busy, Run now say "This Bot is checking in now", and the
     * Bot's last status read running, until the lease sweep closed it ten minutes on. So whatever
     * stops it, it is closed as failed here, and its status recorded, before the error goes on.
     */
    let closed = false;
    let recorded = false;
    let status: "succeeded" | "error" = "error";
    let lastError: string | null = STOPPED_BEFORE_FINISHING;
    /*
     * THE RUN'S OWN CARD (story C2) is filed only once the run is over, and only when it raised
     * something (see `board`): the turn runner is told the card is the caller's, so it files none.
     * The ledger is the record of every run either way.
     *
     * The tenant is the one the claimed queue row proved and the setting's own row agreed with above,
     * never the payload's or a default.
     */
    let raisedCount = 0;
    try {
      await deps.store.recordRun(setting.id, "running");
      const prior = await deps.store.priorItems(
        setting.ownerUserId,
        setting.agentId,
      );
      const turn = { setting, reached: false, catalogue: catalogueOnce() };
      running.set(runId, turn);
      const instruction = researchInstruction(
        setting,
        checkInWindow(lastRead, now()),
        contextOf(prior, setting.agentId),
        trigger,
        gate.apps.map((app) => app.title),
        deps.memory !== undefined,
      );
      let thrown: unknown = null;
      try {
        await deps.runTurn({
          ownerUserId: setting.ownerUserId,
          // The setting's own tenant: the sweep that claimed this run has none (see `TurnRunner`).
          tenantId: tenant,
          routineId: `proactive:${setting.id}`,
          agentId: setting.agentId,
          // A fresh thread: an hourly check-in must not carry every earlier one, and their mail.
          threadId,
          instruction,
          /*
           * Its own message, as it is: a check-in is not a routine, and the runner puts a routine's
           * frame ("one of your routines is firing right now, on its schedule") around any instruction
           * that arrives without one. The instruction opens by saying what started it.
           */
          userMessage: {
            id: `check-in:${runId}`,
            role: "user",
            content: instruction,
          },
          initiator: proactiveInitiator(runId),
          runId,
          signal,
          // Any card is this run's own, filed below; the runner files none.
          cardOwnedByCaller: deps.board !== undefined,
        });
      } catch (error) {
        thrown = error;
      } finally {
        running.delete(runId);
      }
      // Metered once its turn was admitted and went to the model, whether or not it then finished.
      if (turn.reached)
        await recordHeadlessUsage({
          ownerUserId: setting.ownerUserId,
          agentId: setting.agentId,
          threadId,
          runId,
        });
      const [raised, reads] = await Promise.all([
        deps.store.countSuggestions(runId),
        deps.store.readsFor(runId),
      ]);
      const { outcome, error } = outcomeOf({
        thrown,
        raised,
        reads: reads.length,
        unreached: await unreached(reads, runId, turn.catalogue),
      });
      await deps.store.finishRun(runId, {
        outcome,
        itemsRaised: raised,
        reads: reads.length,
        error,
      });
      closed = true;
      raisedCount = raised;
      status = outcome === "failed" ? "error" : "succeeded";
      lastError = error;
      await deps.store.recordRun(setting.id, status, lastError);
      recorded = true;
      // Items recorded before a failure are still the person's, so they wait for a ping too.
      if (raised > 0)
        await tryPing(setting.ownerUserId).catch(
          logged("proactive-ping-error"),
        );
    } finally {
      if (!closed)
        await deps.store
          .finishRun(runId, {
            outcome: "failed",
            itemsRaised: await deps.store
              .countSuggestions(runId)
              .catch(() => 0),
            reads: 0,
            error: STOPPED_BEFORE_FINISHING,
          })
          .catch(logged("proactive-run-close-error"));
      if (!recorded)
        await deps.store
          .recordRun(setting.id, status, lastError)
          .catch(logged("proactive-run-close-error"));
      /*
       * Only a check-in that raised something is a card: it goes to the review lane (查收结果), or
       * reads as failed when the run broke off after raising. A quiet one leaves none and costs no task.
       */
      if (raisedCount > 0 && (await openCard(tenant, setting, runId)))
        await closeCard(tenant, runId, status === "error");
    }
  }

  async function openCard(
    tenant: string,
    setting: ProactiveSetting,
    runId: string,
  ): Promise<boolean> {
    if (!deps.board) return false;
    try {
      await deps.board.opened({
        tenantId: tenant,
        title: setting.focus ? `主动调研：${setting.focus}` : "主动调研",
        executorAgentId: setting.agentId,
        source: "routine",
        triggerSource: "proactive",
        // The conversation the gate just resolved the setting's scope in.
        channelRef: setting.channelId,
        runRef: runId,
      });
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "proactive-board-open-failed",
          settingId: setting.id,
          runId,
          reason: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return false;
    }
  }

  async function closeCard(tenant: string, runId: string, failed: boolean) {
    try {
      await deps.board?.finished({ tenantId: tenant, runRef: runId, failed });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "proactive-board-close-failed",
          runId,
          reason: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }

  async function drain(
    kind: string,
    work: (
      tenant: string,
      payload: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    const [item] = await deps.queue.claim({
      kind,
      owner: deps.owner,
      leaseMs: RUN_LEASE_MS,
      limit: 1,
      maxAttempts: 1,
    });
    if (!item) return false;
    /*
     * The claim asks as `platform`; the work is done as the tenant stamped on the claimed row, which
     * is where the person's `runNow` or this sweep's own per-setting offer put it. A row
     * stamped as nobody's is ended without running anybody (one attempt, so the release below is
     * final) and keeps the reason on the queue row, which only the platform reads.
     */
    let tenant: string;
    try {
      tenant = assertPersonTenant(item.tenantId);
    } catch (error) {
      if (!(error instanceof TenantContextError)) throw error;
      await dropUntrusted(kind, item.key);
      return true;
    }
    const controller = new AbortController();
    const renew = setInterval(() => {
      void deps.queue
        .renew({
          kind,
          key: item.key,
          owner: deps.owner,
          leaseMs: RUN_LEASE_MS,
        })
        .then(
          (kept) => {
            if (!kept) controller.abort();
          },
          () => controller.abort(),
        );
    }, RUN_LEASE_MS / 3);
    renew.unref?.();
    try {
      // The whole chain — turn, items, memories, ping, ledger row, card — in that tenant.
      await runAsTenant(tenant, () =>
        work(tenant, item.payload, controller.signal),
      );
      await deps.queue.finish({ kind, key: item.key, owner: deps.owner });
    } catch (error) {
      if (error instanceof TenantContextError) {
        await dropUntrusted(kind, item.key);
        return true;
      }
      // One attempt only: a background run is not worth repeating a partial read for.
      await deps.queue.release({
        kind,
        key: item.key,
        owner: deps.owner,
        delayMs: 60_000,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearInterval(renew);
    }
    return true;
  }

  /** Ended, not retried, and said on the row and in the log, naming nobody the row did not prove. */
  async function dropUntrusted(kind: string, key: string) {
    await deps.queue.release({
      kind,
      key,
      owner: deps.owner,
      delayMs: 60_000,
      reason: PROACTIVE_TENANT_UNRESOLVED,
    });
    console.warn(
      JSON.stringify({ type: "proactive-untrusted-tenant", kind, key }),
    );
  }

  const payloadSchema = z.object({
    settingId: z.string().min(1),
    runId: z.string().min(1),
    trigger: z.enum(["schedule", "run_now"]).default("schedule"),
  });

  return {
    researchInstruction,
    /** Whether an admin left check-ins on for this person. */
    allowed,
    /** The headless tools for one proactive turn; empty for any other initiator. */
    async toolsForTurn(input: {
      ownerUserId: string;
      agentId: string;
      initiator: AuditInitiator;
    }): Promise<HeadlessTool[]> {
      const runId = proactiveRunIdOf(input.initiator);
      const turn = runId ? running.get(runId) : undefined;
      const setting = turn?.setting;
      if (
        !runId ||
        !turn ||
        !setting ||
        setting.ownerUserId !== input.ownerUserId ||
        setting.agentId !== input.agentId
      )
        return [];
      // The runner asks for a turn's tools once it admitted the turn, just before the model.
      turn.reached = true;
      const own = toolsForRun(setting, runId, turn.catalogue);
      const ownNames = new Set(own.map((tool) => tool.definition.name));
      const denied = (
        (await deps.deniedToolNames?.(input.ownerUserId, input.agentId)) ?? []
      ).filter((name) => !ownNames.has(name));
      return [...own, ...refusalsFor([...new Set(denied)])];
    },
    async create(ownerUserId: string, input: unknown) {
      const parsed = input as { agentId?: unknown; channelId?: unknown };
      if (
        typeof parsed?.agentId !== "string" ||
        typeof parsed?.channelId !== "string" ||
        !(await deps.resolveScope(
          ownerUserId,
          parsed.channelId,
          parsed.agentId,
        ))
      )
        throw new ProactiveRefusedError(
          "Choose one of your Bots and a conversation it's in.",
        );
      return deps.store.create(ownerUserId, input, deps.mintThreadId());
    },
    /**
     * Check in now, because the person asked. Either it is queued, or they are told plainly why it
     * isn't, never a silent nothing:
     * - refused while one is running, or within ten minutes of one that reached the model;
     * - skipped at once, with its reason in the ledger and in the answer, when a gate would stop it
     *   anyway (nothing it can read, paused, turned off). A skip costs nothing, so it never starts
     *   the ten minutes and the next Run now is tried again.
     *
     * Pressed twice before it runs, it is queued once: the queue key names the setting's newest
     * check-in, so both presses offer the same key, and the next press after any check-in, skipped
     * or not, offers a new one.
     */
    async runNow(ownerUserId: string, id: string): Promise<RunNowResponse> {
      const setting = await deps.store.get(ownerUserId, id);
      if (!setting.enabled)
        throw new ProactiveRefusedError(
          "Turn on check-ins for this Bot first.",
        );
      const latest = await deps.store.latestRun(setting.id);
      if (latest?.outcome === "running")
        throw new ProactiveRefusedError("This Bot is checking in now.");
      const last = await deps.store.lastCheckIn(setting.id);
      const wait = last
        ? RUN_NOW_GAP_MS - (now().getTime() - last.startedAt.getTime())
        : 0;
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60_000);
        throw new ProactiveRefusedError(
          `This Bot checked in less than ten minutes ago. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      }
      const runId = crypto.randomUUID();
      const gate = await gateOf(setting);
      if ("skip" in gate) {
        await skip(setting, runId, "run_now", gate.skip);
        return {
          queued: false,
          skipped: gate.skip,
          why: SKIPPED_BECAUSE[gate.skip],
        };
      }
      const payload = { settingId: setting.id, runId, trigger: "run_now" };
      const offered = await deps.queue.offer({
        kind: PROACTIVE_RUN_KIND,
        key: `${setting.id}:now:${latest?.id ?? "first"}`,
        payload,
      });
      /*
       * Already offered and already done: that Run now came up after check-ins were turned off and
       * ran nothing, so no newer check-in moved the key on. This one is new work under its own key.
       */
      if (offered === "already" && !(await deps.store.runQueued(setting.id)))
        await deps.queue.offer({
          kind: PROACTIVE_RUN_KIND,
          key: `${setting.id}:now:${runId}`,
          payload,
        });
      return { queued: true };
    },
    /** Hide: remembered for thirty days and told to every later check-in. */
    async dismiss(ownerUserId: string, suggestionId: string) {
      return deps.store.resolveSuggestion(
        ownerUserId,
        suggestionId,
        "dismissed",
      );
    },
    /**
     * The person chose to act on it: the item is started, once, and becomes a task in a conversation
     * of its own, where the ask runs as their own turn and every send or change meets approval.
     */
    async start(ownerUserId: string, suggestionId: string) {
      if (!deps.tasks)
        throw new ProactiveRefusedError("Starting a task isn't available yet.");
      const suggestion = await deps.store.suggestion(ownerUserId, suggestionId);
      const setting = await deps.store.get(ownerUserId, suggestion.settingId);
      /*
       * The person's own item from their own setting, by the tenant each row is stamped with, which
       * the person may only agree with: a `system` row their frame can still see is not theirs to
       * start, so it is not found.
       */
      try {
        const tenant = settingTenant(setting);
        if (assertPersonTenant(suggestion.tenantId, ownerUserId) !== tenant)
          throw new TenantContextError("suggestion/tenant mismatch");
      } catch (error) {
        if (error instanceof TenantContextError)
          throw new ProactiveNotFoundError();
        throw error;
      }
      if (
        !(await deps.resolveScope(
          ownerUserId,
          setting.channelId,
          suggestion.agentId,
        ))
      )
        throw new ProactiveRefusedError(
          "This Bot or its conversation is no longer available to you.",
        );
      const started = await deps.store.resolveSuggestion(
        ownerUserId,
        suggestionId,
        "started",
      );
      try {
        const task = await deps.tasks.startFromItem({
          ownerUserId,
          item: {
            id: started.id,
            agentId: started.agentId,
            title: started.title,
            detail: started.detail,
            sourceApp: started.sourceApp,
            sourceLink: started.sourceLink,
          },
        });
        return { suggestion: started, task };
      } catch (error) {
        // No task to show for it: back on the list, so pressing Start again tries again.
        await deps.store.reopenSuggestion(ownerUserId, suggestionId);
        throw error;
      }
    },
    /**
     * One scheduling pass: close check-ins a stopped replica left running, ping whoever is due one,
     * offer what is due, then run at most one check-in.
     */
    async sweep() {
      // A run its replica left running is nobody's to close but the platform's, which sees every one.
      await runAsTenant("platform", () =>
        deps.store.closeStaleRuns(RUN_LEASE_MS),
      );
      await pingPass();
      // "What is due" belongs to no tenant, so it is asked as the platform, which sees every one.
      const due: StampedProactiveSetting[] = await runAsTenant("platform", () =>
        deps.store.claimDue(),
      );
      for (const setting of due) {
        let tenant: string;
        try {
          tenant = settingTenant(setting);
        } catch (error) {
          if (!(error instanceof TenantContextError)) throw error;
          // Its interval already moved forward in the claim, so this is said once per interval.
          await runAsTenant("platform", () =>
            deps.store.recordRun(
              setting.id,
              "error",
              "This check-in has no trusted owner, so it didn't run.",
            ),
          ).catch(() => undefined);
          console.warn(
            JSON.stringify({
              type: "proactive-untrusted-tenant",
              kind: PROACTIVE_RUN_KIND,
              settingId: setting.id,
            }),
          );
          continue;
        }
        const runId = crypto.randomUUID();
        // Offered from the setting's tenant, so the queue row is stamped as that person's work.
        await runAsTenant(tenant, () =>
          deps.queue.offer({
            kind: PROACTIVE_RUN_KIND,
            key: `${setting.id}:${runId}`,
            payload: { settingId: setting.id, runId, trigger: "schedule" },
          }),
        );
      }
      await drain(PROACTIVE_RUN_KIND, async (tenant, payload, signal) => {
        const { settingId, runId, trigger } = payloadSchema.parse(payload);
        await run(tenant, settingId, runId, trigger, signal);
      });
    },
  };
}
export type ProactiveEngine = ReturnType<typeof createProactiveEngine>;

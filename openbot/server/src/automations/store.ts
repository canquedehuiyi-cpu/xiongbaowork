/**
 * D06 automations: keeping them (stories AUT1, AUT3, AUT4).
 *
 * WHOSE ROWS. Tenant and owner are one thing (D12: tenant = user), and both come from the caller's
 * tenant frame, never from an argument. A call outside a person's frame — the unscoped `system`
 * default or the cross-tenant `platform` writer — is refused before any statement runs, and 0117's
 * policies refuse it again in the database. Rows written under an existing automation (its
 * triggers) copy the tenant from that automation's locked row, not from the session.
 *
 * TRANSACTIONS. Everything that reads before it writes locks the automation row first
 * (`SELECT ... FOR UPDATE`): the five-trigger cap, the run count against `max_runs`, enabling against
 * the limits. Two concurrent requests then queue on the row instead of both reading "four" and both
 * adding a fifth. Inside a transaction callback only the transaction handle is used: the client reads
 * the tenant when the transaction opens, and the async frame is gone by the time the callback runs.
 *
 * THE SCHEDULER'S DATA (D06-3). `./sweep.ts` decides when and `./waker-executor.ts` runs; this store
 * keeps what they act on and the rules they must share. `dueTriggers` is the one cross-tenant read
 * (as `platform`, like every queue sweep); everything after it — advancing a trigger, beginning a
 * firing, recording its outcome, tripping the breaker — runs in the automation's own tenant frame,
 * which the sweep takes from the claimed row. `exhausted()` stops an automation at its run cap or end
 * date however it was started, and `beginFiring` is where a firing is counted exactly once: the
 * firing's identity (trigger + due minute) is a unique key, so a redelivered work item does nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  agents,
  automationFirings,
  automations,
  automationTriggers,
} from "../db/schema";
import { SYSTEM_TENANT, TEAM_TENANT } from "../db/schema/tenant";
import { nextOccurrence, ScheduleRefusedError } from "../routines/schedule";
import { currentTenant, runAsTenant } from "../tenant/context";
import {
  type Automation,
  type AutomationCreateInput,
  type AutomationExhaustion,
  AutomationNotFoundError,
  AutomationRefusedError,
  type AutomationTarget,
  type AutomationTargetRegistry,
  type AutomationTrigger,
  type AutomationTriggerConfig,
  type AutomationTriggerKind,
  type AutomationUpdateInput,
  automationCreateSchema,
  automationTargetSchema,
  automationTriggerConfigSchema,
  automationUpdateSchema,
  createAutomationTargetRegistry,
  MAX_ACTIVE_TRIGGERS,
  parseOrRefuse,
} from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type AutomationRow = typeof automations.$inferSelect;
type TriggerRow = typeof automationTriggers.$inferSelect;

/** The outcome of asking to start one run (AUT4). */
export type AutomationRunClaim =
  | { status: "claimed"; runCount: number; remaining: number | null }
  | { status: "stopped"; reason: AutomationExhaustion | "disabled" };

/** A trigger whose moment has come, as the platform-wide sweep reads it. */
export type DueAutomationTrigger = {
  id: string;
  automationId: string;
  /** The owner, from the trigger row itself: the frame everything after the read runs in. */
  tenantId: string;
  /** `unreadable`: a config this server cannot parse. Never offered; advancing it switches it off. */
  kind: Exclude<AutomationTriggerKind, "webhook"> | "unreadable";
  nextRunAt: Date;
};

/** One firing that has begun: counted against the limits and recorded, not yet carried out. */
export type AutomationFiring = {
  id: string;
  /** The automation as it stands after this firing was counted. */
  automation: Automation;
  triggerId: string;
  triggerKind: AutomationTriggerKind;
  externalId: string;
};

/** The outcome of asking to begin one firing. */
export type AutomationFiringBegin =
  | { status: "started"; firing: AutomationFiring }
  /** This trigger already fired for this moment: a redelivery, which does nothing. */
  | { status: "duplicate" }
  | {
      status: "stopped";
      reason: AutomationExhaustion | "disabled" | "deleted";
    };

/** How a firing ended. `circuit_breaker` is written only by `tripBreaker`. */
export type AutomationFiringOutcome =
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting";

/**
 * One automation as the management list shows it (D06 C1/C3): `breakerTripped` says that the
 * circuit breaker is what switched it off: it is off now, and its newest finished firing is the one
 * that tripped the breaker. It is only ever reported for a switched-off automation, so switching it
 * back on clears it, and so does any firing that finishes after that.
 */
export type AutomationListing = Automation & { breakerTripped: boolean };

export type AutomationStore = {
  create(input: AutomationCreateInput): Promise<Automation>;
  /** The caller's automations, newest first. Deleted ones are gone from here. */
  list(): Promise<AutomationListing[]>;
  get(id: string): Promise<Automation | null>;
  update(id: string, input: AutomationUpdateInput): Promise<Automation>;
  setEnabled(id: string, enabled: boolean, now?: Date): Promise<Automation>;
  /** Marks it deleted and switches off its triggers. False when there was nothing to delete. */
  softDelete(id: string): Promise<boolean>;
  listTriggers(automationId: string): Promise<AutomationTrigger[]>;
  /** `secret` is the plaintext of a new webhook trigger's secret: shown once, stored only hashed. */
  addTrigger(
    automationId: string,
    config: unknown,
    now?: Date,
  ): Promise<{ trigger: AutomationTrigger; secret: string | null }>;
  setTriggerEnabled(
    automationId: string,
    triggerId: string,
    enabled: boolean,
    now?: Date,
  ): Promise<AutomationTrigger>;
  /** A trigger that already fired keeps its history: it is switched off rather than deleted. */
  removeTrigger(
    automationId: string,
    triggerId: string,
  ): Promise<"removed" | "disabled">;
  rotateTriggerSecret(automationId: string, triggerId: string): Promise<string>;
  /**
   * Count one run against the limits, or say why there is none. Called inside the automation's
   * tenant frame, which a background caller takes from the automation row it claimed.
   */
  claimRun(automationId: string, now?: Date): Promise<AutomationRunClaim>;
  /**
   * Every tenant's switched-on triggers that are due by the database's clock, oldest first. The one
   * cross-tenant read: it runs as `platform` itself, whatever frame it is called from.
   */
  dueTriggers(limit: number): Promise<DueAutomationTrigger[]>;
  /**
   * Move a trigger past the moment `from`, once (compare-and-set on `next_run_at`). False when it
   * had already moved. A one-off switches itself off; `missed` says the moment was too stale to fire,
   * which is recorded on a one-off and makes a schedule land on its next occurrence after `now`.
   */
  advanceTrigger(
    triggerId: string,
    from: Date,
    options?: { now?: Date; missed?: boolean },
  ): Promise<boolean>;
  /**
   * AUT4 + idempotence: record one firing of `triggerId` identified by `externalId` and count it
   * against the limits, in one transaction under the automation's row lock.
   */
  beginFiring(input: {
    automationId: string;
    triggerId: string;
    externalId: string;
    fingerprint: string;
    now?: Date;
  }): Promise<AutomationFiringBegin>;
  /** Close a running firing. Finish-once: false when it was not running any more. */
  finishFiring(
    firingId: string,
    status: AutomationFiringOutcome,
    error?: string | null,
  ): Promise<boolean>;
  /**
   * Failed firings in a row, newest first, up to `window`. Skipped and in-flight firings neither
   * count nor break the streak; a success, a wait, or the firing that tripped the breaker ends it.
   */
  consecutiveFailures(automationId: string, window?: number): Promise<number>;
  /** C3: switch the automation off and mark `firingId` as the one that tripped the breaker. */
  tripBreaker(automationId: string, firingId: string): Promise<void>;
};

const MAX_RUNS_REACHED = "已达到最大运行次数，请先调高上限再启用。";
const END_DATE_PASSED = "已过截止日期，请先修改截止日期再启用。";
const END_DATE_IN_PAST = "截止日期必须晚于现在。";
const SCHEDULE_REFUSED =
  "定时规则需要五段 cron 表达式和有效时区，且间隔不少于 15 分钟。";
const TRIGGER_NOT_FOUND = "找不到这个触发条件。";
const TOO_MANY_TRIGGERS = `每个自动任务最多同时启用 ${MAX_ACTIVE_TRIGGERS} 个触发条件。`;
const WAKER_NOT_VISIBLE = "找不到这位 Waker，或你无权使用它。";
const WAKERFLOW_NOT_AVAILABLE =
  "WakerFlow 自动执行尚未开放，暂时只能选择 Waker。";
const ONCE_MISSED = "一次性触发错过了预定时间，没有执行。";
const TRIGGER_UNREADABLE = "这个触发条件无法读取，已停用。";
/** A firing's error is a sentence for a person, not a stack: kept to a length a row can show. */
const MAX_FIRING_ERROR = 2000;

/**
 * AUT4: whether an automation has run out, and why.
 *
 * The run cap is asked first because it is final: a later end date does not give runs back. The end
 * date is exclusive — at the stated instant the automation has already stopped.
 */
export function exhausted(
  automation: {
    maxRuns: number | null;
    runCount: number;
    endDate: Date | null;
  },
  now: Date,
): AutomationExhaustion | null {
  if (
    automation.maxRuns !== null &&
    automation.runCount >= automation.maxRuns
  ) {
    return "max_runs";
  }
  if (
    automation.endDate !== null &&
    now.getTime() >= automation.endDate.getTime()
  ) {
    return "end_date";
  }
  return null;
}

/** What `automation_triggers.secret_hash` holds: the SHA-256 of the secret, hex. Never the secret. */
export function hashTriggerSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

const uuid = z.uuid();
const isUuid = (value: string) => uuid.safeParse(value).success;

/**
 * The person this call acts for. Outside a person's frame there is nobody to own an automation, and
 * a default tenant would quietly file one under the platform, so the call fails instead.
 */
function callerTenant(): string {
  const tenant = currentTenant();
  if (tenant === SYSTEM_TENANT || tenant === "platform" || tenant === "") {
    throw new Error(
      "The automation store must be called inside the owning tenant's frame.",
    );
  }
  return tenant;
}

function toAutomation(row: AutomationRow): Automation {
  const target = automationTargetSchema.safeParse(row.target);
  if (!target.success) {
    throw new Error(
      `Automation ${row.id} has a target this server cannot read.`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    target: target.data,
    enabled: row.enabled,
    maxRuns: row.maxRuns,
    endDate: row.endDate,
    runCount: row.runCount,
    createdAt: row.createdAt,
  };
}

function toTrigger(row: TriggerRow): AutomationTrigger {
  const config = automationTriggerConfigSchema.safeParse(row.config);
  if (!config.success) {
    throw new Error(
      `Automation trigger ${row.id} has a config this server cannot read.`,
    );
  }
  return {
    id: row.id,
    automationId: row.automationId,
    config: config.data,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    hasSecret: row.secretHash !== null,
    lastError: row.lastError,
  };
}

/**
 * When a trigger should next fire, from `now`, inside the automation's end date (AUT1 + AUT4).
 *
 * A schedule whose next occurrence is past the end date has nothing left to do and gets no next run;
 * a one-off instant past it is refused, because it can never fire and saying so is the honest answer.
 */
function firstRun(
  config: AutomationTriggerConfig,
  now: Date,
  endDate: Date | null,
): Date | null {
  let next: Date | null;
  if (config.kind === "schedule") {
    try {
      next = nextOccurrence(config.cron, config.timezone, now);
    } catch (error) {
      if (error instanceof ScheduleRefusedError) {
        throw new AutomationRefusedError(SCHEDULE_REFUSED);
      }
      throw error;
    }
  } else if (config.kind === "once") {
    next = new Date(config.at);
    if (next.getTime() <= now.getTime()) {
      throw new AutomationRefusedError("一次性触发时间必须晚于现在。");
    }
  } else {
    return null;
  }
  if (endDate !== null && next.getTime() >= endDate.getTime()) {
    if (config.kind === "once") {
      throw new AutomationRefusedError("一次性触发时间必须早于截止日期。");
    }
    return null;
  }
  return next;
}

function newSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashTriggerSecret(secret) };
}

export function createAutomationStore(
  database: Database,
  options: { executors?: AutomationTargetRegistry } = {},
): AutomationStore {
  const executors = options.executors ?? createAutomationTargetRegistry();

  /**
   * AUT3: a target is accepted only if something can carry it out for this tenant. Runs outside any
   * transaction, in the caller's frame, so the agent read is scoped by row security to what this
   * tenant can see: its own Wakers, the platform's built-in ones, and team Wakers (G01-E). A `team`
   * row comes back only when `team_read` — `openbot_team_bot_visible` — already let this person see
   * it, so the stamp alone is enough here; a team Bot this person may not use never reaches the check.
   */
  async function verifyTarget(target: AutomationTarget, tenant: string) {
    if (target.kind === "waker") {
      const [agent] = await database
        .select({ id: agents.id, tenantId: agents.tenantId })
        .from(agents)
        .where(eq(agents.id, target.agentId))
        .limit(1);
      if (
        !agent ||
        (agent.tenantId !== tenant &&
          agent.tenantId !== SYSTEM_TENANT &&
          agent.tenantId !== TEAM_TENANT)
      ) {
        throw new AutomationRefusedError(WAKER_NOT_VISIBLE);
      }
      return;
    }
    const executor = executors.get("wakerflow");
    if (!executor) throw new AutomationRefusedError(WAKERFLOW_NOT_AVAILABLE);
    await executor.verify(target, { tenantId: tenant });
  }

  /** The automation row, locked, or not found. Deleted rows are not there to lock. */
  async function lockAutomation(
    tx: Transaction,
    tenant: string,
    id: string,
  ): Promise<AutomationRow> {
    if (!isUuid(id)) throw new AutomationNotFoundError();
    const [row] = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.id, id),
          eq(automations.tenantId, tenant),
          isNull(automations.deletedAt),
        ),
      )
      .for("update");
    if (!row) throw new AutomationNotFoundError();
    return row;
  }

  async function lockTrigger(
    tx: Transaction,
    automation: AutomationRow,
    triggerId: string,
  ): Promise<TriggerRow> {
    if (!isUuid(triggerId))
      throw new AutomationNotFoundError(TRIGGER_NOT_FOUND);
    const [row] = await tx
      .select()
      .from(automationTriggers)
      .where(
        and(
          eq(automationTriggers.id, triggerId),
          eq(automationTriggers.automationId, automation.id),
          eq(automationTriggers.tenantId, automation.tenantId),
        ),
      )
      .for("update");
    if (!row) throw new AutomationNotFoundError(TRIGGER_NOT_FOUND);
    return row;
  }

  async function activeTriggers(
    tx: Transaction,
    automation: AutomationRow,
  ): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(automationTriggers)
      .where(
        and(
          eq(automationTriggers.tenantId, automation.tenantId),
          eq(automationTriggers.automationId, automation.id),
          eq(automationTriggers.enabled, true),
        ),
      );
    return Number(row?.count ?? 0);
  }

  return {
    async create(input) {
      const tenant = callerTenant();
      const parsed = parseOrRefuse(
        automationCreateSchema,
        input,
        "无法创建这个自动任务，请检查填写的内容。",
      );
      const endDate = parsed.endDate ?? null;
      if (endDate !== null && endDate.getTime() <= Date.now()) {
        throw new AutomationRefusedError(END_DATE_IN_PAST);
      }
      await verifyTarget(parsed.target, tenant);
      const [row] = await database
        .insert(automations)
        .values({
          tenantId: tenant,
          name: parsed.name,
          target: { ...parsed.target },
          maxRuns: parsed.maxRuns ?? null,
          endDate,
        })
        .returning();
      if (!row) throw new Error("The automation was not written.");
      return toAutomation(row);
    },

    async list() {
      const tenant = callerTenant();
      const rows = await database
        .select()
        .from(automations)
        .where(
          and(eq(automations.tenantId, tenant), isNull(automations.deletedAt)),
        )
        .orderBy(desc(automations.createdAt), asc(automations.id));
      // Only a switched-off automation can be one the breaker stopped, so only those are asked about.
      const off = rows.filter((row) => !row.enabled).map((row) => row.id);
      const tripped = new Set<string>();
      if (off.length > 0) {
        const latest = await database
          .selectDistinctOn([automationFirings.automationId], {
            automationId: automationFirings.automationId,
            status: automationFirings.status,
          })
          .from(automationFirings)
          .where(
            and(
              eq(automationFirings.tenantId, tenant),
              inArray(automationFirings.automationId, off),
              // Finished firings only, the same set the breaker's streak is counted over.
              inArray(automationFirings.status, [
                "failed",
                "succeeded",
                "waiting",
                "circuit_breaker",
              ]),
            ),
          )
          .orderBy(
            automationFirings.automationId,
            desc(automationFirings.createdAt),
            desc(automationFirings.id),
          );
        for (const firing of latest) {
          if (firing.status === "circuit_breaker") {
            tripped.add(firing.automationId);
          }
        }
      }
      return rows.map((row) => ({
        ...toAutomation(row),
        breakerTripped: tripped.has(row.id),
      }));
    },

    async get(id) {
      const tenant = callerTenant();
      if (!isUuid(id)) return null;
      const [row] = await database
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.id, id),
            eq(automations.tenantId, tenant),
            isNull(automations.deletedAt),
          ),
        )
        .limit(1);
      return row ? toAutomation(row) : null;
    },

    async update(id, input) {
      const tenant = callerTenant();
      const parsed = parseOrRefuse(
        automationUpdateSchema,
        input,
        "无法修改这个自动任务，请检查填写的内容。",
      );
      if (
        parsed.endDate !== undefined &&
        parsed.endDate !== null &&
        parsed.endDate.getTime() <= Date.now()
      ) {
        throw new AutomationRefusedError(END_DATE_IN_PAST);
      }
      if (parsed.target) await verifyTarget(parsed.target, tenant);
      const row = await database.transaction(async (tx) => {
        const current = await lockAutomation(tx, tenant, id);
        if (
          parsed.maxRuns !== undefined &&
          parsed.maxRuns !== null &&
          parsed.maxRuns < current.runCount
        ) {
          throw new AutomationRefusedError(
            `最大运行次数不能小于已运行的 ${current.runCount} 次。`,
          );
        }
        const changes: Partial<typeof automations.$inferInsert> = {};
        if (parsed.name !== undefined) changes.name = parsed.name;
        if (parsed.target !== undefined) changes.target = { ...parsed.target };
        if (parsed.maxRuns !== undefined) changes.maxRuns = parsed.maxRuns;
        if (parsed.endDate !== undefined) changes.endDate = parsed.endDate;
        if (Object.keys(changes).length === 0) return current;
        // 到期停止 (AUT4): a cap lowered to exactly the runs already made leaves nothing to run, so the
        // automation switches off now rather than showing as on until its next claim finds it spent.
        const limits = {
          maxRuns:
            parsed.maxRuns === undefined ? current.maxRuns : parsed.maxRuns,
          runCount: current.runCount,
          endDate:
            parsed.endDate === undefined ? current.endDate : parsed.endDate,
        };
        if (current.enabled && exhausted(limits, new Date()) !== null) {
          changes.enabled = false;
        }
        const [updated] = await tx
          .update(automations)
          .set(changes)
          .where(
            and(
              eq(automations.id, current.id),
              eq(automations.tenantId, current.tenantId),
            ),
          )
          .returning();
        if (!updated) throw new AutomationNotFoundError();
        return updated;
      });
      return toAutomation(row);
    },

    async setEnabled(id, enabled, now = new Date()) {
      const tenant = callerTenant();
      const row = await database.transaction(async (tx) => {
        const current = await lockAutomation(tx, tenant, id);
        if (enabled) {
          const reason = exhausted(current, now);
          if (reason === "max_runs") {
            throw new AutomationRefusedError(MAX_RUNS_REACHED);
          }
          if (reason === "end_date") {
            throw new AutomationRefusedError(END_DATE_PASSED);
          }
        }
        if (current.enabled === enabled) return current;
        const [updated] = await tx
          .update(automations)
          .set({ enabled })
          .where(
            and(
              eq(automations.id, current.id),
              eq(automations.tenantId, current.tenantId),
            ),
          )
          .returning();
        if (!updated) throw new AutomationNotFoundError();
        return updated;
      });
      return toAutomation(row);
    },

    async softDelete(id) {
      const tenant = callerTenant();
      if (!isUuid(id)) return false;
      return database.transaction(async (tx) => {
        let current: AutomationRow;
        try {
          current = await lockAutomation(tx, tenant, id);
        } catch (error) {
          if (error instanceof AutomationNotFoundError) return false;
          throw error;
        }
        await tx
          .update(automations)
          .set({ deletedAt: new Date(), enabled: false })
          .where(
            and(
              eq(automations.id, current.id),
              eq(automations.tenantId, current.tenantId),
            ),
          );
        await tx
          .update(automationTriggers)
          .set({ enabled: false, nextRunAt: null })
          .where(
            and(
              eq(automationTriggers.automationId, current.id),
              eq(automationTriggers.tenantId, current.tenantId),
            ),
          );
        return true;
      });
    },

    async listTriggers(automationId) {
      const tenant = callerTenant();
      if (!isUuid(automationId)) throw new AutomationNotFoundError();
      const [owner] = await database
        .select({ id: automations.id })
        .from(automations)
        .where(
          and(
            eq(automations.id, automationId),
            eq(automations.tenantId, tenant),
            isNull(automations.deletedAt),
          ),
        )
        .limit(1);
      if (!owner) throw new AutomationNotFoundError();
      const rows = await database
        .select()
        .from(automationTriggers)
        .where(
          and(
            eq(automationTriggers.automationId, owner.id),
            eq(automationTriggers.tenantId, tenant),
          ),
        )
        .orderBy(
          sql`${automationTriggers.nextRunAt} asc nulls last`,
          asc(automationTriggers.id),
        );
      return rows.map(toTrigger);
    },

    async addTrigger(automationId, input, now = new Date()) {
      const tenant = callerTenant();
      const config = parseOrRefuse(
        automationTriggerConfigSchema,
        input,
        "触发条件只能是定期、一次性或事件入口。",
      );
      const secret = config.kind === "webhook" ? newSecret() : null;
      const row = await database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, tenant, automationId);
        const nextRunAt = firstRun(config, now, automation.endDate);
        if ((await activeTriggers(tx, automation)) >= MAX_ACTIVE_TRIGGERS) {
          throw new AutomationRefusedError(TOO_MANY_TRIGGERS);
        }
        const [created] = await tx
          .insert(automationTriggers)
          .values({
            // Copied from the locked automation, never from the session or the request.
            tenantId: automation.tenantId,
            automationId: automation.id,
            config: { ...config },
            enabled: true,
            nextRunAt,
            secretHash: secret?.hash ?? null,
          })
          .returning();
        if (!created)
          throw new Error("The automation trigger was not written.");
        return created;
      });
      return { trigger: toTrigger(row), secret: secret?.secret ?? null };
    },

    async setTriggerEnabled(
      automationId,
      triggerId,
      enabled,
      now = new Date(),
    ) {
      const tenant = callerTenant();
      const row = await database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, tenant, automationId);
        const trigger = await lockTrigger(tx, automation, triggerId);
        if (trigger.enabled === enabled) return trigger;
        let nextRunAt: Date | null = null;
        if (enabled) {
          if ((await activeTriggers(tx, automation)) >= MAX_ACTIVE_TRIGGERS) {
            throw new AutomationRefusedError(TOO_MANY_TRIGGERS);
          }
          nextRunAt = firstRun(
            toTrigger(trigger).config,
            now,
            automation.endDate,
          );
        }
        const [updated] = await tx
          .update(automationTriggers)
          .set({ enabled, nextRunAt })
          .where(
            and(
              eq(automationTriggers.id, trigger.id),
              eq(automationTriggers.tenantId, automation.tenantId),
            ),
          )
          .returning();
        if (!updated) throw new AutomationNotFoundError(TRIGGER_NOT_FOUND);
        return updated;
      });
      return toTrigger(row);
    },

    async removeTrigger(automationId, triggerId) {
      const tenant = callerTenant();
      return database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, tenant, automationId);
        const trigger = await lockTrigger(tx, automation, triggerId);
        const [fired] = await tx
          .select({ id: automationFirings.id })
          .from(automationFirings)
          .where(
            and(
              eq(automationFirings.triggerId, trigger.id),
              eq(automationFirings.tenantId, automation.tenantId),
            ),
          )
          .limit(1);
        if (fired) {
          await tx
            .update(automationTriggers)
            .set({ enabled: false, nextRunAt: null })
            .where(
              and(
                eq(automationTriggers.id, trigger.id),
                eq(automationTriggers.tenantId, automation.tenantId),
              ),
            );
          return "disabled" as const;
        }
        await tx
          .delete(automationTriggers)
          .where(
            and(
              eq(automationTriggers.id, trigger.id),
              eq(automationTriggers.tenantId, automation.tenantId),
            ),
          );
        return "removed" as const;
      });
    },

    async rotateTriggerSecret(automationId, triggerId) {
      const tenant = callerTenant();
      const secret = newSecret();
      await database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, tenant, automationId);
        const trigger = await lockTrigger(tx, automation, triggerId);
        if (toTrigger(trigger).config.kind !== "webhook") {
          throw new AutomationRefusedError("只有事件入口触发条件才有密钥。");
        }
        await tx
          .update(automationTriggers)
          .set({ secretHash: secret.hash })
          .where(
            and(
              eq(automationTriggers.id, trigger.id),
              eq(automationTriggers.tenantId, automation.tenantId),
            ),
          );
      });
      return secret.secret;
    },

    async claimRun(automationId, now = new Date()) {
      const tenant = callerTenant();
      return database.transaction(async (tx): Promise<AutomationRunClaim> => {
        const automation = await lockAutomation(tx, tenant, automationId);
        if (!automation.enabled)
          return { status: "stopped", reason: "disabled" };
        const reason = exhausted(automation, now);
        if (reason !== null) {
          // 到期停止: the automation switches itself off the moment it is found spent.
          await tx
            .update(automations)
            .set({ enabled: false })
            .where(
              and(
                eq(automations.id, automation.id),
                eq(automations.tenantId, automation.tenantId),
              ),
            );
          return { status: "stopped", reason };
        }
        const runCount = automation.runCount + 1;
        const spent =
          automation.maxRuns !== null && runCount >= automation.maxRuns;
        await tx
          .update(automations)
          .set(spent ? { runCount, enabled: false } : { runCount })
          .where(
            and(
              eq(automations.id, automation.id),
              eq(automations.tenantId, automation.tenantId),
            ),
          );
        return {
          status: "claimed",
          runCount,
          remaining:
            automation.maxRuns === null ? null : automation.maxRuns - runCount,
        };
      });
    },

    async dueTriggers(limit) {
      // The operator's view, said here rather than trusted to the caller: which triggers are due is
      // a question about every tenant, and nothing read here is written back in this frame.
      const rows = await runAsTenant("platform", async () => {
        return await database
          .select({
            id: automationTriggers.id,
            automationId: automationTriggers.automationId,
            tenantId: automationTriggers.tenantId,
            config: automationTriggers.config,
            nextRunAt: automationTriggers.nextRunAt,
          })
          .from(automationTriggers)
          .innerJoin(
            automations,
            and(
              eq(automations.id, automationTriggers.automationId),
              eq(automations.tenantId, automationTriggers.tenantId),
            ),
          )
          .where(
            and(
              eq(automationTriggers.enabled, true),
              isNotNull(automationTriggers.nextRunAt),
              sql`${automationTriggers.nextRunAt} <= now()`,
              eq(automations.enabled, true),
              isNull(automations.deletedAt),
            ),
          )
          .orderBy(
            asc(automationTriggers.nextRunAt),
            asc(automationTriggers.id),
          )
          .limit(limit);
      });
      const due: DueAutomationTrigger[] = [];
      for (const row of rows) {
        const config = automationTriggerConfigSchema.safeParse(row.config);
        // An unreadable config is still handed on, so `advanceTrigger` switches it off with a reason
        // instead of it being re-read as due on every pass.
        const kind = config.success ? config.data.kind : "unreadable";
        if (kind === "webhook" || !row.nextRunAt) continue;
        due.push({
          id: row.id,
          automationId: row.automationId,
          tenantId: row.tenantId,
          kind,
          nextRunAt: row.nextRunAt,
        });
      }
      return due;
    },

    async advanceTrigger(triggerId, from, options = {}) {
      const tenant = callerTenant();
      if (!isUuid(triggerId)) return false;
      const now = options.now ?? new Date();
      return await database.transaction(async (tx) => {
        const [row] = await tx
          .select({
            trigger: automationTriggers,
            endDate: automations.endDate,
          })
          .from(automationTriggers)
          .innerJoin(
            automations,
            and(
              eq(automations.id, automationTriggers.automationId),
              eq(automations.tenantId, automationTriggers.tenantId),
            ),
          )
          .where(
            and(
              eq(automationTriggers.id, triggerId),
              eq(automationTriggers.tenantId, tenant),
            ),
          )
          .for("update", { of: automationTriggers });
        if (!row || row.trigger.nextRunAt?.getTime() !== from.getTime()) {
          return false;
        }
        const config = automationTriggerConfigSchema.safeParse(
          row.trigger.config,
        );
        let changes: Partial<typeof automationTriggers.$inferInsert>;
        if (!config.success) {
          changes = {
            enabled: false,
            nextRunAt: null,
            lastError: TRIGGER_UNREADABLE,
          };
        } else if (config.data.kind === "schedule") {
          try {
            // From the stamp, so a firing that was late by seconds keeps its cadence; from now when
            // the stamp was too stale to fire, so one pass makes the clock current.
            let next: Date | null = nextOccurrence(
              config.data.cron,
              config.data.timezone,
              options.missed ? now : from,
            );
            if (
              row.endDate !== null &&
              next.getTime() >= row.endDate.getTime()
            ) {
              next = null;
            }
            changes = { nextRunAt: next };
          } catch (error) {
            if (!(error instanceof ScheduleRefusedError)) throw error;
            changes = {
              enabled: false,
              nextRunAt: null,
              lastError: SCHEDULE_REFUSED,
            };
          }
        } else if (config.data.kind === "once") {
          // 一次性: it fired (or was missed) and has nothing left to do, so it frees its slot.
          changes = {
            enabled: false,
            nextRunAt: null,
            ...(options.missed ? { lastError: ONCE_MISSED } : {}),
          };
        } else {
          changes = { nextRunAt: null };
        }
        const moved = await tx
          .update(automationTriggers)
          .set(changes)
          .where(
            and(
              eq(automationTriggers.id, row.trigger.id),
              eq(automationTriggers.tenantId, row.trigger.tenantId),
              eq(automationTriggers.nextRunAt, from),
            ),
          )
          .returning({ id: automationTriggers.id });
        return moved.length > 0;
      });
    },

    async beginFiring(input) {
      const tenant = callerTenant();
      const now = input.now ?? new Date();
      return await database.transaction(
        async (tx): Promise<AutomationFiringBegin> => {
          let automation: AutomationRow;
          let trigger: TriggerRow;
          try {
            automation = await lockAutomation(tx, tenant, input.automationId);
            trigger = await lockTrigger(tx, automation, input.triggerId);
          } catch (error) {
            if (error instanceof AutomationNotFoundError) {
              return { status: "stopped", reason: "deleted" };
            }
            throw error;
          }
          if (!automation.enabled) {
            return { status: "stopped", reason: "disabled" };
          }
          const reason = exhausted(automation, now);
          if (reason !== null) {
            // 到期停止: found spent at the moment of firing, so it switches itself off.
            await tx
              .update(automations)
              .set({ enabled: false })
              .where(
                and(
                  eq(automations.id, automation.id),
                  eq(automations.tenantId, automation.tenantId),
                ),
              );
            return { status: "stopped", reason };
          }
          const triggerKind = toTrigger(trigger).config.kind;
          const [firing] = await tx
            .insert(automationFirings)
            .values({
              // Copied from the locked automation, never from the session or the work item.
              tenantId: automation.tenantId,
              automationId: automation.id,
              triggerId: trigger.id,
              externalId: input.externalId,
              fingerprint: input.fingerprint,
              target: automation.target,
              status: "running",
            })
            .onConflictDoNothing()
            .returning({ id: automationFirings.id });
          // The unique (tenant, trigger, external id) said this moment already fired: count nothing.
          if (!firing) return { status: "duplicate" };
          const runCount = automation.runCount + 1;
          const spent =
            automation.maxRuns !== null && runCount >= automation.maxRuns;
          const [updated] = await tx
            .update(automations)
            .set(spent ? { runCount, enabled: false } : { runCount })
            .where(
              and(
                eq(automations.id, automation.id),
                eq(automations.tenantId, automation.tenantId),
              ),
            )
            .returning();
          if (!updated) throw new AutomationNotFoundError();
          return {
            status: "started",
            firing: {
              id: firing.id,
              automation: toAutomation(updated),
              triggerId: trigger.id,
              triggerKind,
              externalId: input.externalId,
            },
          };
        },
      );
    },

    async finishFiring(firingId, status, error = null) {
      const tenant = callerTenant();
      if (!isUuid(firingId)) return false;
      const rows = await database
        .update(automationFirings)
        .set({
          status,
          error:
            error === null
              ? null
              : Array.from(error).slice(0, MAX_FIRING_ERROR).join(""),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(automationFirings.id, firingId),
            eq(automationFirings.tenantId, tenant),
            eq(automationFirings.status, "running"),
          ),
        )
        .returning({ id: automationFirings.id });
      return rows.length > 0;
    },

    async consecutiveFailures(automationId, window = 50) {
      const tenant = callerTenant();
      if (!isUuid(automationId)) return 0;
      const rows = await database
        .select({ status: automationFirings.status })
        .from(automationFirings)
        .where(
          and(
            eq(automationFirings.tenantId, tenant),
            eq(automationFirings.automationId, automationId),
            inArray(automationFirings.status, [
              "failed",
              "succeeded",
              "waiting",
              "circuit_breaker",
            ]),
          ),
        )
        .orderBy(desc(automationFirings.createdAt), desc(automationFirings.id))
        .limit(window);
      let failures = 0;
      for (const row of rows) {
        if (row.status !== "failed") break;
        failures += 1;
      }
      return failures;
    },

    async tripBreaker(automationId, firingId) {
      const tenant = callerTenant();
      await database.transaction(async (tx) => {
        const automation = await lockAutomation(tx, tenant, automationId);
        await tx
          .update(automations)
          .set({ enabled: false })
          .where(
            and(
              eq(automations.id, automation.id),
              eq(automations.tenantId, automation.tenantId),
            ),
          );
        // The tripping firing ends the streak, so a person who switches it back on starts from zero.
        await tx
          .update(automationFirings)
          .set({ status: "circuit_breaker", updatedAt: new Date() })
          .where(
            and(
              eq(automationFirings.id, firingId),
              eq(automationFirings.tenantId, automation.tenantId),
              eq(automationFirings.automationId, automation.id),
            ),
          );
      });
    },
  };
}

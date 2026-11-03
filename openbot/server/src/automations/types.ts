import { z } from "zod";

/**
 * D06 automations (stories AUT1, AUT3, AUT4): what a person may ask to have run, and when.
 *
 * Every model here is the contract the store writes into `automations.target` and
 * `automation_triggers.config` (both jsonb). Reads go back through the same schemas, so a row that no
 * longer parses is reported as unreadable rather than handed to an executor half-understood.
 */

/** 原版显示上限 5 (AUT1): an automation may have this many switched-on triggers at once. */
export const MAX_ACTIVE_TRIGGERS = 5;
export const MAX_AUTOMATION_NAME = 80;
/** A cap, not a setting: far beyond any schedule the 15-minute floor allows in a year. */
export const MAX_RUNS_LIMIT = 100_000;

/** A refusal a person can act on. The message is the Chinese sentence the product shows. */
export class AutomationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationRefusedError";
  }
}

/** The automation is not there for this caller: missing, deleted, or another tenant's. */
export class AutomationNotFoundError extends Error {
  constructor(message = "找不到这个自动任务。") {
    super(message);
    this.name = "AutomationNotFoundError";
  }
}

const TARGET_REFUSED = "执行对象只能是一位 Waker 或一个已创建的 WakerFlow。";

/**
 * AUT3: an automation runs either one Waker or one WakerFlow that already exists. Nothing else: an
 * executor is chosen by `kind`, so an unknown kind is refused here rather than at run time.
 */
export const automationTargetSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("waker"),
        agentId: z
          .string(TARGET_REFUSED)
          .trim()
          .min(1, "请选择要执行的 Waker。")
          .max(200, TARGET_REFUSED),
      })
      .strict(),
    z
      .object({
        kind: z.literal("wakerflow"),
        flowId: z.uuid("请选择一个已创建的 WakerFlow。"),
      })
      .strict(),
  ],
  TARGET_REFUSED,
);
export type AutomationTarget = z.infer<typeof automationTargetSchema>;
export type AutomationTargetKind = AutomationTarget["kind"];

const SCHEDULE_REFUSED =
  "定时规则需要五段 cron 表达式和有效时区，且间隔不少于 15 分钟。";
const ONCE_REFUSED = "一次性触发需要一个带时区的具体时间。";

/**
 * AUT1: the conditions that start an automation.
 *  - `schedule` 定期: a five-field cron in a named zone, under the routines' 15-minute floor.
 *  - `once` 一次性: one instant, which must still be ahead when it is saved.
 *  - `webhook` 事件入口: started from outside with a secret; only its hash is ever stored.
 */
export const automationTriggerConfigSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("schedule"),
        cron: z
          .string(SCHEDULE_REFUSED)
          .trim()
          .min(1, SCHEDULE_REFUSED)
          .max(120, SCHEDULE_REFUSED),
        timezone: z
          .string(SCHEDULE_REFUSED)
          .trim()
          .min(1, SCHEDULE_REFUSED)
          .max(64, SCHEDULE_REFUSED),
      })
      .strict(),
    z
      .object({
        kind: z.literal("once"),
        at: z.iso.datetime({ offset: true, error: ONCE_REFUSED }),
      })
      .strict(),
    z.object({ kind: z.literal("webhook") }).strict(),
  ],
  "触发条件只能是定期、一次性或事件入口。",
);
export type AutomationTriggerConfig = z.infer<
  typeof automationTriggerConfigSchema
>;
export type AutomationTriggerKind = AutomationTriggerConfig["kind"];

const END_DATE_REFUSED = "截止日期需要一个带时区的具体时间。";
const endDate = z.union(
  [
    z.date(END_DATE_REFUSED),
    z.iso
      .datetime({ offset: true, error: END_DATE_REFUSED })
      .transform((value) => new Date(value)),
  ],
  END_DATE_REFUSED,
);
const maxRuns = z
  .number("最大运行次数必须是正整数。")
  .int("最大运行次数必须是正整数。")
  .min(1, "最大运行次数至少为 1。")
  .max(MAX_RUNS_LIMIT, `最大运行次数不能超过 ${MAX_RUNS_LIMIT}。`);
const name = z
  .string("请给自动任务起个名字。")
  .trim()
  .min(1, "请给自动任务起个名字。")
  .max(MAX_AUTOMATION_NAME, `名称最多 ${MAX_AUTOMATION_NAME} 个字。`);

/** What a person sends to create one. `maxRuns`/`endDate` absent or null means "no limit" (AUT4). */
export const automationCreateSchema = z
  .object({
    name,
    target: automationTargetSchema,
    maxRuns: maxRuns.nullable().optional(),
    endDate: endDate.nullable().optional(),
  })
  .strict();
export type AutomationCreateInput = z.input<typeof automationCreateSchema>;

/** A change: only the fields named are changed; `null` clears a limit. */
export const automationUpdateSchema = z
  .object({
    name: name.optional(),
    target: automationTargetSchema.optional(),
    maxRuns: maxRuns.nullable().optional(),
    endDate: endDate.nullable().optional(),
  })
  .strict();
export type AutomationUpdateInput = z.input<typeof automationUpdateSchema>;

/** One automation as the product reads it. Tenant is the owner (D12: tenant = user). */
export type Automation = {
  id: string;
  tenantId: string;
  name: string;
  target: AutomationTarget;
  enabled: boolean;
  maxRuns: number | null;
  endDate: Date | null;
  runCount: number;
  createdAt: Date;
};

/** One trigger as the product reads it. The secret hash never leaves the store. */
export type AutomationTrigger = {
  id: string;
  automationId: string;
  config: AutomationTriggerConfig;
  enabled: boolean;
  nextRunAt: Date | null;
  hasSecret: boolean;
  lastError: string | null;
};

/** Why an automation stops running on its own (AUT4). */
export type AutomationExhaustion = "max_runs" | "end_date";

/**
 * Who carries an automation out, per target kind (AUT3).
 *
 * `verify` is asked before a target is saved and refuses (by throwing `AutomationRefusedError`) a
 * target its executor could not run, such as a flow this tenant does not have. The tenant it is given
 * is the caller's frame, never a value from the request.
 */
export type AutomationTargetExecutor<
  K extends AutomationTargetKind = AutomationTargetKind,
> = {
  kind: K;
  verify(
    target: Extract<AutomationTarget, { kind: K }>,
    frame: { tenantId: string },
  ): Promise<void>;
};

export type AutomationTargetRegistry = {
  register<K extends AutomationTargetKind>(
    executor: AutomationTargetExecutor<K>,
  ): void;
  get<K extends AutomationTargetKind>(
    kind: K,
  ): AutomationTargetExecutor<K> | undefined;
};

/**
 * The executors this process can run.
 *
 * Waker targets are verified by the store itself (the agent must be one this tenant can see) and run
 * by the existing agent runner, so they need no entry. A WakerFlow target needs one: until D10 wires
 * a WakerFlow executor, nothing is registered for `wakerflow`, and such a target is refused at save
 * time instead of being accepted and failing at its first firing.
 */
export function createAutomationTargetRegistry(): AutomationTargetRegistry {
  const executors = new Map<AutomationTargetKind, AutomationTargetExecutor>();
  return {
    register(executor) {
      if (executors.has(executor.kind)) {
        throw new Error(
          `An automation executor for "${executor.kind}" is already registered.`,
        );
      }
      executors.set(
        executor.kind,
        executor as unknown as AutomationTargetExecutor,
      );
    },
    get(kind) {
      return executors.get(kind) as
        | AutomationTargetExecutor<typeof kind>
        | undefined;
    },
  };
}

/**
 * Parse, or refuse with a sentence a person can read.
 *
 * Every constraint above carries its own Chinese message; anything else Zod can say (an unknown
 * field, a wrong type) is replaced by the caller's fallback rather than shown in English.
 */
export function parseOrRefuse<S extends z.ZodType>(
  schema: S,
  input: unknown,
  fallback: string,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const message = result.error.issues[0]?.message ?? "";
  throw new AutomationRefusedError(
    /[一-鿿]/.test(message) ? message : fallback,
  );
}

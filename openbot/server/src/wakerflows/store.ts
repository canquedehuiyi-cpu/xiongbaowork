import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  WAKERFLOW_CONFLICT_MESSAGE,
  WAKERFLOW_PLAN_FORMAT_MESSAGE,
  WAKERFLOW_SUGGESTIONS,
  type WakerFlow,
  type WakerFlowCandidate,
  type WakerFlowGenerationResult,
  type WakerFlowPlan,
  type WakerFlowRequestStatus,
  type WakerFlowSaveInput,
} from "../../../shared/wakerflows";
import type { Database } from "../db/client";
import {
  groupTaskRuns,
  groupTaskTemplates,
  wakerFlowRequests,
  wakerFlows,
  wakerGroupMembers,
  wakerGroups,
} from "../db/schema";
import type { PipelineStore } from "../pipeline/store";
import type { QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import {
  FlowGenerationCancelledError,
  FlowGenerationRefusedError,
  type FlowGenerator,
  FlowPlanFormatError,
} from "./generator";
import type { FlowModelResolver } from "./model";
import { wakerFlowPlanSchema } from "./plan";

/**
 * The WakerFlow store (spec D10, stories WF1/WF3/WF4).
 *
 * A Flow is an editable plan, and Save is what turns it into something the pipeline can run: a hidden
 * crew holding exactly the plan's members, and a NEW template whose steps are exactly the plan's steps.
 * A new template per Save rather than an edit of the old one, because a run snapshots the template it
 * started from and the person reviewing an old run must see the plan that run was given.
 *
 * Only `json-plan-v1` rows are this store's business. The JS-source mode and every `flow_source_*`
 * table belong to the activation contract (FLOW-ACTIVATION-CONTRACT.md), which this file neither reads
 * nor writes: a row in that mode is simply not here.
 *
 * The tenant is always the caller's own, passed in from the authenticated actor and entered with
 * `runAsTenant`; nothing in a request body can name one.
 */

const DEFINITION_MODE = "json-plan-v1";

/** Every refusal carries the HTTP answer it means, so the routes do not re-derive it from wording. */
export class WakerFlowError extends Error {
  readonly status: 400 | 404 | 409 | 501;
  constructor(status: 400 | 404 | 409 | 501, message: string) {
    super(message);
    this.name = "WakerFlowError";
    this.status = status;
  }
}

/** Another workspace's Flow, a deleted one, and a missing one all read the same. */
export class WakerFlowNotFoundError extends WakerFlowError {
  constructor() {
    super(404, "这个工作区里没有这个 WakerFlow。");
    this.name = "WakerFlowNotFoundError";
  }
}

export class WakerFlowValidationError extends WakerFlowError {
  constructor(message: string) {
    super(400, message);
    this.name = "WakerFlowValidationError";
  }
}

/** Save lost the revision race: the editor reloads rather than overwriting someone else's edit. */
export class WakerFlowConflictError extends WakerFlowError {
  constructor() {
    super(409, WAKERFLOW_CONFLICT_MESSAGE);
    this.name = "WakerFlowConflictError";
  }
}

/** A Flow with planning or a run in flight cannot be deleted out from under it. */
export class WakerFlowBusyError extends WakerFlowError {
  constructor() {
    super(409, "这个 WakerFlow 仍有进行中的规划或运行，结束后才能删除。");
    this.name = "WakerFlowBusyError";
  }
}

/** Generation and runs arrive with later packages (WF-B, WF-C). */
export class WakerFlowUnavailableError extends WakerFlowError {
  constructor() {
    super(501, "这个 WakerFlow 功能尚未开放。");
    this.name = "WakerFlowUnavailableError";
  }
}

export type WakerFlowCreateInput = {
  idea: string;
  name?: string;
  description?: string;
  modelRef?: string | null;
};

/**
 * One planning request. `members` are the coworkers the person offers the model (their own usable
 * coworkers); `scenario` is one of {@link WAKERFLOW_SUGGESTIONS} when the person started from one.
 */
export type WakerFlowGenerateInput = {
  requestId: string;
  modelRef: string;
  idea: string;
  members: WakerFlowCandidate[];
  scenario?: string;
};

export type WakerFlowStartInput = {
  requestId: string;
  revision: number;
  inputs: Record<string, string>;
};

export type WakerFlowRequestOutcome = {
  id: string;
  requestId: string;
  flowId: string;
  kind: string;
  status: WakerFlowRequestStatus;
  runId: string | null;
  taskId: string | null;
  /** Always this product's own words; a provider's error text is never stored or shown. */
  error: string | null;
  result: WakerFlowGenerationResult | null;
};

export type WakerFlowRunSummary = {
  id: string;
  status: string;
  templateId: string | null;
  parentTaskId: string | null;
  createdAt: string;
};

export type WakerFlowStore = ReturnType<typeof createWakerFlowStore>;

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

const columns = {
  id: wakerFlows.id,
  name: wakerFlows.name,
  description: wakerFlows.description,
  idea: wakerFlows.idea,
  modelRef: wakerFlows.modelRef,
  plan: wakerFlows.plan,
  revision: wakerFlows.revision,
  groupId: wakerFlows.groupId,
  templateId: wakerFlows.templateId,
  createdAt: wakerFlows.createdAt,
  updatedAt: wakerFlows.updatedAt,
};

type FlowRow = {
  id: string;
  name: string;
  description: string;
  idea: string;
  modelRef: string | null;
  plan: WakerFlowPlan | null;
  revision: number;
  groupId: string | null;
  templateId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `waker_flows` has no status column on purpose: "ready" is a fact about the row, not a flag that can
 * disagree with it. A Flow is runnable exactly when Save has compiled it.
 */
function shape(row: FlowRow): WakerFlow {
  const ready =
    row.plan !== null && row.groupId !== null && row.templateId !== null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    idea: row.idea,
    modelRef: row.modelRef,
    plan: row.plan,
    status: ready ? "ready" : "draft",
    revision: row.revision,
    groupId: row.groupId,
    templateId: row.templateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ownFlow(tenantId: string, id: string) {
  return and(
    eq(wakerFlows.id, id),
    eq(wakerFlows.tenantId, tenantId),
    eq(wakerFlows.definitionMode, DEFINITION_MODE),
    isNull(wakerFlows.deletedAt),
  );
}

function validModelRef(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isUuid(value)) throw new WakerFlowValidationError("请选择可用的模型。");
  return value;
}

/** A request id reused for different arguments: the second intent is refused, never merged. */
export class WakerFlowRequestConflictError extends WakerFlowError {
  constructor() {
    super(409, "这个请求编号已用于另一项操作，请刷新后重新发起。");
    this.name = "WakerFlowRequestConflictError";
  }
}

const GENERATE = "generate";
const CANCELLED_MESSAGE = "已取消生成。";
const UNCERTAIN_MESSAGE = "无法确认模型是否完成了这次生成，请发起新的生成。";
const SAVE_FAILED_MESSAGE = "生成的计划未能保存，请重新生成。";

const candidatesSchema = z
  .array(
    z.object({
      agentId: z.string().min(1).max(200),
      name: z.string().trim().max(160).default(""),
      role: z.string().trim().min(1).max(160),
    }),
  )
  .min(1)
  .max(50);

/** Keys sorted at every depth, so the same arguments always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const requestColumns = {
  id: wakerFlowRequests.id,
  requestId: wakerFlowRequests.requestId,
  flowId: wakerFlowRequests.flowId,
  kind: wakerFlowRequests.kind,
  fingerprint: wakerFlowRequests.fingerprint,
  status: wakerFlowRequests.status,
  runId: wakerFlowRequests.runId,
  taskId: wakerFlowRequests.taskId,
  error: wakerFlowRequests.error,
  result: wakerFlowRequests.result,
};

type RequestRow = {
  id: string;
  requestId: string;
  flowId: string;
  kind: string;
  fingerprint: string;
  status: string;
  runId: string | null;
  taskId: string | null;
  error: string | null;
  result: unknown;
};

const STATUSES: readonly WakerFlowRequestStatus[] = [
  "pending",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];

/** The column has no CHECK; the statuses are this file's convention, and anything else reads as unknown. */
function outcome(row: RequestRow): WakerFlowRequestOutcome {
  const status = (STATUSES as readonly string[]).includes(row.status)
    ? (row.status as WakerFlowRequestStatus)
    : "unknown";
  return {
    id: row.id,
    requestId: row.requestId,
    flowId: row.flowId,
    kind: row.kind,
    status,
    runId: row.runId,
    taskId: row.taskId,
    error: row.error,
    result:
      status === "completed" && row.result
        ? (row.result as WakerFlowGenerationResult)
        : null,
  };
}

export function createWakerFlowStore(options: {
  database: Database;
  /** Kept for WF-B, which starts runs from the compiled template. */
  pipeline: PipelineStore;
  /** Kept for WF-B/WF-C, which put planning and runs on the board. */
  board: TaskProjector;
  /** Spec I6: may THIS actor use THIS coworker? Asked for every member on every Save. */
  canUse: (actor: string, agentId: string) => Promise<boolean>;
  /** WF-B: the planning model picker. Without it (and `generator`) generation answers 501. */
  models?: FlowModelResolver;
  generator?: Pick<FlowGenerator, "plan">;
  /** A planning call is model spend, so it is asked against the monthly ceiling first. */
  quota?: Pick<QuotaService, "assertCapacity">;
}) {
  const { database, canUse } = options;
  /** Calls running in THIS process, so Cancel can stop the socket and not only the row. */
  const inflight = new Map<
    string,
    { flowId: string; controller: AbortController }
  >();
  const inflightKey = (tenantId: string, requestId: string) =>
    `${tenantId}\u0000${requestId}`;

  const readRequest = async (tenantId: string, requestId: string) => {
    const [row] = await runAsTenant(tenantId, async () =>
      database
        .select(requestColumns)
        .from(wakerFlowRequests)
        .where(
          and(
            eq(wakerFlowRequests.tenantId, tenantId),
            eq(wakerFlowRequests.requestId, requestId),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  };

  /** A terminal write that loses to Cancel (or to another terminal write) changes nothing. */
  const finish = async (
    tenantId: string,
    claimId: string,
    status: Exclude<WakerFlowRequestStatus, "pending" | "completed">,
    error: string,
  ) => {
    await runAsTenant(tenantId, async () =>
      database
        .update(wakerFlowRequests)
        .set({ status, error, updatedAt: new Date() })
        .where(
          and(
            eq(wakerFlowRequests.id, claimId),
            eq(wakerFlowRequests.tenantId, tenantId),
            eq(wakerFlowRequests.status, "pending"),
          ),
        ),
    );
  };

  return {
    async create(tenantId: string, input: WakerFlowCreateInput) {
      const idea = typeof input.idea === "string" ? input.idea.trim() : "";
      if (idea.length > 4000)
        throw new WakerFlowValidationError("流程描述不能超过 4000 字。");
      const name =
        (typeof input.name === "string" ? input.name.trim() : "") ||
        idea.slice(0, 40) ||
        "未命名 WakerFlow";
      if (name.length > 160)
        throw new WakerFlowValidationError("流程名称不能超过 160 字。");
      const description =
        typeof input.description === "string" ? input.description.trim() : "";
      if (description.length > 4000)
        throw new WakerFlowValidationError("流程简介不能超过 4000 字。");
      const modelRef = validModelRef(input.modelRef) ?? null;
      const [row] = await runAsTenant(tenantId, async () =>
        database
          .insert(wakerFlows)
          .values({
            tenantId,
            name,
            description,
            idea,
            modelRef,
            definitionMode: DEFINITION_MODE,
          })
          .returning(columns),
      );
      // biome-ignore lint/style/noNonNullAssertion: an INSERT with RETURNING answers with the row it wrote
      return shape(row!);
    },

    async list(tenantId: string): Promise<WakerFlow[]> {
      const rows = await runAsTenant(tenantId, async () =>
        database
          .select(columns)
          .from(wakerFlows)
          .where(
            and(
              eq(wakerFlows.tenantId, tenantId),
              eq(wakerFlows.definitionMode, DEFINITION_MODE),
              isNull(wakerFlows.deletedAt),
            ),
          )
          .orderBy(desc(wakerFlows.updatedAt)),
      );
      return rows.map(shape);
    },

    async inspect(tenantId: string, id: string): Promise<WakerFlow | null> {
      if (!isUuid(id)) return null;
      const [row] = await runAsTenant(tenantId, async () =>
        database
          .select(columns)
          .from(wakerFlows)
          .where(ownFlow(tenantId, id))
          .limit(1),
      );
      return row ? shape(row) : null;
    },

    /**
     * Save the edited plan and compile it: fence on the revision, refresh the hidden crew, and add a
     * new template version. All of it happens in one transaction, so a refused member, a lost race or
     * a crash leaves the previous version exactly as it was.
     */
    async save(
      tenantId: string,
      actor: string,
      id: string,
      input: WakerFlowSaveInput,
    ): Promise<WakerFlow> {
      if (!isUuid(id)) throw new WakerFlowNotFoundError();
      if (!Number.isInteger(input.revision) || input.revision < 0)
        throw new WakerFlowValidationError(
          "缺少有效的版本号，请刷新后再保存。",
        );
      const parsed = wakerFlowPlanSchema.safeParse(input.plan);
      if (!parsed.success) {
        throw new WakerFlowValidationError(
          parsed.error.issues[0]?.message ?? "计划格式不正确。",
        );
      }
      const plan: WakerFlowPlan = parsed.data;
      const modelRef = validModelRef(input.modelRef);
      for (const member of plan.members) {
        const allowed = await canUse(actor, member.agentId).catch(() => false);
        if (!allowed) {
          throw new WakerFlowValidationError(
            `计划中的员工「${member.role}」当前不可用，请换一位员工后再保存。`,
          );
        }
      }
      const steps = plan.steps.map((step) => ({
        id: step.id,
        agentId: step.agentId,
        instruction: step.instruction,
        inputKeys: [...step.inputKeys],
        outputKey: step.outputKey,
      }));

      const row = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          // The fence and the row lock in one statement: only the editor holding the current revision
          // gets past here, and anyone arriving after waits for this transaction and then misses.
          const [fenced] = await tx
            .update(wakerFlows)
            .set({
              revision: sql`${wakerFlows.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                ownFlow(tenantId, id),
                eq(wakerFlows.revision, input.revision),
              ),
            )
            .returning({
              groupId: wakerFlows.groupId,
              revision: wakerFlows.revision,
            });
          if (!fenced) {
            const [exists] = await tx
              .select({ id: wakerFlows.id })
              .from(wakerFlows)
              .where(ownFlow(tenantId, id))
              .limit(1);
            if (!exists) throw new WakerFlowNotFoundError();
            throw new WakerFlowConflictError();
          }

          let groupId: string | null = null;
          if (fenced.groupId) {
            const [kept] = await tx
              .update(wakerGroups)
              .set({ description: plan.name, updatedAt: new Date() })
              .where(
                and(
                  eq(wakerGroups.id, fenced.groupId),
                  eq(wakerGroups.tenantId, tenantId),
                ),
              )
              .returning({ id: wakerGroups.id });
            groupId = kept?.id ?? null;
          }
          if (!groupId) {
            // Crew names are unique per workspace and the generic crew API accepts any name, so a crew
            // a person already called `wakerflow-<id>` must not make this Flow unsaveable: the name is
            // only a label, and a taken one falls back to a random suffix.
            const insertCrew = (name: string) =>
              tx
                .insert(wakerGroups)
                .values({ tenantId, name, description: plan.name })
                .onConflictDoNothing()
                .returning({ id: wakerGroups.id });
            const [created] = await insertCrew(`wakerflow-${id}`);
            const [crewRow] = created
              ? [created]
              : await insertCrew(`wakerflow-${id}-${randomUUID()}`);
            // biome-ignore lint/style/noNonNullAssertion: a fresh random name cannot conflict, so RETURNING answers with the row
            groupId = crewRow!.id;
          }
          const crew = groupId;
          await tx
            .delete(wakerGroupMembers)
            .where(eq(wakerGroupMembers.groupId, crew));
          await tx.insert(wakerGroupMembers).values(
            plan.members.map((member, position) => ({
              groupId: crew,
              agentId: member.agentId,
              position: String(position),
            })),
          );
          // The revision makes each version's name unique inside the crew, which the template table's
          // (tenant, group, name) index requires.
          const [template] = await tx
            .insert(groupTaskTemplates)
            .values({
              tenantId,
              groupId: crew,
              name: `${plan.name} · 第 ${fenced.revision} 版`,
              steps,
              createdBy: actor,
            })
            .returning({ id: groupTaskTemplates.id });
          const [saved] = await tx
            .update(wakerFlows)
            .set({
              name: plan.name,
              description: plan.description,
              plan,
              groupId: crew,
              // biome-ignore lint/style/noNonNullAssertion: an INSERT with RETURNING answers with the row it wrote
              templateId: template!.id,
              ...(modelRef === undefined ? {} : { modelRef }),
              updatedAt: new Date(),
            })
            .where(
              and(eq(wakerFlows.id, id), eq(wakerFlows.tenantId, tenantId)),
            )
            .returning(columns);
          return saved;
        }),
      );
      if (!row) throw new WakerFlowNotFoundError();
      return shape(row);
    },

    /**
     * Soft-delete. Refused while planning is pending or a run of this Flow is still going, because
     * both would otherwise finish into a Flow the person can no longer open.
     */
    async remove(
      tenantId: string,
      id: string,
      revision?: number,
    ): Promise<boolean> {
      if (!isUuid(id)) return false;
      return runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const [row] = await tx
            .select({ id: wakerFlows.id, revision: wakerFlows.revision })
            .from(wakerFlows)
            .where(ownFlow(tenantId, id))
            .for("update");
          if (!row) return false;
          if (revision !== undefined && row.revision !== revision)
            throw new WakerFlowConflictError();
          const [planning] = await tx
            .select({ id: wakerFlowRequests.id })
            .from(wakerFlowRequests)
            .where(
              and(
                eq(wakerFlowRequests.tenantId, tenantId),
                eq(wakerFlowRequests.flowId, id),
                eq(wakerFlowRequests.kind, "generate"),
                eq(wakerFlowRequests.status, "pending"),
              ),
            )
            .limit(1);
          const [running] = await tx
            .select({ id: groupTaskRuns.id })
            .from(groupTaskRuns)
            .where(
              and(
                eq(groupTaskRuns.tenantId, tenantId),
                eq(groupTaskRuns.flowId, id),
                inArray(groupTaskRuns.status, ["running", "awaiting_action"]),
              ),
            )
            .limit(1);
          if (planning || running) throw new WakerFlowBusyError();
          const [removed] = await tx
            .update(wakerFlows)
            .set({
              deletedAt: new Date(),
              updatedAt: new Date(),
              revision: sql`${wakerFlows.revision} + 1`,
            })
            .where(ownFlow(tenantId, id))
            .returning({ id: wakerFlows.id });
          return Boolean(removed);
        }),
      );
    },

    /**
     * Natural-language planning (story WF3), once per request id.
     *
     * The order is the contract. A repeat of a request already claimed answers from the stored row and
     * never calls the model again — not even a request whose outcome is `unknown`, because the provider
     * may have done that work. A new request is refused for a Flow that is not the caller's, a model
     * that is not usable, or a coworker the actor may not use before any row is written or any call is
     * made; then the quota; then the claim, which a concurrent twin loses on the unique key; then the
     * one call. A plan that arrives is written into a draft that was never compiled — a saved Flow is
     * not changed behind its template, the editor applies the result itself — and only if nobody
     * cancelled the request meanwhile.
     */
    async generate(
      tenantId: string,
      actor: string,
      id: string,
      input: WakerFlowGenerateInput,
    ): Promise<WakerFlowRequestOutcome> {
      if (!isUuid(id)) throw new WakerFlowNotFoundError();
      if (!isUuid(input.requestId))
        throw new WakerFlowValidationError(
          "缺少有效的请求编号，请刷新后重试。",
        );
      const idea = typeof input.idea === "string" ? input.idea.trim() : "";
      if (!idea) throw new WakerFlowValidationError("请先描述你想创建的流程。");
      if (idea.length > 4000)
        throw new WakerFlowValidationError("流程描述不能超过 4000 字。");
      if (typeof input.modelRef !== "string" || !input.modelRef)
        throw new WakerFlowValidationError("请选择可用的模型。");
      const scenario = input.scenario ?? undefined;
      if (
        scenario !== undefined &&
        !(WAKERFLOW_SUGGESTIONS as readonly string[]).includes(scenario)
      )
        throw new WakerFlowValidationError("请选择列表中的场景建议。");
      const parsedMembers = candidatesSchema.safeParse(input.members);
      if (!parsedMembers.success)
        throw new WakerFlowValidationError("请至少选择一位可用的员工。");
      const members: WakerFlowCandidate[] = parsedMembers.data;
      if (
        new Set(members.map((member) => member.agentId)).size !== members.length
      )
        throw new WakerFlowValidationError("同一位员工不能重复加入计划。");
      const fingerprint = createHash("sha256")
        .update(
          canonical({
            kind: GENERATE,
            flowId: id,
            modelRef: input.modelRef,
            idea,
            members,
            scenario: scenario ?? null,
          }),
        )
        .digest("hex");

      const answer = (row: RequestRow) => {
        if (row.fingerprint !== fingerprint)
          throw new WakerFlowRequestConflictError();
        return outcome(row);
      };
      const existing = await readRequest(tenantId, input.requestId);
      if (existing) return answer(existing);

      const { models, generator } = options;
      if (!models || !generator) throw new WakerFlowUnavailableError();
      const [flow] = await runAsTenant(tenantId, async () =>
        database
          .select({ id: wakerFlows.id })
          .from(wakerFlows)
          .where(ownFlow(tenantId, id))
          .limit(1),
      );
      // The request row references the Flow, and a foreign key does not look through row-level
      // security: without this read another tenant's Flow id would be accepted as a reference.
      if (!flow) throw new WakerFlowNotFoundError();
      const resolved = await models.resolve(tenantId, input.modelRef);
      for (const member of members) {
        const allowed = await canUse(actor, member.agentId).catch(() => false);
        if (!allowed)
          throw new WakerFlowValidationError(
            `你无权使用员工「${member.name || member.role}」，请换一位员工后再生成。`,
          );
      }
      await options.quota?.assertCapacity(tenantId, "tasksPerMonth");

      const [claimed] = await runAsTenant(tenantId, async () =>
        database
          .insert(wakerFlowRequests)
          .values({
            tenantId,
            requestId: input.requestId,
            flowId: id,
            kind: GENERATE,
            fingerprint,
          })
          .onConflictDoNothing({
            target: [wakerFlowRequests.tenantId, wakerFlowRequests.requestId],
          })
          .returning(requestColumns),
      );
      if (!claimed) {
        // A twin claimed it first; its row is the answer, whatever state it is in.
        const twin = await readRequest(tenantId, input.requestId);
        if (!twin) throw new WakerFlowNotFoundError();
        return answer(twin);
      }

      const key = inflightKey(tenantId, input.requestId);
      const controller = new AbortController();
      inflight.set(key, { flowId: id, controller });
      let generated: WakerFlowPlan | null = null;
      try {
        generated = await generator.plan({
          model: resolved.model,
          idea,
          members,
          scenario,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof FlowPlanFormatError)
          await finish(
            tenantId,
            claimed.id,
            "failed",
            WAKERFLOW_PLAN_FORMAT_MESSAGE,
          );
        else if (error instanceof FlowGenerationRefusedError)
          await finish(tenantId, claimed.id, "failed", error.message);
        else if (error instanceof FlowGenerationCancelledError)
          await finish(tenantId, claimed.id, "cancelled", CANCELLED_MESSAGE);
        // Everything else — a timeout, a dropped line, an error nobody classified — may have been
        // done and charged by the provider, so it is recorded as such and never replayed.
        else await finish(tenantId, claimed.id, "unknown", UNCERTAIN_MESSAGE);
        const settled = await readRequest(tenantId, input.requestId);
        return outcome(settled ?? claimed);
      } finally {
        inflight.delete(key);
      }
      const plan = generated;
      // Unreachable: the call either answered with a plan or the catch above returned.
      if (!plan) return outcome(claimed);

      try {
        await runAsTenant(tenantId, () =>
          database.transaction(async (tx) => {
            // Locked so Cancel either lands first (and the plan is not written) or waits and misses.
            const [pending] = await tx
              .select({ id: wakerFlowRequests.id })
              .from(wakerFlowRequests)
              .where(
                and(
                  eq(wakerFlowRequests.id, claimed.id),
                  eq(wakerFlowRequests.tenantId, tenantId),
                  eq(wakerFlowRequests.status, "pending"),
                ),
              )
              .for("update");
            if (!pending) return;
            const [written] = await tx
              .update(wakerFlows)
              .set({
                plan,
                name: plan.name,
                description: plan.description,
                idea,
                ...(isUuid(resolved.modelRef)
                  ? { modelRef: resolved.modelRef }
                  : {}),
                revision: sql`${wakerFlows.revision} + 1`,
                updatedAt: new Date(),
              })
              .where(and(ownFlow(tenantId, id), isNull(wakerFlows.templateId)))
              .returning({ revision: wakerFlows.revision });
            const result: WakerFlowGenerationResult = {
              plan,
              modelRef: resolved.modelRef,
              revision: written?.revision ?? null,
              applied: Boolean(written),
            };
            await tx
              .update(wakerFlowRequests)
              .set({
                status: "completed",
                error: null,
                result,
                updatedAt: new Date(),
              })
              .where(eq(wakerFlowRequests.id, claimed.id));
          }),
        );
      } catch (error) {
        // The answer arrived but could not be stored: settle the row so it does not stay pending (and
        // block deleting the Flow) forever. A new request id is the way to try again.
        await finish(tenantId, claimed.id, "failed", SAVE_FAILED_MESSAGE).catch(
          () => undefined,
        );
        throw error;
      }
      const settled = await readRequest(tenantId, input.requestId);
      return outcome(settled ?? claimed);
    },

    /**
     * Stop a planning request. The row is marked first, with a condition on `pending`, so a request
     * that already finished keeps its outcome; then the call is aborted if it runs in this process.
     * Another process's call finishes into a cancelled row and writes nothing.
     */
    async cancel(
      tenantId: string,
      flowId: string,
      requestId: string,
    ): Promise<WakerFlowRequestOutcome | null> {
      if (!isUuid(flowId) || !isUuid(requestId)) return null;
      await runAsTenant(tenantId, async () =>
        database
          .update(wakerFlowRequests)
          .set({
            status: "cancelled",
            error: CANCELLED_MESSAGE,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(wakerFlowRequests.tenantId, tenantId),
              eq(wakerFlowRequests.requestId, requestId),
              eq(wakerFlowRequests.flowId, flowId),
              eq(wakerFlowRequests.kind, GENERATE),
              eq(wakerFlowRequests.status, "pending"),
            ),
          ),
      );
      const running = inflight.get(inflightKey(tenantId, requestId));
      if (running && running.flowId === flowId) running.controller.abort();
      const row = await readRequest(tenantId, requestId);
      return row && row.flowId === flowId ? outcome(row) : null;
    },

    /** One request of the caller's own tenant, or null. */
    async getRequest(
      tenantId: string,
      requestId: string,
    ): Promise<WakerFlowRequestOutcome | null> {
      if (!isUuid(requestId)) return null;
      const row = await readRequest(tenantId, requestId);
      return row ? outcome(row) : null;
    },

    /** WF-B: start a run of the saved template. */
    async start(
      _tenantId: string,
      _actor: string,
      _id: string,
      _input: WakerFlowStartInput,
    ): Promise<WakerFlowRequestOutcome> {
      throw new WakerFlowUnavailableError();
    },

    /** WF-B: the runs of this Flow. */
    async runs(_tenantId: string, _id: string): Promise<WakerFlowRunSummary[]> {
      throw new WakerFlowUnavailableError();
    },
  };
}

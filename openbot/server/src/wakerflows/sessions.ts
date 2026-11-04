import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  WakerFlow,
  WakerFlowCandidate,
  WakerFlowGenerationResult,
  WakerFlowPlan,
  WakerFlowRequestStatus,
} from "../../../shared/wakerflows";
import type { Database } from "../db/client";
import {
  flowCustomizationHeads,
  flowCustomizationSessions,
  flowCustomizationTurns,
  wakerFlowRequests,
} from "../db/schema";
import { runAsTenant } from "../tenant/context";
import {
  CUSTOMIZATION_TURNS,
  type FlowCustomizationTurnSummary,
  flowCustomizationContext,
} from "./generator";
import type {
  WakerFlowCustomizeTurn,
  WakerFlowGenerateInput,
  WakerFlowRequestOutcome,
} from "./store";

/**
 * WakerFlow customization sessions (story WF9, spec 2026-11-04-wf9-flow-sessions-sharing §3.1, S-A).
 *
 * A session is one person's conversation about changing one Flow. Each turn is a change request
 * ("把第二步改成先审核") planned against the Flow's current plan and the session's last turns; the
 * planning itself is the store's `generate` (kind `customize`), so idempotency, the model pick, the
 * coworker check, the quota, Cancel and restart recovery are the ones planning already has. A turn's
 * outcome lives in its `waker_flow_requests` row (same request id); the turn row keeps what was asked
 * and the context the model was given.
 *
 * What comes back is only a candidate: a never-compiled draft takes it (as first planning does), a
 * saved Flow is never changed behind its template, and the editor applies the candidate and Saves.
 *
 * Every statement runs in the caller's own tenant (`runAsTenant`), and every id from a request is
 * looked up within that tenant first, so another workspace's Flow or session reads as not here.
 *
 * This file imports only types from `store.ts`, which builds it: the store hands itself in.
 */

/** A session refusal, carrying the HTTP answer it means. */
export class FlowSessionError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "FlowSessionError";
    this.status = status;
  }
}

const FLOW_NOT_FOUND = "这个工作区里没有这个 WakerFlow。";
const SESSION_NOT_FOUND = "这个 WakerFlow 没有这个修改会话。";
const SESSION_CONFLICT = "这个修改会话已在另一处修改，请刷新后再试。";
const REQUEST_CONFLICT = "这个请求编号已用于另一项操作，请刷新后重新发起。";
const DEFAULT_TITLE = "新的修改会话";
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 500;
const MAX_PROMPT = 4000;

/** One session, as the history list shows it. */
export type FlowSession = {
  id: string;
  requestId: string;
  title: string;
  description: string;
  revision: number;
  turnCount: number;
  /** Whether the Flow's page opens on this session. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** One turn of a session, with the candidate plan it produced (if it produced one). */
export type FlowSessionTurn = {
  id: string;
  requestId: string;
  prompt: string;
  modelRef: string;
  status: WakerFlowRequestStatus;
  error: string | null;
  plan: WakerFlowPlan | null;
  /** Written into the draft when it arrived, or the Flow's plan is this candidate now. */
  applied: boolean;
  createdAt: string;
};

/** What the sessions need of the WakerFlow store. */
export type FlowSessionPlanner = {
  inspect: (tenantId: string, id: string) => Promise<WakerFlow | null>;
  generate: (
    tenantId: string,
    actor: string,
    id: string,
    input: WakerFlowGenerateInput,
    turn?: WakerFlowCustomizeTurn,
  ) => Promise<WakerFlowRequestOutcome>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

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

const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

const STATUSES: readonly WakerFlowRequestStatus[] = [
  "pending",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];
const statusOf = (value: string | null): WakerFlowRequestStatus =>
  (STATUSES as readonly string[]).includes(value ?? "")
    ? (value as WakerFlowRequestStatus)
    : "unknown";

function text(value: unknown, max: number, tooLong: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max) throw new FlowSessionError(400, tooLong);
  return trimmed;
}

/** What one earlier turn produced, in a sentence the next turn's context carries. */
function outcomeSummary(
  status: WakerFlowRequestStatus,
  result: WakerFlowGenerationResult | null,
): string {
  if (status === "completed" && result) {
    const steps = result.plan.steps
      .map((step) =>
        step.kind === undefined || step.kind === "worker"
          ? `${step.id}：${step.instruction}`
          : step.id,
      )
      .join("；");
    const line = `生成了候选计划「${result.plan.name}」（${result.applied ? "已写入草稿" : "未直接应用"}）：${steps}`;
    return line.length > 600 ? `${line.slice(0, 599)}…` : line;
  }
  if (status === "pending") return "这一轮仍在生成中。";
  return "这一轮没有产生计划。";
}

export type FlowSessionStore = ReturnType<typeof createFlowSessionStore>;

export function createFlowSessionStore(options: {
  database: Database;
  flows: FlowSessionPlanner;
}) {
  const { database, flows } = options;

  const flowOf = async (tenantId: string, flowId: string) => {
    const flow = await flows.inspect(tenantId, flowId);
    if (!flow) throw new FlowSessionError(404, FLOW_NOT_FOUND);
    return flow;
  };

  const own = (tenantId: string, flowId: string, sessionId: string) =>
    and(
      eq(flowCustomizationSessions.tenantId, tenantId),
      eq(flowCustomizationSessions.flowId, flowId),
      eq(flowCustomizationSessions.id, sessionId),
      isNull(flowCustomizationSessions.deletedAt),
    );

  // Spelled out: inside one table's select drizzle leaves columns unqualified, and the subquery's
  // own columns would then shadow the session's.
  const turnCount = sql<number>`(select count(*)::int from "flow_customization_turns" as "turn" where "turn"."tenant_id" = "flow_customization_sessions"."tenant_id" and "turn"."session_id" = "flow_customization_sessions"."id")`;
  const sessionColumns = {
    id: flowCustomizationSessions.id,
    requestId: flowCustomizationSessions.requestId,
    title: flowCustomizationSessions.title,
    description: flowCustomizationSessions.description,
    revision: flowCustomizationSessions.revision,
    creationFingerprint: flowCustomizationSessions.creationFingerprint,
    turnCount,
    createdAt: flowCustomizationSessions.createdAt,
    updatedAt: flowCustomizationSessions.updatedAt,
  };
  type SessionRow = {
    id: string;
    requestId: string;
    title: string;
    description: string;
    revision: number;
    turnCount: number;
    createdAt: Date;
    updatedAt: Date;
  };
  const shape = (row: SessionRow, active: string | null): FlowSession => ({
    id: row.id,
    requestId: row.requestId,
    title: row.title,
    description: row.description,
    revision: row.revision,
    turnCount: Number(row.turnCount),
    active: row.id === active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  const activeOf = async (tenantId: string, flowId: string) => {
    const [head] = await runAsTenant(tenantId, () =>
      database
        .select({ sessionId: flowCustomizationHeads.sessionId })
        .from(flowCustomizationHeads)
        .where(
          and(
            eq(flowCustomizationHeads.tenantId, tenantId),
            eq(flowCustomizationHeads.flowId, flowId),
          ),
        )
        .limit(1),
    );
    return head?.sessionId ?? null;
  };

  const readSession = async (
    tenantId: string,
    flowId: string,
    sessionId: string,
  ) => {
    if (!isUuid(sessionId)) throw new FlowSessionError(404, SESSION_NOT_FOUND);
    const [row] = await runAsTenant(tenantId, () =>
      database
        .select(sessionColumns)
        .from(flowCustomizationSessions)
        .where(own(tenantId, flowId, sessionId))
        .limit(1),
    );
    if (!row) throw new FlowSessionError(404, SESSION_NOT_FOUND);
    return row;
  };

  /** Point the Flow's page at a session (or at none). */
  const setHead = (
    db: Pick<Database, "insert">,
    tenantId: string,
    flowId: string,
    sessionId: string | null,
  ) =>
    db
      .insert(flowCustomizationHeads)
      .values({ tenantId, flowId, sessionId })
      .onConflictDoUpdate({
        target: [
          flowCustomizationHeads.tenantId,
          flowCustomizationHeads.flowId,
        ],
        set: { sessionId, updatedAt: new Date() },
      });

  /** A session's turns, oldest first, each with its request's outcome. */
  const turnRows = (tenantId: string, sessionId: string) =>
    runAsTenant(tenantId, () =>
      database
        .select({
          id: flowCustomizationTurns.id,
          requestId: flowCustomizationTurns.requestId,
          prompt: flowCustomizationTurns.prompt,
          modelRef: flowCustomizationTurns.modelRef,
          createdAt: flowCustomizationTurns.createdAt,
          status: wakerFlowRequests.status,
          error: wakerFlowRequests.error,
          result: wakerFlowRequests.result,
        })
        .from(flowCustomizationTurns)
        .leftJoin(
          wakerFlowRequests,
          and(
            eq(wakerFlowRequests.tenantId, flowCustomizationTurns.tenantId),
            eq(wakerFlowRequests.requestId, flowCustomizationTurns.requestId),
          ),
        )
        .where(
          and(
            eq(flowCustomizationTurns.tenantId, tenantId),
            eq(flowCustomizationTurns.sessionId, sessionId),
          ),
        )
        .orderBy(
          asc(flowCustomizationTurns.createdAt),
          asc(flowCustomizationTurns.id),
        ),
    );

  const resultOf = (status: WakerFlowRequestStatus, result: unknown) =>
    status === "completed" && result
      ? (result as WakerFlowGenerationResult)
      : null;

  return {
    /** The Flow's live sessions, most recently used first, and the one its page opens on. */
    async list(tenantId: string, flowId: string) {
      await flowOf(tenantId, flowId);
      const rows = await runAsTenant(tenantId, () =>
        database
          .select(sessionColumns)
          .from(flowCustomizationSessions)
          .where(
            and(
              eq(flowCustomizationSessions.tenantId, tenantId),
              eq(flowCustomizationSessions.flowId, flowId),
              isNull(flowCustomizationSessions.deletedAt),
            ),
          )
          .orderBy(
            desc(flowCustomizationSessions.updatedAt),
            desc(flowCustomizationSessions.id),
          ),
      );
      const active = await activeOf(tenantId, flowId);
      return {
        sessions: rows.map((row) => shape(row, active)),
        activeSessionId: rows.some((row) => row.id === active) ? active : null,
      };
    },

    /**
     * Start a session, once per request id, and make it the one the Flow's page opens on. A repeat
     * answers with the same session; the same id with a different title is a 409.
     */
    async create(
      tenantId: string,
      flowId: string,
      input: { requestId: string; title?: string; description?: string },
    ): Promise<FlowSession> {
      if (!isUuid(input.requestId))
        throw new FlowSessionError(400, "缺少有效的请求编号，请刷新后重试。");
      const title =
        text(input.title, MAX_TITLE, `会话名称不能超过 ${MAX_TITLE} 字。`) ||
        DEFAULT_TITLE;
      const description = text(
        input.description,
        MAX_DESCRIPTION,
        `会话说明不能超过 ${MAX_DESCRIPTION} 字。`,
      );
      await flowOf(tenantId, flowId);
      const fingerprint = digest({ flowId, title, description });
      const created = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const [row] = await tx
            .insert(flowCustomizationSessions)
            .values({
              tenantId,
              flowId,
              requestId: input.requestId,
              title,
              description,
              creationFingerprint: fingerprint,
            })
            .onConflictDoNothing({
              target: [
                flowCustomizationSessions.tenantId,
                flowCustomizationSessions.requestId,
              ],
            })
            .returning({ id: flowCustomizationSessions.id });
          if (row) await setHead(tx, tenantId, flowId, row.id);
          return row;
        }),
      );
      const [row] = await runAsTenant(tenantId, () =>
        database
          .select({
            ...sessionColumns,
            flowId: flowCustomizationSessions.flowId,
          })
          .from(flowCustomizationSessions)
          .where(
            and(
              eq(flowCustomizationSessions.tenantId, tenantId),
              created
                ? eq(flowCustomizationSessions.id, created.id)
                : eq(flowCustomizationSessions.requestId, input.requestId),
            ),
          )
          .limit(1),
      );
      if (
        !row ||
        row.flowId !== flowId ||
        row.creationFingerprint !== fingerprint
      )
        throw new FlowSessionError(409, REQUEST_CONFLICT);
      return shape(row, await activeOf(tenantId, flowId));
    },

    /** Rename a session, fenced on the revision the person was looking at. */
    async update(
      tenantId: string,
      flowId: string,
      sessionId: string,
      input: { revision: number; title?: string; description?: string },
    ): Promise<FlowSession> {
      if (!Number.isInteger(input.revision) || input.revision < 0)
        throw new FlowSessionError(400, "缺少有效的版本号，请刷新后再试。");
      await flowOf(tenantId, flowId);
      const current = await readSession(tenantId, flowId, sessionId);
      const title =
        input.title === undefined
          ? current.title
          : text(
              input.title,
              MAX_TITLE,
              `会话名称不能超过 ${MAX_TITLE} 字。`,
            ) || DEFAULT_TITLE;
      const description =
        input.description === undefined
          ? current.description
          : text(
              input.description,
              MAX_DESCRIPTION,
              `会话说明不能超过 ${MAX_DESCRIPTION} 字。`,
            );
      const [updated] = await runAsTenant(tenantId, () =>
        database
          .update(flowCustomizationSessions)
          .set({
            title,
            description,
            revision: sql`${flowCustomizationSessions.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              own(tenantId, flowId, sessionId),
              eq(flowCustomizationSessions.revision, input.revision),
            ),
          )
          .returning({ id: flowCustomizationSessions.id }),
      );
      if (!updated) throw new FlowSessionError(409, SESSION_CONFLICT);
      return shape(
        await readSession(tenantId, flowId, sessionId),
        await activeOf(tenantId, flowId),
      );
    },

    /**
     * Soft-delete a session (fenced on its revision when one is given). Deleting the session the
     * Flow's page opens on leaves the page with none.
     */
    async remove(
      tenantId: string,
      flowId: string,
      sessionId: string,
      revision?: number,
    ): Promise<void> {
      await flowOf(tenantId, flowId);
      await readSession(tenantId, flowId, sessionId);
      const removed = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const [row] = await tx
            .update(flowCustomizationSessions)
            .set({
              deletedAt: new Date(),
              updatedAt: new Date(),
              revision: sql`${flowCustomizationSessions.revision} + 1`,
            })
            .where(
              and(
                own(tenantId, flowId, sessionId),
                ...(revision === undefined
                  ? []
                  : [eq(flowCustomizationSessions.revision, revision)]),
              ),
            )
            .returning({ id: flowCustomizationSessions.id });
          if (!row) return false;
          await tx
            .update(flowCustomizationHeads)
            .set({ sessionId: null, updatedAt: new Date() })
            .where(
              and(
                eq(flowCustomizationHeads.tenantId, tenantId),
                eq(flowCustomizationHeads.flowId, flowId),
                eq(flowCustomizationHeads.sessionId, sessionId),
              ),
            );
          return true;
        }),
      );
      if (!removed) throw new FlowSessionError(409, SESSION_CONFLICT);
    },

    /** Make a session the one the Flow's page opens on. Nothing else changes. */
    async activate(
      tenantId: string,
      flowId: string,
      sessionId: string,
    ): Promise<FlowSession> {
      await flowOf(tenantId, flowId);
      const row = await readSession(tenantId, flowId, sessionId);
      await runAsTenant(tenantId, () =>
        setHead(database, tenantId, flowId, sessionId),
      );
      return shape(row, sessionId);
    },

    /** A session's turns, oldest first, with each candidate plan and whether it is applied. */
    async turns(
      tenantId: string,
      flowId: string,
      sessionId: string,
    ): Promise<FlowSessionTurn[]> {
      const flow = await flowOf(tenantId, flowId);
      await readSession(tenantId, flowId, sessionId);
      const current = flow.plan ? canonical(flow.plan) : null;
      return (await turnRows(tenantId, sessionId)).map((row) => {
        const status = statusOf(row.status);
        const result = resultOf(status, row.result);
        return {
          id: row.id,
          requestId: row.requestId,
          prompt: row.prompt,
          modelRef: row.modelRef,
          status,
          error: row.error,
          plan: result?.plan ?? null,
          applied: result
            ? result.applied || canonical(result.plan) === current
            : false,
          createdAt: row.createdAt.toISOString(),
        };
      });
    },

    /**
     * One turn: ask for a change to the Flow, planned against its current plan and the session's
     * last turns. Without `members` the coworkers offered are the current plan's own. A repeat of a
     * request id answers from its row and never calls the model again.
     */
    async say(
      tenantId: string,
      actor: string,
      flowId: string,
      sessionId: string,
      input: {
        requestId: string;
        modelRef: string;
        prompt: string;
        members?: WakerFlowCandidate[];
      },
    ): Promise<WakerFlowRequestOutcome> {
      const prompt = text(
        input.prompt,
        MAX_PROMPT,
        `修改要求不能超过 ${MAX_PROMPT} 字。`,
      );
      if (!prompt)
        throw new FlowSessionError(400, "请写下要怎么修改这个流程。");
      // The turn's own column is a model library id; the deployment's model is not one.
      if (!isUuid(input.modelRef))
        throw new FlowSessionError(400, "请选择可用的模型。");
      if (!isUuid(sessionId))
        throw new FlowSessionError(404, SESSION_NOT_FOUND);
      const flow = await flowOf(tenantId, flowId);
      await readSession(tenantId, flowId, sessionId);
      const members =
        input.members ??
        (flow.plan?.members ?? []).map((member) => ({
          agentId: member.agentId,
          name: "",
          role: member.role,
        }));
      const turn: WakerFlowCustomizeTurn = {
        sessionId,
        prepare: async () => {
          await readSession(tenantId, flowId, sessionId);
          const previous = (await turnRows(tenantId, sessionId))
            .slice(-CUSTOMIZATION_TURNS)
            .map<FlowCustomizationTurnSummary>((row) => {
              const status = statusOf(row.status);
              return {
                prompt: row.prompt,
                outcome: outcomeSummary(status, resultOf(status, row.result)),
              };
            });
          // Read again: the plan the model is shown is the one saved now, not when the page loaded.
          const latest = await flowOf(tenantId, flowId);
          return flowCustomizationContext({ plan: latest.plan, previous });
        },
        record: async (tx, context) => {
          await tx.insert(flowCustomizationTurns).values({
            tenantId,
            flowId,
            sessionId,
            requestId: input.requestId,
            fingerprint: digest({
              sessionId,
              prompt,
              modelRef: input.modelRef,
              members,
            }),
            prompt,
            context,
            modelRef: input.modelRef,
            // The column's type is the object shape; the snapshot is an array (CHECK in 0140).
            members: members as unknown as Record<string, unknown>,
          });
          await tx
            .update(flowCustomizationSessions)
            .set({ updatedAt: new Date() })
            .where(own(tenantId, flowId, sessionId));
        },
      };
      return flows.generate(
        tenantId,
        actor,
        flowId,
        {
          requestId: input.requestId,
          modelRef: input.modelRef,
          idea: prompt,
          members,
        },
        turn,
      );
    },
  };
}

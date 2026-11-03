import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  groupTaskRuns,
  groupTaskTemplates,
  tasks,
  wakerFlows,
  wakerGroupMembers,
} from "../db/schema";
import {
  type PipelineStepRow,
  type PipelineStepStateRow,
  stepIsSettled,
} from "../db/schema/pipeline";
import type { QuotaService } from "../quota/limits";
import type { TaskProjector } from "../tasks/projector";
import { runAsTenant } from "../tenant/context";
import { reapAbandonedPipelineRuns } from "./reap";

/**
 * The crew pipeline (ticket 021, spec D10 / I1-I6, ADR-0001 = A).
 *
 * A run is a cursor over a template's steps, and every step that executes becomes a task card under the
 * run's parent card. There is no per-step table on purpose: the card IS the record that a step happened
 * — the same row the person sees on the board — so a second copy would only be a second thing to keep
 * in step with it. The run row snapshots the steps it started with, which is also what makes a resumed
 * run immune to the template being edited in between: the person asked for the plan that existed then.
 *
 * Execution is handed to `executeStep` rather than done here. In production that is the deployment's own
 * unattended turn channel — the same runner, thread lock, transcript and governance gates a routine
 * firing uses — and this file's job is only the sequence: whose turn it is, what it is told, what came
 * back, and whether the run continues.
 */

/**
 * The step shapes are the columns' shapes, aliased rather than restated: the row and the in-memory
 * record are the same object going through a jsonb column, and two declarations of one shape is where
 * they start to disagree.
 */
export type PipelineStep = PipelineStepRow;
export type StepRecord = PipelineStepStateRow;

export type RunOutcome = {
  status: "running" | "awaiting_action" | "done" | "failed" | "aborted";
  cursor: number;
  steps: StepRecord[];
};

/**
 * What one step's turn produced. `awaiting_action` parks the whole run (spec I3), and the cursor stays
 * put so the call after the person handles the approval re-runs THIS step rather than skipping it.
 *
 * `approvalId` is the row the coworker is waiting on, and it is optional because the pipeline is not the
 * only thing that can park a step: a question, or a headless suspension on a durable request id, has no
 * approval row at all (see `routines/runner.ts`, which refuses to use `needs_action` for exactly that
 * reason). Without a row there is nothing for the board's lane to hold, and the store says so by parking
 * only what it can.
 */
export type StepResult =
  | { status: "done"; output: string }
  | { status: "awaiting_action"; approvalId?: string }
  | { status: "failed"; error: string };

/**
 * How the orchestrator asks for one coworker's turn, named so the production channel
 * (`pipeline/turn-channel.ts`) is checked against this contract instead of against a copy that can drift.
 */
export type PipelineStepRunner = (input: {
  tenantId: string;
  agentId: string;
  instruction: string;
  signal?: AbortSignal;
  /** What earlier steps produced, so step 3 is not answering out of thin air (spec I2). */
  prior: string[];
  initiatedBy: string;
  runId: string;
  /**
   * The id this step's card is keyed by, and the id the turn must run under.
   *
   * Not a convenience: the approval machinery parks a board card by the run id the approval was opened
   * with (`approvals/store.ts` -> `board.needsAction({runRef})`), so a step that ran its turn under some
   * other id would park a card that does not exist and leave this one `running` while its own work is
   * waiting on a person. Handing the card's id down is what makes the gate's park land on the card the
   * person is looking at.
   */
  stepRunRef: string;
}) => Promise<StepResult>;

/**
 * A template or run that is not in this workspace.
 *
 * Its own class because the HTTP answer is a 404 and not a 400: spec D15's rule is that another
 * tenant's ids are never confirmed to a caller, and a string comparison in the route layer is how that
 * turns into a 200 with an error in the body the moment somebody rewords the sentence.
 */
export class PipelineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineNotFoundError";
  }
}

/** A template or a step that cannot be run as written — the person can fix this one. */
export class PipelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineValidationError";
  }
}

/**
 * Another template in the same crew already has this name.
 *
 * Its own class because it is a 409, not a 400: the plan is fine as written, it collides with one that
 * exists, and the person's fix is to rename one of the two. The database's unique index is what
 * decides it, because two saves racing each other would both pass a read-then-write check.
 */
export class PipelineNameTakenError extends Error {
  constructor() {
    super("这个小组里已经有一条同名的流程了，换个名字再保存。");
    this.name = "PipelineNameTakenError";
  }
}

/**
 * Turn the unique index's refusal into `PipelineNameTakenError`; anything else is rethrown as is.
 *
 * The state code arrives on the server's error, which drizzle wraps, and Bun reports it as `errno` —
 * the same lookup `waker-groups/store.ts` makes for a crew's name.
 */
function nameTaken(error: unknown): never {
  const violation = error as {
    errno?: unknown;
    code?: unknown;
    cause?: { errno?: unknown; code?: unknown };
  } | null;
  const states = [
    violation?.errno,
    violation?.code,
    violation?.cause?.errno,
    violation?.cause?.code,
  ];
  if (states.some((state) => String(state) === "23505")) {
    throw new PipelineNameTakenError();
  }
  throw error;
}

/**
 * The person who pressed run may not use one or more of the template's coworkers (spec I6).
 *
 * Thrown by `start` before anything is written: no quota is asked, no parent card opens and no run row
 * exists, because a plan whose middle the person cannot run is not a plan they can start. `refused`
 * names every step that stopped it, not just the first, so one answer tells the person everything they
 * have to fix — `index` is the step's position in the template (0-based), `stepId` its id and
 * `agentId` the coworker the person has no use of.
 */
export class PipelineStepForbiddenError extends Error {
  readonly refused: { index: number; stepId: string; agentId: string }[];
  constructor(refused: { index: number; stepId: string; agentId: string }[]) {
    super(
      `第 ${refused.map((step) => step.index + 1).join("、")} 步的员工（${[
        ...new Set(refused.map((step) => step.agentId)),
      ].join(
        "、",
      )}）你没有使用权，这次没有派出去。先给这些员工开通使用权，或把模板里的这几步换成你能用的员工，再运行。`,
    );
    this.name = "PipelineStepForbiddenError";
    this.refused = refused;
  }
}

/** How many steps one template may hold. A pipeline is a machine for spending turns, so the number that
 * bounds it has to live somewhere other than the person's patience. */
const MAX_STEPS = 10;

/** `groupTaskTemplates.group_id` is a uuid, and Postgres answers a malformed one with a 22P02 that
 * reaches the person as a 500. Ask about the shape before the database does. */
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * The WakerFlow that compiled this template's crew, if any (spec D10).
 *
 * A Flow's crew and templates are its compiled form, not a crew a person arranged: the generic
 * pipeline API must not list them, add steps to them, or start them behind the Flow's back.
 */
const owningFlow = () =>
  sql<
    string | null
  >`(select ${wakerFlows.id} from ${wakerFlows} where ${wakerFlows.groupId} = ${groupTaskTemplates.groupId} limit 1)`;

type RunRow = {
  id: string;
  parentTaskId: string | null;
  parentRunRef: string | null;
  cursor: number;
  status: string;
  steps: StepRecord[];
  initiatedBy: string | null;
  instruction: string;
  revision: number;
  advanceOwner: string | null;
  inputs: Record<string, string>;
};

export function createPipelineStore(options: {
  database: Database;
  board: TaskProjector;
  /**
   * Run one coworker's turn on the deployment's existing unattended channel.
   *
   * Injectable because the pipeline is the first caller that asks for a turn from outside a run, and the
   * whole point of ADR-0001's option A is that it goes through the gates rather than around them: the
   * sequence is tested here, the channel's own suites test the governance.
   */
  executeStep: PipelineStepRunner;
  /**
   * Spec I6: may THIS person use THIS coworker? Never substituted, never run as the platform.
   *
   * Asked with the run's initiator — the person who pressed run, as recorded on the run row — and not
   * with the workspace id: "who may dispatch" is a question about a person, and a workspace default is
   * how it quietly becomes "anyone in here may". Asked for every step before the run opens anything,
   * and again for each step as it is reached, because a use can be revoked while a run is in flight.
   */
  canUse: (initiatedBy: string, agentId: string) => Promise<boolean>;
  /**
   * The monthly ceiling, asked before the run opens anything (spec 022's rule: refuse before the work,
   * not after). Optional because a deployment without plans still runs pipelines.
   */
  quota?: QuotaService;
  newRunId?: () => string;
}) {
  const { database, board, executeStep, canUse } = options;
  const newRunId = options.newRunId ?? (() => randomUUID());

  const selectRun = (tenantId: string, runId: string) =>
    database
      .select({
        id: groupTaskRuns.id,
        parentTaskId: groupTaskRuns.parentTaskId,
        cursor: groupTaskRuns.cursor,
        status: groupTaskRuns.status,
        steps: groupTaskRuns.steps,
        initiatedBy: groupTaskRuns.initiatedBy,
        revision: groupTaskRuns.revision,
        advanceOwner: groupTaskRuns.advanceOwner,
        inputs: groupTaskRuns.inputs,
      })
      .from(groupTaskRuns)
      .where(
        and(eq(groupTaskRuns.tenantId, tenantId), eq(groupTaskRuns.id, runId)),
      )
      .limit(1);

  async function readRun(
    tenantId: string,
    runId: string,
  ): Promise<RunRow | null> {
    const [row] = await runAsTenant(tenantId, async () =>
      selectRun(tenantId, runId),
    );
    if (!row) return null;
    const steps = Array.isArray(row.steps) ? (row.steps as StepRecord[]) : [];
    /*
     * The task text lives on the parent card, which is where the person reads it: a second copy on the
     * run row is one more thing that can disagree with the board. The parent's run reference is the run
     * id itself (see `start`), so it needs no lookup at all.
     */
    const [card] = row.parentTaskId
      ? await runAsTenant(tenantId, async () =>
          database
            .select({ title: tasks.title })
            .from(tasks)
            .where(eq(tasks.id, row.parentTaskId as string))
            .limit(1),
        )
      : [];
    return {
      id: row.id,
      parentTaskId: row.parentTaskId ?? null,
      parentRunRef: row.parentTaskId ? row.id : null,
      cursor: row.cursor,
      status: row.status,
      steps,
      initiatedBy: row.initiatedBy ?? null,
      instruction: card?.title ?? "",
      revision: row.revision,
      advanceOwner: row.advanceOwner,
      inputs: row.inputs,
    };
  }

  async function writeRun(
    tenantId: string,
    runId: string,
    patch: Partial<{
      cursor: number;
      status: string;
      steps: StepRecord[];
    }>,
    expected: RunRow,
    owner?: string,
  ) {
    const [updated] = await runAsTenant(tenantId, async () => {
      return await database
        .update(groupTaskRuns)
        .set({
          ...patch,
          ...(owner ? {} : { advanceOwner: null }),
          revision: sql`${groupTaskRuns.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(groupTaskRuns.tenantId, tenantId),
            eq(groupTaskRuns.id, runId),
            eq(groupTaskRuns.revision, expected.revision),
            sql`${groupTaskRuns.status} not in ('done', 'failed', 'aborted')`,
            ...(owner ? [eq(groupTaskRuns.advanceOwner, owner)] : []),
          ),
        )
        .returning({ revision: groupTaskRuns.revision });
    });
    if (!updated) return false;
    expected.revision = updated.revision;
    if (patch.status !== undefined) expected.status = patch.status;
    return true;
  }

  const outcome = (run: RunRow): RunOutcome => ({
    status: run.status as RunOutcome["status"],
    cursor: run.cursor,
    steps: run.steps,
  });
  const terminal = (run: RunRow) =>
    ["done", "failed", "aborted"].includes(run.status);
  async function currentOutcome(tenantId: string, runId: string) {
    const run = await readRun(tenantId, runId);
    if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
    return outcome(run);
  }

  async function closeCard(
    tenantId: string,
    runRef: string,
    failed: boolean,
    pipelineRunId?: string,
  ) {
    if (!runRef) return;
    await board
      .finished({
        tenantId,
        runRef,
        failed,
        ...(pipelineRunId ? { pipelineRunId } : {}),
      })
      .catch(() => undefined);
  }

  /** The card the whole run hangs under: done with the crew's work, or failed with it. */
  async function closeParent(run: RunRow, tenantId: string, failed: boolean) {
    if (run.parentRunRef)
      await closeCard(
        tenantId,
        run.parentRunRef,
        failed,
        failed ? undefined : run.id,
      );
  }

  /**
   * Whether a template may be saved as written, for a create and an edit alike — one set of rules,
   * because an edit that skipped one of them would be the way around it. Answers the name to store.
   */
  async function validateTemplate(input: {
    tenantId: string;
    groupId: string;
    name: string;
    steps: PipelineStep[];
  }): Promise<string> {
    if (input.steps.length === 0) {
      throw new PipelineValidationError("没有步骤的流水线跑不了任何东西。");
    }
    if (input.steps.length > MAX_STEPS) {
      throw new PipelineValidationError(
        `一条流水线最多 ${MAX_STEPS} 步，这条写了 ${input.steps.length} 步。`,
      );
    }
    for (const step of input.steps) {
      if (!step.id || !step.agentId || !step.instruction.trim()) {
        throw new PipelineValidationError(
          "每一步都要有编号、一位员工，和它要做的事。",
        );
      }
    }
    if (
      new Set(input.steps.map((step) => step.id)).size !== input.steps.length
    ) {
      throw new PipelineValidationError(
        "两个步骤用了同一个编号，跳过和恢复就分不清是哪一步了。",
      );
    }
    const name = input.name.trim();
    if (!name) {
      throw new PipelineValidationError("给这条流程起个名字。");
    }
    if (!isUuid(input.groupId)) {
      throw new PipelineValidationError(
        "流程要写给一个小组，得先从「员工 › 小组」里挑一个。",
      );
    }
    const [flowOwned] = await runAsTenant(input.tenantId, async () =>
      database
        .select({ id: wakerFlows.id })
        .from(wakerFlows)
        .where(eq(wakerFlows.groupId, input.groupId))
        .limit(1),
    );
    if (flowOwned) {
      throw new PipelineValidationError(
        "这个小组属于 WakerFlow 内部，只能在 WakerFlow 里编辑它的流程。",
      );
    }
    /*
     * Every step goes to somebody IN this crew — the promise the pipeline screen makes in its own
     * description, so it is checked here rather than left to the picker. Reading the roster under the
     * caller's tenant scope means a crew that is not theirs comes back empty, which is the same answer
     * as a crew with no members and the right one for both.
     */
    const roster = await runAsTenant(input.tenantId, async () =>
      database
        .select({ agentId: wakerGroupMembers.agentId })
        .from(wakerGroupMembers)
        .where(eq(wakerGroupMembers.groupId, input.groupId)),
    );
    if (roster.length === 0) {
      throw new PipelineValidationError(
        "这个小组里还没有员工。先到「员工 › 小组」把人加进去，再来排流程。",
      );
    }
    if (
      input.steps.some(
        (step) => !roster.some((row) => row.agentId === step.agentId),
      )
    ) {
      throw new PipelineValidationError(
        "流程里有步骤交给了组外的员工。每一步的员工都得在这个小组里。",
      );
    }
    return name;
  }

  /**
   * One template of this workspace, or null — a malformed id is "not here", not a cast error. A
   * WakerFlow's compiled template is not here either (spec D10): it is edited only through its Flow.
   */
  async function readTemplate(tenantId: string, templateId: string) {
    if (!isUuid(templateId)) return null;
    const [row] = await runAsTenant(tenantId, async () =>
      database
        .select({
          id: groupTaskTemplates.id,
          groupId: groupTaskTemplates.groupId,
        })
        .from(groupTaskTemplates)
        .where(
          and(
            eq(groupTaskTemplates.tenantId, tenantId),
            eq(groupTaskTemplates.id, templateId),
            isNull(owningFlow()),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  }

  /*
   * Named rather than returned inline, because `resume` has to reach the same driving loop `advance`
   * is — and a resumed crew is exactly the case where two copies of that loop would drift into running
   * one step twice.
   */
  const store = {
    async createTemplate(input: {
      tenantId: string;
      groupId: string;
      name: string;
      steps: PipelineStep[];
      createdBy?: string;
    }): Promise<string> {
      const name = await validateTemplate(input);
      const [row] = await runAsTenant(input.tenantId, async () =>
        database
          .insert(groupTaskTemplates)
          .values({
            tenantId: input.tenantId,
            groupId: input.groupId,
            name,
            steps: input.steps,
            createdBy: input.createdBy ?? null,
          })
          .returning({ id: groupTaskTemplates.id }),
      ).catch(nameTaken);
      // biome-ignore lint/style/noNonNullAssertion: an INSERT with RETURNING answers with the row it wrote
      return row!.id;
    },

    /**
     * Rewrite a template's name and steps (spec I1: the plan is the person's to change).
     *
     * The crew is NOT editable: it is read from the stored row, never from the request, because a
     * template's steps were validated against that crew's roster and moving it would be a second way to
     * hand a step to somebody outside it. The same checks `createTemplate` makes are made here, against
     * the same crew, so an edit cannot save a plan a create would have refused.
     *
     * Runs already started are untouched by design: each one snapshotted its steps when it started
     * (`start`), so a person who reworded step 2 has changed the next press, not last hour's work. And
     * the edit grants nothing — whoever presses run next is asked spec I6's question about every step of
     * the edited plan at `start`, and again per step as the run reaches it.
     */
    async updateTemplate(input: {
      tenantId: string;
      templateId: string;
      name: string;
      steps: PipelineStep[];
    }): Promise<void> {
      const current = await readTemplate(input.tenantId, input.templateId);
      if (!current) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const name = await validateTemplate({
        tenantId: input.tenantId,
        groupId: current.groupId,
        name: input.name,
        steps: input.steps,
      });
      const [row] = await runAsTenant(input.tenantId, async () =>
        database
          .update(groupTaskTemplates)
          .set({ name, steps: input.steps, updatedAt: new Date() })
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              eq(groupTaskTemplates.id, input.templateId),
            ),
          )
          .returning({ id: groupTaskTemplates.id }),
      ).catch(nameTaken);
      // Deleted between the read and the write: the same answer as never having been here.
      if (!row) throw new PipelineNotFoundError("这个工作区里没有这条模板。");
    },

    /**
     * Throw a template away. The runs it started are kept, and one still in flight keeps going.
     *
     * Nothing here touches `group_task_runs`: the column is `ON DELETE SET NULL` (migration 0076), and
     * a run never reads its template after `start` — it advances from the steps it snapshotted. So a
     * delete in the middle of a run only forgets which recipe the run came from, which is the point of
     * tidying a recipe away.
     */
    async deleteTemplate(input: {
      tenantId: string;
      templateId: string;
    }): Promise<void> {
      if (!isUuid(input.templateId)) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const [row] = await runAsTenant(input.tenantId, async () =>
        database
          .delete(groupTaskTemplates)
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              eq(groupTaskTemplates.id, input.templateId),
              // A WakerFlow's compiled template goes away with its Flow, never on its own (spec D10).
              isNull(owningFlow()),
            ),
          )
          .returning({ id: groupTaskTemplates.id }),
      );
      if (!row) throw new PipelineNotFoundError("这个工作区里没有这条模板。");
    },

    /**
     * The templates this workspace can run, newest first.
     *
     * Read per group because the crew page is where a person picks one: "编程小组 有三个流程" is the
     * question, and a deployment-wide list would answer a different one.
     */
    async listTemplates(input: { tenantId: string; groupId?: string }): Promise<
      {
        id: string;
        groupId: string;
        name: string;
        steps: PipelineStep[];
        createdAt: Date;
      }[]
    > {
      return runAsTenant(input.tenantId, async () =>
        database
          .select({
            id: groupTaskTemplates.id,
            groupId: groupTaskTemplates.groupId,
            name: groupTaskTemplates.name,
            steps: groupTaskTemplates.steps,
            createdAt: groupTaskTemplates.createdAt,
          })
          .from(groupTaskTemplates)
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              input.groupId
                ? eq(groupTaskTemplates.groupId, input.groupId)
                : undefined,
              isNull(owningFlow()),
            ),
          )
          .orderBy(desc(groupTaskTemplates.createdAt)),
      );
    },

    /**
     * Put a task in front of the crew and get the card that owns it.
     *
     * Every step's coworker is checked against the person who pressed run before anything is written
     * (spec I6): a refusal is answered to that person right away, as `PipelineStepForbiddenError`
     * naming the steps, rather than as a card that opens and fails — the answer is not silent, it is
     * the response to the press. Once the check passes, the parent card opens before any step runs, so
     * a coworker revoked mid-run still leaves the run's failure on the board (the silent-failure shape
     * ticket 030 closed for chat).
     */
    async start(input: {
      tenantId: string;
      templateId: string;
      task: string;
      initiatedBy: string;
      inputs?: Record<string, string>;
      flowId?: string;
      runId?: string;
    }): Promise<{ runId: string; parentTaskId: string }> {
      // A malformed id is "not here" (spec D15), the same answer edit and delete give, not a cast error.
      if (!isUuid(input.templateId)) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const template = await runAsTenant(input.tenantId, async () => {
        const [row] = await database
          .select({
            steps: groupTaskTemplates.steps,
            groupId: groupTaskTemplates.groupId,
            flowId: owningFlow(),
          })
          .from(groupTaskTemplates)
          .where(
            and(
              eq(groupTaskTemplates.tenantId, input.tenantId),
              eq(groupTaskTemplates.id, input.templateId),
            ),
          )
          .limit(1);
        return row ?? null;
      });
      // A Flow's template runs only as that Flow's run; to everyone else it is not here.
      if (!template || (template.flowId && template.flowId !== input.flowId)) {
        throw new PipelineNotFoundError("这个工作区里没有这条模板。");
      }
      const declared = Array.isArray(template.steps)
        ? (template.steps as PipelineStep[])
        : [];
      if (declared.length > MAX_STEPS) {
        throw new PipelineValidationError(
          `一条流水线最多 ${MAX_STEPS} 步，这条有 ${declared.length} 步。`,
        );
      }
      /*
       * Spec I6, asked for the whole plan before any of it is dispatched: may the person who pressed run
       * use EVERY coworker the template names? Being in the crew grants nothing. A refusal here writes
       * nothing at all — no quota spent, no parent card, no run row — and names every step that stopped
       * it, because a run that opened and then failed on step 2 would have run step 1 for a plan the
       * person could never finish. A check that errors counts as a refusal: failing open is how a
       * flaky lookup becomes "the platform ran it anyway".
       */
      const refused: { index: number; stepId: string; agentId: string }[] = [];
      for (const [index, step] of declared.entries()) {
        const allowed = await canUse(input.initiatedBy, step.agentId).catch(
          () => false,
        );
        if (!allowed) {
          refused.push({ index, stepId: step.id, agentId: step.agentId });
        }
      }
      if (refused.length > 0) throw new PipelineStepForbiddenError(refused);
      /*
       * The ceiling is asked before anything is opened or run, because a pipeline is a machine for
       * spending: one press starts N turns. A refusal after the first card would charge for work that
       * happened (ticket 022's rule, restated in `tasks/projector.ts`), and a template of a hundred
       * steps is a hundred cards a month nobody agreed to.
       */
      await options.quota?.assertCapacity(input.tenantId, "tasksPerMonth");
      await options.quota?.assertCapacity(
        input.tenantId,
        "tasksPerMonth",
        declared.length + 1,
      );
      /*
       * The run id IS the parent card's run reference. The parent stands for this run rather than for
       * any turn, so borrowing one of the steps' ids would be wrong and minting a second one makes
       * "is this run already on the board" a question with two answers -- the design doc's phrasing, and
       * the reason a re-run of the same id cannot open a second parent card.
       */
      const runId = input.runId ?? newRunId();
      const parentTaskId = await board.opened({
        tenantId: input.tenantId,
        title: input.task,
        // No executor on the parent, on purpose. Each step's card names its own coworker, and the
        // ask above them belongs to the group as a whole — which is not a coworker. The group's id
        // used to go in this column, and the board then drew that uuid as an employee's name and
        // filtered the card out of every `executors=` view.
        source: "group_run",
        runRef: runId,
        quotaUnits: declared.length + 1,
      });

      await runAsTenant(input.tenantId, async () => {
        await database.insert(groupTaskRuns).values({
          id: runId,
          tenantId: input.tenantId,
          templateId: input.templateId,
          groupId: template.groupId,
          parentTaskId,
          status: "running",
          cursor: 0,
          steps: declared.map<StepRecord>((step) => ({
            ...step,
            state: "pending",
          })),
          initiatedBy: input.initiatedBy,
          inputs: input.inputs ?? {},
          flowId: input.flowId ?? null,
        });
      });
      return { runId, parentTaskId };
    },

    /**
     * Run steps from the cursor until the run stops, and report where it stopped.
     *
     * One step's failure ends the run rather than being stepped over: a review of a deliverable that
     * was never produced is worse than no review, and every later instruction was written against the
     * output the failed step did not give it. Skipping is a separate, deliberate act (spec I4).
     */
    async advance(input: {
      tenantId: string;
      runId: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      const records = [...run.steps];
      /*
       * A run that has stopped stays stopped. `advance` is called by whoever holds the request or the
       * resume, and two arriving for one run must not produce two sets of step cards or close a reviewed
       * parent a second time. The terminal check handles later retries; the database claim below
       * handles competing drivers while execution is still in flight.
       */
      if (
        run.status === "done" ||
        run.status === "failed" ||
        run.status === "aborted"
      ) {
        return {
          status: run.status as RunOutcome["status"],
          cursor: run.cursor,
          steps: records,
        };
      }
      let cursor = run.cursor;
      /*
       * Whose authority each step runs under: the person recorded on the run row when it started, never
       * the workspace or the caller of this method. A run with no initiator on record cannot answer
       * spec I6's question, so its next step is refused rather than run on somebody's default.
       */
      const initiator = run.initiatedBy;
      /*
       * A run parked on a person stays parked until that person's answer is delivered.
       *
       * `advance` is not the door for it: the step that stopped is in the middle of a turn the approval
       * machinery is resuming, so driving it again from here would ask the coworker a second time — a
       * second model spend, a second card answer, and a duplicate of anything the first turn already
       * wrote to the world. `resume` is the door, and it carries what that resumed turn produced.
       */
      if (run.status === "awaiting_action") {
        return {
          status: "awaiting_action",
          cursor: run.cursor,
          steps: records,
        };
      }
      const owner = randomUUID();
      const [claimed] = await runAsTenant(input.tenantId, async () =>
        database
          .update(groupTaskRuns)
          .set({
            advanceOwner: owner,
            revision: sql`${groupTaskRuns.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(groupTaskRuns.tenantId, input.tenantId),
              eq(groupTaskRuns.id, input.runId),
              eq(groupTaskRuns.status, "running"),
              eq(groupTaskRuns.revision, run.revision),
              isNull(groupTaskRuns.advanceOwner),
            ),
          )
          .returning({ revision: groupTaskRuns.revision }),
      );
      if (!claimed) return currentOutcome(input.tenantId, input.runId);
      run.revision = claimed.revision;
      const controller = new AbortController();
      let lastHeartbeatAt = Date.now();
      let releaseOwner = true;
      let heartbeatWork: Promise<unknown> | undefined;
      const heartbeat = setInterval(() => {
        if (heartbeatWork) return;
        heartbeatWork = runAsTenant(input.tenantId, async () => {
          const [current] = await database
            .select({
              owner: groupTaskRuns.advanceOwner,
              status: groupTaskRuns.status,
            })
            .from(groupTaskRuns)
            .where(
              and(
                eq(groupTaskRuns.tenantId, input.tenantId),
                eq(groupTaskRuns.id, input.runId),
              ),
            )
            .limit(1);
          if (
            !current ||
            current.owner !== owner ||
            current.status !== "running"
          ) {
            controller.abort();
            return;
          }
          if (Date.now() - lastHeartbeatAt < 30_000) return;
          lastHeartbeatAt = Date.now();
          await database
            .update(groupTaskRuns)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(groupTaskRuns.tenantId, input.tenantId),
                eq(groupTaskRuns.id, input.runId),
                eq(groupTaskRuns.advanceOwner, owner),
                eq(groupTaskRuns.status, "running"),
              ),
            );
        })
          .catch(() => undefined)
          .finally(() => {
            heartbeatWork = undefined;
          });
      }, 500);
      try {
        const prior: string[] = records
          .map((record) => record.output)
          .filter((output): output is string => typeof output === "string");
        /*
         * Which steps did not produce what they were asked to. A later instruction has to say so rather
         * than omit the gap: a summary that quietly ignores a skipped review will report on a deliverable
         * nobody reviewed, and the person reading it has no way to tell (spec I4's skip is a deliberate
         * act, not an erasure).
         */
        const missing = records
          .filter(
            (record) => record.state === "skipped" || record.state === "failed",
          )
          .map((record) => record.id);

        while (cursor < records.length) {
          // A control request may have won while the previous card projection was settling.
          if (!(await writeRun(input.tenantId, input.runId, {}, run, owner))) {
            return currentOutcome(input.tenantId, input.runId);
          }
          // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
          const record = records[cursor]!;
          const allowed =
            initiator !== null &&
            (await canUse(initiator, record.agentId).catch(() => false));
          if (initiator === null || !allowed) {
            /*
             * Spec I6, and the shape of the answer is the point: the run stops naming the coworker it
             * stopped on. Choosing another member of the crew, or running as the deployment's own Bot, is
             * how "this person may not use this coworker" quietly becomes "the platform ran it anyway" —
             * the boundary D11 was drawn to hold.
             */
            records[cursor] = {
              ...record,
              state: "failed",
              /*
               * In the person's language, and naming the coworker it stopped on.
               *
               * This sentence is stored on the step and read on the run's own view, so it is content
               * rather than protocol. The id stays because the person's next action is to go grant that
               * one coworker — "无权限" alone would be a dead end.
               */
              error:
                initiator === null
                  ? `这次运行没有记录发起人，无法核对谁能用 ${record.agentId}，所以第 ${cursor + 1} 步没有执行。`
                  : `${record.agentId} 你没有使用权，所以第 ${cursor + 1} 步没有执行。`,
            };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  status: "failed",
                  steps: records,
                },
                run,
                owner,
              ))
            ) {
              return currentOutcome(input.tenantId, input.runId);
            }
            await closeParent(run, input.tenantId, true);
            return { status: "failed", cursor, steps: records };
          }

          /*
           * A step that parked keeps its card, because the resume is the SAME turn finishing, not a new
           * one: the channel replays the approved action inside the run that asked (that is what
           * `approval.resume` does), so minting a second run reference here would leave the first card on
           * the board still asking a question that has been answered, next to a twin doing the work.
           */
          const runRef = record.runRef ?? newRunId();
          const taskId =
            record.taskId ??
            (await board.opened({
              tenantId: input.tenantId,
              title: record.instruction,
              executorAgentId: record.agentId,
              source: "group_run",
              runRef,
              parentTaskId: run.parentTaskId ?? undefined,
            }));
          records[cursor] = {
            ...record,
            state: "running",
            runRef,
            taskId,
            // The park is over — whether the person approved or the queue is simply driving the step again.
            // Leaving it would make the run claim to be waiting on a decision that has been made.
            approvalId: undefined,
          };
          if (
            !(await writeRun(
              input.tenantId,
              input.runId,
              {
                cursor,
                status: "running",
                steps: records,
              },
              run,
              owner,
            ))
          ) {
            // Abort can win while the card is opening. Close that late card and never invoke the step.
            await closeCard(input.tenantId, runRef, true);
            return currentOutcome(input.tenantId, input.runId);
          }

          const result = await executeStep({
            tenantId: input.tenantId,
            agentId: record.agentId,
            instruction: `${record.instruction}\n\n任务：${run.instruction}${
              record.inputKeys
                ? `\n\n此步骤的输入：\n${JSON.stringify(Object.fromEntries(record.inputKeys.map((key) => [key, run.inputs[key] ?? records.slice(0, cursor).find((step) => step.outputKey === key)?.output ?? "（此输入未产生）"])))}`
                : prior.length > 0
                  ? `\n\n前面步骤的产出：\n${prior
                      .map((line, index) => `${index + 1}. ${line}`)
                      .join("\n")}`
                  : ""
            }${
              missing.length > 0
                ? `\n\n注意：${missing.join("、")} 这几步没有产出（被跳过或已失败），下面的结论里不要假装它们发生过。`
                : ""
            }`,
            prior: record.inputKeys
              ? record.inputKeys.map(
                  (key) =>
                    run.inputs[key] ??
                    records
                      .slice(0, cursor)
                      .find((step) => step.outputKey === key)?.output ??
                    "（此输入未产生）",
                )
              : prior,
            initiatedBy: initiator,
            runId: input.runId,
            stepRunRef: runRef,
            signal: controller.signal,
          });

          if (result.status === "done") {
            records[cursor] = {
              // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
              ...records[cursor]!,
              state: "done",
              output: result.output,
            };
            prior.push(result.output);
            cursor += 1;
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  steps: records,
                  status: cursor >= records.length ? "done" : "running",
                },
                run,
                owner,
              ))
            ) {
              return currentOutcome(input.tenantId, input.runId);
            }
            await closeCard(input.tenantId, runRef, false, input.runId);
            continue;
          }

          if (result.status === "awaiting_action") {
            const approvalId = result.approvalId;
            records[cursor] = {
              // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
              ...records[cursor]!,
              state: "awaiting_action",
              ...(approvalId ? { approvalId } : {}),
            };
            if (
              !(await writeRun(
                input.tenantId,
                input.runId,
                {
                  cursor,
                  status: "awaiting_action",
                  steps: records,
                },
                run,
                owner,
              ))
            ) {
              return currentOutcome(input.tenantId, input.runId);
            }
            /*
             * Spec I3: the parent hangs in the attention region while a step waits.
             *
             * The step's own card is parked by the gate that opened the approval, which keys on the turn's
             * run id — that is why `executeStep` is handed `stepRunRef`. The parent has no turn of its own
             * to be parked against, so this is the one place the run itself says "nobody is working, this
             * is waiting on you". Both cards carry the same approval row, and `resumed` matches on that row
             * rather than on a run id, so the person's single answer moves both back at once.
             *
             * With no approval row there is nothing to hold a card against, and `needs_action` would be a
             * lane promising a decision that cannot be made — the mistake `routines/runner.ts` names for a
             * headless suspension. The run row still carries the parked cursor either way.
             */
            if (approvalId) {
              if (run.parentRunRef) {
                await board
                  .needsAction({
                    tenantId: input.tenantId,
                    runRef: run.parentRunRef,
                    approvalId,
                    pipelineRunId: input.runId,
                  })
                  .catch(() => undefined);
              }
              await board
                .needsAction({
                  tenantId: input.tenantId,
                  runRef,
                  approvalId,
                  pipelineRunId: input.runId,
                })
                .catch(() => undefined);
            }
            return currentOutcome(input.tenantId, input.runId);
          }

          records[cursor] = {
            // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
            ...records[cursor]!,
            state: "failed",
            error: result.error,
          };
          if (
            !(await writeRun(
              input.tenantId,
              input.runId,
              {
                cursor,
                status: "failed",
                steps: records,
              },
              run,
              owner,
            ))
          ) {
            return currentOutcome(input.tenantId, input.runId);
          }
          await closeCard(input.tenantId, runRef, true);
          await closeParent(run, input.tenantId, true);
          return { status: "failed", cursor, steps: records };
        }

        if (
          run.status !== "done" &&
          !(await writeRun(
            input.tenantId,
            input.runId,
            {
              status: "done",
              steps: records,
            },
            run,
            owner,
          ))
        ) {
          return currentOutcome(input.tenantId, input.runId);
        }
        await closeParent(run, input.tenantId, false);
        return { status: "done", cursor, steps: records };
      } catch (error) {
        if (controller.signal.aborted)
          return currentOutcome(input.tenantId, input.runId);
        // Execution may already have written to the world. Keep the claim for the reaper instead of
        // letting a retry repeat a turn whose outcome is unknown.
        releaseOwner = false;
        throw error;
      } finally {
        clearInterval(heartbeat);
        await heartbeatWork;
        if (releaseOwner) {
          await runAsTenant(input.tenantId, async () => {
            await database
              .update(groupTaskRuns)
              .set({ advanceOwner: null })
              .where(
                and(
                  eq(groupTaskRuns.tenantId, input.tenantId),
                  eq(groupTaskRuns.id, input.runId),
                  eq(groupTaskRuns.advanceOwner, owner),
                ),
              );
          });
        }
      }
    },

    /**
     * Move past a step without running it (spec I4), recorded as skipped rather than cleared so the run
     * says afterwards what it did not do. Skipping the step the cursor is on is what unblocks a park.
     */
    async skip(input: {
      tenantId: string;
      runId: string;
      stepId?: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      if (terminal(run)) return outcome(run);
      const records = [...run.steps];
      const at = input.stepId
        ? records.findIndex((record) => record.id === input.stepId)
        : run.cursor;
      if (at < 0 || at >= records.length) {
        throw new PipelineValidationError("这次运行里没有这一步。");
      }
      // biome-ignore lint/style/noNonNullAssertion: the loop condition is this array's own length
      const closed = records[at]!;
      if (run.advanceOwner && at !== run.cursor) {
        throw new PipelineValidationError(
          "运行中的流程只能跳过当前步骤。请等它停下再编辑后续步骤。",
        );
      }
      records[at] = { ...closed, state: "skipped" };
      const cursor = at === run.cursor ? run.cursor + 1 : run.cursor;
      const done = cursor >= records.length;
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          {
            cursor,
            steps: records,
            status: done ? "done" : at === run.cursor ? "running" : run.status,
          },
          run,
        ))
      ) {
        return currentOutcome(input.tenantId, input.runId);
      }
      if (closed.runRef && closed.state !== "done") {
        await closeCard(input.tenantId, closed.runRef, false, input.runId);
      }
      if (done) await closeParent(run, input.tenantId, false);
      return {
        status: done
          ? "done"
          : at === run.cursor
            ? "running"
            : (run.status as RunOutcome["status"]),
        cursor,
        steps: records,
      };
    },

    /**
     * Stop the run and say so on the board: everything still open is closed as failed rather than left
     * `running` for a sweep to find (spec I4, and the same stranding ticket 032 fixed for hops).
     */
    async abort(input: {
      tenantId: string;
      runId: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      if (terminal(run)) return outcome(run);
      const records = run.steps.map((record) =>
        stepIsSettled(record.state)
          ? record
          : { ...record, state: "aborted" as const },
      );
      /*
       * Anything still open is closed, and "still open" includes the step parked on an approval: the
       * person has just said the run is over, so a card asking them to decide something they have
       * cancelled is the stranding ticket 032 removed from hops, in a new place. Awaiting each close
       * rather than firing it off, because "aborted" that leaves a card asking is only half reported.
       */
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          {
            cursor: records.length,
            status: "aborted",
            steps: records,
          },
          run,
        ))
      ) {
        return store.abort(input);
      }
      for (const record of run.steps) {
        if (record.runRef) {
          await board
            .finished({
              tenantId: input.tenantId,
              runRef: record.runRef,
              failed: true,
              onlyUnsettled: true,
            })
            .catch(() => undefined);
        }
      }
      await closeParent(run, input.tenantId, true);
      return { status: "aborted", cursor: records.length, steps: records };
    },

    async inspect(input: { tenantId: string; runId: string }) {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) return null;
      return {
        status: run.status,
        cursor: run.cursor,
        steps: run.steps,
        parentTaskId: run.parentTaskId,
        inputs: run.inputs,
      };
    },

    /**
     * Deliver the answer a parked step was waiting on, and carry the run on from there.
     *
     * This is spec I3's second half. The approval machinery resumes the coworker's own turn — the
     * person's decision belongs to that turn, not to the crew — so what reaches the pipeline is what
     * that resumed turn finally said, and the run's job is to record it and take the next step.
     *
     * Not a re-run: the step's card keeps its reference and its output comes from here, which is what
     * makes design test #2's assertion ("the parked step is not run again") true rather than merely
     * likely. It is also the only shape that cannot spend a second turn and write to the world twice
     * for one question.
     */
    async resume(input: {
      tenantId: string;
      runId: string;
      /** What the resumed turn finally answered. Absent with `error` when the person said no. */
      output?: string;
      /** Why the step did not produce one: declined, or the replayed turn failed. */
      error?: string;
    }): Promise<RunOutcome> {
      const run = await readRun(input.tenantId, input.runId);
      if (!run) throw new PipelineNotFoundError("这个工作区里没有这次运行。");
      const records = [...run.steps];
      const cursor = run.cursor;
      const parked = records[cursor];
      /*
       * A run that is not parked answers nothing.
       *
       * The approval queue retries, and an answer can be delivered twice; the second one arriving after
       * the crew already moved on must not file a second card for the step or overwrite the output the
       * next one produced.
       */
      if (run.status !== "awaiting_action" || !parked) {
        return {
          status: run.status as RunOutcome["status"],
          cursor,
          steps: records,
        };
      }

      if (input.error) {
        records[cursor] = {
          ...parked,
          state: "failed",
          error: input.error,
          approvalId: undefined,
        };
        if (
          !(await writeRun(
            input.tenantId,
            input.runId,
            {
              cursor,
              status: "failed",
              steps: records,
            },
            run,
          ))
        ) {
          return currentOutcome(input.tenantId, input.runId);
        }
        if (parked.runRef) {
          await closeCard(input.tenantId, parked.runRef, true);
        }
        await closeParent(run, input.tenantId, true);
        return { status: "failed", cursor, steps: records };
      }

      const output = input.output ?? "";
      records[cursor] = {
        ...parked,
        state: "done",
        output,
        approvalId: undefined,
      };
      const next = cursor + 1;
      if (
        !(await writeRun(
          input.tenantId,
          input.runId,
          {
            cursor: next,
            steps: records,
            status: next >= records.length ? "done" : "running",
          },
          run,
        ))
      ) {
        return currentOutcome(input.tenantId, input.runId);
      }
      if (parked.runRef)
        await closeCard(input.tenantId, parked.runRef, false, input.runId);
      /*
       * Then the rest of the plan, through the same door the first press used.
       *
       * The guard at the top of `advance` now lets this one through: the run's status was just moved
       * off `awaiting_action`, which is the fact that says a person is no longer being asked.
       */
      if (next < records.length) {
        return store.advance({
          tenantId: input.tenantId,
          runId: input.runId,
        });
      }
      await closeParent(run, input.tenantId, false);
      return { status: "done", cursor: next, steps: records };
    },

    /**
     * Which run, if any, is waiting on this approval.
     *
     * Asked by the approval machinery's resume path rather than by the screen: a person answers in the
     * approvals region, nothing there knows a crew is running, and a step that stayed parked because
     * nobody could tell the run it belonged to is spec I3's "处理后流水线从该步继续" left half-done —
     * the coworker's turn resumes, and the sequence after it does not.
     *
     * Read in the platform frame because that is the frame the resume runs in, and a sweep that can
     * only see its own tenant's rows would find nothing and say so confidently.
     */
    async runHoldingApproval(input: {
      approvalId: string;
    }): Promise<{ tenantId: string; runId: string } | null> {
      const [row] = await runAsTenant("platform", async () =>
        database
          .select({ id: groupTaskRuns.id, tenantId: groupTaskRuns.tenantId })
          .from(groupTaskRuns)
          .where(
            and(
              eq(groupTaskRuns.status, "awaiting_action"),
              /*
               * "Some step of this run recorded this approval", asked of the array's elements.
               *
               * Not the shorter-looking `steps @> ($1::jsonb)`: the driver sends a string parameter, and
               * by the time it reaches Postgres the value has been encoded as a JSON scalar rather than
               * the array the operator wants, so the containment answers false on rows that plainly
               * match. Measured, not guessed -- and the same double-encoding the shared `db/schema/json`
               * helper exists to avoid, arriving from the other side.
               */
              sql`exists (select 1 from jsonb_array_elements(${groupTaskRuns.steps}) as step where step->>'approvalId' = ${input.approvalId})`,
            ),
          )
          .limit(1),
      );
      return row ? { tenantId: row.tenantId, runId: row.id } : null;
    },

    /**
     * Close the runs no process is coming back for, and say how many.
     *
     * Kept on the store so a caller holding one object can drive and clean up a crew run, and
     * implemented in `pipeline/reap.ts` so the CronJob that only cleans up does not have to build a
     * step runner it will never call. What it does and why — no replay, `awaiting_action` left alone,
     * open cards closed with the run — is written down there.
     */
    async reapAbandoned(input: { olderThanMs: number }): Promise<number> {
      return reapAbandonedPipelineRuns(database, board, input);
    },
  };

  return store;
}

/**
 * The store's own shape, named once.
 *
 * The routes and the deployment's mount both take this rather than a hand-written list of methods, so
 * adding one operation cannot leave a caller's type still claiming the old set.
 */
export type PipelineStore = ReturnType<typeof createPipelineStore>;

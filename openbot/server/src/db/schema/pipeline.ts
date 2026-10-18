import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { tenantId } from "./tenant";
import { wakerGroups } from "./waker-groups";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A `jsonb` column holding an array, typed as one.
 *
 * `./json`'s helper types its data as `Record<string, unknown>`, which an array is not, and casting at
 * every write is how a shape mistake stops being a compile error. Same serialize-once rule as that
 * helper -- the driver already sends an object to a `jsonb` parameter, and a second `JSON.stringify` is
 * the double-encoding bug the shared helper exists to avoid.
 */
function jsonbArray<Row>() {
  return customType<{ data: Row[]; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
  })();
}

/** One step as a template holds it. */
export type PipelineStepRow = {
  id: string;
  agentId: string;
  instruction: string;
  inputKeys?: string[];
  outputKey?: string;
};

/** One step as a run records it: the template's step, plus where it got to. */
export type PipelineStepStateRow = PipelineStepRow & {
  state:
    | "pending"
    | "running"
    | "awaiting_action"
    | "done"
    | "failed"
    | "skipped"
    | "aborted";
  taskId?: string;
  runRef?: string;
  /**
   * The approval this step parked on, while it is parked.
   *
   * Stored because the board's attention lane is not a status a card can hold on its own: `needs_action`
   * means "answerable by the row this id names" (see `tasks/projector.ts`), and the parent card has to be
   * parked against the same row so the person's one decision flips both cards back.
   */
  approvalId?: string;
  output?: string;
  error?: string;
};

/**
 * A step that has reached an end it will not leave, whatever the process holding it does next.
 *
 * Next to the union rather than beside either caller: the orchestrator needs it to decide what a resume
 * may still re-run, and the restart's reaper needs it to decide which cards are still open — and the two
 * answers have to be the same answer.
 */
export function stepIsSettled(state: PipelineStepStateRow["state"]): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "skipped" ||
    state === "aborted"
  );
}

/**
 * The pipeline a Group can run (ticket 021, spec D10 / I1-I6, ADR-0001 = A).
 *
 * Two tables, deliberately not three. A step is not a row of its own: once it runs it IS a task card
 * (`tasks.source = 'group_run'`, filed under the run's parent card), so a third table would hold a
 * second copy of the same fact and disagree with the board the moment somebody reviewed or archived a
 * card. What the run keeps here is only what no card can answer: which step is next, whether the whole
 * thing is still going, and which card was the parent.
 */
export const groupTaskTemplates = pgTable(
  "group_task_templates",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    /** The crew whose members the steps may name. */
    groupId: uuid("group_id")
      .notNull()
      .references(() => wakerGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The ordered steps: `{ id, agentId, instruction }`.
     *
     * A JSON array rather than a child table because the only writer is the editor and the only reader
     * is the orchestrator, and a step is never addressed on its own the way a task row is — skipping,
     * aborting and resuming all name a *position*, which is what the array's order already is.
     *
     * The `agentId` is checked when a run starts, not when the template is saved: a coworker can be
     * retired between those two moments, and a template that validated at write time would still be
     * unrunnable later while looking clean on the editor.
     */
    steps: jsonbArray<PipelineStepRow>().notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Two crews, or one crew twice: a name is unique inside the group it belongs to, not deployment-wide.
    uniqueIndex("group_task_templates_group_name_idx").on(
      table.tenantId,
      table.groupId,
      table.name,
    ),
  ],
);

export const groupTaskRuns = pgTable(
  "group_task_runs",
  {
    tenantId: tenantId(),
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id").references(() => groupTaskTemplates.id, {
      /*
       * Set null rather than cascade or restrict: a run is the record that a crew did work, and it has
       * to outlive the plan it came from. Cascade would delete that history because a person tidied a
       * template away; restrict would turn the delete into a failure that names nothing the person
       * can see. Neither is needed -- a run snapshots its steps at start, so it still advances and
       * still reads correctly with no template to point at.
       */
      onDelete: "set null",
    }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => wakerGroups.id, { onDelete: "cascade" }),
    /**
     * The parent card on the board — the row `tasks.id`, with no foreign key.
     *
     * Spec D7/I2 and ticket 020 settled this: archiving the parent must not take the steps with it, and
     * a cascade would do exactly that. The pointer is also why the step cards exist under one parent at
     * all, which is the only way a person can see "what did this crew do for me" after the fact.
     */
    parentTaskId: uuid("parent_task_id"),
    /** `running` | `awaiting_action` | `done` | `failed` | `aborted`. */
    status: text("status").notNull().default("running"),
    /**
     * Which step is next. A number rather than a per-step status column because the operations the spec
     * asks for are all about the cursor: resume at the step that parked (I3), skip forward past one
     * (I4), abort by moving the cursor to the end and closing what is open (I4).
     */
    cursor: integer("cursor").notNull().default(0),
    /** One durable driver across processes. A crashed driver is reaped, never blindly replayed. */
    advanceOwner: text("advance_owner"),
    /** Conditional writes fence callbacks and control requests based on an older run snapshot. */
    revision: integer("revision").notNull().default(0),
    /** WakerFlow's declared inputs are separate from the board card title. */
    inputs: jsonb("inputs")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    flowId: uuid("flow_id"),
    /**
     * What each step produced, keyed by step id: `{ taskId, runRef, state, output }`.
     *
     * `taskId` is the join to the card, and `runRef` is what closes it when the turn ends — the pair the
     * projector's `finished({runRef})` already keys on, so a resumed run can find the card of a step it
     * finished before the process died.
     */
    steps: jsonbArray<PipelineStepStateRow>().notNull(),
    initiatedBy: text("initiated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("group_task_runs_tenant_status_idx").on(table.tenantId, table.status),
    index("group_task_runs_parent_idx").on(table.parentTaskId),
  ],
);

/*
 * Story WF7, phase 3: a nested Flow's run knows the run and step that started it (spec
 * 2026-11-04-wf7-flow-graph-nodes §3.4).
 *
 * A `flow` step of a WakerFlow starts another Flow's run (the child) and waits on it. The child
 * finds its parent through these two columns when it ends, and the restart sweep finds a parent
 * still waiting on a child that has already ended. Both are null for every run that is not a child,
 * which is every run written before this migration; nothing is backfilled.
 *
 *  - `parent_run_id`: the parent run. A foreign key to the same table, `ON DELETE SET NULL`, so a
 *    child outlives a parent removed by hand, as a run outlives its template (0076).
 *  - `parent_step_id`: the step of the parent that started this child (a step id of its plan).
 *  - `group_task_runs_parent_pair_check`: the two are set together or not at all.
 *  - `group_task_runs_parent_step_idx`: at most one child per parent step, so a parent step that is
 *    driven twice (a retried request, two replicas) cannot start a second child.
 *  - `own_parent_run_insert`: a restrictive insert check that the parent named is a run of the
 *    inserting tenant. A foreign key does not look through row security, so without it a child
 *    could name another workspace's run. The platform frame is exempt, as in every sibling (0137).
 */
ALTER TABLE "public"."group_task_runs" ADD COLUMN "parent_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."group_task_runs" ADD COLUMN "parent_step_id" text;
--> statement-breakpoint
ALTER TABLE "public"."group_task_runs" ADD CONSTRAINT "group_task_runs_parent_run_id_group_task_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."group_task_runs" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "public"."group_task_runs" ADD CONSTRAINT "group_task_runs_parent_pair_check" CHECK (("parent_run_id" IS NULL) = ("parent_step_id" IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "group_task_runs_parent_step_idx" ON "public"."group_task_runs" USING btree ("tenant_id", "parent_run_id", "parent_step_id") WHERE "parent_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE POLICY "own_parent_run_insert" ON "public"."group_task_runs" AS RESTRICTIVE FOR INSERT TO public WITH CHECK ("group_task_runs"."parent_run_id" IS NULL OR current_setting('app.tenant_id', true) = 'platform' OR EXISTS (SELECT 1 FROM public.group_task_runs AS parent_run WHERE parent_run.id = "group_task_runs"."parent_run_id" AND parent_run.tenant_id = current_setting('app.tenant_id', true)));

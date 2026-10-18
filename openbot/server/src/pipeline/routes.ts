import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { QuotaExceeded } from "../quota/limits";
import {
  PipelineNotFoundError,
  type PipelineStore,
  PipelineValidationError,
} from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The crew's pipelines: the templates a workspace can run, and the runs it has started.
 *
 * Thin over the store on purpose. Every decision worth arguing about — what a step is told, who may run
 * one, what a refusal does to the rest of the plan — is made in `pipeline/store.ts` where its own suite
 * can reach it, and the board's state is written by the projector the store already calls. What lives
 * here is which workspace is asking, and what an answer costs in status codes.
 *
 * Reads and writes run under the caller's tenant scope as everywhere else in this API, and a run id that
 * is not this workspace's answers 404 rather than 403 — spec D15's rule, and the one the task board
 * already follows.
 */
export function createPipelineRoutes(
  store: PipelineStore,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/templates", requireUser, async (context) => {
    const groupId = context.req.query("groupId");
    return context.json({
      templates: await store.listTemplates({
        tenantId: context.var.actor.id,
        ...(groupId ? { groupId } : {}),
      }),
    });
  });

  routes.post("/templates", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    try {
      const templateId = await store.createTemplate({
        tenantId: context.var.actor.id,
        groupId: String(body.groupId ?? ""),
        name: String(body.name ?? ""),
        createdBy: context.var.actor.id,
        steps: Array.isArray(body.steps)
          ? body.steps.map((step) => {
              const row = (step ?? {}) as Record<string, unknown>;
              return {
                id: String(row.id ?? ""),
                agentId: String(row.agentId ?? ""),
                instruction: String(row.instruction ?? ""),
              };
            })
          : [],
      });
      return context.json({ templateId }, 201);
    } catch (error) {
      return refuse(context, error);
    }
  });

  /*
   * Pressing "run" answers as soon as the work is on the board, not when the crew finishes.
   *
   * A pipeline is N coworker turns, so a request that waits for them is a request that will time out
   * with the work still going — and a timed-out request is not a stopped crew, which is a confusing pair
   * to read. The step cards appear as the steps complete, which is what the person is watching, and the
   * run's own row says where it got to.
   */
  routes.post("/templates/:templateId/runs", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) {
      return context.json({ error: "给小组的任务不能是空的。" }, 400);
    }
    const tenantId = context.var.actor.id;
    try {
      const started = await store.start({
        tenantId,
        templateId: context.req.param("templateId"),
        task,
        initiatedBy: tenantId,
      });
      drive(store, started.runId, tenantId);
      // Under a key, the same as the read: the screen that just pressed run needs both ids, and a bare
      // object would be the one endpoint in this API whose body it has to remember the shape of.
      return context.json({ run: started }, 201);
    } catch (error) {
      return refuse(context, error);
    }
  });

  /*
   * The run under a key, like every other read in this API.
   *
   * A bare object would be one more shape the browser has to remember the location of, and the envelope
   * is what lets the shared client say "the server sent something malformed" instead of handing the
   * screen an object with `undefined` in it.
   */
  routes.get("/runs/:runId", requireUser, async (context) => {
    const run = await store.inspect({
      tenantId: context.var.actor.id,
      runId: context.req.param("runId"),
    });
    return run
      ? context.json({ run })
      : context.json({ error: "这里没有这个运行。" }, 404);
  });

  /**
   * Deliver the answer a parked step was waiting on.
   *
   * The screen's "批准了，往下走" and the approval machinery's own resume path both land here. It is a
   * separate route from `/advance` because the two carry different things: advancing asks the crew to
   * run what is next, while this one says a person has answered the step that stopped, and what they
   * answered with is the step's output. Confusing the two would run the coworker again for a question
   * it has already been given the answer to.
   */
  routes.post("/runs/:runId/resume", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const output = typeof body.output === "string" ? body.output : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;
    if (output === undefined && error === undefined) {
      return context.json(
        { error: "要么给出这一步做完了什么，要么给出它为什么没做完。" },
        400,
      );
    }
    try {
      return context.json(
        await store.resume({
          tenantId: context.var.actor.id,
          runId: context.req.param("runId"),
          ...(output === undefined ? {} : { output }),
          ...(error === undefined ? {} : { error }),
        }),
      );
    } catch (caught) {
      return refuse(context, caught);
    }
  });

  /**
   * Drive the run from where it stopped.
   *
   * A run that is waiting on a person is not driven from here — that is `/resume` — but a plan that
   * stopped for any other reason (a step skipped, a crew left mid-way) continues on this call.
   */
  routes.post("/runs/:runId/advance", requireUser, async (context) => {
    try {
      const outcome = await store.advance({
        tenantId: context.var.actor.id,
        runId: context.req.param("runId"),
      });
      return context.json(outcome);
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post("/runs/:runId/skip", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    try {
      return context.json(
        await store.skip({
          tenantId: context.var.actor.id,
          runId: context.req.param("runId"),
          ...(typeof body.stepId === "string" ? { stepId: body.stepId } : {}),
        }),
      );
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post("/runs/:runId/abort", requireUser, async (context) => {
    try {
      return context.json(
        await store.abort({
          tenantId: context.var.actor.id,
          runId: context.req.param("runId"),
        }),
      );
    } catch (error) {
      return refuse(context, error);
    }
  });

  return routes;
}

/**
 * Run the crew without keeping the person's request open.
 *
 * Not awaited, and its failure is logged rather than answered, because there is nobody left on the
 * connection to answer. The run row is the record either way: a drive that died mid-step leaves it
 * `running` and `reapAbandoned` closes it as the design requires, instead of replaying a turn that may
 * already have written to the world.
 */
function drive(store: PipelineStore, runId: string, tenantId: string) {
  void store.advance({ tenantId, runId }).catch((error: unknown) =>
    console.error(
      JSON.stringify({
        type: "pipeline-drive-failed",
        runId,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
}

/**
 * What the store's refusals mean as HTTP.
 *
 * A not-found is the answer to a run or template that is not this workspace's, and 404 is both the true
 * statement and D15's rule that another tenant's ids are not confirmed to it. A quota refusal keeps the
 * ceiling's own body and status, because the person's next move is the plans page rather than a retry.
 */
function refuse(context: Context<Ctx>, error: unknown) {
  if (error instanceof QuotaExceeded) return context.json(error.body, 402);
  const message =
    error instanceof Error ? error.message : "流水线没有按预期执行。";
  if (error instanceof PipelineNotFoundError) {
    return context.json({ error: message }, 404);
  }
  if (error instanceof PipelineValidationError) {
    return context.json({ error: message }, 400);
  }
  throw error;
}

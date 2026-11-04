import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type {
  WakerFlowCandidate,
  WakerFlowPlan,
} from "../../../shared/wakerflows";
import type { AppVariables } from "../auth/guards";
import {
  PipelineNotFoundError,
  PipelineValidationError,
} from "../pipeline/store";
import { QuotaExceeded } from "../quota/limits";
import { WakerFlowError, type WakerFlowStore } from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The WakerFlow API (spec D10, stories WF1/WF3/WF4/WF5/WF6).
 *
 * Thin over the store, the same way the pipeline routes are: what a Flow is, who may run which
 * coworker and what a stopped run does with a late answer are decided in `wakerflows/store.ts` and
 * `pipeline/store.ts`. What lives here is which workspace is asking — always the authenticated actor,
 * never a field of the body — and what each refusal costs in status codes: 401 without an actor, 404
 * for a Flow or run that is not this workspace's (never 403, so another tenant's ids are not
 * confirmed), 409 for a lost revision or a reused request id, 400 for input the person can fix.
 */
export function createWakerFlowRoutes(options: {
  store: WakerFlowStore;
  requireUser: MiddlewareHandler<Ctx>;
}) {
  const { store, requireUser } = options;
  const routes = new Hono<Ctx>();
  const body = (context: Context<Ctx>) =>
    context.req
      .json<Record<string, unknown>>()
      .then(
        (value): Record<string, unknown> =>
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? value
            : {},
      )
      .catch((): Record<string, unknown> => ({}));
  const tenant = (context: Context<Ctx>) => context.var.actor.id;
  const notFound = (context: Context<Ctx>) =>
    context.json({ error: "这个工作区里没有这个 WakerFlow。" }, 404);

  routes.get("/", requireUser, async (context) =>
    context.json({ flows: await store.list(tenant(context)) }),
  );

  routes.post("/", requireUser, async (context) => {
    const input = await body(context);
    try {
      const flow = await store.create(tenant(context), {
        idea: typeof input.idea === "string" ? input.idea : "",
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(typeof input.description === "string"
          ? { description: input.description }
          : {}),
        ...(input.modelRef === null || typeof input.modelRef === "string"
          ? { modelRef: input.modelRef as string | null }
          : {}),
      });
      return context.json({ flow }, 201);
    } catch (error) {
      return refuse(context, error);
    }
  });

  // Before `/:id`, so the picker is not read as a Flow id.
  routes.get("/model-choices", requireUser, async (context) => {
    try {
      return context.json({
        models: await store.modelChoices(tenant(context)),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.get("/:id", requireUser, async (context) => {
    const flow = await store.inspect(tenant(context), context.req.param("id"));
    return flow ? context.json({ flow }) : notFound(context);
  });

  routes.put("/:id", requireUser, async (context) => {
    const input = await body(context);
    try {
      const flow = await store.save(
        tenant(context),
        tenant(context),
        context.req.param("id"),
        {
          revision: input.revision as number,
          plan: input.plan as WakerFlowPlan,
          ...(input.modelRef === null || typeof input.modelRef === "string"
            ? { modelRef: input.modelRef as string | null }
            : {}),
        },
      );
      return context.json({ flow });
    } catch (error) {
      return refuse(context, error);
    }
  });

  /*
   * WF8: the saved versions of a Flow, and rolling back to one. A rollback is a Save of the old
   * plan, fenced by the revision the person was looking at, so a stale page answers 409 like a Save.
   */
  routes.get("/:id/versions", requireUser, async (context) => {
    try {
      return context.json({
        versions: await store.versions(
          tenant(context),
          context.req.param("id"),
        ),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.get("/:id/versions/:revision", requireUser, async (context) => {
    try {
      return context.json({
        version: await store.version(
          tenant(context),
          context.req.param("id"),
          Number(context.req.param("revision")),
        ),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post(
    "/:id/versions/:revision/restore",
    requireUser,
    async (context) => {
      const input = await body(context);
      try {
        const flow = await store.restore(
          tenant(context),
          tenant(context),
          context.req.param("id"),
          Number(context.req.param("revision")),
          { revision: input.revision as number },
        );
        return context.json({ flow });
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  routes.delete("/:id", requireUser, async (context) => {
    const raw = context.req.query("revision");
    const revision = raw === undefined ? undefined : Number(raw);
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 0))
      return context.json({ error: "缺少有效的版本号，请刷新后再删除。" }, 400);
    try {
      const removed = await store.remove(
        tenant(context),
        context.req.param("id"),
        revision,
      );
      return removed ? context.json({ deleted: true }) : notFound(context);
    } catch (error) {
      return refuse(context, error);
    }
  });

  /*
   * Planning answers when the model does. Its request id is what makes a retry safe: the same id
   * answers from the stored row and never reaches the provider twice.
   */
  routes.post("/:id/generate", requireUser, async (context) => {
    const input = await body(context);
    try {
      const request = await store.generate(
        tenant(context),
        tenant(context),
        context.req.param("id"),
        {
          requestId: String(input.requestId ?? ""),
          modelRef: typeof input.modelRef === "string" ? input.modelRef : "",
          idea: typeof input.idea === "string" ? input.idea : "",
          members: input.members as WakerFlowCandidate[],
          ...(typeof input.scenario === "string"
            ? { scenario: input.scenario }
            : {}),
        },
      );
      return context.json({ request });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post("/:id/generate/cancel", requireUser, async (context) => {
    const input = await body(context);
    const request = await store.cancel(
      tenant(context),
      context.req.param("id"),
      String(input.requestId ?? ""),
    );
    return request
      ? context.json({ request })
      : context.json({ error: "这里没有这个请求。" }, 404);
  });

  routes.get("/:id/requests/:requestId", requireUser, async (context) => {
    const request = await store.getRequest(
      tenant(context),
      context.req.param("requestId"),
    );
    return request && request.flowId === context.req.param("id")
      ? context.json({ request })
      : context.json({ error: "这里没有这个请求。" }, 404);
  });

  /*
   * Pressing "run" answers as soon as the run is registered and on the board, not when the crew
   * finishes: the steps are driven in the background by the pipeline's own `advance`.
   */
  routes.post("/:id/runs", requireUser, async (context) => {
    const input = await body(context);
    try {
      const request = await store.start(
        tenant(context),
        tenant(context),
        context.req.param("id"),
        {
          requestId: String(input.requestId ?? ""),
          revision: input.revision as number,
          inputs: (input.inputs ?? {}) as Record<string, string>,
        },
      );
      return context.json({ request });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.get("/:id/runs", requireUser, async (context) => {
    try {
      return context.json({
        runs: await store.runs(tenant(context), context.req.param("id")),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.get("/:id/runs/:runId", requireUser, async (context) => {
    try {
      return context.json({
        run: await store.run(
          tenant(context),
          context.req.param("id"),
          context.req.param("runId"),
        ),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post("/:id/runs/:runId/abort", requireUser, async (context) => {
    try {
      return context.json(
        await store.abortRun(
          tenant(context),
          context.req.param("id"),
          context.req.param("runId"),
        ),
      );
    } catch (error) {
      return refuse(context, error);
    }
  });

  /*
   * WF8: a run's recorded state changes, paged by sequence, and the questions its steps stopped on.
   * Answering or skipping one moves the run on in the background; the request id makes a retry safe.
   */
  routes.get("/:id/runs/:runId/events", requireUser, async (context) => {
    const after = Number(context.req.query("after") ?? 0);
    const limit = Number(context.req.query("limit") ?? 50);
    try {
      return context.json(
        await store.events(
          tenant(context),
          context.req.param("id"),
          context.req.param("runId"),
          { after, limit },
        ),
      );
    } catch (error) {
      return refuse(context, error);
    }
  });

  /*
   * WF8: retry a failed run from the step that failed, with the definition it ran on. The request id
   * makes a repeat safe: it answers from the retry ledger and never starts a second run.
   */
  routes.post("/:id/runs/:runId/retry", requireUser, async (context) => {
    const input = await body(context);
    try {
      return context.json({
        retry: await store.retry(
          tenant(context),
          tenant(context),
          context.req.param("id"),
          context.req.param("runId"),
          { requestId: String(input.requestId ?? "") },
        ),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.get("/:id/runs/:runId/confirmations", requireUser, async (context) => {
    try {
      return context.json({
        confirmations: await store.confirmations(
          tenant(context),
          context.req.param("id"),
          context.req.param("runId"),
        ),
      });
    } catch (error) {
      return refuse(context, error);
    }
  });

  routes.post(
    "/:id/runs/:runId/confirmations/:confirmationId/answer",
    requireUser,
    async (context) => {
      const input = await body(context);
      try {
        return context.json({
          confirmation: await store.answer(
            tenant(context),
            context.req.param("id"),
            context.req.param("runId"),
            context.req.param("confirmationId"),
            {
              requestId: String(input.requestId ?? ""),
              answer: typeof input.answer === "string" ? input.answer : "",
            },
          ),
        });
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  routes.post(
    "/:id/runs/:runId/confirmations/:confirmationId/skip",
    requireUser,
    async (context) => {
      const input = await body(context);
      try {
        return context.json({
          confirmation: await store.skipConfirmation(
            tenant(context),
            context.req.param("id"),
            context.req.param("runId"),
            context.req.param("confirmationId"),
            { requestId: String(input.requestId ?? "") },
          ),
        });
      } catch (error) {
        return refuse(context, error);
      }
    },
  );

  return routes;
}

/**
 * What the stores' refusals mean as HTTP. Every WakerFlow refusal carries its own status; a quota
 * refusal keeps the ceiling's own body, as on the pipeline routes; anything else is a real failure.
 */
function refuse(context: Context<Ctx>, error: unknown) {
  if (error instanceof QuotaExceeded) return context.json(error.body, 402);
  if (error instanceof WakerFlowError)
    return context.json({ error: error.message }, error.status);
  if (error instanceof PipelineNotFoundError)
    return context.json({ error: error.message }, 404);
  if (error instanceof PipelineValidationError)
    return context.json({ error: error.message }, 400);
  throw error;
}

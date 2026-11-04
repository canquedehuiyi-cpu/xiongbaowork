import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  ProtectedAgentError,
  RoleTemplateNotApplicableError,
  RoleTemplateSourceError,
} from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import { QuotaExceeded } from "../quota/limits";
import { FlowModelUnavailableError } from "../wakerflows/model";
import {
  RoleGenerationConflictError,
  RoleGenerationUnavailableError,
  RoleTemplateNameTakenError,
  RoleTemplateNotFoundError,
  type RoleTemplateStore,
  RoleTemplateValidationError,
  RoleTemplateVersionConflictError,
} from "./store";

type Ctx = { Variables: AppVariables };

/**
 * `/api/role-templates` (story ROLE1): a person's own role templates, the package's read-only
 * official ones beside them, applying one to a coworker, and where a coworker's role came from.
 *
 * Every route runs in the signed-in person's frame, which the auth middleware opened; the
 * templates' row security does the rest, so another person's template is a 404 here, never a 403
 * that admits it exists. No template is shared across tenants (D8): Markdown export and import,
 * which happen in the browser, are how one person hands a role to another.
 */
export function createRoleTemplateRoutes(
  store: RoleTemplateStore,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();
  const body = (context: Context<Ctx>) =>
    context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}))
      .then((value) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? value
          : {},
      );

  routes.get("/", requireUser, async (context) =>
    context.json({
      templates: await store.list(),
      official: store.official(),
    }),
  );

  routes.post("/", requireUser, async (context) => {
    const input = await body(context);
    try {
      const template = await store.create(context.var.actor, {
        name: input.name,
        profile: input.profile,
      });
      return context.json({ template }, 201);
    } catch (error) {
      return refusal(context, error);
    }
  });

  // Smart generation (§3.5): the models offered, one request, and reading it back.
  routes.get("/models", requireUser, async (context) =>
    context.json({ models: await store.modelChoices(context.var.actor) }),
  );

  routes.post("/generate", requireUser, async (context) => {
    const input = await body(context);
    try {
      const outcome = await store.generate(context.var.actor, {
        requestId: input.requestId,
        modelRef: input.modelRef,
        description: input.description,
      });
      return context.json(outcome);
    } catch (error) {
      return refusal(context, error);
    }
  });

  routes.get("/generate/:requestId", requireUser, async (context) => {
    const outcome = await store.generation(context.req.param("requestId"));
    return outcome
      ? context.json(outcome)
      : context.json({ error: "没有这次生成。" }, 404);
  });

  routes.get("/employees/:agentId", requireUser, async (context) => {
    const status = await store.sourceStatus(
      context.var.actor,
      context.req.param("agentId"),
    );
    return status
      ? context.json(status)
      : context.json({ error: "员工不存在。" }, 404);
  });

  routes.get("/:id", requireUser, async (context) => {
    try {
      return context.json({
        template: await store.get(context.req.param("id")),
      });
    } catch (error) {
      return refusal(context, error);
    }
  });

  routes.put("/:id", requireUser, async (context) => {
    const input = await body(context);
    try {
      const template = await store.update(context.req.param("id"), {
        name: input.name,
        profile: input.profile,
        version: input.version,
      });
      return context.json({ template });
    } catch (error) {
      return refusal(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      await store.remove(context.var.actor, context.req.param("id"));
      return context.json({ ok: true });
    } catch (error) {
      return refusal(context, error);
    }
  });

  routes.post("/:id/apply", requireUser, async (context) => {
    const input = await body(context);
    try {
      const agent = await store.apply(
        context.var.actor,
        context.req.param("id"),
        {
          agentId: input.agentId,
          version: input.version,
        },
      );
      const status = await store.sourceStatus(context.var.actor, agent.id);
      return context.json({
        agent: {
          id: agent.id,
          title: agent.title,
          roleDescription: agent.roleDescription,
          persona: agent.persona,
          bible: agent.bible ?? null,
          roleTemplate: agent.roleTemplate ?? null,
        },
        status,
      });
    } catch (error) {
      return refusal(context, error);
    }
  });

  return routes;
}

function refusal(context: Context<Ctx>, error: unknown): Response {
  if (error instanceof QuotaExceeded) return context.json(error.body, 402);
  if (error instanceof FlowModelUnavailableError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof RoleGenerationConflictError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof RoleGenerationUnavailableError) {
    return context.json({ error: error.message }, 503);
  }
  if (
    error instanceof RoleTemplateNotFoundError ||
    error instanceof AgentNotFoundError
  ) {
    return context.json(
      {
        error:
          error instanceof AgentNotFoundError ? "员工不存在。" : error.message,
      },
      404,
    );
  }
  if (error instanceof RoleTemplateVersionConflictError) {
    return context.json({ error: error.message, version: error.current }, 409);
  }
  if (error instanceof RoleTemplateNameTakenError) {
    return context.json({ error: error.message }, 409);
  }
  if (
    error instanceof RoleTemplateValidationError ||
    error instanceof RoleTemplateNotApplicableError ||
    error instanceof RoleTemplateSourceError
  ) {
    return context.json({ error: error.message }, 400);
  }
  if (
    error instanceof AgentNotManageableError ||
    error instanceof ProtectedAgentError
  ) {
    return context.json({ error: "你无权修改这位员工。" }, 403);
  }
  throw error;
}

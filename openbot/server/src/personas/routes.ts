import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { personaIsEmpty } from "../../../shared/persona";
import type { AppVariables } from "../auth/guards";
import { PersonaNameError, type PersonaTemplateStore } from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The tenant's persona templates: read them, save one, retire one.
 *
 * Deliberately tiny. A template is text with a name on it, so there is no grant to check, no
 * credential to reach, and nothing that outlives the copy onto a coworker — which is why the whole
 * surface is three routes and no policy module.
 *
 * Writes happen under the caller's tenant scope, which the auth middleware already set, so the row
 * level policies decide what is visible and no query here has to name a tenant to stay inside one.
 */
export function createPersonaRoutes(
  store: PersonaTemplateStore,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/", requireUser, async (context) =>
    context.json({ templates: await store.list() }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const name = typeof body.name === "string" ? body.name : "";
    const persona = body.persona;
    if (
      !persona ||
      typeof persona !== "object" ||
      Array.isArray(persona) ||
      personaIsEmpty(persona as never)
    ) {
      return context.json(
        { error: "Write at least one line of the persona first." },
        400,
      );
    }
    const given = persona as Record<string, unknown>;
    const written = ["tone", "principles", "habits"].every(
      (key) => given[key] === undefined || typeof given[key] === "string",
    );
    if (!written) {
      return context.json({ error: "Every persona line must be text." }, 400);
    }
    try {
      const saved = await store.save({
        name,
        persona: {
          tone: typeof given.tone === "string" ? given.tone.trim() : "",
          principles:
            typeof given.principles === "string" ? given.principles.trim() : "",
          habits: typeof given.habits === "string" ? given.habits.trim() : "",
        },
      });
      return context.json({ template: saved }, 201);
    } catch (error) {
      if (error instanceof PersonaNameError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const removed = await store.remove(context.req.param("id"));
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such persona." }, 404);
  });

  return routes;
}

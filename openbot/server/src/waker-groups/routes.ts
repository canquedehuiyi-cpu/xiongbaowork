import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  WakerGroupMemberError,
  WakerGroupNameError,
  WakerGroupNameTakenError,
  type WakerGroupStore,
} from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The tenant's crews: list them, name one, put coworkers in it, retire it.
 *
 * Three routes and no policy module, because a crew decides nothing — the authorisation a coworker
 * has is its own, and grouping cannot add to it.
 *
 * Writes run under the caller's tenant scope, which the auth middleware already set, so the row level
 * policies decide what is visible and nothing here names a tenant to stay inside one.
 */
export function createWakerGroupRoutes(
  store: WakerGroupStore,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/", requireUser, async (context) =>
    context.json({ groups: await store.list() }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    try {
      const group = await store.create({
        name: typeof body.name === "string" ? body.name : "",
        description:
          typeof body.description === "string" ? body.description : null,
      });
      return context.json({ group }, 201);
    } catch (error) {
      if (error instanceof WakerGroupNameError) {
        return context.json({ error: error.message }, 400);
      }
      if (error instanceof WakerGroupNameTakenError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  routes.put("/:id/members", requireUser, async (context) => {
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const agentIds = Array.isArray(body.agentIds)
      ? body.agentIds.filter((id): id is string => typeof id === "string")
      : null;
    if (!agentIds) {
      return context.json(
        { error: "Send the coworker ids the group should hold." },
        400,
      );
    }
    try {
      const group = await store.setMembers(context.req.param("id"), agentIds);
      return group
        ? context.json({ group })
        : context.json({ error: "No such group." }, 404);
    } catch (error) {
      if (error instanceof WakerGroupMemberError) {
        // 400 rather than a silent filter: a roster that quietly dropped somebody is a crew whose
        // board filter is wrong and nobody was told.
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const removed = await store.remove(context.req.param("id"));
    return removed
      ? context.json({ ok: true })
      : context.json({ error: "No such group." }, 404);
  });

  return routes;
}

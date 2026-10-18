import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { AutonomousStore } from "./store";

type Ctx = { Variables: AppVariables };

/**
 * The one question the autonomous page asks: what has this coworker been doing on its own?
 *
 * A single read-only endpoint rather than three, because the screen is one list per coworker and a
 * browser that assembled it from three calls would have to decide what "still loading" means for a
 * fact that is one question. The write paths stay where they are — pausing a routine is the routine
 * store's, with its floor and its fatigue rule.
 */
export function createAutonomousRoutes(
  store: AutonomousStore,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/:agentId/autonomous", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    // RLS limits this lookup to visible coworkers, including the shared built-in catalogue. A
    // private foreign id and an unknown id receive the same answer as other private resources.
    if (!(await store.agentIsVisible(agentId))) {
      return context.json({ error: "No such coworker." }, 404);
    }
    return context.json({ autonomous: await store.summaryForAgent(agentId) });
  });

  return routes;
}

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { OwnerlessBotPrivateError } from "../agents/profile-store";
import type { AdminScope } from "../auth/admin-scope";
import type { AppVariables } from "../auth/guards";
import { capabilityFor, isPersonTenant } from "../tenant/context";
import {
  TeamBotForbiddenError,
  TeamBotNotFoundError,
  TeamBotRefusedError,
  type TeamBots,
} from "./team-bots";

export function createTeamBotRoutes(
  teamBots: TeamBots,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * How an administrator reaches Team Bots that are not theirs (G01-E P9, I5, I6). Their own frame
   * shows them what it shows anyone. Holding the capability, they list every publication and assign
   * as `platform`, and unpublish another person's Bot in that OWNER's frame, so the Bot goes back to
   * its owner as if the owner had unpublished it. Absent, an administrator is answered as anyone.
   */
  adminScope?: Pick<
    AdminScope,
    "adminCapability" | "adminActAsOwner" | "asAdminPlatform"
  >,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  // Re-reads the role: a session that still says admin after the role was removed holds nothing.
  if (adminScope) routes.use("*", adminScope.adminCapability);
  /** The admin doors, only for an administrator who holds the capability in this request. */
  const adminDoors = (actor: AppVariables["actor"]) =>
    adminScope && actor.role === "admin" && capabilityFor(actor.id) === "admin"
      ? adminScope
      : undefined;
  routes.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof TeamBotForbiddenError
        ? 403
        : error instanceof OwnerlessBotPrivateError
          ? 409
          : error instanceof TeamBotNotFoundError
            ? 404
            : error instanceof TeamBotRefusedError ||
                error instanceof z.ZodError
              ? 400
              : 500,
    ),
  );
  routes.get("/", async (context) => {
    const actor = context.var.actor;
    const doors = adminDoors(actor);
    return context.json({
      // An administrator's settings page lists every publication, which only `platform` reads.
      teamBots: doors
        ? await doors.asAdminPlatform(actor, () => teamBots.list(actor))
        : await teamBots.list(actor),
      publishable: await teamBots.publishable(actor),
    });
  });
  routes.delete("/consents", async (context) => {
    await teamBots.clearConsents(context.var.actor);
    return context.body(null, 204);
  });
  routes.put("/:botId/publication", async (context) => {
    const input = z
      .strictObject({
        audience: z.enum(["team", "people"]),
        emails: z.array(z.string().max(320)).max(200).default([]),
        groups: z.array(z.string().max(200)).max(100).default([]),
      })
      .parse(await context.req.json());
    await teamBots.publish(
      context.var.actor,
      context.req.param("botId"),
      input,
    );
    return context.body(null, 204);
  });
  routes.delete("/:botId/publication", async (context) => {
    const actor = context.var.actor;
    const botId = context.req.param("botId");
    const doors = adminDoors(actor);
    const owner = doors
      ? await doors.asAdminPlatform(actor, () => teamBots.ownerOf(botId))
      : undefined;
    if (doors && owner === null)
      // Nobody owns it any more: no person's frame may write it, so `platform`.
      await doors.asAdminPlatform(actor, () =>
        teamBots.unpublish(actor, botId),
      );
    else if (doors && isPersonTenant(owner) && owner !== actor.id)
      await doors.adminActAsOwner(actor, owner, () =>
        teamBots.unpublish(actor, botId),
      );
    else await teamBots.unpublish(actor, botId);
    return context.body(null, 204);
  });
  routes.post("/:botId/assignments", async (context) => {
    const input = z
      .strictObject({ group: z.string().min(1).max(200) })
      .parse(await context.req.json());
    const actor = context.var.actor;
    const botId = context.req.param("botId");
    const doors = adminDoors(actor);
    // As `platform`: an administrator assigns Bots published to audiences they are not in.
    if (doors)
      await doors.asAdminPlatform(actor, () =>
        teamBots.assign(actor, botId, input.group),
      );
    else await teamBots.assign(actor, botId, input.group);
    return context.body(null, 204);
  });
  routes.delete("/:botId/assignments/:group", async (context) => {
    const actor = context.var.actor;
    const botId = context.req.param("botId");
    const group = decodeURIComponent(context.req.param("group"));
    const doors = adminDoors(actor);
    if (doors)
      await doors.asAdminPlatform(actor, () =>
        teamBots.unassign(actor, botId, group),
      );
    else await teamBots.unassign(actor, botId, group);
    return context.body(null, 204);
  });
  routes.post("/:botId/consents", async (context) => {
    const input = z
      .strictObject({
        serverId: z.string().min(1).max(200),
        decision: z.enum([
          "allow_once",
          "allow_always",
          "allow_all_team_bots",
          "skip",
        ]),
      })
      .parse(await context.req.json());
    await teamBots.consent(
      context.var.actor,
      context.req.param("botId"),
      input.serverId,
      input.decision,
    );
    return context.body(null, 204);
  });
  return routes;
}

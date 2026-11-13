import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import { GroupRefusedError } from "../channels/group";
import { ChannelNotOwnerError } from "../channels/routes";
import {
  type WakerGroupActions,
  WakerGroupForbiddenError,
  WakerGroupLinkedError,
  WakerGroupOwnerGoneError,
  WakerGroupRunningError,
  WakerGroupSizeError,
  WakerGroupStepsError,
} from "./linked-actions";
import {
  WakerGroupMemberError,
  WakerGroupNameError,
  WakerGroupNameTakenError,
  type WakerGroupStore,
} from "./store";

type Ctx = { Variables: AppVariables };

const SEND_IDS = "Send the coworker ids the group should hold.";

/** A list of non-empty ids, or null when the body sent anything else. */
function coworkerIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((id) => typeof id === "string" && id.length > 0)
    ? (value as string[])
    : null;
}

/**
 * The tenant's crews: list them, name one, put coworkers in it, retire it.
 *
 * Three routes and no policy module, because a crew decides nothing — the authorisation a coworker
 * has is its own, and grouping cannot add to it.
 *
 * Writes run under the caller's tenant scope, which the auth middleware already set, so the row level
 * policies decide what is visible and nothing here names a tenant to stay inside one.
 *
 * With `actions` (group-unify, spec 6.2-6.3) a crew and its chat are one thing: `POST /` with
 * `agentIds` opens both, `PATCH /:id` renames both, `POST /:id/chat` opens the chat a crew lacks,
 * `POST /for-channel/:channelId` links a chat when its settings open, the list carries each
 * crew's chat status, `PUT /:id/members` changes a linked crew through its chat (and opens the chat
 * of an unlinked crew that reaches two) and `DELETE /:id` dissolves a crew with its chat. Without it
 * every route is exactly what it was.
 */
export function createWakerGroupRoutes(
  store: WakerGroupStore,
  requireUser: MiddlewareHandler<Ctx>,
  actions?: WakerGroupActions,
) {
  const routes = new Hono<Ctx>();
  const bodyOf = (context: Context<Ctx>) =>
    context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));

  routes.get("/", requireUser, async (context) =>
    context.json({
      groups: actions
        ? await actions.list(context.var.actor.id)
        : await store.list(),
    }),
  );

  routes.post("/", requireUser, async (context) => {
    const body = await bodyOf(context);
    try {
      if (actions && body.agentIds !== undefined) {
        const agentIds = coworkerIds(body.agentIds);
        if (!agentIds) return context.json({ error: SEND_IDS }, 400);
        const made = await actions.createWithChat(context.var.actor.id, {
          name: typeof body.name === "string" ? body.name : "",
          description:
            typeof body.description === "string" ? body.description : null,
          agentIds,
        });
        return context.json(made, 201);
      }
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
      // The chat could not be made as asked (a Bot the caller cannot use); the crew is gone again.
      if (
        error instanceof WakerGroupSizeError ||
        error instanceof GroupRefusedError ||
        error instanceof AgentNotFoundError
      ) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  if (actions) {
    routes.patch("/:id", requireUser, async (context) => {
      const body = await bodyOf(context);
      if (
        (body.name !== undefined && typeof body.name !== "string") ||
        (body.description !== undefined &&
          body.description !== null &&
          typeof body.description !== "string")
      )
        return context.json(
          { error: "Send the group's new name or description." },
          400,
        );
      try {
        const group = await actions.rename(
          context.var.actor.id,
          context.req.param("id"),
          {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(body.description !== undefined
              ? { description: body.description as string | null }
              : {}),
          },
        );
        return group
          ? context.json({ group })
          : context.json({ error: "No such group." }, 404);
      } catch (error) {
        if (error instanceof WakerGroupNameError)
          return context.json({ error: error.message }, 400);
        if (error instanceof WakerGroupNameTakenError)
          return context.json({ error: error.message }, 409);
        if (error instanceof ChannelNotOwnerError)
          return context.json(
            { error: new WakerGroupForbiddenError().message },
            403,
          );
        throw error;
      }
    });

    // Before `/:id/chat`, so `POST /for-channel/chat` is a channel called "chat", not a crew.
    routes.post("/for-channel/:channelId", requireUser, async (context) => {
      try {
        const group = await actions.forChannel(
          context.var.actor.id,
          context.req.param("channelId"),
        );
        // Unreadable and absent answer alike, so a conversation's existence cannot be probed.
        return group
          ? context.json({ group })
          : context.json({ error: "Couldn't find that conversation." }, 404);
      } catch (error) {
        if (error instanceof WakerGroupForbiddenError)
          return context.json({ error: error.message }, 403);
        if (error instanceof WakerGroupOwnerGoneError)
          return context.json({ error: error.message, code: error.code }, 409);
        throw error;
      }
    });

    routes.post("/:id/chat", requireUser, async (context) => {
      try {
        const made = await actions.startChat(
          context.var.actor.id,
          context.req.param("id"),
        );
        return made
          ? context.json(made, 201)
          : context.json({ error: "No such group." }, 404);
      } catch (error) {
        if (
          error instanceof WakerGroupLinkedError ||
          error instanceof WakerGroupSizeError
        )
          return context.json({ error: error.message }, 409);
        if (error instanceof WakerGroupOwnerGoneError)
          return context.json({ error: error.message, code: error.code }, 409);
        if (
          error instanceof GroupRefusedError ||
          error instanceof AgentNotFoundError
        )
          return context.json({ error: error.message }, 400);
        throw error;
      }
    });
  }

  routes.put("/:id/members", requireUser, async (context) => {
    const body = await bodyOf(context);
    const agentIds = Array.isArray(body.agentIds)
      ? body.agentIds.filter((id): id is string => typeof id === "string")
      : null;
    if (!agentIds) {
      return context.json({ error: SEND_IDS }, 400);
    }
    try {
      const group = actions
        ? await actions.setMembers(
            context.var.actor.id,
            context.req.param("id"),
            agentIds,
          )
        : await store.setMembers(context.req.param("id"), agentIds);
      return group
        ? context.json({ group })
        : context.json({ error: "No such group." }, 404);
    } catch (error) {
      if (error instanceof WakerGroupMemberError) {
        // 400 rather than a silent filter: a roster that quietly dropped somebody is a crew whose
        // board filter is wrong and nobody was told.
        return context.json({ error: error.message }, 400);
      }
      if (error instanceof WakerGroupSizeError)
        return context.json({ error: error.message }, 409);
      // Part-way: what went through stays, and the caller is told which steps those were.
      if (error instanceof WakerGroupStepsError)
        return context.json({ error: error.message, done: error.done }, 409);
      if (error instanceof WakerGroupOwnerGoneError)
        return context.json({ error: error.message, code: error.code }, 409);
      // The chat a crew that reached two Bots asked for could not be made as asked.
      if (
        error instanceof GroupRefusedError ||
        error instanceof AgentNotFoundError
      )
        return context.json({ error: error.message }, 400);
      throw error;
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      const removed = actions
        ? await actions.dissolve(context.var.actor.id, context.req.param("id"))
        : await store.remove(context.req.param("id"));
      return removed
        ? context.json({ ok: true })
        : context.json({ error: "No such group." }, 404);
    } catch (error) {
      if (error instanceof WakerGroupRunningError)
        return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  return routes;
}

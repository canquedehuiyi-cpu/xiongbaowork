import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { DEFAULT_SENSITIVE_PATHS, SENSITIVE_PATH_PATTERN } from "./policy";
import type { ApprovalService } from "./service";
import {
  ACTION_KIND_POLICIES,
  ACTION_KINDS,
  APPROVAL_DECISIONS,
  ApprovalNotFoundError,
  ApprovalRefusedError,
  RULE_BEHAVIOURS,
} from "./types";

const pattern = z.string().trim().min(1).max(300);
/** An action class: which Bot, which tool or app, which kind of effect, and which target. */
const ruleInput = z.strictObject({
  botId: pattern.default("*"),
  toolRef: pattern,
  effect: pattern.default("*"),
  scope: pattern.default("*"),
  behaviour: z.enum(RULE_BEHAVIOURS),
});
const hostCommands = z.enum(["ask", "allow", "never"]);
/** One tool's mode on a Bot's permissions page, or `default` to remove the owner's rule. */
const toolModeInput = z.strictObject({
  toolRef: pattern,
  mode: z.enum(["direct", "ask", "disabled", "default"]),
});
const floorMode = z.enum(["off", "ask"]);
/**
 * A Bot's floors. Added paths use the same narrow glob form as the defaults; a default can only be
 * switched off, so `disabledDefaultPaths` names defaults and nothing else (D8). Commands cannot be
 * added to the dangerous list in v1.0 (D7), so there is no field for it.
 */
const securityInput = z
  .strictObject({
    dangerousCommands: floorMode,
    sensitivePaths: floorMode,
    extraSensitivePaths: z
      .array(z.string().trim().regex(SENSITIVE_PATH_PATTERN))
      .max(50)
      .transform((paths) => [...new Set(paths)]),
    disabledDefaultPaths: z
      .array(z.enum(DEFAULT_SENSITIVE_PATHS))
      .max(DEFAULT_SENSITIVE_PATHS.length)
      .transform((paths) => [...new Set(paths)]),
  })
  .partial()
  .refine(
    (input) => Object.keys(input).length > 0,
    "Change at least one setting.",
  );
/** A change to a saved rule: any of its fields, and at least one. */
const ruleChange = z
  .strictObject({
    botId: pattern,
    toolRef: pattern,
    effect: pattern,
    scope: pattern,
    behaviour: z.enum(RULE_BEHAVIOURS),
  })
  .partial()
  .refine(
    (input) => Object.keys(input).length > 0,
    "Change at least one field.",
  );

import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";

/**
 * Whether the database refused the statement for want of privilege: row-level security's "new row
 * violates row-level security policy" and a missing grant both carry SQLSTATE 42501. The query
 * builder wraps the driver's error, so it may sit on the error or on its cause; Bun's driver puts
 * the SQLSTATE in `errno` (its `code` is `ERR_POSTGRES_SERVER_ERROR`), other drivers in `code`.
 */
function refusedByDatabase(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 4;
    current = (current as Error & { cause?: unknown }).cause, depth += 1
  ) {
    const { code, errno } = current as Error & {
      code?: unknown;
      errno?: unknown;
    };
    if (code === "42501" || errno === "42501") return true;
  }
  return false;
}

export function createApprovalRoutes(
  service: ApprovalService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * `createAdminScope(...).adminCapability`. Team rules and the team settings row are stamped
   * `team`, and row-level security admits those writes only with the admin capability (G01-E I10),
   * so without it an admin's change is refused by the database: fail closed, never wider.
   */
  adminCapability?: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  if (adminCapability) {
    // Only the admin-only team writes carry the capability; every other route runs without it.
    // `/team/*` matches `/team` itself as well.
    routes.use("/team/*", adminCapability);
  }
  routes.onError((error, context) =>
    // A body that is not JSON is the caller's mistake, as the delivery routes answer it, not a
    // 500 carrying the parser's message.
    error instanceof SyntaxError
      ? context.json({ error: "Supply a valid request." }, 400)
      : // A team write the database refused (an admin whose role or capability it does not see) is
        // a 403, never a 500 that echoes the statement back.
        refusedByDatabase(error)
        ? context.json({ error: "Administrator access required." }, 403)
        : context.json(
          { error: error.message },
          error instanceof ApprovalNotFoundError
            ? 404
            : error instanceof ApprovalRefusedError ||
                error instanceof z.ZodError
              ? 400
              : 500,
        ),
  );
  routes.get("/", async (context) =>
    context.json(await service.inbox(context.var.actor.id)),
  );
  /*
   * Whether this conversation asks before every step: a task's, started from a check-in. The browser
   * asks before it sends a Bot's look at a page straight to the computer, since a look sent that way
   * carries no conversation for the gate to ask in. Answered by the rule the gate itself applies
   * (`asksEveryChange`), for the asker's own conversations only: anybody else's reads as no.
   */
  routes.get("/threads/:threadId", async (context) =>
    context.json({
      asksEveryStep:
        (await service.store.asksEveryChange?.(
          context.var.actor.id,
          context.req.param("threadId"),
        )) === true,
    }),
  );
  routes.post("/computer/:botId", async (context) => {
    try {
      return context.json({
        result: await service.frontendAction(
          context.var.actor.id,
          context.req.param("botId"),
          await context.req.json(),
        ),
      });
    } catch (error) {
      if (error instanceof HeadlessToolSuspension)
        return context.json(
          {
            waiting: true,
            approvalId: error.waiting.requestId,
            reason: error.message,
          },
          202,
        );
      throw error;
    }
  });
  routes.patch("/preferences", async (context) => {
    const input = z
      .strictObject({
        enabled: z.boolean().optional(),
        autoReview: z.boolean().optional(),
        hostCommands: hostCommands.optional(),
      })
      .parse(await context.req.json());
    if (!service.store.policy) {
      if (input.enabled === undefined)
        throw new ApprovalRefusedError("Choose whether to ask first.");
      await service.store.setEnabled(context.var.actor.id, input.enabled);
      return context.json({ enabled: input.enabled });
    }
    return context.json(
      await service.setPreferences(context.var.actor.id, input),
    );
  });
  routes.post("/rules", async (context) =>
    context.json(
      {
        rule: await service.createRule(
          context.var.actor.id,
          ruleInput.parse(await context.req.json()),
        ),
      },
      201,
    ),
  );
  routes.patch("/rules/:id", async (context) =>
    context.json({
      rule: await service.updateRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await context.req.json()),
      ),
    }),
  );
  /** Team rules and settings. Members read them as locked rows in the inbox; only admins change them. */
  routes.patch("/team", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const input = z
      .strictObject({
        enforceAutoReview: z.boolean().optional(),
        customRulesEnabled: z.boolean().optional(),
        hostCommandsCap: hostCommands.optional(),
        enforceDangerousCommands: z.boolean().optional(),
        // One or more kinds of action, each open, asked every time, or left to the person.
        actionKinds: z
          .partialRecord(z.enum(ACTION_KINDS), z.enum(ACTION_KIND_POLICIES))
          .optional(),
        /*
         * The words that make clicking a control on a member's computer ask every time. Only a cheap
         * size bound here: the store trims, drops blanks and repeats and counts a word's length by
         * code point, and its refusal comes back as a 400 below. Null is the default list.
         */
        desktopActionWords: z
          .array(z.string().max(200))
          .max(200)
          .nullable()
          .optional(),
      })
      .parse(await context.req.json());
    return context.json(
      await service.setTeamSettings(context.var.actor.id, input),
    );
  });
  routes.post("/team/rules", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(
      {
        rule: await service.createTeamRule(
          context.var.actor.id,
          ruleInput.parse(await context.req.json()),
        ),
      },
      201,
    );
  });
  routes.patch("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({
      rule: await service.updateTeamRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await context.req.json()),
      ),
    });
  });
  routes.delete("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await service.revokeTeamRule(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  /*
   * One Bot's permissions (SEC1 §4.5). Anybody may read them for a Bot whose owner's rules apply to
   * their runs; only the owner changes them, checked by the service and by row security.
   */
  routes.get("/employees/:botId", async (context) =>
    context.json(
      await service.employeePermissions(
        context.var.actor.id,
        context.req.param("botId"),
      ),
    ),
  );
  routes.put("/employees/:botId/tools", async (context) => {
    const input = toolModeInput.parse(await context.req.json());
    return context.json({
      rule: await service.setEmployeeToolMode(
        context.var.actor.id,
        context.req.param("botId"),
        input.toolRef,
        input.mode,
      ),
    });
  });
  routes.patch("/employees/:botId/security", async (context) =>
    context.json(
      await service.setEmployeeSecurity(
        context.var.actor.id,
        context.req.param("botId"),
        securityInput.parse(await context.req.json()),
      ),
    ),
  );
  routes.post("/questions/:id/respond", async (context) => {
    const input = z
      .strictObject({
        response: z.string().trim().min(1).max(6000),
        /*
         * Sent from the open conversation, which runs the answer as its own next turn when that is
         * where it belongs, live and stoppable, rather than waiting on a turn run out of its sight.
         */
        inConversation: z.boolean().optional(),
      })
      .parse(await context.req.json());
    return context.json(
      await service.answerQuestion(
        context.var.actor.id,
        context.req.param("id"),
        input.response,
        { inConversation: input.inConversation ?? false },
      ),
    );
  });
  // One request by id, owner-scoped like the inbox: another person's id is a 404 (spec D15).
  routes.get("/:id", async (context) =>
    context.json(
      await service.request(context.var.actor.id, context.req.param("id")),
    ),
  );
  routes.post("/questions/:id/dismiss", async (context) =>
    context.json(
      await service.dismissQuestion(
        context.var.actor.id,
        context.req.param("id"),
      ),
    ),
  );
  routes.post("/:id/decision", async (context) => {
    const input = z
      .strictObject({
        decision: z.enum(APPROVAL_DECISIONS),
      })
      .parse(await context.req.json());
    const request = await service.decide(
      context.var.actor.id,
      context.req.param("id"),
      input.decision,
    );
    return context.json({ id: request.id, status: request.status });
  });
  /** Turn off one "Allow for this conversation": the next such call in it asks again. */
  routes.delete("/conversation-grants/:id", async (context) => {
    await service.revokeConversationGrant(
      context.var.actor.id,
      context.req.param("id"),
    );
    return context.json({ revoked: true });
  });
  routes.delete("/rules/:id", async (context) => {
    await service.revoke(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  return routes;
}

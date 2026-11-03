/**
 * The HTTP half of the capability switches, and the model allowlist.
 *
 * Mounted once in app.ts as `app.use("/api/*", createEnterpriseGate(requireUser))`. A request that
 * matches none of the routes below passes straight through without a session lookup. One that
 * matches is authenticated by the same `requireUser` the route itself uses, checked, and refused with
 * a 403 carrying a sentence the person can act on. The route then runs its own guard as before.
 *
 * Fail closed: a capability that cannot be read refuses (503). Where the enterprise controls were
 * never installed (a unit test, a script) the gate passes everything, which is the product as it was.
 */
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { agents } from "../db/schema";
import { boundModelName } from "../models/runtime-resolver";
import { currentTenant, isTenantFramed, runAsTenant } from "../tenant/context";
import { type Capability, capabilityRefusal } from "./capabilities";
import { enterpriseControls } from "./controls";

type Ctx = Context<{ Variables: AppVariables }>;

type Rule = {
  method: string | string[];
  path: RegExp;
  /** The capabilities this request needs, possibly depending on its body. */
  needs: (context: Ctx) => Promise<Capability[]>;
};

async function body(context: Ctx): Promise<Record<string, unknown>> {
  try {
    const parsed = await context.req.raw.clone().json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const COPILOT_BASE = "/api/copilotkit";

/**
 * A run or connect of a Bot through the CopilotKit runtime, matched the way the runtime matches it.
 *
 * The runtime does not anchor its routes: its router (`fetch-router` `matchSegments`) takes any path
 * under its base whose LAST segments are `agent/<id>/run`, `agent/<id>/connect` or `agent/<id>/suggest`
 * (a suggestion runs the Bot's model on whatever messages the caller sends). So
 * `/api/copilotkit/x/agent/<id>/run` runs the Bot exactly as `/api/copilotkit/agent/<id>/run` does,
 * and an anchored pattern here would let the first one through ungoverned.
 */
export function runtimeRun(
  path: string,
): { agentId: string; action: "run" | "connect" | "suggest" } | null {
  if (path !== COPILOT_BASE && !path.startsWith(`${COPILOT_BASE}/`))
    return null;
  const segments = path.split("/").filter(Boolean);
  const count = segments.length;
  const action = segments[count - 1];
  if (count < 3 || segments[count - 3] !== "agent") return null;
  if (action !== "run" && action !== "connect" && action !== "suggest")
    return null;
  try {
    return { agentId: decodeURIComponent(segments[count - 2] ?? ""), action };
  } catch {
    return null;
  }
}

const RUNTIME_RUN: Rule = {
  method: "POST",
  path: /$^/,
  needs: async () => ["useBots"],
};

export const GATED_ROUTES: Rule[] = [
  {
    method: ["POST", "PATCH"],
    path: /^\/api\/agents(\/[^/]+)?$/,
    needs: async (context) =>
      String((await body(context)).visibility ?? "").trim() === "public"
        ? ["useBots", "teamBots"]
        : ["useBots"],
  },
  {
    method: "POST",
    path: /^\/api\/agents\/[^/]+\/duplicate$/,
    needs: async () => ["useBots"],
  },
  {
    method: "POST",
    path: /^\/api\/host-access\/grants$/,
    needs: async () => ["localComputer"],
  },
  {
    method: "POST",
    path: /^\/api\/delivery\/(slack|teams)(\/.*)?$/,
    needs: async () => ["slackTeams"],
  },
  {
    method: ["POST", "PUT", "PATCH"],
    path: /^\/api\/approvals\/(preferences|rules)(\/.*)?$/,
    needs: async () => ["customRules"],
  },
  {
    method: "POST",
    path: /^\/api\/approvals\/[^/]+\/decision$/,
    needs: async (context) =>
      (await body(context)).decision === "allow_always" ? ["customRules"] : [],
  },
  {
    method: ["POST", "PUT", "PATCH"],
    path: /^\/api\/passwords(\/.*)?$/,
    needs: async () => ["passwordManager"],
  },
  {
    method: "POST",
    path: /^\/api\/computers\/[^/]+\/(control|human)\/(secret|sign-in)$/,
    needs: async () => ["passwordManager"],
  },
];

function matches(rule: Rule, method: string, path: string) {
  const methods = Array.isArray(rule.method) ? rule.method : [rule.method];
  return methods.includes(method) && rule.path.test(path);
}

/** The serving model a run's stream names, if it names one: `"model":"..."` in any event. */
const MODEL_IN_STREAM = /"model"\s*:\s*"([^"]{1,200})"/;

export function createEnterpriseGate(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const controls = enterpriseControls();
    /*
     * Both spellings of the path. Hono routes on the DECODED path (`c.req.path`), so
     * `/api/%61gents/<id>` reaches the agents route; a rule tested only against the raw URL would
     * never see it. The runtime, behind its own sub-app, reads the raw URL. A rule that matches
     * either one applies.
     */
    const raw = new URL(context.req.url).pathname;
    const paths = [...new Set([context.req.path, raw])];
    const path = paths[0] ?? raw;
    const method = context.req.method;
    const run =
      method === "POST"
        ? paths.map(runtimeRun).find((found) => found !== null)
        : undefined;
    const rule = controls
      ? run
        ? RUNTIME_RUN
        : GATED_ROUTES.find((candidate) =>
            paths.some((candidatePath) =>
              matches(candidate, method, candidatePath),
            ),
          )
      : undefined;
    if (!controls || !rule) return next();

    // A suggestion runs the model as a run does, so the allowlist governs it the same way.
    const governedAgent =
      (run?.action === "run" || run?.action === "suggest") && run.agentId
        ? run.agentId
        : undefined;
    let refused: Response | undefined;
    let governed: Response | undefined;
    const authenticated = await requireUser(context, async () => {
      let needed: Capability[];
      try {
        needed = await rule.needs(context);
        for (const capability of needed) {
          if (
            !(await controls.capabilityFor(context.var.actor.id, capability))
          ) {
            refused = context.json(
              { error: capabilityRefusal(capability), capability },
              403,
            );
            return;
          }
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "capability-check-failed",
            path,
            error: String(error),
          }),
        );
        refused = context.json(
          {
            error:
              "This deployment's enterprise controls could not be checked, so nothing was done.",
          },
          503,
        );
      }
      /*
       * A governed run is judged, run and recorded HERE, inside the tenant frame `requireUser` opened
       * for this person: the Bot lookup, the bound model, the usage row and the audit row are theirs.
       * Outside it they would read and write as `system` (or throw under
       * OPENBOT_TENANT_FRAME_GUARD=throw), where a Bot stamped with its owner's tenant is not found,
       * so a built-in Bot would pass the allowlist unjudged.
       */
      if (!refused && governedAgent)
        governed = await governRun(context, next, governedAgent);
    });
    // requireUser answered on its own: not signed in, or no role.
    if (authenticated instanceof Response) return authenticated;
    if (refused) return refused;
    if (governedAgent) return governed;
    /*
     * Everything else passes on outside the frame, as before: each gated route sits behind its own
     * `requireUser`, which opens the person's frame again. The CopilotKit runtime is not behind
     * `requireUser`; `mountCopilotRuntime` opens the frame of the actor it resolves around each whole
     * runtime request (and refuses a signed-out one everything but `/info`), so an ungoverned
     * `/connect` or thread read is framed there, not here.
     */
    return next();
  };
}

/**
 * The model allowlist, and one usage row per run with the model that served it.
 *
 * A built-in Bot runs on the deployment's configured model, so it is known before the run and a model
 * off the list refuses the run outright. A built-in Bot bound to an entry in its tenant's model
 * library runs on THAT model, and it is that name the row records and the allowlist judges —
 * otherwise the usage view would name a model the run never spoke. A remote Bot chooses its own
 * model; the stream is read as it passes and the first model it names is recorded (`observed`), or
 * `unknown` when it names none.
 */
async function governRun(
  context: Ctx,
  next: () => Promise<void>,
  agentId: string,
): Promise<Response | undefined> {
  const controls = enterpriseControls();
  if (!controls) {
    await next();
    return undefined;
  }
  const request = await body(context);
  const threadId =
    typeof request.threadId === "string" ? request.threadId : null;
  const runId = typeof request.runId === "string" ? request.runId : null;
  const actor = context.var.actor;
  /*
   * The frame this runs in, kept for the stream's `flush`, which runs whenever the body is read --
   * after this function has returned and outside any frame. The tenant is the one `requireUser`
   * framed the request as, not re-derived here.
   */
  const tenant = isTenantFramed() ? currentTenant() : undefined;
  const inFrame = <T>(work: () => T): T =>
    tenant === undefined ? work() : runAsTenant(tenant, work);

  let builtIn = false;
  let bound: string | null = null;
  try {
    const [row] = await controls.deps.database
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    builtIn = row?.type === "built_in";
    if (builtIn) bound = await boundModelName(controls.deps.database, agentId);
  } catch {
    builtIn = false;
    bound = null;
  }
  const allowlist = controls.snapshot()?.settings.modelAllowlist;
  const isAllowed = (model: string) =>
    !allowlist?.enabled || allowlist.models.includes(model);
  const configured = builtIn
    ? (bound ?? controls.deps.builtInModel)
    : undefined;
  const configuredSource: "configured" | "bound" = bound
    ? "bound"
    : "configured";

  const record = (
    model: string,
    source: "configured" | "bound" | "observed" | "unknown",
    allowed: boolean,
  ) =>
    controls.store
      .recordModelUsage({
        userId: actor.id,
        agentId,
        threadId,
        runId,
        model,
        source,
        allowed,
      })
      .catch((error) =>
        console.error(
          JSON.stringify({
            type: "model-usage-write-failed",
            error: String(error),
          }),
        ),
      );

  if (configured && !isAllowed(configured)) {
    await record(configured, configuredSource, false);
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "model.refused",
      targetType: "agent",
      targetId: agentId,
      actorUserId: actor.id,
      payload: { model: configured, source: configuredSource },
    }).catch(() => undefined);
    return context.json(
      {
        error: `This Bot runs on ${configured}, which is not on this deployment's model allowlist. An administrator can add it.`,
      },
      403,
    );
  }

  await next();

  const response = context.res;
  if (!response.body || configured) {
    if (configured) await record(configured, configuredSource, true);
    return undefined;
  }

  // A remote Bot: read the model its stream names, without holding the stream back.
  const decoder = new TextDecoder();
  let seen = "";
  let found: string | undefined;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!found) {
        seen = (seen + decoder.decode(chunk, { stream: true })).slice(-8_192);
        found = MODEL_IN_STREAM.exec(seen)?.[1];
      }
      controller.enqueue(chunk);
    },
    flush() {
      const model = found ?? `remote:${agentId}`;
      const allowed = found ? isAllowed(found) : !allowlist?.enabled;
      void inFrame(() =>
        record(model, found ? "observed" : "unknown", allowed),
      );
      if (!allowed) {
        void inFrame(() =>
          recordAuditEvent(controls.deps.auditStore, {
            eventType: "model.refused",
            targetType: "agent",
            targetId: agentId,
            actorUserId: actor.id,
            payload: {
              model,
              source: found ? "observed" : "unknown",
              note: "A remote Bot chooses its own model; this run was recorded against the allowlist after it streamed.",
            },
          }),
        ).catch(() => undefined);
      }
    },
  });
  context.res = new Response(response.body.pipeThrough(tap), response);
  return undefined;
}

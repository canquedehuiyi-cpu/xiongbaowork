import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { CredentialSecretReader, CredentialStore } from "../credentials";
import {
  MODEL_REGISTRY_KEY_PREFIX,
  openCredential,
  sealCredential,
} from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  modelRegistry,
  PLATFORM_POOL_KEY_ENV,
  platformModelPool,
  providerTemplates,
} from "../db/schema";
import {
  checkOutboundUrl,
  guardedFetch,
  type OutboundPolicy,
  OutboundRefusedError,
} from "../net/outbound-guard";
import type { Plan, QuotaService } from "../quota/limits";
import { FREE_PLAN_FALLBACK, QuotaExceeded } from "../quota/limits";
import type { PoolKeyEnvironment } from "./runtime-resolver";

type Ctx = { Variables: AppVariables };

/** One platform pool model as a picker offers it: never its key variable, only whether a key is there. */
export type OfferedPoolModel = {
  id: string;
  provider: string;
  modelName: string;
  label: string;
  available: boolean;
};

/**
 * The platform pool models this plan may bind, as the model picker lists them: switched on, offered
 * on the plan, and `available` when the deployment holds the key behind the row. Read in the caller's
 * own frame (the pool has no row security; openbot_app may only SELECT it).
 *
 * One reader for the picker (`GET /api/models`) and for the staffing tools, so an employee drafted in
 * conversation is offered exactly the pool the person would see in the employee's model picker.
 */
export async function poolFor(
  database: Database,
  planId: string,
  environment: PoolKeyEnvironment,
): Promise<OfferedPoolModel[]> {
  const rows = await database
    .select({
      id: platformModelPool.id,
      provider: platformModelPool.provider,
      modelName: platformModelPool.modelName,
      label: platformModelPool.label,
      apiKeyEnv: platformModelPool.apiKeyEnv,
      tiers: platformModelPool.tiers,
    })
    .from(platformModelPool)
    .where(eq(platformModelPool.enabled, true))
    .orderBy(platformModelPool.label, platformModelPool.id);
  return rows
    .filter((row) => (row.tiers as readonly string[]).includes(planId))
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      modelName: row.modelName,
      label: row.label,
      available:
        PLATFORM_POOL_KEY_ENV.test(row.apiKeyEnv) &&
        Boolean(environment[row.apiKeyEnv]),
    }));
}

/** The models a person may bind an employee to: their library's switched-on rows, and the pool. */
export type ModelShelf = {
  choices(actorId: string): Promise<{
    library: { id: string; label: string | null; modelName: string }[];
    pool: OfferedPoolModel[];
  }>;
};

/**
 * The model picker's shelf, read without a request: the same library rows the employee update accepts
 * (`modelRegistry` switched on, in the caller's frame) and the same pool (`poolFor`, on the person's
 * plan, Free when this deployment counts no quota, as `GET /api/models` reads it).
 */
export function createModelShelf(options: {
  database: Database;
  quota?: Pick<QuotaService, "planFor">;
  environment?: PoolKeyEnvironment;
}): ModelShelf {
  const environment = options.environment ?? process.env;
  return {
    async choices(actorId) {
      const library = await options.database
        .select({
          id: modelRegistry.id,
          label: modelRegistry.label,
          modelName: modelRegistry.modelName,
        })
        .from(modelRegistry)
        .where(eq(modelRegistry.enabled, true))
        .orderBy(desc(modelRegistry.updatedAt));
      const plan: Plan = options.quota
        ? await options.quota.planFor(actorId)
        : FREE_PLAN_FALLBACK;
      return {
        library,
        pool: await poolFor(options.database, plan.id, environment),
      };
    },
  };
}

/**
 * The tenant's model library: connect a provider template with one's own key,
 * list what is connected, probe it, remove it. Keys go to the same encrypted
 * vault everything else uses and never come back out -- the list answers with
 * a masked tail so a screen can say "…abc3" without leaking.
 */
export function createModelRoutes(
  database: Database,
  requireUser: MiddlewareHandler<Ctx>,
  credentials: CredentialStore & CredentialSecretReader,
  encryptionKey: string,
  /** The tenant's ceiling on models of their own, when this deployment counts one (ticket 022). */
  quota?: QuotaService,
  options: {
    /** Where a pool row's key variable is looked up for `available`; tests pass their own. */
    environment?: PoolKeyEnvironment;
    /**
     * Where a tenant's base URL may point (audit defect #6). The deployment's private-host opt-in and
     * named hosts, so a developer's local provider still works; injectable resolver and fetch for
     * tests.
     */
    outbound?: OutboundPolicy;
  } = {},
) {
  const routes = new Hono<Ctx>();
  const environment = options.environment ?? process.env;
  const outbound = options.outbound ?? {};

  routes.get("/", requireUser, async (context) => {
    const rows = await database
      .select({
        id: modelRegistry.id,
        provider: modelRegistry.provider,
        baseUrl: modelRegistry.baseUrl,
        modelName: modelRegistry.modelName,
        label: modelRegistry.label,
        enabled: modelRegistry.enabled,
        updatedAt: modelRegistry.updatedAt,
      })
      .from(modelRegistry)
      .orderBy(desc(modelRegistry.updatedAt));
    const templates = await database
      .select()
      .from(providerTemplates)
      .orderBy(providerTemplates.id);
    /*
     * How many coworkers answer on each, in the same breath as the list.
     *
     * A model library whose rows do not say who uses them is a list somebody has to memorise before
     * they can switch one off or delete one. This is the count the screen puts on the row, and the
     * reason the row is not worded as though removing it were free.
     */
    const bound = await database
      .select({
        modelRef: agentProfiles.modelRef,
        coworkers: sql<number>`count(*)::int`,
      })
      .from(agentProfiles)
      .where(
        and(isNotNull(agentProfiles.modelRef), isNull(agentProfiles.deletedAt)),
      )
      .groupBy(agentProfiles.modelRef);
    const counts = new Map(bound.map((row) => [row.modelRef, row.coworkers]));
    /*
     * The platform's experience models this tenant's plan may bind (stories H1, K1).
     *
     * The plan is this tenant's own, and a workspace with no subscription is Free (audit #7) — also
     * when this deployment counts no quota, so the shelf never offers Pro rows by omission. The pool
     * is platform-owned with no row security (openbot_app may only SELECT it), so it is read in the
     * member's own frame: a member request never opens `platform` (G01-E). Only the fields a
     * screen needs leave this handler: never `api_key_env`, never a key. `available` says whether
     * the deployment holds the key behind the row, so a screen can grey out a row that would fall
     * back to the default model.
     */
    const plan: Plan = quota
      ? await quota.planFor(context.var.actor.id)
      : FREE_PLAN_FALLBACK;
    // Under this tenant's row-level security, like the library count above: other tenants' coworkers
    // on the same pool row are not this tenant's business.
    const pooled = await database
      .select({
        platformModelRef: agentProfiles.platformModelRef,
        coworkers: sql<number>`count(*)::int`,
      })
      .from(agentProfiles)
      .where(
        and(
          isNotNull(agentProfiles.platformModelRef),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .groupBy(agentProfiles.platformModelRef);
    const poolCounts = new Map(
      pooled.map((row) => [row.platformModelRef, row.coworkers]),
    );
    const pool = (await poolFor(database, plan.id, environment)).map((row) => ({
      ...row,
      coworkers: poolCounts.get(row.id) ?? 0,
    }));
    return context.json({
      models: rows.map((row) => ({
        ...row,
        coworkers: counts.get(row.id) ?? 0,
      })),
      templates,
      pool,
      // Whether this plan may connect models with its own key (K1); the screen gates the form on it.
      customModels: plan.limits.customModels,
    });
  });

  routes.post("/", requireUser, async (context) => {
    const body = await context.req.json<Record<string, string>>();
    const provider = (body.provider ?? "").trim();
    const modelName = (body.modelName ?? body.model ?? "").trim();
    const apiKey = (body.apiKey ?? "").trim();
    if (!provider || !modelName || !apiKey) {
      return context.json(
        { error: "provider、modelName 和 apiKey 均为必填项。" },
        400,
      );
    }
    const template = await database
      .select()
      .from(providerTemplates)
      .where(eq(providerTemplates.id, provider))
      .limit(1);
    if (!template[0]) {
      return context.json({ error: "未知的模型提供方模板。" }, 400);
    }
    const baseUrl = (body.baseUrl ?? "").trim();
    if (baseUrl && !template[0].allowsBaseUrl) {
      return context.json({ error: "该提供方不支持自定义接口地址。" }, 400);
    }
    /*
     * Refused before it is stored. This server will POST the tenant's key to this address, so an
     * address inside the deployment (or the metadata service, or plain http) never reaches the
     * database; the probe and every run check it again, with DNS, before sending anything.
     */
    if (baseUrl) {
      const verdict = checkOutboundUrl(baseUrl, outbound);
      if (!verdict.allowed) {
        return context.json({ error: verdict.reason }, 400);
      }
    }
    /*
     * Before the key is stored, not after.
     *
     * A refused connection that had already written a credential would leave an encrypted key in the
     * vault with no row pointing at it — invisible to the library screen, and revocable only by
     * somebody who knows the id the response never returned.
     */
    if (quota) {
      try {
        await quota.assertCapacity(context.var.actor.id, "customModels");
      } catch (thrown) {
        if (thrown instanceof QuotaExceeded) {
          return context.json(thrown.body, 402);
        }
        throw thrown;
      }
    }
    /*
     * The key is named after the library row it belongs to, not after the model (audit #9).
     *
     * `modelName` is the tenant's own text: as a vault key it collided with every other tenant
     * connecting the same model, and it shared a namespace with the deployment's
     * `credentialSecretRef`, so a tenant could name a model after it. Nothing reads a library key by
     * its name — the row's `credential_id` is the reference — so the id is the only name it needs.
     */
    const registryId = crypto.randomUUID();
    /*
     * ONE TRANSACTION FOR THE KEY AND THE ROW THAT POINTS AT IT.
     *
     * Two statements, two chances to die between them. Written in sequence, a process lost after the
     * first leaves an encrypted key in the vault with no library entry naming it — which is the exact
     * orphan the comment above refuses to create on a 402, arriving instead on a crash or on a
     * constraint nobody predicted. A key with no row cannot be listed, cannot be tested, and cannot
     * be revoked from any screen, because every screen starts from the row.
     */
    let row: typeof modelRegistry.$inferSelect | undefined;
    try {
      [row] = await database.transaction(async (transaction) => {
        await quota?.assertCapacityWithin(
          transaction,
          context.var.actor.id,
          "customModels",
        );
        const credential = await credentials.create(
          {
            kind: "model",
            provider,
            keyId: `${MODEL_REGISTRY_KEY_PREFIX}${registryId}`,
            seal: (binding) => sealCredential(encryptionKey, binding, apiKey),
            metadata: {},
          },
          transaction,
        );
        return await transaction
          .insert(modelRegistry)
          .values({
            id: registryId,
            provider,
            baseUrl: baseUrl || null,
            credentialId: credential.id,
            modelName,
            label: (body.label ?? "").trim() || null,
          })
          .returning();
      });
    } catch (error) {
      if (error instanceof QuotaExceeded) return context.json(error.body, 402);
      throw error;
    }
    return context.json({ model: { ...row, apiKey: mask(apiKey) } }, 201);
  });

  routes.post("/:id/test", requireUser, async (context) => {
    const id = context.req.param("id");
    const [row] = await database
      .select({
        provider: modelRegistry.provider,
        baseUrl: modelRegistry.baseUrl,
        modelName: modelRegistry.modelName,
        credentialId: modelRegistry.credentialId,
      })
      .from(modelRegistry)
      .where(eq(modelRegistry.id, id))
      .limit(1);
    if (!row?.credentialId) {
      return context.json({ error: "找不到该模型。" }, 404);
    }
    const secret = await credentials.readSecret(row.credentialId);
    if (!secret)
      return context.json({ ok: false, error: "密钥已被吊销。" }, 200);
    const apiKey = await openCredential(encryptionKey, secret);
    const answer = await probe(
      row.provider,
      row.baseUrl,
      row.modelName,
      apiKey,
      outbound,
    );
    // Refused before sending: the stored endpoint is not one this server will dial. A 4xx, so a
    // screen does not read it as the provider's own answer.
    const { refused, ...result } = answer;
    return context.json(result, refused ? 400 : 200);
  });

  routes.delete("/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    /*
     * A model a coworker still answers on is refused (audit #13), not silently unbound.
     *
     * `model_ref` is `on delete set null`, so without this check a delete that bypasses the screen
     * would quietly move every bound coworker onto the deployment's model. The row is locked first
     * (FOR UPDATE conflicts with the FK's KEY SHARE taken by a concurrent bind), so a bind either
     * commits before the count below sees it, or waits and then fails its FK after the delete.
     * Switching the model off (PATCH) remains the way to retire it without touching the bindings.
     */
    const outcome = await database.transaction(async (transaction) => {
      const [locked] = await transaction
        .select({ id: modelRegistry.id })
        .from(modelRegistry)
        .where(eq(modelRegistry.id, id))
        .for("update");
      if (!locked) return { kind: "missing" as const };
      const [usage] = await transaction
        .select({ value: count() })
        .from(agentProfiles)
        .where(
          and(eq(agentProfiles.modelRef, id), isNull(agentProfiles.deletedAt)),
        );
      const references = Number(usage?.value ?? 0);
      if (references > 0) return { kind: "in_use" as const, references };
      const [row] = await transaction
        .delete(modelRegistry)
        .where(eq(modelRegistry.id, id))
        .returning({
          id: modelRegistry.id,
          credentialId: modelRegistry.credentialId,
        });
      return row
        ? { kind: "removed" as const, removed: row }
        : { kind: "missing" as const };
    });
    if (outcome.kind === "missing") {
      return context.json({ error: "找不到该模型。" }, 404);
    }
    if (outcome.kind === "in_use") {
      return context.json(
        {
          error: `This model is still used by ${outcome.references} coworker(s); switch them to another model or turn the model off instead.`,
          code: "model_in_use",
          references: outcome.references,
        },
        409,
      );
    }
    const { removed } = outcome;
    /*
     * The key goes with the model.
     *
     * The row is what a person sees, and the vault row is the encrypted thing behind it; deleting one
     * and leaving the other would keep a working credential for a service they stopped using, with
     * nothing on any screen naming it. Revoked rather than deleted, so the audit rows that already
     * name this credential still resolve.
     */
    if (removed.credentialId) {
      await credentials
        .revoke(removed.credentialId)
        .catch((error) =>
          console.error(
            "model credential retire failed",
            removed.credentialId,
            error,
          ),
        );
    }
    return context.json({ ok: true });
  });

  /*
   * Switch a model off, or rename it on the shelf.
   *
   * Switching off is how a person retires a model without throwing away the coworkers bound to it:
   * the binding stays, the resolver refuses a disabled entry, and each of them answers on the
   * deployment's own model again until it is switched back. Deleting is refused while any are bound.
   */
  routes.patch("/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const patch: { enabled?: boolean; label?: string | null } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.label === null) patch.label = null;
    else if (typeof body.label === "string")
      patch.label = body.label.trim().slice(0, 80) || null;
    if (Object.keys(patch).length === 0) {
      return context.json({ error: "没有需要更改的内容。" }, 400);
    }
    const [row] = await database
      .update(modelRegistry)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(modelRegistry.id, id))
      .returning();
    if (!row) return context.json({ error: "找不到该模型。" }, 404);
    return context.json({ model: row });
  });

  /*
   * Which coworkers answer on this one, by name.
   *
   * Deleting a model that any of them still answers on is refused with 409 (`DELETE /:id`), so this
   * is the list a person needs to act on that refusal — a bare count cannot be acted on, because
   * acting on it means going to each specific coworker and rebinding it.
   *
   * A deleted coworker is not listed: its binding going changes nothing anybody will notice.
   */
  routes.get("/:id/references", requireUser, async (context) => {
    const id = context.req.param("id");
    const coworkers = await database
      .select({ id: agents.id, name: agents.name, title: agentProfiles.title })
      .from(agentProfiles)
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .where(
        and(eq(agentProfiles.modelRef, id), isNull(agentProfiles.deletedAt)),
      )
      .orderBy(agents.name);
    return context.json({ references: coworkers.length, coworkers });
  });

  return routes;
}

function mask(key: string): string {
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

/** How long a probe waits for a provider before calling it unreachable. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * One-token ping against whichever shape the template speaks.
 *
 * Exported for tests. Every request is `redirect: "manual"` with a deadline, and a redirect is an
 * answer rather than a hop, so the key never travels further than the host it was sent to. The
 * tenant-chosen base URL goes through {@link guardedFetch} (scheme, DNS, internal ranges); the two
 * fixed provider hosts are ours and are not resolved, but are not followed anywhere either.
 * `refused` means nothing was sent, and the route answers it with a 400.
 */
export async function probe(
  provider: string,
  baseUrl: string | null,
  modelName: string,
  apiKey: string,
  outbound: OutboundPolicy & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string; refused?: true }> {
  const timeoutMs = outbound.timeoutMs ?? PROBE_TIMEOUT_MS;
  const send = outbound.fetchImpl ?? fetch;
  const toFixedHost = async (url: string, init: RequestInit) => {
    const response = await send(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response;
  };
  const verdict = (response: Response, acceptBadRequest: boolean) =>
    response.status >= 300 && response.status < 400
      ? {
          ok: false,
          error: `HTTP ${response.status}（不跟随重定向）`,
        }
      : response.ok || (acceptBadRequest && response.status === 400)
        ? { ok: true }
        : { ok: false, error: `HTTP ${response.status}` };
  try {
    if (provider === "anthropic") {
      const response = await toFixedHost(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
      );
      return verdict(response, true);
    }
    if (provider === "google") {
      // The key in a header, never in the query string, where proxies and access logs keep it.
      const response = await toFixedHost(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
        },
      );
      return verdict(response, false);
    }
    const base =
      baseUrl ||
      (provider === "openai"
        ? "https://api.openai.com/v1"
        : provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : provider === "deepseek"
            ? "https://api.deepseek.com/v1"
            : "");
    if (!base) return { ok: false, error: "尚未配置接口地址。" };
    let response: Response;
    try {
      response = await guardedFetch(
        `${base.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
        { ...outbound, timeoutMs },
      );
    } catch (error) {
      if (error instanceof OutboundRefusedError) {
        // A redirect was answered and refused, not sent onward: the provider's answer, not ours.
        // A name that did not resolve is unreachable, not forbidden: a 200 with ok:false, so a
        // transient resolver error does not read as a policy refusal.
        return error.kind === "destination"
          ? { ok: false, error: error.message, refused: true }
          : { ok: false, error: error.message };
      }
      throw error;
    }
    await response.body?.cancel().catch(() => undefined);
    return verdict(response, true);
  } catch (error) {
    // Never the thrown value's text verbatim beyond its kind: a fetch error can repeat the URL.
    const name = error instanceof Error ? error.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError" || name === "AbortError"
          ? "模型提供方未在规定时间内响应。"
          : `${name}：无法连接模型提供方。`,
    };
  }
}

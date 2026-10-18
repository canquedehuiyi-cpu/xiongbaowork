import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { CredentialSecretReader, CredentialStore } from "../credentials";
import { encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  modelRegistry,
  providerTemplates,
} from "../db/schema";
import type { QuotaService } from "../quota/limits";
import { QuotaExceeded } from "../quota/limits";

type Ctx = { Variables: AppVariables };

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
) {
  const routes = new Hono<Ctx>();

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
    return context.json({
      models: rows.map((row) => ({
        ...row,
        coworkers: counts.get(row.id) ?? 0,
      })),
      templates,
    });
  });

  routes.post("/", requireUser, async (context) => {
    const body = await context.req.json<Record<string, string>>();
    const provider = (body.provider ?? "").trim();
    const modelName = (body.modelName ?? body.model ?? "").trim();
    const apiKey = (body.apiKey ?? "").trim();
    if (!provider || !modelName || !apiKey) {
      return context.json(
        { error: "provider, modelName and apiKey are all required." },
        400,
      );
    }
    const template = await database
      .select()
      .from(providerTemplates)
      .where(eq(providerTemplates.id, provider))
      .limit(1);
    if (!template[0]) {
      return context.json({ error: "Unknown provider template." }, 400);
    }
    const baseUrl = (body.baseUrl ?? "").trim();
    if (baseUrl && !template[0].allowsBaseUrl) {
      return context.json(
        { error: "This provider does not take a custom endpoint." },
        400,
      );
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
    const encrypted = await encryptSecret(encryptionKey, apiKey);
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
            keyId: modelName,
            encryptedValue: encrypted,
            metadata: {},
          },
          transaction,
        );
        return await transaction
          .insert(modelRegistry)
          .values({
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
      return context.json({ error: "No such model." }, 404);
    }
    const secret = await credentials.readSecret(row.credentialId);
    if (!secret) return context.json({ ok: false, error: "Key revoked." }, 200);
    const { decryptSecret } = await import("../credentials");
    const apiKey = await decryptSecret(encryptionKey, secret.encryptedValue);
    const answer = await probe(
      row.provider,
      row.baseUrl,
      row.modelName,
      apiKey,
    );
    return context.json(answer, 200);
  });

  routes.delete("/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    const [removed] = await database
      .delete(modelRegistry)
      .where(eq(modelRegistry.id, id))
      .returning({
        id: modelRegistry.id,
        credentialId: modelRegistry.credentialId,
      });
    if (!removed) return context.json({ error: "No such model." }, 404);
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
   * deployment's own model again until it is switched back. Deleting would take the binding with it.
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
      return context.json({ error: "Nothing to change." }, 400);
    }
    const [row] = await database
      .update(modelRegistry)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(modelRegistry.id, id))
      .returning();
    if (!row) return context.json({ error: "No such model." }, 404);
    return context.json({ model: row });
  });

  /*
   * Which coworkers answer on this one, by name.
   *
   * Deleting a model unbinds them rather than breaking them (`model_ref` is `on delete set null`, and
   * an unbound coworker falls back to the deployment's model), so this is not a guard but the notice
   * that lets a person expect the change — and a bare count would be a notice that cannot be acted
   * on, because acting on it means going to each specific coworker and rebinding it.
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

/** One-token ping against whichever shape the template speaks. */
async function probe(
  provider: string,
  baseUrl: string | null,
  modelName: string,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
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
      });
      return response.ok || response.status === 400
        ? { ok: true }
        : { ok: false, error: `HTTP ${response.status}` };
    }
    if (provider === "google") {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
        },
      );
      return response.ok
        ? { ok: true }
        : { ok: false, error: `HTTP ${response.status}` };
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
    if (!base) return { ok: false, error: "No endpoint configured." };
    const response = await fetch(
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
    );
    return response.ok || response.status === 400
      ? { ok: true }
      : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

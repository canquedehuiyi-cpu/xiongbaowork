import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CredentialSecretReader } from "../credentials";
import { openCredential } from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  credentials as credentialRows,
  modelRegistry,
  PLATFORM_POOL_KEY_ENV,
  platformModelPool,
  subscriptions,
} from "../db/schema";
import { PLATFORM_TENANT, TEAM_TENANT } from "../db/schema/tenant";
import { createGuardedFetch, type OutboundPolicy } from "../net/outbound-guard";
import {
  currentTenant,
  isPersonTenant,
  isTenantFramed,
  runAsTenant,
  TenantContextError,
} from "../tenant/context";
import {
  databaseTokenCallSink,
  type ModelTokenCallSink,
  meteredLanguageModel,
  sha256Hex,
} from "./token-metering";

/**
 * Per-coworker model binding (ticket 012): the profile's `model_ref` decides
 * which language model that one coworker's runs speak with, while everything
 * else about the run -- tools, grants, policy -- is untouched. A profile with
 * no binding, or a binding whose credential was revoked, falls back to the
 * deployment default rather than failing the turn: an employee answering in
 * the house model is a degradation, a silent refusal is a broken product.
 */
export type AgentModelResolver = (
  agentId: string,
  /**
   * The deployment's own model, already built, for a coworker with no binding. Given, an unbound
   * coworker answers on it METERED (audit defect #11); absent, an unbound coworker resolves to
   * `null` and the runtime builds the deployment model itself, unmetered, as it always did.
   */
  deployment?: DeploymentModel,
) => Promise<LanguageModel | null>;

/**
 * The deployment default model as a run will speak it: built by the runtime from the deployment's
 * `provider/model` and key, exactly as it would otherwise build it from the string, so metering it
 * changes nothing about where the call goes. Everything but `model` and `apiKey` is non-secret, and
 * `apiKey` is read only to digest it.
 */
export type DeploymentModel = {
  model: LanguageModel;
  provider: string;
  modelName: string;
  /** The endpoint the deployment's environment points that provider at, when it names one. */
  baseUrl: string | null;
  apiKey: string;
};

/**
 * The `model_ref` and `credential_id` of a call on the deployment default: the nil UUID, because that
 * call is made through no model-library row and no vault row. Both columns are NOT NULL and carry no
 * foreign key, so a reader tells a default-model call from a bound one by this value.
 */
export const DEPLOYMENT_MODEL_REF = "00000000-0000-0000-0000-000000000000";

/** What a coworker is bound to, before the key behind it is touched. */
type LibraryBinding = {
  kind: "library";
  /** The tenant stamped on the binding's own rows; metering is written under it. */
  tenantId: string;
  modelRef: string;
  provider: string;
  baseUrl: string | null;
  modelName: string;
  credentialId: string;
};

/**
 * A platform pool model (stories H1, K1): the platform's key, the coworker's tenant. Metering is
 * written under the PROFILE's tenant, never `system` or `platform`, because that is who spent it.
 */
type PoolBinding = {
  kind: "pool";
  tenantId: string;
  poolId: string;
  provider: string;
  baseUrl: string | null;
  modelName: string;
  apiKeyEnv: string;
  apiKey: string;
};

type Binding = LibraryBinding | PoolBinding;

/** Where a pool row's key is read from; tests pass their own instead of the process's. */
export type PoolKeyEnvironment = Readonly<Record<string, string | undefined>>;

/** Builds the provider client; tests inject a fake so no provider is ever called. */
export type LanguageModelFactory = (
  provider: string,
  baseUrl: string | null,
  modelName: string,
  apiKey: string,
) => LanguageModel;

export type AgentModelResolverOptions = {
  environment?: PoolKeyEnvironment;
  languageModel?: LanguageModelFactory;
  /**
   * Where a TENANT's library base URL may point (audit defect #6), passed to {@link languageModelFor}
   * for library bindings only. A platform pool row's base URL is the operator's (rows are written by
   * the operator, never by a tenant route), so it is not held to the tenant policy.
   */
  outbound?: OutboundPolicy;
};

const OPENAI_COMPATIBLE_DEFAULTS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  moonshot: "https://api.moonshot.cn/v1",
};

export function languageModelFor(
  provider: string,
  baseUrl: string | null,
  modelName: string,
  apiKey: string,
  /**
   * Where a tenant's base URL may point (audit defect #6). Applied to every request the SDK makes to
   * a tenant-chosen endpoint: checked, resolved, never redirected. No deadline here — a streamed
   * answer is legitimately long, and the run's own abort signal still applies.
   */
  outbound: OutboundPolicy = {},
): LanguageModel {
  if (provider === "anthropic") {
    return createAnthropic({ apiKey })(modelName);
  }
  if (provider === "google") {
    return createGoogleGenerativeAI({ apiKey })(modelName);
  }
  if (provider === "openai" && !baseUrl) {
    return createOpenAI({ apiKey })(modelName);
  }
  // OpenAI-shaped endpoints: an explicit base URL, or the template's known one.
  const baseURL =
    baseUrl ||
    OPENAI_COMPATIBLE_DEFAULTS[provider] ||
    "https://api.openai.com/v1";
  return createOpenAICompatible({
    name: provider,
    baseURL,
    apiKey,
    includeUsage: true,
    ...(baseUrl ? { fetch: createGuardedFetch(outbound) } : {}),
  }).chatModel(modelName);
}

/**
 * The binding row for one coworker, decided without touching the vault.
 *
 * `null` for a coworker with no binding, and for a binding that is disabled, missing, revoked, or
 * somebody else's. The tenancy comparison is not redundant with row-level security: a question asked
 * under `platform` — an admin's controls, background work that has not yet narrowed to its owner —
 * sees every tenant's rows, and a foreign key is not stopped by row-level security, so a binding that
 * points across that line would otherwise be honoured. Headless turns no longer read as `system`:
 * background work runs in its row's owner frame, and a read with no frame at all is a bug that the
 * frame guard turns into a `TenantContextError`, which the resolver below passes on rather than
 * treating as "unbound".
 */
async function bindingFor(
  database: Database,
  agentId: string,
  environment: PoolKeyEnvironment,
): Promise<Binding | null> {
  return (
    (await bindingsFor(database, [agentId], environment)).get(agentId) ?? null
  );
}

/**
 * {@link bindingFor} for many coworkers in a fixed number of reads: one for the profiles, one for the
 * library rows, one for the pool rows, and one plan read per paying tenant. Every coworker asked about
 * is in the map, `null` where it has no usable binding. The decision per coworker is exactly
 * {@link bindingFor}'s.
 */
async function bindingsFor(
  database: Database,
  agentIds: readonly string[],
  environment: PoolKeyEnvironment,
): Promise<Map<string, Binding | null>> {
  const ids = [...new Set(agentIds)];
  const result = new Map<string, Binding | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return result;
  const profiles = await database
    .select({
      agentId: agentProfiles.agentId,
      tenantId: agentProfiles.tenantId,
      ownerUserId: agentProfiles.ownerUserId,
      modelRef: agentProfiles.modelRef,
      platformModelRef: agentProfiles.platformModelRef,
    })
    .from(agentProfiles)
    .where(inArray(agentProfiles.agentId, ids));

  /** What each coworker would be bound to, before the rows behind it are read. */
  const library: {
    agentId: string;
    modelRef: string;
    expected: string | null;
  }[] = [];
  const pool: { agentId: string; payer: string; poolId: string }[] = [];
  for (const profile of profiles) {
    /*
     * A TEAM Bot (G01-E, plan §2.4) is stamped `team`, which is nobody and cannot be billed. Its
     * owner's private library model is the owner's key, so it is used only when the owner is the one
     * asking; a teammate falls back to the deployment default. A pool model is paid by whoever invokes
     * it — the person in the frame — and under `platform` (background work) by the owner.
     */
    const team = profile.tenantId === TEAM_TENANT;
    // Asked only for a team Bot: a private Bot's binding never depends on who is asking.
    const frame = team ? currentTenant() : "";
    const owner = isPersonTenant(profile.ownerUserId)
      ? profile.ownerUserId
      : null;
    if (!profile.modelRef) {
      if (!profile.platformModelRef) continue;
      const payer = !team
        ? profile.tenantId
        : isPersonTenant(frame)
          ? frame
          : frame === PLATFORM_TENANT
            ? owner
            : null;
      // A tenant that is nobody's gets no pool model: its calls could not be metered to anybody.
      if (payer && isPersonTenant(payer))
        pool.push({
          agentId: profile.agentId,
          payer,
          poolId: profile.platformModelRef,
        });
      continue;
    }
    if (team && (!owner || frame !== owner)) continue;
    library.push({
      agentId: profile.agentId,
      modelRef: profile.modelRef,
      expected: team ? owner : profile.tenantId,
    });
  }

  if (library.length > 0) {
    const entries = new Map(
      (
        await database
          .select({
            id: modelRegistry.id,
            tenantId: modelRegistry.tenantId,
            provider: modelRegistry.provider,
            baseUrl: modelRegistry.baseUrl,
            modelName: modelRegistry.modelName,
            credentialId: modelRegistry.credentialId,
            enabled: modelRegistry.enabled,
          })
          .from(modelRegistry)
          .where(
            inArray(modelRegistry.id, [
              ...new Set(library.map((wanted) => wanted.modelRef)),
            ]),
          )
      ).map((entry) => [entry.id, entry]),
    );
    for (const wanted of library) {
      const entry = entries.get(wanted.modelRef);
      if (!entry?.enabled || !entry.credentialId) continue;
      if (entry.tenantId !== wanted.expected) continue;
      result.set(wanted.agentId, {
        kind: "library",
        tenantId: entry.tenantId,
        modelRef: wanted.modelRef,
        provider: entry.provider,
        baseUrl: entry.baseUrl,
        modelName: entry.modelName,
        credentialId: entry.credentialId,
      });
    }
  }

  if (pool.length > 0) {
    const entries = new Map(
      (
        await database
          .select({
            id: platformModelPool.id,
            provider: platformModelPool.provider,
            baseUrl: platformModelPool.baseUrl,
            modelName: platformModelPool.modelName,
            apiKeyEnv: platformModelPool.apiKeyEnv,
            tiers: platformModelPool.tiers,
            enabled: platformModelPool.enabled,
          })
          .from(platformModelPool)
          .where(
            inArray(platformModelPool.id, [
              ...new Set(pool.map((wanted) => wanted.poolId)),
            ]),
          )
      ).map((entry) => [entry.id, entry]),
    );
    const plans = new Map<string, string>();
    for (const wanted of pool) {
      const binding = await poolBindingFrom(
        entries.get(wanted.poolId),
        wanted.payer,
        environment,
        async (tenantId) => {
          let plan = plans.get(tenantId);
          if (plan === undefined) {
            plan = await planIdFor(database, tenantId);
            plans.set(tenantId, plan);
          }
          return plan;
        },
      );
      result.set(wanted.agentId, binding);
    }
  }
  return result;
}

/**
 * The plan the tenant is on, read under that tenant's own frame: the newest active subscription, and
 * Free when there is none (audit #7: an absent row is never "no limit", and never Pro).
 */
async function planIdFor(
  database: Database,
  tenantId: string,
): Promise<string> {
  const [row] = await runAsTenant(tenantId, () =>
    database
      .select({ planId: subscriptions.planId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenantId, tenantId),
          eq(subscriptions.status, "active"),
        ),
      )
      .orderBy(
        desc(subscriptions.updatedAt),
        desc(subscriptions.createdAt),
        desc(subscriptions.id),
      )
      .limit(1),
  );
  return row?.planId ?? "free";
}

/**
 * A pool binding, or `null` for every reason it may not hold: the row is gone or switched off, the
 * tenant's plan is not one of the row's tiers, the row names no pool key, or the deployment has no
 * value for that key. Each of those falls back to the deployment default, as a library binding does.
 * A tenant that is nobody's (`system`, `platform`, `team`) gets none: its calls could not be metered
 * to anybody. The plan is asked only for a row that is switched on.
 */
async function poolBindingFrom(
  entry:
    | {
        id: string;
        provider: string;
        baseUrl: string | null;
        modelName: string;
        apiKeyEnv: string;
        tiers: unknown;
        enabled: boolean;
      }
    | undefined,
  tenantId: string,
  environment: PoolKeyEnvironment,
  planOf: (tenantId: string) => Promise<string>,
): Promise<PoolBinding | null> {
  if (!isPersonTenant(tenantId)) return null;
  if (!entry?.enabled) return null;
  const plan = await planOf(tenantId);
  if (!(entry.tiers as readonly string[]).includes(plan)) return null;
  // The CHECK already holds this; asking again keeps a row from ever naming DATABASE_URL.
  if (!PLATFORM_POOL_KEY_ENV.test(entry.apiKeyEnv)) return null;
  const apiKey = environment[entry.apiKeyEnv];
  if (!apiKey) return null;
  return {
    kind: "pool",
    tenantId,
    poolId: entry.id,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    modelName: entry.modelName,
    apiKeyEnv: entry.apiKeyEnv,
    apiKey,
  };
}

/** Which row a coworker's run will speak through: a library entry, a platform pool row, or neither. */
export type BindingRef =
  | { kind: "library"; modelRef: string }
  | { kind: "pool"; poolId: string };

/**
 * What each coworker's run will be bound to, by the same decision the runtime makes (`bindingsFor`,
 * with {@link poolBindingFrom}'s eligibility for a pool row: switched on, open to the payer's plan, a
 * key configured), read without touching any key. `null` means the run falls back to the deployment's
 * model, so a display (the conversation sidebar) names that one rather than a binding the run will not
 * use. A library binding whose vault row is gone or revoked is also `null`, as {@link boundModelName}
 * reads it.
 */
export async function bindingRefsFor(
  database: Database,
  agentIds: readonly string[],
  environment: PoolKeyEnvironment = process.env,
): Promise<Map<string, BindingRef | null>> {
  const bindings = await bindingsFor(database, agentIds, environment);
  const library = [...bindings.values()].flatMap((binding) =>
    binding?.kind === "library" ? [binding.credentialId] : [],
  );
  // A vault row that is gone or revoked names nothing, as in boundModelName.
  const usable = new Set(
    library.length > 0
      ? (
          await database
            .select({
              id: credentialRows.id,
              revokedAt: credentialRows.revokedAt,
            })
            .from(credentialRows)
            .where(inArray(credentialRows.id, [...new Set(library)]))
        ).flatMap((row) => (row.revokedAt ? [] : [row.id]))
      : [],
  );
  return new Map(
    [...bindings].map(([agentId, binding]) => [
      agentId,
      !binding
        ? null
        : binding.kind === "pool"
          ? { kind: "pool", poolId: binding.poolId }
          : usable.has(binding.credentialId)
            ? { kind: "library", modelRef: binding.modelRef }
            : null,
    ]),
  );
}

/**
 * The model this coworker is bound to, in the `provider/model` shape the deployment's own model and
 * the administrator's allowlist both use — for the usage record and the allowlist check, which need
 * a NAME and must not be given the deployment's instead. Reading one costs no key.
 *
 * A binding whose vault row is gone or revoked names nothing, as the resolver below builds nothing for
 * it: the run speaks the deployment's model, and that is the one to record (story H4). Only a key that
 * will not decrypt is beyond this read; {@link createNamedAgentModelResolver} answers that too.
 */
export async function boundModelName(
  database: Database,
  agentId: string,
  environment: PoolKeyEnvironment = process.env,
): Promise<string | null> {
  try {
    const binding = await bindingFor(database, agentId, environment);
    if (!binding) return null;
    if (binding.kind === "library") {
      const [secret] = await database
        .select({ revokedAt: credentialRows.revokedAt })
        .from(credentialRows)
        .where(eq(credentialRows.id, binding.credentialId))
        .limit(1);
      if (!secret || secret.revokedAt) return null;
    }
    return `${binding.provider}/${binding.modelName}`;
  } catch {
    // Never log the thrown value: database errors can contain connection details or row contents.
    return null;
  }
}

/**
 * The tenant a run of this coworker started in the current frame writes its `model_token_calls` rows
 * under, decided as the resolver below decides it: a usable library binding meters under the library
 * row's tenant, a pool binding under its payer, and anything that falls back to the deployment default
 * under the frame itself (`meteredDeploymentModel`). Null when that is nobody (the frame is not a
 * person's). Reads no key: a binding whose vault row is gone or revoked falls back, as the run does.
 *
 * For readers of usage (the conversation sidebar), which must look for a coworker's calls where they
 * were written, not where the person asking happens to be. It follows the CURRENT binding: calls made
 * under an earlier binding in another tenant are not where this points.
 */
export async function meteringTenantFor(
  database: Database,
  agentId: string,
  environment: PoolKeyEnvironment = process.env,
): Promise<string | null> {
  return (
    (await meteringTenantsFor(database, [agentId], environment)).get(agentId) ??
    null
  );
}

/** {@link meteringTenantFor} for many coworkers, in a fixed number of reads. */
export async function meteringTenantsFor(
  database: Database,
  agentIds: readonly string[],
  environment: PoolKeyEnvironment = process.env,
): Promise<Map<string, string | null>> {
  const bindings = await bindingsFor(database, agentIds, environment).catch(
    (error) => {
      if (error instanceof TenantContextError) throw error;
      return new Map<string, Binding | null>();
    },
  );
  const credentialIds = [
    ...new Set(
      [...bindings.values()].flatMap((binding) =>
        binding?.kind === "library" ? [binding.credentialId] : [],
      ),
    ),
  ];
  const usable = new Set(
    credentialIds.length > 0
      ? (
          await database
            .select({
              id: credentialRows.id,
              revokedAt: credentialRows.revokedAt,
            })
            .from(credentialRows)
            .where(inArray(credentialRows.id, credentialIds))
        )
          .filter((secret) => !secret.revokedAt)
          .map((secret) => secret.id)
      : [],
  );
  const frame = currentTenant();
  const fallback = isPersonTenant(frame) ? frame : null;
  return new Map(
    [...new Set(agentIds)].map((agentId) => {
      const binding = bindings.get(agentId);
      if (binding?.kind === "pool") return [agentId, binding.tenantId];
      if (binding?.kind === "library" && usable.has(binding.credentialId))
        return [agentId, binding.tenantId];
      return [agentId, fallback];
    }),
  );
}

/** The model a coworker's run will speak with, and its `provider/model` name, decided together. */
export type ResolvedAgentModel = { model: LanguageModel; name: string };

/**
 * The resolver, with the name of what it resolved.
 *
 * The name is taken from the SAME decision that built the model, so a usage record cannot name a bound
 * model while the run spoke the deployment's: a revoked key, a credential that will not decrypt, a
 * vault row that is gone — each answers `null` here exactly when the turn falls back to the default.
 * {@link boundModelName} reads the rows without the key, so it would still name the binding for a key
 * that will not decrypt.
 *
 * Every call a bound model makes is metered into `model_token_calls` (see `./token-metering`).
 * `sink` exists for tests; production writes to the same database the binding was read from.
 */
export function createNamedAgentModelResolver(
  database: Database,
  credentials: CredentialSecretReader,
  encryptionKey: string,
  sink: ModelTokenCallSink = databaseTokenCallSink(database),
  options: AgentModelResolverOptions = {},
): (agentId: string) => Promise<ResolvedAgentModel | null> {
  const environment = options.environment ?? process.env;
  const outbound = options.outbound ?? {};
  // A library binding's base URL is the tenant's, so the default factory holds it to the guard.
  const libraryModel: LanguageModelFactory =
    options.languageModel ??
    ((provider, baseUrl, modelName, apiKey) =>
      languageModelFor(provider, baseUrl, modelName, apiKey, outbound));
  const poolLanguageModel = options.languageModel ?? languageModelFor;
  return async (agentId) => {
    // A binding that will not read falls back to the deployment's model, but a missing tenant frame
    // is the caller's bug and must not pass as "unbound".
    const binding = await bindingFor(database, agentId, environment).catch(
      (error) => {
        if (error instanceof TenantContextError) throw error;
        return null;
      },
    );
    if (!binding) return null;
    if (binding.kind === "pool") {
      return poolModel(binding, agentId, poolLanguageModel, sink);
    }
    const secret = await credentials
      .readSecret(binding.credentialId)
      .catch(() => null);
    if (!secret || secret.revokedAt) return null;
    try {
      const apiKey = await openCredential(encryptionKey, secret);
      const originalText = `${binding.provider}/${binding.modelName}`;
      const model = meteredLanguageModel(
        libraryModel(
          binding.provider,
          binding.baseUrl,
          binding.modelName,
          apiKey,
        ),
        {
          tenantId: binding.tenantId,
          agentId,
          modelRef: binding.modelRef,
          provider: binding.provider,
          modelName: binding.modelName,
          credentialId: binding.credentialId,
          // Of the stored ciphertext, so it moves when the key is rotated and never sees the key.
          credentialDigest: sha256Hex(
            `${binding.credentialId}:${secret.encryptedValue}`,
          ),
          originalModelFingerprint: sha256Hex(
            JSON.stringify([
              binding.provider,
              binding.baseUrl,
              binding.modelName,
            ]),
          ),
          originalText,
        },
        sink,
      );
      return { model, name: originalText };
    } catch {
      // A bad key costs the binding, not the conversation.
      return null;
    }
  };
}

/** A pool binding as a metered model: the platform's key, the profile tenant's usage row. */
function poolModel(
  binding: PoolBinding,
  agentId: string,
  languageModel: LanguageModelFactory,
  sink: ModelTokenCallSink,
): ResolvedAgentModel | null {
  try {
    const name = `${binding.provider}/${binding.modelName}`;
    const model = meteredLanguageModel(
      languageModel(
        binding.provider,
        binding.baseUrl,
        binding.modelName,
        binding.apiKey,
      ),
      {
        tenantId: binding.tenantId,
        agentId,
        modelRef: binding.poolId,
        provider: binding.provider,
        modelName: binding.modelName,
        credentialId: binding.poolId,
        // Moves when the operator rotates the key or renames its variable; never carries the key.
        credentialDigest: sha256Hex(
          `pool:${binding.poolId}:${binding.apiKeyEnv}:${sha256Hex(binding.apiKey)}`,
        ),
        originalModelFingerprint: sha256Hex(
          JSON.stringify([
            binding.provider,
            binding.baseUrl,
            binding.modelName,
          ]),
        ),
        originalText: name,
      },
      sink,
    );
    return { model, name };
  } catch {
    // A provider client that cannot be built costs the binding, not the conversation.
    return null;
  }
}

export function createAgentModelResolver(
  database: Database,
  credentials: CredentialSecretReader,
  encryptionKey: string,
  sink: ModelTokenCallSink = databaseTokenCallSink(database),
  options: AgentModelResolverOptions = {},
): AgentModelResolver {
  return modelOf(
    createNamedAgentModelResolver(
      database,
      credentials,
      encryptionKey,
      sink,
      options,
    ),
    sink,
  );
}

/**
 * The runtime's view of a named resolver: the model alone.
 *
 * With a `sink`, a coworker the named resolver leaves unbound — no binding, or one that fell back —
 * answers on the deployment model the runtime hands in, metered into that sink (audit defect #11).
 * The named resolver itself still answers `null` for it, so the usage record and the allowlist keep
 * naming the deployment's model, as they always did.
 */
export function modelOf(
  resolve: (agentId: string) => Promise<ResolvedAgentModel | null>,
  sink?: ModelTokenCallSink,
): AgentModelResolver {
  return async (agentId, deployment) => {
    const bound = (await resolve(agentId))?.model;
    if (bound) return bound;
    if (!deployment || !sink) return null;
    return meteredDeploymentModel(deployment, agentId, sink);
  };
}

/**
 * The deployment default model, metered to the person whose run it is.
 *
 * There is no binding row to take a tenant from, so the row belongs to the frame the run is built in:
 * the person asking, or the owner a routine's headless turn runs as (G01-E). That is also who a pool
 * call on a shared Bot is charged to. Outside a person's frame (`platform`) the call has nobody to be
 * metered to, so the model is returned as it is and the run still answers — the sink would refuse
 * such a row anyway.
 */
export function meteredDeploymentModel(
  deployment: DeploymentModel,
  agentId: string,
  sink: ModelTokenCallSink,
): LanguageModel {
  const tenantId = isTenantFramed() ? currentTenant() : "";
  if (!isPersonTenant(tenantId)) return deployment.model;
  const originalText = `${deployment.provider}/${deployment.modelName}`;
  return meteredLanguageModel(
    deployment.model,
    {
      tenantId,
      agentId,
      modelRef: DEPLOYMENT_MODEL_REF,
      provider: deployment.provider,
      modelName: deployment.modelName,
      credentialId: DEPLOYMENT_MODEL_REF,
      // Moves when the deployment's key is rotated; a digest of a digest, never the key.
      credentialDigest: sha256Hex(
        `deployment:${deployment.provider}:${sha256Hex(deployment.apiKey)}`,
      ),
      originalModelFingerprint: sha256Hex(
        JSON.stringify([
          deployment.provider,
          deployment.baseUrl,
          deployment.modelName,
        ]),
      ),
      originalText,
    },
    sink,
  );
}

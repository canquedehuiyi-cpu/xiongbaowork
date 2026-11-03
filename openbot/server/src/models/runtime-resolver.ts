import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { and, desc, eq } from "drizzle-orm";
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
import {
  currentTenant,
  isPersonTenant,
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
) => Promise<LanguageModel | null>;

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
  const [profile] = await database
    .select({
      tenantId: agentProfiles.tenantId,
      ownerUserId: agentProfiles.ownerUserId,
      modelRef: agentProfiles.modelRef,
      platformModelRef: agentProfiles.platformModelRef,
    })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  if (!profile) return null;
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
    if (!profile.platformModelRef) return null;
    const payer = !team
      ? profile.tenantId
      : isPersonTenant(frame)
        ? frame
        : frame === PLATFORM_TENANT
          ? owner
          : null;
    return payer
      ? poolBindingFor(database, payer, profile.platformModelRef, environment)
      : null;
  }
  if (team && (!owner || frame !== owner)) return null;
  const [entry] = await database
    .select({
      tenantId: modelRegistry.tenantId,
      provider: modelRegistry.provider,
      baseUrl: modelRegistry.baseUrl,
      modelName: modelRegistry.modelName,
      credentialId: modelRegistry.credentialId,
      enabled: modelRegistry.enabled,
    })
    .from(modelRegistry)
    .where(eq(modelRegistry.id, profile.modelRef))
    .limit(1);
  if (!entry?.enabled || !entry.credentialId) return null;
  if (entry.tenantId !== (team ? owner : profile.tenantId)) return null;
  return {
    kind: "library",
    tenantId: entry.tenantId,
    modelRef: profile.modelRef,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    modelName: entry.modelName,
    credentialId: entry.credentialId,
  };
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
 * to anybody.
 */
async function poolBindingFor(
  database: Database,
  tenantId: string,
  poolId: string,
  environment: PoolKeyEnvironment,
): Promise<PoolBinding | null> {
  if (!isPersonTenant(tenantId)) return null;
  const [entry] = await database
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
    .where(eq(platformModelPool.id, poolId))
    .limit(1);
  if (!entry?.enabled) return null;
  const plan = await planIdFor(database, tenantId);
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
  const languageModel = options.languageModel ?? languageModelFor;
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
      return poolModel(binding, agentId, languageModel, sink);
    }
    const secret = await credentials
      .readSecret(binding.credentialId)
      .catch(() => null);
    if (!secret || secret.revokedAt) return null;
    try {
      const apiKey = await openCredential(encryptionKey, secret);
      const originalText = `${binding.provider}/${binding.modelName}`;
      const model = meteredLanguageModel(
        languageModel(
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
  );
}

/** The runtime's view of a named resolver: the model alone. */
export function modelOf(
  resolve: (agentId: string) => Promise<ResolvedAgentModel | null>,
): AgentModelResolver {
  return async (agentId) => (await resolve(agentId))?.model ?? null;
}

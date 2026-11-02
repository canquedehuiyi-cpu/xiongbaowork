import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import type { CredentialSecretReader } from "../credentials";
import { decryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { agentProfiles, credentials, modelRegistry } from "../db/schema";

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
type Binding = {
  provider: string;
  baseUrl: string | null;
  modelName: string;
  credentialId: string;
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
 * somebody else's. The tenancy comparison is not redundant with row-level security: a headless turn —
 * a routine at three in the morning, a hop delivery — reads as `system`, which sees every tenant's
 * rows, so a binding that reaches across that line would otherwise be honoured.
 */
async function bindingFor(
  database: Database,
  agentId: string,
): Promise<Binding | null> {
  const [profile] = await database
    .select({
      tenantId: agentProfiles.tenantId,
      modelRef: agentProfiles.modelRef,
    })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  if (!profile?.modelRef) return null;
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
  if (entry.tenantId !== profile.tenantId) return null;
  return {
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    modelName: entry.modelName,
    credentialId: entry.credentialId,
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
): Promise<string | null> {
  try {
    const binding = await bindingFor(database, agentId);
    if (!binding) return null;
    const [secret] = await database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, binding.credentialId))
      .limit(1);
    if (!secret || secret.revokedAt) return null;
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
 */
export function createNamedAgentModelResolver(
  database: Database,
  credentials: CredentialSecretReader,
  encryptionKey: string,
): (agentId: string) => Promise<ResolvedAgentModel | null> {
  return async (agentId) => {
    const binding = await bindingFor(database, agentId).catch(() => null);
    if (!binding) return null;
    const secret = await credentials
      .readSecret(binding.credentialId)
      .catch(() => null);
    if (!secret || secret.revokedAt) return null;
    try {
      const apiKey = await decryptSecret(encryptionKey, secret.encryptedValue);
      return {
        model: languageModelFor(
          binding.provider,
          binding.baseUrl,
          binding.modelName,
          apiKey,
        ),
        name: `${binding.provider}/${binding.modelName}`,
      };
    } catch {
      // A bad key costs the binding, not the conversation.
      return null;
    }
  };
}

export function createAgentModelResolver(
  database: Database,
  credentials: CredentialSecretReader,
  encryptionKey: string,
): AgentModelResolver {
  return modelOf(
    createNamedAgentModelResolver(database, credentials, encryptionKey),
  );
}

/** The runtime's view of a named resolver: the model alone. */
export function modelOf(
  resolve: (agentId: string) => Promise<ResolvedAgentModel | null>,
): AgentModelResolver {
  return async (agentId) => (await resolve(agentId))?.model ?? null;
}

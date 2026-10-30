import type { RuntimeModel } from "../copilot";
import type { AgentModelResolver } from "./runtime-resolver";
import { languageModelFor } from "./runtime-resolver";

export class DedicatedModelConfigurationError extends Error {
  constructor() {
    super("Dedicated DeepSeek deployment configuration is unavailable or incompatible.");
    this.name = "DedicatedModelConfigurationError";
  }
}

/** A single selection seals the upstream, endpoint, model and credential source together. */
export function effectiveDeploymentModel(
  original: RuntimeModel,
  environment: Record<string, string | undefined>,
) {
  const selection = environment.OPENBOT_MODEL_UPSTREAM?.trim();
  if (!selection) return undefined;
  if (selection !== "deepseek" || original.plan)
    throw new DedicatedModelConfigurationError();
  const readApiKey = async (): Promise<string> => {
    const key = environment.DEEPSEEK_API_KEY?.trim();
    if (!key) throw new DedicatedModelConfigurationError();
    return key;
  };
  const model: RuntimeModel = Object.freeze({
    ...original,
    provider: "openai",
    defaultModel: "deepseek-flash",
  });
  return Object.freeze({
    upstream: "deepseek" as const,
    baseUrl: "https://api.deepseek.com" as const,
    modelName: "deepseek-flash" as const,
    credentialSource: "DEEPSEEK_API_KEY" as const,
    model,
    resolveApiKey: readApiKey,
    wrapAgentResolver(existing: AgentModelResolver): AgentModelResolver {
      return async (agentId) => {
        // A valid employee binding retains its own SDK/key, never this default credential.
        try {
          const bound = await existing(agentId);
          if (bound) return bound;
          return languageModelFor(
            "deepseek",
            "https://api.deepseek.com",
            "deepseek-flash",
            await readApiKey(),
          );
        } catch {
          throw new DedicatedModelConfigurationError();
        }
      };
    },
  });
}

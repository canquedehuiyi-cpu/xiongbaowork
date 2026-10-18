import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One model this person has connected: which provider template it came through, where to dial, and
 * which model to ask for.
 *
 * No key material, ever. The server answers with a masked tail at most, and this list exists so a
 * coworker can be pointed at one of these and so a person can see who already uses it before they
 * switch one off.
 */
export type ConnectedModel = {
  id: string;
  provider: string;
  baseUrl: string | null;
  modelName: string;
  label: string | null;
  enabled: boolean;
  updatedAt: string;
  /** How many coworkers answer on this one — the reason a row cannot be deleted carelessly. */
  coworkers: number;
};

/** A provider shape this deployment offers to connect through: platform-owned, not the person's. */
export type ProviderTemplate = {
  id: string;
  label: string;
  allowsBaseUrl: boolean;
  probe: string;
};

/** How a provider is named to a person, for a list with no room for a sentence. */
export const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  zhipu: "智谱 GLM",
  moonshot: "Moonshot Kimi",
  custom: "自定义端点",
};

export const modelKeys = {
  all: ["models"] as const,
  library: () => ["models", "library"] as const,
};

/**
 * The library and the catalogue it was built from, in one request.
 *
 * The wizard needs the templates to draw its first choice and the rows to name the provider an entry
 * came through; two endpoints would be two answers about one screen, and the second could arrive
 * after the person had already picked.
 */
export function modelLibraryQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.library(),
    queryFn: async (): Promise<{
      models: ConnectedModel[];
      templates: ProviderTemplate[];
    }> => {
      const response = await client("/api/models", {
        fallback: "Your model library could not be loaded.",
      });
      return (
        (await response.json().catch(() => null)) ?? {
          models: [],
          templates: [],
        }
      );
    },
  });
}

/** "GPT-6 · OpenAI", or the model name alone when its provider is not one we know the face of. */
export function modelChoiceName(model: ConnectedModel): string {
  const named = model.label?.trim() || model.modelName;
  const provider = PROVIDER_NAMES[model.provider];
  return provider ? `${named} · ${provider}` : named;
}

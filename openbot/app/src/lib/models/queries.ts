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

/**
 * One of the platform's own experience models (stories H1, K1): keyed by the platform, offered to
 * every tenant whose plan lists it, and never editable from here.
 *
 * Only what a screen needs. The server never sends which variable holds the key, let alone a key.
 */
export type PlatformPoolModel = {
  id: string;
  provider: string;
  modelName: string;
  label: string | null;
  /** How many of this tenant's coworkers answer on it. */
  coworkers: number;
  /**
   * Whether the deployment holds the key behind it. A row without one would quietly fall back to the
   * deployment's model, so it is shown but cannot be picked.
   */
  available: boolean;
};

/** Everything `GET /api/models` answers for one screen. */
export type ModelLibrary = {
  models: ConnectedModel[];
  templates: ProviderTemplate[];
  /** The platform pool rows this tenant's plan may bind. */
  pool: PlatformPoolModel[];
  /**
   * Whether this plan may connect models with its own key (K1). The server refuses the write either
   * way; this only decides whether the form is offered or locked behind an upgrade.
   */
  customModels: boolean;
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
    queryFn: async (): Promise<ModelLibrary> => {
      const response = await client("/api/models", {
        fallback: "Your model library could not be loaded.",
      });
      const body = (await response
        .json()
        .catch(() => null)) as Partial<ModelLibrary> | null;
      return {
        models: body?.models ?? [],
        templates: body?.templates ?? [],
        pool: body?.pool ?? [],
        // Locked unless the server says otherwise: an answer that does not mention it is not a plan
        // that allows it.
        customModels: body?.customModels === true,
      };
    },
  });
}

/** "GPT-6 · OpenAI", or the model name alone when its provider is not one we know the face of. */
export function modelChoiceName(model: ConnectedModel): string {
  const named = model.label?.trim() || model.modelName;
  const provider = PROVIDER_NAMES[model.provider];
  return provider ? `${named} · ${provider}` : named;
}

/** "GLM-4.6 · 智谱 GLM" for a pool row, named the same way as a library entry. */
export function poolChoiceName(model: PlatformPoolModel): string {
  const named = model.label?.trim() || model.modelName;
  const provider = PROVIDER_NAMES[model.provider];
  return provider ? `${named} · ${provider}` : named;
}

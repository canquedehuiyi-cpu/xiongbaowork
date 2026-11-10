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

/**
 * The models a person may pick for a built-in Bot's run. See server/src/model-catalogue.ts.
 *
 * Read from whatever serves OpenBot's model: the provider, or a gateway or router in front of it.
 * The ids are what a run sends; the labels are what the picker shows. The server has already
 * narrowed the list to the admin's allowlist, so the browser offers exactly what it is given.
 */
export type ModelOption = {
  id: string;
  label: string;
  /** Who makes it, as a brand id for its mark. Absent for a gateway alias that names no vendor. */
  vendor?: string;
  /**
   * The thinking efforts this model accepts, weakest first, from `none`, `minimal`, `low`, `medium`,
   * `high`, `xhigh` and `max`. Absent or empty for a model that takes no effort, which then shows
   * no thinking control.
   */
  efforts?: string[];
  /** The effort the model uses when none is sent, when its provider says. Absent when unknown. */
  defaultEffort?: string;
};

/**
 * Who actually serves the models: a provider's own API, an OpenAI-compatible endpoint in front of
 * one, or a ChatGPT or Claude plan. What the Providers page names.
 */
export type ModelSource =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "gateway"
  | "chatgpt"
  | "claude";

/**
 * Who decides which models people may pick. `all`: one person on their own machine, offered every
 * model the credential lists. `allowed`: a team, where an admin allows models in Admin, Providers.
 */
export type ModelExposure = "all" | "allowed";

export type ModelCatalogue = {
  /** The allowlist's `provider/model` prefix. Not who serves the models; that is `source`. */
  provider: "openai" | "anthropic";
  source: ModelSource;
  exposure: ModelExposure;
  /** What a run uses when nobody picked anything. Always one of `models`. */
  default: string;
  /** Newest first. */
  models: ModelOption[];
  /** Whether there is anything to pick. False hides the picker. */
  choosable: boolean;
};

/**
 * Every model the provider or gateway lists, before the admin's allowlist narrows it. What an admin
 * picks the allowlist from. `listed` is false when the listing could not be read.
 */
export type AvailableModels = {
  provider: "openai" | "anthropic";
  source: ModelSource;
  exposure: ModelExposure;
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  listed: boolean;
};

/**
 * One person's pick for one conversation, as the server holds it. A null model is the default
 * model; a null effort is the model's own default, so none is sent.
 */
export type ConversationModel = {
  model: string | null;
  effort: string | null;
};

export const modelKeys = {
  all: ["models"] as const,
  library: () => ["models", "library"] as const,
  catalogue: ["models", "catalogue"] as const,
  available: ["models", "available"] as const,
  conversation: (channelId: string) =>
    ["models", "conversation", channelId] as const,
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
        fallback: "无法加载你的模型库。",
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

export function modelCatalogueQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.catalogue,
    queryFn: async (): Promise<ModelCatalogue> =>
      (
        await client("/api/model-catalogue", {
          fallback: "无法加载可选模型。",
        })
      ).json(),
    // The server keeps the provider's listing for ten minutes; asking more often learns nothing.
    staleTime: 5 * 60_000,
  });
}

/** Admin only: the whole listing, for choosing the model allowlist. */
export function availableModelsQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.available,
    queryFn: async (): Promise<AvailableModels> =>
      (
        await client("/api/model-catalogue/available", {
          fallback: "无法加载模型列表。",
        })
      ).json(),
    staleTime: 5 * 60_000,
  });
}

/**
 * The model and effort the signed-in person picked for one conversation, each null for the
 * default. Null too while an admin has picking off, or when the saved pick is no longer offered:
 * the server answers with what a run there would use.
 */
export function conversationModelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: modelKeys.conversation(channelId),
    queryFn: async (): Promise<ConversationModel> =>
      (
        await client(`/api/channels/${encodeURIComponent(channelId)}/model`, {
          fallback: "无法加载这个对话所用的模型。",
        })
      ).json(),
  });
}

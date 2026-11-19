import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * DeepSeek 的思考模式（期三，规格 docs/specs/2026-11-19-codex-grade-employee.md §2）。
 *
 * 员工对话默认开着思考：推理内容作为 reasoning 部分流出，经运行时变成 AG-UI 的 `REASONING_*` 事件，随这一轮
 * 的其它事件存库。部署设 `DEEPSEEK_THINKING=disabled` 全部关掉；每个员工也能单独关（`shared/thinking.ts`）。
 *
 * DeepSeek 的规则（api-docs.deepseek.com/guides/thinking_mode）：思考内容在响应的 `reasoning_content` 里，和
 * `content` 同级。两个用户消息之间，模型调过工具的那些 assistant 消息，它们的 `reasoning_content` 之后每一次
 * 请求都要原样传回；没调工具的，不用传，传了也被忽略。请求带 `tools` 而少传了，返回 400（「The
 * `reasoning_content` in the thinking mode must be passed back to the API」）。这里的做法：
 *
 * - 同一次运行的工具循环里，AI SDK 把上一步的 reasoning 部分留在 assistant 消息里，`@ai-sdk/openai-compatible`
 *   发成 `reasoning_content`，原样传回。
 * - 跨轮：调过工具的 assistant 消息照规则带上 `reasoning_content`。历史里存着这段思考的（线程历史里的
 *   `reasoning` 消息，toolkit 按工具调用 id 放回，见 `replayed-reasoning.ts`），传原文；没存的（群聊的共享
 *   记录、审批后续跑、期三之前的对话）传空字符串，DeepSeek 只认字段在不在。没调工具的 assistant 消息，跨轮
 *   的思考一律去掉，省得历史越滚越大。
 *
 * 为什么不再用运行时按 `openai/<模型>` 建的模型：那是 `@ai-sdk/openai` 的 chat 模型，不解析
 * `reasoning_content`，也不回传。DeepSeek 改由这里用 `@ai-sdk/openai-compatible` 建（仓库原本就依赖它，员工
 * 绑定的模型一直用它）。
 *
 * 全局 fetch 这一层（{@link installDeepSeekThinkingOff}）还在，只管没写 `thinking` 的请求：路由、起标题这类
 * 不带工具的辅助调用。员工对话的请求总是写明 `thinking`，它不碰。
 */

const DEEPSEEK_HOST = "api.deepseek.com";

/** 这里建的 DeepSeek 模型的提供方名字：AI SDK 的 `provider` 是 `deepseek.chat`，providerOptions 的键是它。 */
export const DEEPSEEK_PROVIDER = "deepseek";

/**
 * 员工关掉思考时，运行配置里带的 providerOptions。`@ai-sdk/openai-compatible` 把提供方名下它不认识的键原样
 * 写进请求体，于是请求带上 `thinking: { type: "disabled" }`。别的提供方读不到这个键，不受影响。
 */
export const THINKING_OFF_PROVIDER_OPTIONS = {
  [DEEPSEEK_PROVIDER]: { thinking: { type: "disabled" } },
};

/**
 * 这台部署是否关闭员工对话的思考模式。默认开着；`DEEPSEEK_THINKING=disabled` 关掉。
 */
export function deepSeekThinkingOff(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.DEEPSEEK_THINKING?.trim().toLowerCase() === "disabled";
}

/** 这个地址是不是 DeepSeek 官方的 API（主机正好是 `api.deepseek.com`）。 */
export function isDeepSeekEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    return new URL(baseUrl.trim()).hostname === DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/**
 * 这个模型是不是 {@link deepSeekLanguageModel} 建的。计量、工具搜索的包装都保留 `provider` 和规格版本；
 * 模型库里提供方写 `deepseek`、地址却是别处（代理）的，仍是 `@ai-sdk/openai-compatible` 原样的 v2 模型，不算。
 */
export function speaksDeepSeek(model: unknown): boolean {
  if (typeof model !== "object" || model === null) return false;
  const { provider, specificationVersion } = model as {
    provider?: unknown;
    specificationVersion?: unknown;
  };
  return (
    provider === `${DEEPSEEK_PROVIDER}.chat` && specificationVersion === "v3"
  );
}

type Body = Record<string, unknown>;
type ChatMessage = Record<string, unknown> & { role?: unknown };

function hasToolCalls(message: ChatMessage): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function withoutReasoning(message: ChatMessage): ChatMessage {
  if (!("reasoning_content" in message)) return message;
  const { reasoning_content: _dropped, ...rest } = message;
  return rest;
}

/**
 * 发往 DeepSeek 的请求体，按思考模式的规则整理（`createOpenAICompatible` 的 `transformRequestBody`）。
 *
 * `thinking` 总是写明：员工关掉时运行配置已经带了 `disabled`（{@link THINKING_OFF_PROVIDER_OPTIONS}），部署
 * 关掉时这里写 `disabled`，否则写 `enabled`。关着思考时历史里的 `reasoning_content` 全部去掉；开着时，调过
 * 工具的 assistant 消息必有 `reasoning_content`（没有就是空字符串），最后一条用户消息之前、没调工具的去掉。
 */
export function deepSeekRequestBody(body: Body, deploymentOff = false): Body {
  const declared = body.thinking as { type?: unknown } | undefined;
  const on = !deploymentOff && declared?.type !== "disabled";
  const messages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[])
    : undefined;
  let lastUser = -1;
  messages?.forEach((message, index) => {
    if (message?.role === "user") lastUser = index;
  });
  return {
    ...body,
    thinking: { type: on ? "enabled" : "disabled" },
    ...(messages
      ? {
          messages: messages.map((message, index) => {
            if (message?.role !== "assistant") return message;
            if (!on) return withoutReasoning(message);
            if (hasToolCalls(message))
              return typeof message.reasoning_content === "string"
                ? message
                : { ...message, reasoning_content: "" };
            return index < lastUser ? withoutReasoning(message) : message;
          }),
        }
      : {}),
  };
}

type CompatibleModel = ReturnType<
  ReturnType<typeof createOpenAICompatible>["chatModel"]
>;
type CompatibleCall = Parameters<CompatibleModel["doStream"]>[0];
type CompatibleGenerate = Awaited<ReturnType<CompatibleModel["doGenerate"]>>;

/**
 * 运行时给内置员工选的思考力度（`effortProviderOptions`，写在 `openai` 名下），照搬到 `deepseek` 名下：原来
 * `@ai-sdk/openai` 的 chat 模型会发 `reasoning_effort`，换了客户端也照发。
 */
function withEffortCarried(options: CompatibleCall): CompatibleCall {
  const providerOptions = options.providerOptions as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  const effort = providerOptions?.openai?.reasoningEffort;
  if (
    typeof effort !== "string" ||
    providerOptions?.[DEEPSEEK_PROVIDER]?.reasoningEffort !== undefined
  )
    return options;
  return {
    ...options,
    providerOptions: {
      ...providerOptions,
      [DEEPSEEK_PROVIDER]: {
        ...providerOptions?.[DEEPSEEK_PROVIDER],
        reasoningEffort: effort,
      },
    } as CompatibleCall["providerOptions"],
  };
}

function finishReasonV3(reason: CompatibleGenerate["finishReason"]) {
  return { unified: reason === "unknown" ? "other" : reason, raw: undefined };
}

/** DeepSeek 在 usage 里报的缓存命中 / 未命中的输入 token 数（别的提供方没有这两个字段）。 */
type CacheCounts = { hit?: number; miss?: number };

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * 从响应体（或一个流式块）的 `usage` 读 DeepSeek 的缓存字段。`@ai-sdk/openai-compatible` 只认
 * `prompt_tokens_details.cached_tokens`，DeepSeek 报的是 `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens`，不读的话计量里的缓存命中恒为 0。
 */
function cacheCountsOf(raw: unknown): CacheCounts | undefined {
  const usage =
    typeof raw === "object" && raw !== null
      ? (raw as { usage?: unknown }).usage
      : undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const hit = tokenCount(
    (usage as Record<string, unknown>).prompt_cache_hit_tokens,
  );
  const miss = tokenCount(
    (usage as Record<string, unknown>).prompt_cache_miss_tokens,
  );
  return hit === undefined && miss === undefined ? undefined : { hit, miss };
}

function usageV3(usage: CompatibleGenerate["usage"], cache?: CacheCounts) {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: cache?.miss,
      cacheRead: cache?.hit ?? usage.cachedInputTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: undefined,
      reasoning: usage.reasoningTokens,
    },
  };
}

/**
 * 仓库锁定的 `@ai-sdk/openai-compatible`（1.0.48）是 v2 规格的模型，运行时用的 AI SDK 6 认 v3。AI SDK 自己
 * 收到 v2 模型时也是这样转（`asLanguageModelV3`，没有导出）：只改结束原因和用量的形状，其余原样。转成 v3 的
 * 才会被 toolkit 的最后一步 / 失诺追问（`answersOnLastStep`）和工具搜索包上，和别的内置员工一样。
 */
function asV3(model: CompatibleModel): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    async doGenerate(options: CompatibleCall) {
      const result = await model.doGenerate(withEffortCarried(options));
      return {
        ...result,
        finishReason: finishReasonV3(result.finishReason),
        usage: usageV3(result.usage, cacheCountsOf(result.response?.body)),
      };
    },
    async doStream(options: CompatibleCall) {
      /*
       * 缓存字段只在原始块里，所以一律要原始块，调用方没要的再丢掉。用量块在结束事件之前到，
       * 结束时按最后一个带缓存字段的块报。
       */
      const result = await model.doStream({
        ...withEffortCarried(options),
        includeRawChunks: true,
      });
      let cache: CacheCounts | undefined;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "raw") {
                cache = cacheCountsOf(part.rawValue) ?? cache;
                if (options.includeRawChunks) controller.enqueue(part);
                return;
              }
              controller.enqueue(
                part.type === "finish"
                  ? {
                      ...part,
                      finishReason: finishReasonV3(part.finishReason),
                      usage: usageV3(part.usage, cache),
                    }
                  : part,
              );
            },
          }),
        ),
      };
    },
  } as unknown as LanguageModel;
}

/**
 * 员工对话用的 DeepSeek 模型：推理内容流出、按规则回传，`thinking` 总是写明。部署级模型（`OPENAI_BASE_URL`
 * 指向 DeepSeek）和员工在模型库、平台体验模型里绑定的 DeepSeek 都用它。
 */
export function deepSeekLanguageModel(options: {
  baseURL: string;
  apiKey: string;
  modelName: string;
  /** 员工绑定的模型：租户填的地址要过出站守卫（`createGuardedFetch`）。 */
  fetch?: typeof globalThis.fetch;
  environment?: Record<string, string | undefined>;
}): LanguageModel {
  const deploymentOff = deepSeekThinkingOff(options.environment);
  return asV3(
    createOpenAICompatible({
      name: DEEPSEEK_PROVIDER,
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      includeUsage: true,
      transformRequestBody: (body) => deepSeekRequestBody(body, deploymentOff),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }).chatModel(options.modelName),
  );
}

/** 这台部署是否给没写 `thinking` 的 DeepSeek 请求关掉思考。只有 `DEEPSEEK_THINKING=enabled` 不关。 */
function auxiliaryThinkingOff(
  environment: Record<string, string | undefined>,
): boolean {
  return environment.DEEPSEEK_THINKING?.trim().toLowerCase() !== "enabled";
}

function urlOf(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    return new URL(input.url);
  } catch {
    return null;
  }
}

/**
 * 给一个发往 DeepSeek chat/completions 的请求加上 `thinking: { type: "disabled" }`。不该改的请求
 * 原样返回同一个 `init`，调用方可以按引用判断有没有改。
 *
 * 只改：主机正好是 `api.deepseek.com`、路径以 `/chat/completions` 结尾、正文是 JSON 对象、而且还没写
 * `thinking` 的请求。别的主机、别的接口、已经写了 `thinking` 的请求（员工对话总是写明）一律原样发出。
 */
export function withThinkingDisabled(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): RequestInit | undefined {
  const url = urlOf(input);
  if (
    !url ||
    url.hostname !== DEEPSEEK_HOST ||
    !url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")
  )
    return init;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (method !== "POST" || typeof init?.body !== "string") return init;
  let payload: unknown;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    "thinking" in payload
  )
    return init;
  return {
    ...init,
    body: JSON.stringify({ ...payload, thinking: { type: "disabled" } }),
  };
}

/**
 * 在启动时装一次：之后经全局 fetch 发往 DeepSeek、没写 `thinking` 的对话请求都关闭思考模式。返回是否装上。
 *
 * 这些是路由、起标题之类的辅助调用，不带工具、要快，思考只添等待。员工对话不经这里决定（见文件开头）。
 * `DEEPSEEK_THINKING=enabled` 时不装，辅助调用也按 DeepSeek 自己的默认。
 */
export function installDeepSeekThinkingOff(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (!auxiliaryThinkingOff(environment)) return false;
  const inner = globalThis.fetch;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    inner(input, withThinkingDisabled(input, init))) as typeof fetch;
  globalThis.fetch = Object.assign(wrapped, inner);
  return true;
}

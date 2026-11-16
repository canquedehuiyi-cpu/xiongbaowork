/**
 * 发往 DeepSeek 的对话请求关闭思考模式。
 *
 * DeepSeek 的思考模式默认开着。请求带 `tools` 时，它要求把之前每一轮的 `reasoning_content` 原样传回，
 * 少了就返回 400（「The `reasoning_content` in the thinking mode must be passed back to the API」，见
 * api-docs.deepseek.com/guides/thinking_mode）。员工的每次请求都带工具，而对话历史（本地线程、群聊的
 * 共享记录、审批后续跑的那一轮）只存说出口的话，不存思考内容，所以只要对话有前文，调用就会被拒：
 * 群聊的第二句、审批通过后继续执行，都是这样卡住的。
 *
 * 为什么在 fetch 这一层改：内置员工的模型由 CopilotKit 运行时按字符串自己建（`openai/<模型>` 加
 * `OPENAI_BASE_URL`），员工绑定的模型由 runtime-resolver 建，两条路都不接受额外的请求体字段，`@ai-sdk/openai`
 * 的 providerOptions 也会丢掉不认识的键。它们最后都经全局 fetch 发出，所以只在这里改一处，所有路径都覆盖。
 *
 * 只改：主机正好是 `api.deepseek.com`、路径以 `/chat/completions` 结尾、正文是 JSON 对象、而且还没写
 * `thinking` 的请求。别的主机、别的接口、已经写了 `thinking` 的请求一律原样发出。
 *
 * 部署想保留思考模式（例如以后能把思考内容存进历史），设 `DEEPSEEK_THINKING=enabled`，这里就什么都不装。
 */

const DEEPSEEK_HOST = "api.deepseek.com";

/** 这台部署是否关闭 DeepSeek 的思考模式。默认关闭；`DEEPSEEK_THINKING=enabled` 保留 DeepSeek 自己的默认。 */
export function deepSeekThinkingOff(
  environment: Record<string, string | undefined> = process.env,
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
 * 在启动时装一次：之后经全局 fetch 发往 DeepSeek 的对话请求都关闭思考模式。返回是否装上。
 */
export function installDeepSeekThinkingOff(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (!deepSeekThinkingOff(environment)) return false;
  const inner = globalThis.fetch;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    inner(input, withThinkingDisabled(input, init))) as typeof fetch;
  globalThis.fetch = Object.assign(wrapped, inner);
  return true;
}

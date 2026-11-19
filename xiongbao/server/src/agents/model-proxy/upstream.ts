import { isDeepSeekEndpoint } from "../../models/deepseek-thinking";

/**
 * Where a request in one wire format goes for a given provider, and how it is signed there.
 *
 * THE FIRST VERSION ONLY FORWARDS. A request is passed on untouched (but for the model name, the
 * credential and the usage that is read back) to a provider that speaks that format itself. A provider
 * that does not is refused with a sentence the person can act on; turning one format into another is
 * not done here. The address comes only from the employee's own model configuration, never from the
 * request.
 */

/** The formats the proxy forwards: Codex speaks `responses`, Claude Code `messages`. */
export type ModelWire = "responses" | "messages";

export type UpstreamTarget = {
  url: string;
  /** How the real key is presented: `Authorization: Bearer`, or the `x-api-key` header. */
  auth: "bearer" | "x-api-key";
  /** Headers this provider needs beyond the client's own allowed ones. */
  headers: Record<string, string>;
};

const OPENAI_BASE = "https://api.openai.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com";

/** `base` without its trailing slashes and a final `/v1`. */
function rootOf(base: string): string {
  return base.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The target for `wire`, or null when this provider has no such endpoint. */
export function upstreamTarget(
  wire: ModelWire,
  provider: string,
  baseUrl: string | null,
): UpstreamTarget | null {
  const base = baseUrl?.trim() || defaultBase(provider);
  if (base && isDeepSeekEndpoint(base)) {
    const origin = new URL(base).origin;
    return wire === "responses"
      ? { url: `${origin}/responses`, auth: "bearer", headers: {} }
      : {
          url: `${origin}/anthropic/v1/messages`,
          auth: "bearer",
          headers: {},
        };
  }
  if (wire === "responses" && provider === "openai") {
    return {
      url: `${rootOf(baseUrl || OPENAI_BASE)}/v1/responses`,
      auth: "bearer",
      headers: {},
    };
  }
  if (wire === "messages" && provider === "anthropic") {
    return {
      url: `${rootOf(baseUrl || ANTHROPIC_BASE)}/v1/messages`,
      auth: "x-api-key",
      headers: {},
    };
  }
  return null;
}

/** The address a provider template points at when the binding names none (DeepSeek's only). */
function defaultBase(provider: string): string | null {
  return provider === "deepseek" ? "https://api.deepseek.com/v1" : null;
}

/** What each harness is called in the sentence that refuses a provider that cannot serve it. */
const HARNESS_NAME: Record<ModelWire, string> = {
  responses: "Codex",
  messages: "Claude Code",
};

/** The Chinese sentence for a model whose provider has no endpoint in this format. */
export function unsupportedWireMessage(
  wire: ModelWire,
  modelLabel: string,
): string {
  return `这位员工的模型（${modelLabel}）不支持 ${HARNESS_NAME[wire]} 接入，请换成 DeepSeek 等兼容模型。`;
}

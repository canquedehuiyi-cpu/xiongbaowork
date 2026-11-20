/**
 * 两个评测脚本共用的门槛和模型参数。
 *
 * 真跑要花真 key，所以和 `server/scripts/model-e2e.ts` 一样：只有 `MODEL_E2E=1` 且在 GitHub Actions 里
 * （`GITHUB_ACTIONS=true`）、`MODEL_E2E_API_KEY` 有值时才跑。本机验证用 `EVAL_LOCAL_MOCK=1`，换成回环
 * 地址上的假模型；这个模式在 GitHub Actions 里被拒绝，所以真作业不可能对着假模型「通过」。
 *
 * 模型和提供方都是参数，不写死 DeepSeek（以后要接很多模型，同一套评测直接换参数跑）：
 *
 *   EVAL_PROVIDER   提供方，默认 deepseek（熊宝模型库里的提供方模板名；Codex 侧作自定义 provider 的名字）
 *   EVAL_MODEL      模型名，默认 deepseek-v4-flash
 *   EVAL_BASE_URL   OpenAI 兼容的接口地址，可空；空时按提供方取下面的默认值
 *
 * 拒绝的理由只写变量名，从不写值。
 */

export type ModelConfig = {
  provider: string;
  model: string;
  /** 两边共用的接口地址；null 表示这个提供方没有已知默认值，熊宝侧交给模板，Codex 侧会报不支持。 */
  baseUrl: string | null;
  apiKey: string;
  mock: boolean;
};

/**
 * 提供方的默认接口地址。DeepSeek 官方文档给的 base_url 是 `https://api.deepseek.com`：Chat Completions
 * 在它下面的 `/chat/completions`，Responses 在 `/responses`，两边都能用同一个地址。
 */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  openrouter: "https://openrouter.ai/api/v1",
};

export const DEFAULT_PROVIDER = "deepseek";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export function evalGate(
  env: Record<string, string | undefined>,
): { ok: true; config: ModelConfig } | { ok: false; reason: string } {
  if (env.MODEL_E2E !== "1")
    return { ok: false, reason: "MODEL_E2E=1 is not set" };
  const mock = env.EVAL_LOCAL_MOCK === "1";
  if (mock && env.GITHUB_ACTIONS === "true")
    return {
      ok: false,
      reason: "EVAL_LOCAL_MOCK=1 is for local verification only",
    };
  if (!mock && env.GITHUB_ACTIONS !== "true")
    return { ok: false, reason: "not running inside GitHub Actions" };
  const apiKey =
    env.MODEL_E2E_API_KEY?.trim() || (mock ? "mock-key-not-a-secret" : "");
  if (!apiKey) return { ok: false, reason: "MODEL_E2E_API_KEY is not set" };
  const provider = (
    env.EVAL_PROVIDER?.trim() || DEFAULT_PROVIDER
  ).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(provider))
    return {
      ok: false,
      reason: "EVAL_PROVIDER must be a lowercase provider id",
    };
  const model = env.EVAL_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^[\w.:/@-]{1,120}$/.test(model))
    return { ok: false, reason: "EVAL_MODEL is not a model name" };
  const named = env.EVAL_BASE_URL?.trim().replace(/\/+$/, "") || null;
  const baseUrl = named ?? DEFAULT_BASE_URLS[provider] ?? null;
  if (baseUrl && !mock) {
    let protocol = "";
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {}
    if (protocol !== "https:")
      return { ok: false, reason: "EVAL_BASE_URL must be an https URL" };
  }
  return { ok: true, config: { provider, model, baseUrl, apiKey, mock } };
}

/**
 * 熊宝侧用哪个模型：`EVAL_XIONGBAO_MODEL` 有值就用它，没有（空串、纯空白）就和 `EVAL_MODEL` 一样。
 * 只影响熊宝侧；Codex 侧永远用 `EVAL_MODEL`，所以同一次评测里能把「换更强模型的熊宝」和「同模型的熊宝」「Codex」
 * 放在一起比，分清差距多少来自模型、多少来自做法。`base` 是 {@link evalGate} 已经核过的 `EVAL_MODEL`。
 */
export function xiongbaoModel(
  env: Record<string, string | undefined>,
  base: string,
):
  | { ok: true; model: string; overridden: boolean }
  | { ok: false; reason: string } {
  const named = env.EVAL_XIONGBAO_MODEL?.trim();
  if (!named) return { ok: true, model: base, overridden: false };
  if (!/^[\w.:/@-]{1,120}$/.test(named))
    return { ok: false, reason: "EVAL_XIONGBAO_MODEL is not a model name" };
  return { ok: true, model: named, overridden: named !== base };
}

/** 每题的墙钟上限（分钟），默认 20。 */
export function taskMinutes(env: Record<string, string | undefined>): number {
  const value = Number(env.EVAL_TASK_MINUTES ?? "");
  return Number.isFinite(value) && value > 0 && value <= 120 ? value : 20;
}

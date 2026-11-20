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

import { randomBytes } from "node:crypto";

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

/**
 * `EVAL_SERVER_ENV`：给被测服务器多带几个部署开关，逗号分隔的 `名字=值`，例如
 * `XIONGBAO_VERIFY_NUDGE=off,XIONGBAO_NUDGE_WHOLE_TURN=off`。只放行 `XIONGBAO_` 开头的名字，别的（`PATH`、
 * 密钥）丢掉，评测脚本给服务器的环境仍然由它自己决定。用来对照同一个构建里开关开和关的差别。
 */
export function serverEnvFrom(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (raw ?? "").split(",")) {
    const at = item.indexOf("=");
    if (at < 0) continue;
    const name = item.slice(0, at).trim();
    if (/^XIONGBAO_[A-Z0-9_]+$/.test(name))
      out[name] = item.slice(at + 1).trim();
  }
  return out;
}

/** 重复类的题连做几对：`EVAL_REPEAT_PAIRS`，1 到 4，默认 1。每一对用新员工、新种子，复盘和技能只在同一对内有效。 */
export function repeatPairs(
  env: Record<string, string | undefined>,
): { ok: true; pairs: number } | { ok: false; reason: string } {
  const text = env.EVAL_REPEAT_PAIRS?.trim() ?? "";
  if (!text) return { ok: true, pairs: 1 };
  if (!/^[1-4]$/.test(text))
    return { ok: false, reason: "EVAL_REPEAT_PAIRS must be 1, 2, 3 or 4" };
  return { ok: true, pairs: Number(text) };
}

/**
 * 夹具的基础种子：`EVAL_SEED`（作业里是 run id，熊宝和 Codex 两个作业同一个，两边夹具才一样），没设就现抽一个。
 * 具体每一对、每一次用的种子由它派生（`gen-pitfall.ts` 的 `pairSeeds`），结果里记着。
 */
export function evalSeed(env: Record<string, string | undefined>): string {
  return env.EVAL_SEED?.trim() || randomBytes(6).toString("hex");
}

/**
 * 还来不来得及再做一对：作业开头记下一个截止时间（`EVAL_DEADLINE_EPOCH`，Unix 秒，比作业超时早，留出出报告和上传的
 * 时间），一对要做两次。有上一对的实测墙钟就按它的一倍半留余量，没有就按最坏情况（两次都跑满每题上限，再加两分钟
 * 等复盘）。没设截止时间（本机）总是来得及。多对放在同一次运行里做完，不能被作业超时整个杀掉。
 */
export function pairFits(
  env: Record<string, string | undefined>,
  nowMs: number,
  lastPairMs: number | undefined,
  perRunMinutes: number,
): boolean {
  const epoch = Number(env.EVAL_DEADLINE_EPOCH ?? "");
  if (!Number.isFinite(epoch) || epoch <= 0) return true;
  const need =
    lastPairMs !== undefined
      ? lastPairMs * 1.5
      : (2 * perRunMinutes + 2) * 60_000;
  return epoch * 1000 - nowMs >= need;
}

import { type QuotaErrorDetails, RequestError } from "@/lib/client";

/**
 * What a person is told when the server refuses for a full allowance (story K4).
 *
 * The server's 402 already carries the plan, the metric and the used/limit pair; `client.ts` parses
 * and freezes them into `RequestError.quota`. This file turns those numbers into the one sentence and
 * the two ways out — upgrade, or free a slot — so every screen that hits a ceiling answers the same
 * way instead of each form inventing its own copy.
 */

/** The screens that free a slot. Every one is a registered route in `routeTree.gen.ts`. */
export type QuotaCleanupHref = "/agents" | "/settings" | "/resources";

export type QuotaGuidance = Readonly<{
  metric: QuotaErrorDetails["metric"];
  title: string;
  /** "<plan> 套餐：<metric>已用 used/limit" */
  sentence: string;
  /** What happens next, in a sentence: how to make room, or when it comes back on its own. */
  hint: string;
  upgradeHref: QuotaErrorDetails["upgradeUrl"];
  /** Absent when nothing can be deleted to make room — a monthly tally only resets. */
  cleanup?: Readonly<{ href: QuotaCleanupHref; label: string }>;
}>;

type MetricCopy = Readonly<{
  label: string;
  title: string;
  hint: string;
  cleanup?: Readonly<{ href: QuotaCleanupHref; label: string }>;
}>;

const COPY: Readonly<Record<QuotaErrorDetails["metric"], MetricCopy>> = {
  wakers: {
    label: "员工",
    title: "员工数量已达套餐上限",
    hint: "删除不再需要的员工即可腾出名额，或升级套餐获得更多名额。",
    cleanup: { href: "/agents", label: "管理员工" },
  },
  devices: {
    label: "设备",
    title: "设备数量已达套餐上限",
    hint: "移除不再使用的设备即可腾出名额，或升级套餐获得更多名额。",
    // The count is `registered_devices`, which 设置 › 我的设备 lists and removes (DELETE /api/devices/:id).
    cleanup: { href: "/settings", label: "管理设备" },
  },
  /*
   * A plan's `customModels` is a yes/no, which the server turns into a ceiling of 0 or unlimited, so
   * this refusal always means "not on this plan": deleting a model frees nothing, and only upgrading
   * helps. The cleanup screen is still named for the rare case of a numeric ceiling above zero.
   */
  customModels: {
    label: "自定义模型",
    title: "当前套餐不支持更多自定义模型",
    hint: "从模型库删除不再使用的模型即可腾出名额，或升级套餐获得更多名额。",
    cleanup: { href: "/resources", label: "管理模型库" },
  },
  tasksPerMonth: {
    label: "本月任务",
    title: "本月任务次数已用完",
    hint: "额度会在下个周期自动恢复；现在就需要更多，可以升级套餐。",
  },
};

export function guidanceFor(details: QuotaErrorDetails): QuotaGuidance {
  const copy = COPY[details.metric];
  /*
   * A ceiling of 0 means the plan does not include this at all: nothing can be deleted to make room
   * and nothing comes back next period, so the only honest way out is the upgrade.
   */
  const excluded = details.limit === 0;
  return {
    metric: details.metric,
    title: copy.title,
    sentence: `${details.plan.trim()} 套餐：${copy.label}已用 ${details.used}/${details.limit}`,
    hint: excluded
      ? `当前套餐不包含${copy.label}，升级套餐后即可使用。`
      : copy.hint,
    upgradeHref: details.upgradeUrl,
    ...(copy.cleanup && !excluded ? { cleanup: copy.cleanup } : {}),
  };
}

/*
 * The store: one current refusal, and whoever is drawing it. No dependency — it is a variable and a
 * set of listeners, read through `useSyncExternalStore`.
 */
let current: QuotaErrorDetails | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeQuotaGuidance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentQuotaGuidance(): QuotaErrorDetails | null {
  return current;
}

/**
 * Shows the guidance for this refusal.
 *
 * With nobody drawing it (a screen outside the signed-in layout), the refusal is dropped rather than kept:
 * a dialog that opened later, on an unrelated screen, about a click long forgotten would be noise.
 */
export function reportQuotaExceeded(details: QuotaErrorDetails): void {
  if (listeners.size === 0) return;
  current = details;
  notify();
}

export function dismissQuotaGuidance(): void {
  if (current === null) return;
  current = null;
  notify();
}

/**
 * True when `error` is the server's structured quota refusal; reports it when it is.
 *
 * Both halves are required: the 402 the server answers a full allowance with, and the validated body.
 * A quota-shaped body on any other status is some other failure and is left to the screen.
 */
export function reportIfQuotaError(error: unknown): boolean {
  if (!(error instanceof RequestError) || error.status !== 402 || !error.quota)
    return false;
  reportQuotaExceeded(error.quota);
  return true;
}

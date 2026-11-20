/**
 * 员工的「心跳」（期 3·3.1，规格 docs/specs/2026-11-20-employee-depth-optimization.md 子项目 3）。
 *
 * 开了心跳的员工隔一段时间自己醒来，照一份清单（「有新卡就看一眼」「每天 9 点汇总邮件」）检查一遍：有事就做、
 * 就告诉本人，没事就静默收工，不产生对话、不发通知。存在员工的 `agents.configuration.heartbeat` 里，没有这个键
 * 就是没开，所以已有的员工不用迁移，也没有改表结构。设置界面先不做，这一期服务器先认这个字段和接口。
 *
 * 间隔最短 15 分钟，和例行任务的下限一样；清单是一段文字，员工自己用 `update_heartbeat_checklist` 维护。
 */

/** 员工配置里存心跳的键。 */
export const HEARTBEAT_KEY = "heartbeat";

/** 间隔下限，分钟。 */
export const HEARTBEAT_MIN_INTERVAL_MINUTES = 15;
/** 间隔上限：一周。更久的事该用例行任务。 */
export const HEARTBEAT_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
/** 只打开、没写间隔时用的间隔。 */
export const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = 60;
/** 清单最长多少字：它每次醒来都要读，写长了就是在烧 token。 */
export const HEARTBEAT_CHECKLIST_MAX_CHARS = 2000;

/** 员工醒来后没事做时回的那一个词；回复里除了它没有别的字，就是静默收工。 */
export const HEARTBEAT_OK = "HEARTBEAT_OK";

export type HeartbeatSettings = {
  enabled: boolean;
  intervalMinutes: number;
  checklist: string;
};

/** 存在配置里的样子：多一个 `chain`，是这条心跳队列的编号，服务器自己用，不对外。 */
export type StoredHeartbeat = HeartbeatSettings & { chain?: string };

/** 一次设置里可以只写其中几项。 */
export type HeartbeatPatch = Partial<HeartbeatSettings>;

/**
 * 从员工的 `agents.configuration` 读出心跳：没有这个键是 undefined（没开过）；存坏了的项（间隔不是 15 到一周的
 * 整数、清单不是字符串）读成默认，而不是让整条心跳作废。
 */
export function heartbeatOf(
  configuration: unknown,
): StoredHeartbeat | undefined {
  if (!configuration || typeof configuration !== "object") return undefined;
  const raw = (configuration as Record<string, unknown>)[HEARTBEAT_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const interval = value.intervalMinutes;
  return {
    enabled: value.enabled === true,
    intervalMinutes:
      typeof interval === "number" &&
      Number.isInteger(interval) &&
      interval >= HEARTBEAT_MIN_INTERVAL_MINUTES &&
      interval <= HEARTBEAT_MAX_INTERVAL_MINUTES
        ? interval
        : HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
    checklist:
      typeof value.checklist === "string"
        ? value.checklist.slice(0, HEARTBEAT_CHECKLIST_MAX_CHARS)
        : "",
    ...(typeof value.chain === "string" && value.chain
      ? { chain: value.chain }
      : {}),
  };
}

/** 没开过的员工读到的样子。 */
export const NO_HEARTBEAT: HeartbeatSettings = {
  enabled: false,
  intervalMinutes: HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
  checklist: "",
};

/** 对外读出的样子：不带服务器自己用的 `chain`。 */
export function publicHeartbeat(
  stored: StoredHeartbeat | undefined,
): HeartbeatSettings {
  if (!stored) return { ...NO_HEARTBEAT };
  return {
    enabled: stored.enabled,
    intervalMinutes: stored.intervalMinutes,
    checklist: stored.checklist,
  };
}

/**
 * 校验一次写入：只认 `enabled`、`intervalMinutes`、`checklist` 三个键，间隔是 15 分钟到一周的整数，清单是不超过
 * 2000 字的文字。不合格的答一句说明给人看，不存。
 */
export function parseHeartbeatPatch(
  input: unknown,
): { ok: true; patch: HeartbeatPatch } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ok: false,
      error: "心跳要写成 { enabled, intervalMinutes, checklist }。",
    };
  const patch: HeartbeatPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "enabled") {
      if (typeof value !== "boolean")
        return { ok: false, error: "enabled 只能是 true 或 false。" };
      patch.enabled = value;
    } else if (key === "intervalMinutes") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < HEARTBEAT_MIN_INTERVAL_MINUTES ||
        value > HEARTBEAT_MAX_INTERVAL_MINUTES
      )
        return {
          ok: false,
          error: `间隔要是 ${HEARTBEAT_MIN_INTERVAL_MINUTES} 分钟到 ${HEARTBEAT_MAX_INTERVAL_MINUTES} 分钟之间的整数。`,
        };
      patch.intervalMinutes = value;
    } else if (key === "checklist") {
      if (typeof value !== "string")
        return { ok: false, error: "清单要写成文字。" };
      if (value.length > HEARTBEAT_CHECKLIST_MAX_CHARS)
        return {
          ok: false,
          error: `清单最多 ${HEARTBEAT_CHECKLIST_MAX_CHARS} 个字，现在 ${value.length} 个。`,
        };
      patch.checklist = value.trim();
    } else {
      return { ok: false, error: `心跳没有「${key}」这一项。` };
    }
  }
  if (Object.keys(patch).length === 0)
    return {
      ok: false,
      error: "至少写一项要改的：enabled、intervalMinutes 或 checklist。",
    };
  return { ok: true, patch };
}

/**
 * 这次醒来的回复是不是「没事」：什么也没说，或者除了 `HEARTBEAT_OK` 和标点、空白没有别的字。宁可严一点：
 * 「HEARTBEAT_OK，不过构建挂了」这种带了别的话的，当作有事，去告诉人，不当作静默。
 */
export function isHeartbeatQuiet(reply: string | null | undefined): boolean {
  const text = (reply ?? "").trim();
  if (text === "") return true;
  if (!text.includes(HEARTBEAT_OK)) return false;
  return (
    text
      .replaceAll(HEARTBEAT_OK, "")
      .replace(/[\s.,;:!?。，；：！？*_`'"“”-]/g, "") === ""
  );
}

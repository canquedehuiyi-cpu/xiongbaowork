/**
 * 员工的「难任务模型」（期七，规格 docs/specs/2026-11-19-codex-grade-employee.md §5）。
 *
 * 员工派子代理（`run_subagent`）时，难的子任务可以指定 `model: "hard"`，这位员工用这里存的模型跑它，
 * 平时的活仍用员工自己的模型。存在员工的 `agents.configuration.hardModel` 里，一个模型名，没写就是没设置，
 * 所以已有的员工不用迁移，也没有改 schema。设置界面下一期做，这一期服务器先认这个字段。
 */

/** 员工配置里存难任务模型的键。 */
export const HARD_MODEL_KEY = "hardModel";

/** 从员工的 `agents.configuration` 读出难任务模型：非空的字符串才算，别的都当没设置。 */
export function hardModelOf(configuration: unknown): string | undefined {
  if (!configuration || typeof configuration !== "object") return undefined;
  const value = (configuration as Record<string, unknown>)[HARD_MODEL_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

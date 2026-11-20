/**
 * 员工的「轻量模型」（期 1·1.5，规格 docs/specs/2026-11-20-employee-depth-optimization.md 子项目 1）。
 *
 * 巡检（主动检查）和跟进（员工给自己留的「回头再看」）这类轻量轮，多数时候只是看一眼、没事就收，用不着员工平时
 * 那个贵的模型：这位员工用这里存的模型跑它们，平时的活仍用员工自己的模型。没设置就用平时的模型，不设回退默认。
 * 做法同难任务模型（`hard-model.ts`）：存在员工的 `agents.configuration.lightModel` 里，一个模型名，没写就是
 * 没设置，所以已有的员工不用迁移，也没有改 schema。设置界面先不做，这一期服务器先认这个字段和接口。
 */

/** 员工配置里存轻量模型的键。 */
export const LIGHT_MODEL_KEY = "lightModel";

/** 从员工的 `agents.configuration` 读出轻量模型：非空的字符串才算，别的都当没设置。 */
export function lightModelOf(configuration: unknown): string | undefined {
  if (!configuration || typeof configuration !== "object") return undefined;
  const value = (configuration as Record<string, unknown>)[LIGHT_MODEL_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

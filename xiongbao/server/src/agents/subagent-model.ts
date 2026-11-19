/**
 * 子代理跑在哪个模型上（期七）：`run_subagent` 的可选参数 `model` 怎么解析。
 *
 * 只认三样：
 *  - 不写，或者 `"default"`：员工平时的模型，什么都不改；
 *  - `"hard"`：这位员工设置里的难任务模型（`shared/hard-model.ts`）。没设置、或者设置的那个模型现在已经不在
 *    本租户可用的模型里了（管理员收回、换了提供方），就退回默认模型，并在结果里说明，子任务照常做；
 *  - 本租户可用模型里的名字（和对话里模型选择器是同一份目录，管理员的白名单已经算在里面）。
 * 别的名字，包括别的租户的模型名，一律拒绝并用中文说明哪些可以写；不抛异常，也不占这一轮子代理的名额。
 */
import {
  SUBAGENT_MODEL_DEFAULT,
  SUBAGENT_MODEL_HARD,
} from "../../../shared/subagent";

export type SubagentModelChoice =
  /** 用这个模型跑；`note` 有就是要对模型说的话。 */
  | { use: string; note?: undefined; refusal?: undefined }
  /** 用员工平时的模型；`note` 有就是为什么没用上它想要的那个。 */
  | { use?: undefined; note?: string; refusal?: undefined }
  /** 不启动，原因用中文。 */
  | { use?: undefined; note?: undefined; refusal: string };

export function resolveSubagentModel(input: {
  /** 模型写的 `model` 参数。 */
  requested: string | undefined;
  /** 这位员工设置里的难任务模型。 */
  hardModel: string | undefined;
  /** 本租户可用的模型名。 */
  allowed: readonly string[];
}): SubagentModelChoice {
  const requested = input.requested?.trim();
  if (!requested || requested.toLowerCase() === SUBAGENT_MODEL_DEFAULT)
    return {};
  if (requested.toLowerCase() === SUBAGENT_MODEL_HARD) {
    if (!input.hardModel)
      return {
        note: `这位员工还没有设置难任务模型，这个子代理用的是平时的模型。`,
      };
    if (!input.allowed.includes(input.hardModel))
      return {
        note: `这位员工设置的难任务模型「${input.hardModel}」现在不在可用的模型里，这个子代理用的是平时的模型。`,
      };
    return { use: input.hardModel };
  }
  if (input.allowed.includes(requested)) return { use: requested };
  const offered = input.allowed.slice(0, 8);
  return {
    refusal: `没有启动子代理：模型「${requested}」不在可用的模型里。model 可以写 "${SUBAGENT_MODEL_HARD}"（难任务模型）、"${SUBAGENT_MODEL_DEFAULT}"（平时的模型）${
      offered.length > 0 ? `，或者：${offered.join("、")}` : ""
    }；不写就用平时的模型。`,
  };
}

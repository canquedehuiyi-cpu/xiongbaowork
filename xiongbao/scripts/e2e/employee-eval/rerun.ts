/** 交付题失败后的重跑：至多一次，结果取重跑那次；重跑出错或来不及就保留第一次的记录。 */

import type { EvalRecord } from "./records";

export async function withRerun(
  first: EvalRecord,
  input: {
    /** 输入 `rerun_failed` 是否开着。 */
    enabled: boolean;
    /** 离作业截止时间还够不够再做一题。 */
    fits: () => boolean;
    rerun: () => Promise<EvalRecord>;
    note: (line: string) => void;
  },
): Promise<EvalRecord> {
  const once: EvalRecord = { ...first, reruns: 0 };
  if (first.passed || !input.enabled) return once;
  if (!input.fits()) {
    input.note(`${first.task} 重跑没做：离作业截止时间不够再做一题`);
    return once;
  }
  const failedChecks = first.checks.filter((item) => !item.ok);
  input.note(
    `${first.task} 首次没过：${failedChecks.map((item) => item.name).join("、") || first.error || "没有失败检查项"}`,
  );
  try {
    return { ...(await input.rerun()), reruns: 1 };
  } catch (thrown) {
    // 重跑出错不能拖垮整次评测，也不能把已有的第一次结果弄丢。
    input.note(
      `${first.task} 重跑没做：${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
    return once;
  }
}

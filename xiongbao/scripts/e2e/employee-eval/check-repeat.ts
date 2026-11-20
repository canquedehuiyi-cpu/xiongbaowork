/**
 * 判分：重复任务。题目就是多步办公题（夹具、金标、判分都复用 `check-office.ts`），区别只在做法：
 * 同一位员工在两个干净的目录里把它连做两次（第一次 `eval/repeat-first`，第二次 `eval/repeat-second`），
 * 每次各判一遍，指标分别记成 `firstRun` 和 `secondRun`（见 `records.ts` 的 `combineRepeat`），
 * 给期 2 看「同一类任务第二次做时，步数和 token 有没有降」。
 */

import { checkOffice } from "./check-office";
import { type CheckResult, runCheckCli } from "./lib";

export function checkRepeat(dir: string): CheckResult {
  return { ...checkOffice(dir), task: "repeat" };
}

if (import.meta.main) await runCheckCli("repeat", checkRepeat);

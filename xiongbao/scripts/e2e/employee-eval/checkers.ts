/** 各题（五道对标题和加难题）的判分函数，按题名查。跑评测的两个脚本和报告都从这里取。 */

import { checkCode } from "./check-code";
import { checkCompare } from "./check-compare";
import { checkData } from "./check-data";
import { checkDocs } from "./check-docs";
import { checkOffice } from "./check-office";
import { checkRefactor } from "./check-refactor";
import { checkRepeat } from "./check-repeat";
import { checkRepeatPitfall } from "./check-repeat-pitfall";
import { checkResearch } from "./check-research";
import { checkTerminal } from "./check-terminal";
import { checkWebform } from "./check-webform";
import { type CheckResult, check, type TaskName } from "./lib";

/**
 * 判分函数：目录、（夹具由种子生成的题才要的）种子。有坑可学的题没有种子就没法判，直接记没过。
 */
export const CHECKERS: Record<
  TaskName,
  (dir: string, seed?: string) => Promise<CheckResult>
> = {
  research: (dir) => checkResearch(dir),
  docs: (dir) => checkDocs(dir),
  code: async (dir) => checkCode(dir),
  data: async (dir) => checkData(dir),
  office: async (dir) => checkOffice(dir),
  compare: (dir) => checkCompare(dir),
  refactor: async (dir) => checkRefactor(dir),
  terminal: async (dir) => checkTerminal(dir),
  webform: async (dir) => checkWebform(dir),
  repeat: async (dir) => checkRepeat(dir),
  "repeat-pitfall": async (dir, seed) =>
    seed
      ? checkRepeatPitfall(dir, seed)
      : {
          task: "repeat-pitfall",
          passed: false,
          checks: [check("有种子", false, "有坑可学的题没有种子，没法判分")],
        },
};

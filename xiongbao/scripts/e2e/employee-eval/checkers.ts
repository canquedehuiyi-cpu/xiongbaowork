/** 五道题的判分函数，按题名查。跑评测的两个脚本和报告都从这里取。 */

import { checkCode } from "./check-code";
import { checkData } from "./check-data";
import { checkDocs } from "./check-docs";
import { checkOffice } from "./check-office";
import { checkResearch } from "./check-research";
import type { CheckResult, TaskName } from "./lib";

export const CHECKERS: Record<TaskName, (dir: string) => Promise<CheckResult>> =
  {
    research: (dir) => checkResearch(dir),
    docs: (dir) => checkDocs(dir),
    code: async (dir) => checkCode(dir),
    data: async (dir) => checkData(dir),
    office: async (dir) => checkOffice(dir),
  };

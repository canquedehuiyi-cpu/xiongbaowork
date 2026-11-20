/** 各题（五道对标题和加难题）的判分函数，按题名查。跑评测的两个脚本和报告都从这里取。 */

import { checkCode } from "./check-code";
import { checkCompare } from "./check-compare";
import { checkData } from "./check-data";
import { checkDocs } from "./check-docs";
import { checkOffice } from "./check-office";
import { checkRefactor } from "./check-refactor";
import { checkRepeat } from "./check-repeat";
import { checkResearch } from "./check-research";
import { checkTerminal } from "./check-terminal";
import { checkWebform } from "./check-webform";
import type { CheckResult, TaskName } from "./lib";

export const CHECKERS: Record<TaskName, (dir: string) => Promise<CheckResult>> =
  {
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
  };

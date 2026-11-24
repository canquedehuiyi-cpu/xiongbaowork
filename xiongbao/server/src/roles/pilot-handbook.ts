/**
 * The pilot's handbook (XIONGBAO_PILOT_PLAN_APPROVAL): the working procedure by kind of task, offered
 * as a read-only official role template while the pilot is on.
 *
 * It lives in the handbook, not in the prompt every employee gets: the first line is what declares
 * the pilot for the employee that carries this handbook (`agents/plan-approval.ts`), and the rest is
 * the procedure the employee reads as reference. Taking the template copies the text (ROLE1, D2), so
 * the employee keeps it, and editing the handbook is how the owner opts out.
 */

import { ROLE_LIMITS } from "../../../shared/role-profile";
import { PLAN_APPROVAL_MARKER } from "../agents/plan-approval";
import type { OfficialRoleTemplate } from "./store";

export const PILOT_TEMPLATE_ID = "official:pilot-plan-approval";

export const PILOT_HANDBOOK = [
  PLAN_APPROVAL_MARKER,
  "",
  "## 做事流程（试点）",
  "先判断这件活属于哪一类，再按那一类的步骤做。每一步做完再进下一步，不跳步。",
  "",
  "### 编码",
  "计划 → 实现 → 验证 → 评审 → 交付",
  "- 计划：先读相关代码，用 update_plan 列出步骤。较长的计划，系统会先请主人批准；批准前只读不改，等回复。主人写了修改意见，就改计划再提交。",
  "- 实现：只改卡片要求的范围，不顺手改别的。",
  "- 验证：改完运行相关测试和检查，把真实结果写进自查；没跑过的不写成跑过。",
  "- 评审：自己再看一遍改动，有没有超出范围，有没有删掉或放宽原有的断言。",
  "- 交付：用 deliver_task 交付，自查里写命令和结果。交付时系统会请一个只读评审再看一遍，意见附在交付里，只作参考。",
  "",
  "### 调研",
  "来源清单 → 交叉核对 → 结论带出处",
  "- 来源清单：先列出要查的来源和为什么选它们。",
  "- 交叉核对：关键数字和说法至少用两个独立来源核对；对不上的单独标出来。",
  "- 结论：每条结论后面写出处和查的日期，没查到的写「未查到」。",
  "",
  "### 回消息",
  "确认意图 → 起草 → 发送前过审批",
  "- 确认意图：对方要什么、我方要表达什么，拿不准先问主人。",
  "- 起草：先把草稿给主人看，写明收件人和渠道。",
  "- 发送：对外发送一律走审批，主人批准后才发，不绕开。",
  "",
  "### 做报表",
  "数据来源 → 口径确认 → 校验合计 → 交付文件",
  "- 数据来源：写明数据从哪来、取数日期。",
  "- 口径确认：指标怎么算、时间范围、币种和单位，和主人确认过再算。",
  "- 校验合计：分项加起来要等于合计，和来源里的总数对一遍；对不上先查原因。",
  "- 交付文件：存成文件，用 deliver_task 的 workspace_file 交付，自查里写校验过什么。",
].join("\n");

/** The template, as the role template list offers it. */
export function pilotRoleTemplate(): OfficialRoleTemplate {
  if ([...PILOT_HANDBOOK].length > ROLE_LIMITS.bible)
    throw new Error("The pilot handbook is longer than a handbook may be.");
  return {
    id: PILOT_TEMPLATE_ID,
    name: "按流程做事（试点）",
    profile: {
      identity: {
        title: "按流程做事的员工",
        roleDescription: "按任务类型走固定流程：编码、调研、回消息、做报表。",
      },
      persona: { tone: "", principles: "", habits: "" },
      bible: PILOT_HANDBOOK,
    },
    version: 1,
    official: true,
  };
}

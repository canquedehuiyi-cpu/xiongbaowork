/**
 * 本机假模型的「重复任务」剧本：用来在本机走通「第一次做 -> 复盘 -> 技能授予 -> 第二次带着技能做」这条链，
 * 看两次之间有没有产生技能、第二次有没有用上。`EVAL_MOCK_SCRIPT=learn` 打开。
 *
 * 它不懂题目，只按固定节奏动手：接活、跑命令摸索、写产物、交付。差别在两处：
 * - 请求里看得到员工自己写的技能被放进了上下文（产品放进去的那段话）：走短路径，少跑摸索的几步；
 * - 收到复盘的请求（系统提示是复盘员那一段）：按请求里的那件事写一份技能。
 * 所以第二次是不是更快，取决于产品有没有把技能真的交到模型手上，而不是剧本里写死的。判分结果不代表能力。
 */

import { TOOL } from "./metrics";
import type { MockRequest, MockTurn } from "./mock-model";

/** 摸索的命令数：没有技能可参考时一步步试，有技能时只跑技能里写的两步。 */
export const EXPLORE_STEPS = 9;
const SHORT_STEPS = 2;

/** 产品把对得上的自写技能放进上下文时的开头那句（`plugins/picked-skill.ts`）。 */
export const SKILL_MARK = "You have done this kind of work before";
/** 复盘员的系统提示开头（`learning/retrospect.ts` 的 `RETRO_SYSTEM`）。 */
export const RETRO_MARK = "You review how an AI coworker";

const whole = (request: MockRequest) => JSON.stringify(request.raw);

/** 复盘请求里「Request: …」那一行，就是这件事怎么提的。 */
function requestOf(prompt: string): string {
  return (
    /Request: (.*)/.exec(prompt)?.[1]?.slice(0, 160) ?? "整理动作清单做成汇总表"
  );
}

function retroAnswer(request: MockRequest): MockTurn {
  const skill = {
    name: "办公题做法",
    when: requestOf(whole(request).replace(/\\n/g, "\n")),
    steps: [
      "先 ls 看目录里有什么，读 TASK.md",
      "直接写 actions.csv 到目录里",
      "用 test -f 校验产物存在",
      "accept_task 接活，deliver_task 交付并列上产物文件",
    ],
    pitfalls: ["不要逐个命令摸索，按上面的步骤一次做完"],
    verify: "test -f <dir>/actions.csv 通过",
    scope: "self",
  };
  return { text: JSON.stringify({ skill }) };
}

/** 一轮里第几步该发什么（按这一轮已收到的工具结果数算）。 */
export function learnPolicy(request: MockRequest, dir: string): MockTurn {
  if (whole(request).includes(RETRO_MARK)) return retroAnswer(request);
  const known = whole(request).includes(SKILL_MARK);
  const explore = known ? SHORT_STEPS : EXPLORE_STEPS;
  const done = request.toolResultsSinceUser;
  const accepted = request.offeredTools.includes("accept_task");
  const script: MockTurn[] = [
    ...(accepted
      ? [
          {
            tools: [
              {
                name: "accept_task",
                arguments: { criteria: "产物 actions.csv 写好并核对过" },
              },
            ],
          },
        ]
      : []),
    ...Array.from({ length: explore }, (_, index) => ({
      tools: [
        {
          name: TOOL.command,
          arguments: {
            command:
              index === 0
                ? `ls -la ${dir} && cat ${dir}/TASK.md || true`
                : `echo explore-${index} && ls ${dir}`,
          },
        },
      ],
    })),
    {
      tools: [
        {
          name: TOOL.write,
          arguments: {
            path: `${dir}/actions.csv`,
            contents: "owner,action\nmock,placeholder\n",
          },
        },
      ],
    },
    ...(accepted
      ? [
          {
            tools: [
              {
                name: "deliver_task",
                arguments: {
                  items: [
                    {
                      kind: "workspace_file",
                      ref: `${dir}/actions.csv`,
                      title: "动作清单",
                    },
                  ],
                  checks: ["actions.csv 已写好并核对过"],
                },
              },
            ],
          },
        ]
      : []),
    { text: "做完了：产物已写好并交付（假模型）。" },
  ];
  return script[Math.min(done, script.length - 1)] as MockTurn;
}

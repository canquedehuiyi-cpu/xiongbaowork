/**
 * 本机假模型的「看板卡」剧本：用来在本机数一张看板卡从开始到交付要走几次模型调用，修前修后各是几次
 * （`EVAL_MOCK_SCRIPT=board` 打开）。
 *
 * 它不懂题目，演一个照提示做事的员工：接活回执、列计划、读题、写占位文件、校验、计划打勾、交付，最后说一句收尾的话。
 * 并不并步，看请求里的系统提示和工具描述有没有这几句（逐字的一小段，见 {@link MARKS}）：
 * - 「接活回执和第一批读取、命令放在同一步一起发」：接活回执和第一批读取同一步发；
 * - 「更新计划和下一步动作放在同一步发」：开头的计划和第一批读取同一步发，收尾的计划和交付同一步发；
 * - 「joined with &&」：读、写、校验并成一条命令。
 * 没有就一步一个。所以步数看的是产品有没有把这几句话交到模型手上，回退开关关掉哪一句，那一句对应的步就回来；
 * 交付之后那一步收尾的话，也是产品自己省不省（交付被接受后不再问模型），剧本只在被问到时才说。
 * 判分结果不代表能力。
 */

import { TOOL } from "./metrics";
import type { MockRequest, MockTurn } from "./mock-model";

/** 剧本是否打开。 */
export function boardMockWanted(
  env: Record<string, string | undefined>,
): boolean {
  return env.EVAL_MOCK_SCRIPT?.trim() === "board";
}

/** 提示里认的三句话（各取逐字的一小段）。 */
export const MARKS = {
  accept: "接活回执和第一批读取",
  plan: "更新计划和下一步动作放在同一步发",
  merge: "joined with &&",
} as const;

/** 剧本的动作：接活、开头的计划、读、写、校验、读写校验合成一条、收尾的计划、交付、收尾的话。 */
type Action = "A" | "P1" | "R" | "W" | "C" | "RWC" | "P2" | "D" | "T";
const WORK: ReadonlySet<Action> = new Set(["R", "W", "C", "RWC"]);

export type BoardPlanOptions = {
  accept: boolean;
  plan: boolean;
  merge: boolean;
  /** 请求里提供的工具名：没有接活、计划、交付工具就没有那几步。 */
  tools: ReadonlySet<string>;
};

/** 每一步要发的动作，按提示里有没有那几句话并步。 */
function stepsOf(options: BoardPlanOptions): Action[][] {
  const has = (name: string) => options.tools.has(name);
  const queue: Action[] = [
    ...(has("accept_task") ? (["A"] as const) : []),
    ...(has("update_plan") ? (["P1"] as const) : []),
    ...(options.merge ? (["RWC"] as const) : (["R", "W", "C"] as const)),
    ...(has("update_plan") ? (["P2"] as const) : []),
    ...(has("deliver_task") ? (["D"] as const) : []),
    "T",
  ];
  const out: Action[][] = [];
  while (queue.length > 0) {
    const first = queue.shift() as Action;
    const step: Action[] = [first];
    const take = (match: (action: Action) => boolean) => {
      const index = queue.findIndex(match);
      if (index >= 0) step.push(...queue.splice(index, 1));
    };
    if (first === "A" && options.accept) {
      if (options.plan) take((action) => action === "P1");
      take((action) => WORK.has(action));
    } else if (first === "P1" && options.plan)
      take((action) => WORK.has(action));
    else if (first === "P2" && options.plan) take((action) => action === "D");
    out.push(step);
  }
  return out;
}

/** 一个动作对应的那一条回复里的内容。 */
function turnOf(action: Action, dir: string): MockTurn["tools"] {
  const file = `${dir}/mock-output.md`;
  const read = `ls -la ${dir} && cat ${dir}/TASK.md || true`;
  const check = `test -f ${file} && echo checked-by-mock`;
  const plan = (done: boolean) => ({
    name: TOOL.plan,
    arguments: {
      items: [
        { text: "读题", status: done ? "done" : "in_progress" },
        { text: "写产物", status: done ? "done" : "pending" },
      ],
    },
  });
  switch (action) {
    case "A":
      return [
        {
          name: "accept_task",
          arguments: { criteria: "占位产物写好并核对过" },
        },
      ];
    case "P1":
      return [plan(false)];
    case "P2":
      return [plan(true)];
    case "R":
      return [{ name: TOOL.command, arguments: { command: read } }];
    case "W":
      return [
        {
          name: TOOL.write,
          arguments: { path: file, contents: "假模型写下的占位产物\n" },
        },
      ];
    case "C":
      return [{ name: TOOL.command, arguments: { command: check } }];
    case "RWC":
      return [
        {
          name: TOOL.command,
          arguments: {
            command: `${read}; printf '假模型写下的占位产物\\n' > ${file} && ${check}`,
          },
        },
      ];
    case "D":
      return [
        {
          name: "deliver_task",
          arguments: {
            items: [
              {
                kind: "note",
                ref: "占位产物已写好并核对过（假模型）",
                title: "占位产物",
              },
            ],
            checks: [`${check} 通过`],
          },
        },
      ];
    case "T":
      return undefined;
  }
}

/** 整张卡每一步的回复，按提示里有没有那几句话并步。 */
export function boardMockPlan(
  dir: string,
  options: BoardPlanOptions,
): MockTurn[] {
  return stepsOf(options).map((step) => {
    if (step[0] === "T")
      return { text: "做完了：占位产物已写好并交付（假模型）。" };
    return { tools: step.flatMap((action) => turnOf(action, dir) ?? []) };
  });
}

type Message = { role?: unknown; content?: unknown };

/** 剧本的下一步：走到第几步，看这段对话里已经有几条助手消息。 */
export function boardPolicy(request: MockRequest): MockTurn {
  const messages = (request.raw.messages as Message[] | undefined) ?? [];
  // 提示的话分在两处：系统提示（交付规约、how_to_work）和工具定义的描述（update_plan、accept_task），都认。
  const system = JSON.stringify({
    messages: messages.filter(
      (message) => message.role === "system" || message.role === "developer",
    ),
    tools: request.raw.tools ?? [],
  });
  const dir = /((?:eval|smoke)\/[a-z-]+)/.exec(request.lastUser)?.[1] ?? "eval";
  const plan = boardMockPlan(dir, {
    accept: system.includes(MARKS.accept),
    plan: system.includes(MARKS.plan),
    merge: system.includes(MARKS.merge),
    tools: new Set(request.offeredTools),
  });
  const done = messages.filter(
    (message) => message.role === "assistant",
  ).length;
  return plan[Math.min(done, plan.length - 1)] as MockTurn;
}

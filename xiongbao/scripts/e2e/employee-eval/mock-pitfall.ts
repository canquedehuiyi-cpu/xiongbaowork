/**
 * 本机假模型的「有坑可学」剧本（`EVAL_MOCK_SCRIPT=pitfall`）：在本机走通「第一次排查 -> 复盘 -> 技能 -> 第二次带着技能做」
 * 这条链，并看判分会不会把「照抄上一次的具体值」判错、把「按通用做法做」判对。
 *
 * 它不懂题目，只按固定节奏动手：
 * - 第一次（请求里没有技能）：先读题、跑 `bun run import`（报错）、读源码、读配置、跑 `bun run warm`（也报错）、看数据、
 *   看目录，一步步排查，最后按通用做法做完（`pitfall-solve.ts`：看数据定分隔符和小数点、找汇率目录、暖缓存、导入）；
 * - 收到复盘的请求：写一份通用的技能，快路径就是那条通用做法的命令，没有这一次的任何具体值；
 * - 第二次（技能带着快路径放进了上下文）：接活、一条命令做完、交付。
 *
 * `EVAL_MOCK_PITFALL=copy`：第二次改成照抄第一次的具体值（第一次的配置、汇率缓存、汇总整个拷过来再导入），判分应当
 * 判它不通过。默认（`general`）按通用做法，判分应当判它通过。判分结果本身不代表模型能力。
 */

import { join } from "node:path";
import { TOOL } from "./metrics";
import { FAST_MARK, RETRO_MARK, SKILL_MARK } from "./mock-learn";
import type { MockRequest, MockTurn } from "./mock-model";

/** 通用做法的脚本（本机绝对路径：假模型只在本机，命令在本机跑）。 */
export const SOLVER = join(import.meta.dir, "pitfall-solve.ts");
const FAST_PATH = `bun ${SOLVER} <dir>`;
const FAST_CHECK = "cd <dir> && bun test";

const whole = (request: MockRequest) => JSON.stringify(request.raw);

const command = (text: string): MockTurn => ({
  tools: [{ name: TOOL.command, arguments: { command: text } }],
});

/** 复盘员的回答：一份不带这一次具体值的技能。 */
function retroAnswer(): MockTurn {
  const skill = {
    name: "商户对账单导入跑不通的排查与修复",
    when: "收到一个把商户对账单（.csv）按商户汇总的小工具，要求让导入命令跑通并产出汇总文件，而导入命令一上来就报错时",
    steps: [
      "报错信息会指向币种配置，但那不是真因：先看 package.json 里的脚本，导入前要先跑一个暖汇率缓存的脚本（文档没写）",
      "看数据文件首行和第一行数据，定下分隔符和小数点写法，写进导入配置",
      "找到放汇率文件的目录（顶层目录里放着汇率文件的那个），把它写进导入配置，不要把汇率文件挪来挪去",
      "先暖缓存再导入，最后跑测试，并核对汇总里没有被跳过的行",
    ],
    pitfalls: [
      "不要改上游的代码、数据，也不要手写汇总文件",
      "不要照抄别的一期的配置值：分隔符、目录名、币种每期都可能不一样",
    ],
    verify: "导入命令退出 0，汇总里跳过的行数是 0，测试全绿",
    fastPath: FAST_PATH,
    fastPathNeeds: "目录里有对账单、汇率文件和导入配置，写权限正常",
    fastPathCheck: FAST_CHECK,
    scope: "self",
  };
  return { text: JSON.stringify({ skill }) };
}

/** 第一次要排查的几步（没有技能可参考，一步步试）。 */
function exploration(dir: string): MockTurn[] {
  const inDir = (text: string) => command(`cd ${dir} && ${text}`);
  return [
    command(`ls -la ${dir} && cat ${dir}/TASK.md`),
    inDir("bun run import || true"),
    inDir("cat src/import.ts"),
    inDir("cat package.json import.config.json"),
    inDir("bun run warm || true"),
    inDir("ls -d */ && ls inbox"),
    inDir("head -3 inbox/*.csv"),
    command(fixCommand(dir)),
    inDir("bun test"),
  ];
}

const fixCommand = (dir: string) => FAST_PATH.replaceAll("<dir>", dir);

/** 照抄：第一次的配置、汇率缓存和汇总，整个拷过来再导入。 */
function copyCommand(dir: string): string {
  const first = dir.replace(/-second$/, "-first");
  return [
    `mkdir -p ${dir}/.cache ${dir}/out`,
    `cp ${first}/import.config.json ${dir}/import.config.json`,
    `cp ${first}/.cache/rates.json ${dir}/.cache/rates.json`,
    `cp ${first}/out/summary.json ${dir}/out/summary.json`,
    `(cd ${dir} && bun run import || true)`,
  ].join(" && ");
}

/** 一轮里第几步该发什么（按这一轮已收到的工具结果数算）。 */
export function pitfallPolicy(
  request: MockRequest,
  dir: string,
  env: Record<string, string | undefined> = process.env,
  root?: string,
): MockTurn {
  if (whole(request).includes(RETRO_MARK)) return retroAnswer();
  const known = whole(request).includes(SKILL_MARK);
  const fast = known && whole(request).includes(FAST_MARK);
  const second = dir.endsWith("-second");
  const copy = second && env.EVAL_MOCK_PITFALL?.trim() === "copy";
  const accepted = request.offeredTools.includes("accept_task");
  // 命令在电脑上的 shell 里跑，它的起点不是工作区根，所以命令里用绝对路径（`root` 是工作区根）；交付的文件用相对路径。
  const at = root ? join(root, dir) : dir;
  const work: MockTurn[] = copy
    ? [command(copyCommand(at))]
    : fast
      ? [command(`${fixCommand(at)} && ${FAST_CHECK.replaceAll("<dir>", at)}`)]
      : exploration(at);
  const script: MockTurn[] = [
    ...(accepted
      ? [
          {
            tools: [
              {
                name: "accept_task",
                arguments: {
                  criteria: "out/summary.json 由 bun run import 生成并核对过",
                },
              },
            ],
          },
        ]
      : []),
    ...work,
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
                      ref: `${dir}/out/summary.json`,
                      title: "对账汇总",
                    },
                  ],
                  checks: ["汇总已由 bun run import 生成并核对过"],
                },
              },
            ],
          },
        ]
      : []),
    { text: "做完了：导入已跑通并交付（假模型）。" },
  ];
  return script[
    Math.min(request.toolResultsSinceUser, script.length - 1)
  ] as MockTurn;
}

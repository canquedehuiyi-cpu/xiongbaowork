/**
 * 本机假模型的「提前收尾」剧本：用来在本机看收尾提醒有没有生效（`EVAL_MOCK_SCRIPT=early-stop` 打开）。
 *
 * 剧本不懂题目，只演一个爱提前收尾的员工：列计划、读两个文件，计划还没做完就说一句话收尾；被提醒（或被评测脚本
 * 追「继续」）之后才动手写 `src/money.ts`，写完又不验就收尾；再被提醒才跑一条校验、把计划打勾、说「全部做完」。
 * 有收尾提醒时，这些提醒在同一轮里就被收到，评测脚本不用替人发「继续」；没有时，评测脚本要追，且改完没有验证。
 * 「被提醒」只认请求末尾的一条新用户消息：它之前追过的「继续」留在历史里，不算这一步的提醒。
 */

import { TOOL } from "./metrics";
import type { MockRequest, MockTurn } from "./mock-model";

/** 剧本是否打开。 */
export function earlyStopWanted(
  env: Record<string, string | undefined>,
): boolean {
  return env.EVAL_MOCK_SCRIPT?.trim() === "early-stop";
}

type Message = { role?: unknown; content?: unknown };

/** 剧本的下一步：按已经收到的工具结果数走，提醒只看请求末尾那条新的用户消息。 */
export function earlyStopPolicy(request: MockRequest): MockTurn {
  const messages = (request.raw.messages as Message[] | undefined) ?? [];
  const results = messages.filter((message) => message.role === "tool").length;
  const last = messages.at(-1);
  const fresh =
    last?.role === "user" &&
    messages.filter((m) => m.role === "user").length > 1
      ? String(last.content ?? "")
      : "";
  const dir =
    /((?:eval|smoke)\/[a-z-]+)/.exec(request.lastUser)?.[1] ?? "eval/refactor";
  const first = String(
    messages.find((message) => message.role === "user")?.content ?? "",
  );
  const where = /((?:eval|smoke)\/[a-z-]+)/.exec(first)?.[1] ?? dir;
  const continued = /计划里还有|继续完成上面交代/.test(fresh);
  const checkAsked = /没有跑任何测试|继续完成上面交代/.test(fresh);
  const plan = (status: "pending" | "done") => ({
    name: TOOL.plan,
    arguments: {
      items: [
        { text: "读代码", status: status === "done" ? "done" : "in_progress" },
        { text: "新建 money.ts 并改调用处", status },
        { text: "跑测试", status },
      ],
    },
  });
  const command = (text: string) => ({
    name: TOOL.command,
    arguments: { command: text },
  });
  if (results === 0)
    return { tools: [plan("pending"), command(`ls ${where}/src`)] };
  if (results === 2) return { tools: [command(`cat ${where}/src/price.ts`)] };
  if (results === 3) return { tools: [command(`cat ${where}/src/order.ts`)] };
  if (results === 4)
    return continued
      ? {
          tools: [
            {
              name: TOOL.write,
              arguments: {
                path: `${where}/src/money.ts`,
                contents:
                  "export const cents = (n: number) => Math.round(n * 100);\n",
              },
            },
          ],
        }
      : { text: "文件都读完了，下一步我来动手重构（假模型）。" };
  if (results === 5)
    return checkAsked
      ? { tools: [command(`echo "tests: all passed (mock)"`)] }
      : { text: "重构完成（假模型）。" };
  if (results === 6) return { tools: [plan("done")] };
  return { text: "全部做完，测试通过（假模型）。" };
}

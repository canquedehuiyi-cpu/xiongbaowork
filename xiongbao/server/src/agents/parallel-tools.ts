/**
 * 一步多个工具调用的开关（token 第三轮）。
 *
 * 每一步都把整段历史再发一遍，所以步数是输入 token 的乘数。员工一步只调一个工具，Codex 一次动作常常带多条命令。
 * 两处一起改：系统提示请员工把互不依赖的读取、搜索、命令放在同一步里一次发出（`slim-guidance.ts`）；
 * 只读的电脑工具在同一步里并行执行（`computer/headless-tools.ts`）。
 *
 * `XIONGBAO_PARALLEL_TOOLS=off` 一次关掉两处，回到原样。默认开。
 */
export const PARALLEL_TOOLS_ENV = "XIONGBAO_PARALLEL_TOOLS";

/** 并行工具调用是否开着：默认开，只有明确写 `off` 才关。 */
export function parallelToolsOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PARALLEL_TOOLS_ENV]?.trim().toLowerCase() !== "off";
}

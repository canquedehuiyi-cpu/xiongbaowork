/**
 * 员工的「思考模式」（期三，规格 docs/specs/2026-11-19-codex-grade-employee.md §2）。
 *
 * 用 DeepSeek 时，员工默认先想再做：模型的推理内容作为 AG-UI 的推理事件（`REASONING_*`）流出，随这一轮的其它
 * 事件一起存库，刷新后回放。每个员工可以单独关掉；部署级的 `DEEPSEEK_THINKING=disabled` 全部关掉。别的模型
 * 不受这个开关影响。
 *
 * 存在员工的 `agents.configuration.thinking` 里：只记关掉（`false`），没写就是开着，所以已有的员工不用迁移。
 * 只有在本部署上跑的员工（`built_in`）有这个开关：远端员工的模型由它自己的服务器决定。
 */

/** 没设置过的员工是否开着思考模式。 */
export const THINKING_DEFAULT = true;

/** 界面上这个开关的名字。 */
export const THINKING_LABEL = "思考模式";

/** 开关下面的一句说明。 */
export const THINKING_HINT =
  "开着时员工先想再做，对话里能看到它的思考过程；用量和等待时间会增加。关掉后直接作答。";

/** 员工资料（`GET /api/agents/:id` 等）里带的字段。 */
export type AgentThinkingFields = {
  /** 这个员工是否开着思考模式。 */
  thinking: boolean;
};

/** 保存员工（创建、`PATCH`）时可以带的字段：不带就是不改，`true` 打开，`false` 关掉。 */
export type AgentThinkingInput = {
  thinking?: boolean;
};

/** 从员工的 `agents.configuration` 读出思考模式：只有明确写了 `false` 才算关掉。 */
export function thinkingOf(configuration: unknown): boolean {
  if (!configuration || typeof configuration !== "object") {
    return THINKING_DEFAULT;
  }
  return (configuration as { thinking?: unknown }).thinking !== false;
}

/**
 * 推理内容在流里的 AG-UI 事件，按出现的顺序。界面据此画可折叠的「思考」块：`REASONING_MESSAGE_CONTENT`
 * 的 `delta` 是一段段推理文字，同一段的事件共用一个 `messageId`。
 */
export const REASONING_EVENTS = [
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_END",
] as const;

export type ReasoningEventType = (typeof REASONING_EVENTS)[number];

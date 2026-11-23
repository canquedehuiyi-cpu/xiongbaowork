/**
 * 只交了文字结论、这件活要的却是实物：交付第一次被挡回（交付即可用，规格 D）。
 *
 * 交付里全是 `note`，而验收标准、卡标题或交付项标题里提到「文件/网页/程序/PPT/文档/表格/视频/图片」这类实物词，
 * `deliver_task` 第一次被挡回，让员工把产物存成文件交付。逃生口：note 里写明「这件活没有文件产物」就放行。
 *
 * 只看这一轮的对话（最后一条用户消息之后），不另存状态：「已经挡回过」从历史里的挡回结果标记认出来，
 * 每轮最多挡一次。部署开关 `XIONGBAO_PHYSICAL_GATE=off` 关掉，默认开。被挡回的交付不算已交付：卡片没动，
 * 交付即收尾（`tasks/delivery-end.ts`）只认 `delivered: true`。
 */

import type { DeliveryItem } from "./evidence-gate";

export const PHYSICAL_GATE_ENV = "XIONGBAO_PHYSICAL_GATE";

/** 开着吗：默认开，只有明确写 `off` 才关。 */
export function physicalGateOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PHYSICAL_GATE_ENV]?.trim().toLowerCase() !== "off";
}

/** 挡回结果里的标记：历史里有它，就是这一轮已经挡回过一次。 */
export const PHYSICAL_BOUNCE_KEY = "physicalDeliverableBounce";

/** 确实没有文件产物时，员工在 note 里写的固定说法。 */
export const NO_FILE_PHRASE = "这件活没有文件产物";
/** 给员工看的一句：交付的是文件就存进工作区交付，别只贴在对话里；真没有文件就按 {@link NO_FILE_PHRASE} 写明。 */
export const FILE_DELIVERY_HINT = `交付的是文件/网页/程序就把它存在工作区里并作为 workspace_file / app 交付；不要只把内容贴在对话里。确实没有文件产物，就在 note 里写「${NO_FILE_PHRASE}」。`;

export const PHYSICAL_WORDS = [
  "文件",
  "网页",
  "程序",
  "PPT",
  "文档",
  "表格",
  "视频",
  "图片",
] as const;

type Turn = { role?: string; content?: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : "";

/** 这一轮的消息：最后一条用户消息之后的。 */
function thisTurn(messages: readonly Turn[]): Turn[] {
  let start = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") start = index + 1;
  });
  return messages.slice(start);
}

const mentionsPhysical = (text: string): boolean => {
  const upper = text.toUpperCase();
  return PHYSICAL_WORDS.some((word) => upper.includes(word.toUpperCase()));
};

/** 真 = 应该挡回。 */
export function uncheckedPhysical(input: {
  items: readonly DeliveryItem[];
  criteria: string | null;
  title: string | null;
  messages: readonly unknown[];
}): boolean {
  if (input.items.length === 0) return false;
  if (!input.items.every((item) => item.kind === "note")) return false;
  const said = input.items.flatMap((item) => [item.ref, item.title ?? ""]);
  if (said.some((text) => text.includes(NO_FILE_PHRASE))) return false;
  const named = [
    input.criteria ?? "",
    input.title ?? "",
    ...input.items.map((item) => item.title ?? ""),
  ];
  if (!named.some(mentionsPhysical)) return false;
  const bounced = thisTurn(input.messages as readonly Turn[]).some(
    (message) =>
      message.role === "tool" &&
      textOf(message.content).includes(`"${PHYSICAL_BOUNCE_KEY}"`),
  );
  return !bounced;
}

export function physicalBounceReason(): string {
  return `只给了文字结论，但这件活要的是实物。把产物存成文件放在工作区，用 workspace_file 交付；确实没有文件产物，就在 note 里写「${NO_FILE_PHRASE}」。`;
}

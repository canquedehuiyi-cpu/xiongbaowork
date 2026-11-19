/**
 * 「招聘与组群」起草工具的回答格式，服务端写、对话记录读，两边共用这一份声明（照 `app-access-request.ts`）。
 *
 * 服务端执行的工具到了对话记录里只是一段给模型看的文字，所以卡片要的字段放在第一行的标记后面，用 JSON
 * 写；后面的句子才是模型读的。JSON 里只带提议 id、种类和标题：卡片打开时向 `GET /api/proposals/:id`
 * 读最新的草稿与状态，不信任对话记录里的副本。
 */

/** 这组工具的名字，按目录与授予（`staffing/<名字>`）列出的顺序。 */
export const STAFFING_TOOL_NAMES = [
  "list_staff",
  "propose_employee",
  "propose_employee_change",
  "propose_group",
  "propose_group_change",
  "proposal_status",
] as const;

export type StaffingToolName = (typeof STAFFING_TOOL_NAMES)[number];

/** 会出卡片的四个：只有它们的回答以标记开头。 */
const PROPOSE_TOOLS: ReadonlySet<string> = new Set([
  "propose_employee",
  "propose_employee_change",
  "propose_group",
  "propose_group_change",
]);

/** 给模型的工具名形如 `mcp__staffing__propose_employee`；对话记录里两种写法都可能出现。 */
const SERVER_PREFIX = "mcp__staffing__";

/** 这次工具调用是不是起草提议的那四个之一（去掉服务器前缀后精确比对）。 */
export function isStaffingProposalTool(name: string): boolean {
  const bare = name.startsWith(SERVER_PREFIX)
    ? name.slice(SERVER_PREFIX.length)
    : name;
  return PROPOSE_TOOLS.has(bare);
}

/** 回答第一行的开头，后面紧跟卡片的 JSON。 */
export const STAFFING_PROPOSAL_MARKER = "<<openbot:staffing-proposal>>";

export const STAFFING_PROPOSAL_KINDS = [
  "employee",
  "employee_change",
  "group",
  "group_change",
] as const;

export type StaffingProposalKind = (typeof STAFFING_PROPOSAL_KINDS)[number];

export type StaffingProposalCard = {
  proposalId: string;
  kind: StaffingProposalKind;
  /** 卡片标题：新员工或新群的名字，改动类是「调整「名字」」。 */
  title: string;
};

export function writeStaffingProposalAnswer(
  card: StaffingProposalCard,
  sentence: string,
): string {
  return `${STAFFING_PROPOSAL_MARKER}${JSON.stringify(card)}\n${sentence}`;
}

/** 从工具回答里读出卡片和句子；不是这种回答、或任何一个字段不对时为 null。 */
export function readStaffingProposalAnswer(
  text: string,
): { card: StaffingProposalCard; sentence: string } | null {
  if (!text.startsWith(STAFFING_PROPOSAL_MARKER)) return null;
  const rest = text.slice(STAFFING_PROPOSAL_MARKER.length);
  const newline = rest.indexOf("\n");
  const json = newline === -1 ? rest : rest.slice(0, newline);
  const sentence = newline === -1 ? "" : rest.slice(newline + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const card = parsed as Record<string, unknown>;
  if (
    typeof card.proposalId !== "string" ||
    card.proposalId === "" ||
    typeof card.title !== "string" ||
    !(STAFFING_PROPOSAL_KINDS as readonly unknown[]).includes(card.kind)
  )
    return null;
  return {
    card: {
      proposalId: card.proposalId,
      kind: card.kind as StaffingProposalKind,
      title: card.title,
    },
    sentence,
  };
}

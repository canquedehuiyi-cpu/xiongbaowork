import { asText } from "@/lib/plugins/tool-result";
import {
  type ProposalStatus,
  type ProposalSummary,
  useProposal,
} from "@/lib/staffing/queries";
import {
  type StaffingProposalCard as Card,
  isStaffingProposalTool,
  readStaffingProposalAnswer,
  type StaffingProposalKind,
} from "../../../../shared/staffing-proposal";
import { CardShell, ClosedNote, isClosed } from "./card-parts";
import { EmployeeChangeProposal } from "./employee-change-proposal";
import { EmployeeProposal } from "./employee-proposal";
import { GroupChangeProposal, GroupProposal } from "./group-proposal";
import { ProposalResult } from "./proposal-result";

/**
 * 对话里招聘与组群的卡片：员工调起草工具得到的回答，按提议的种类画成四种卡片之一。
 *
 * 标记只带提议 id、种类和标题，卡片打开时向 `GET /api/proposals/:id` 读最新的草稿与状态，不信对话记录里的
 * 副本。只有那四个起草工具的回答才读标记：别的工具的回答是别人写的字，里面出现一个像样的标记也不画卡片。
 */

/** 缺的角色最多几项、每项多长：与服务端转述给员工时的上限一致（`builtin-staffing.ts`）。 */
const MISSING_ROLES_MAX = 10;
const MISSING_ROLE_LENGTH = 60;

/** 这次工具调用的回答是不是一张招聘与组群卡片；是就给出卡片和建群时缺的角色。 */
export function readStaffingCard(
  name: string,
  args: string | undefined,
  result: string | undefined,
): { card: Card; missingRoles: string[] } | null {
  if (result === undefined || !isStaffingProposalTool(name)) return null;
  const read = readStaffingProposalAnswer(asText(result));
  if (!read) return null;
  return {
    card: read.card,
    missingRoles: read.card.kind === "group" ? missingRolesIn(args) : [],
  };
}

/** 员工这次调用写的 `missingRoles`：只收短文字，读不出来就当没有。 */
function missingRolesIn(args: string | undefined): string[] {
  if (!args) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return [];
  }
  const roles = (parsed as { missingRoles?: unknown } | null)?.missingRoles;
  if (!Array.isArray(roles)) return [];
  return [
    ...new Set(
      roles
        .filter((role): role is string => typeof role === "string")
        .map((role) => role.replace(/\s+/g, " ").trim())
        .filter((role) => role !== "" && role.length <= MISSING_ROLE_LENGTH),
    ),
  ].slice(0, MISSING_ROLES_MAX);
}

export function StaffingProposalCard({
  card,
  missingRoles = [],
}: {
  card: Card;
  missingRoles?: string[];
}) {
  const view = useProposal(card.proposalId);
  const fallbackTitle = TITLE[card.kind](card.title);

  if (view.isPending)
    return (
      <CardShell
        proposalId={card.proposalId}
        status={null}
        title={fallbackTitle}
      >
        <p className="text-muted-foreground text-sm">正在读取这份提议…</p>
      </CardShell>
    );
  if (view.isError || !view.data)
    return (
      <CardShell
        proposalId={card.proposalId}
        status={null}
        title={fallbackTitle}
      >
        <p className="text-muted-foreground text-sm">
          读不到这份提议了，它可能不在你能看到的范围里。
        </p>
      </CardShell>
    );

  if (!view.data.canAct)
    return (
      <SummaryLine proposalId={card.proposalId} summary={view.data.summary} />
    );

  const { proposal } = view.data;
  const title = TITLE[proposal.kind](titleOf(proposal.draft, card.title));
  if (proposal.status === "applied" || proposal.status === "partially_applied")
    return <ProposalResult proposal={proposal} title={title} />;
  if (isClosed(proposal.status))
    return (
      <CardShell
        proposalId={proposal.id}
        status={proposal.status}
        title={title}
      >
        <ClosedNote status={proposal.status} />
      </CardShell>
    );
  if (proposal.status === "applying")
    return (
      <CardShell proposalId={proposal.id} status="applying" title={title}>
        <p className="text-muted-foreground text-sm">正在执行，稍等…</p>
      </CardShell>
    );
  switch (proposal.kind) {
    case "employee":
      return <EmployeeProposal proposal={proposal} />;
    case "employee_change":
      return <EmployeeChangeProposal proposal={proposal} />;
    case "group":
      return <GroupProposal missingRoles={missingRoles} proposal={proposal} />;
    case "group_change":
      return <GroupChangeProposal proposal={proposal} />;
  }
}

const TITLE: Record<StaffingProposalKind, (name: string) => string> = {
  employee: (name) => `招聘「${name}」`,
  employee_change: (name) => name,
  group: (name) => `组建群聊「${name}」`,
  group_change: (name) => name,
};

/** 草稿里有名字（新员工、新群）用它，否则用标记里的标题（改动类是「调整「名字」」）。 */
function titleOf(draft: unknown, fallback: string): string {
  const name = (draft as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

const KIND_WORDS: Record<StaffingProposalKind, string> = {
  employee: "一个新员工",
  employee_change: "一份员工调整",
  group: "一个新群聊",
  group_change: "一份群聊调整",
};

/** 摘要里括号中的那句：还在等谁、做没做、作废还是过期。 */
function waitingWords(status: ProposalStatus, owner: string): string {
  switch (status) {
    case "pending":
      return `待${owner}确认`;
    case "applying":
      return "正在执行";
    case "applied":
      return `${owner}已确认`;
    case "partially_applied":
      return `${owner}已确认，部分完成`;
    case "discarded":
      return "已作废";
    case "expired":
      return "已过期";
  }
}

/** 别人看这段对话时的一行摘要：没有按钮，也不露出草稿内容。 */
function SummaryLine({
  proposalId,
  summary,
}: {
  proposalId: string;
  summary: ProposalSummary;
}) {
  const owner = summary.ownerName.trim();
  const butler = owner ? `${owner}的小管家` : "小管家";
  return (
    <p
      className={
        isClosed(summary.status)
          ? "my-2 text-muted-foreground text-sm opacity-60"
          : "my-2 text-muted-foreground text-sm"
      }
      data-staffing-proposal={proposalId}
      data-status={summary.status}
    >
      {`${butler}拟了${KIND_WORDS[summary.kind]}：${summary.title}（${waitingWords(summary.status, owner || "主人")}）`}
    </p>
  );
}

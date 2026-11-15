import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type AcpChoice,
  AcpPermissionCard,
  acpCardOf,
  acpRawText,
  decisionErrorText,
} from "@/components/channels/acp-cards";
import { approvalRequestOptions, decideApproval } from "@/lib/approvals";
import { type GroupAcpPermission, groupKeys } from "@/lib/groups";
import { cn } from "@/lib/utils";

/*
 * 群里的许可状态行（外部员工 Task 12）。外部员工在群里干活时请求许可，群转录里只有一行状态：谁在等谁确认、
 * 结果如何（服务器 `channels/group.ts` 的 `acpPermission`），命令、路径、改动的文件、规则名、审批 id 都不在里面。
 *
 * 群里其他人：只有这一行，没有按钮。招聘人：同一行，另有「去确认」（他自己的审批详情页），并在这里直接给出
 * 请求许可卡。他那条审批的 id 只交给他本人（服务器放在这一行的私有部分），卡片内容按这个 id 从他自己的
 * 审批接口读，不在群转录里。
 */

const LINE =
  "m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--wb-fg2,var(--muted-foreground))]";

function sentence(
  line: GroupAcpPermission,
  employee: string,
  hirerIsMe: boolean,
): string {
  const hirer = hirerIsMe ? "你" : line.hirerName;
  if (line.status === "waiting")
    return hirerIsMe
      ? `${employee}在等你确认一个操作`
      : `${employee}在等 ${hirer} 确认一个操作`;
  if (line.status === "approved") return `${hirer}批准了${employee}的一个操作`;
  if (line.status === "denied") return `${hirer}拒绝了${employee}的一个操作`;
  return `${employee}等确认的一个操作已作废`;
}

export function AcpGroupPermissionLine({
  line,
  employee,
  approvalId,
  meId,
}: {
  line: GroupAcpPermission;
  /** 员工的名字。 */
  employee: string;
  /** 招聘人本人读到的、这一行等的那条审批；别人读不到。 */
  approvalId?: string;
  meId?: string;
}) {
  const hirerIsMe = meId !== undefined && meId === line.hirerUserId;
  const waiting = line.status === "waiting";
  return (
    <div className="flex w-full flex-col gap-2" data-acp-group-line="">
      <p className={LINE} role="status">
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            waiting
              ? "bg-[color:var(--wb-amber,var(--signal))]"
              : line.status === "approved"
                ? "bg-[color:var(--wb-green,var(--color-emerald-500))]"
                : "bg-[color:var(--wb-gray,var(--muted-foreground))]",
          )}
        />
        <span>{sentence(line, employee, hirerIsMe)}</span>
        {hirerIsMe && waiting ? (
          <Link
            className="font-medium text-[color:var(--wb-accent2,var(--primary))] underline underline-offset-2"
            {...(approvalId ? { search: { id: approvalId } } : {})}
            to="/approvals"
          >
            去确认
          </Link>
        ) : null}
      </p>
      {hirerIsMe && waiting && approvalId ? (
        // 换了一条请求就是一张新卡：上一条的答复不会留在下一条上。
        <HirerCard approvalId={approvalId} key={approvalId} />
      ) : null}
    </div>
  );
}

function HirerCard({ approvalId }: { approvalId: string }) {
  const cache = useQueryClient();
  const request = useQuery({
    ...approvalRequestOptions(approvalId),
    retry: false,
  });
  const decision = useMutation({
    mutationFn: (choice: AcpChoice) => decideApproval(approvalId, choice),
    onSettled: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: ["approvals"] }),
        cache.invalidateQueries({ queryKey: groupKeys.all }),
      ]),
  });
  const data = request.data;
  const card = data ? acpCardOf(data.action) : null;
  if (!data || !card || data.status !== "pending") return null;
  return (
    <AcpPermissionCard
      answered={decision.isSuccess ? decision.variables : null}
      card={card}
      error={decisionErrorText(decision.error)}
      onDecide={(choice) => decision.mutate(choice)}
      raw={acpRawText(data.action.args)}
      submitting={decision.isPending}
    />
  );
}

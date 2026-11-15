import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type AcpChoice,
  AcpPermissionCard,
  acpCardOf,
  acpRawText,
} from "@/components/channels/acp-cards";
import { approvalInboxOptions, decideApproval } from "@/lib/approvals";
import { type GroupAcpPermission, groupKeys } from "@/lib/groups";
import { cn } from "@/lib/utils";

/*
 * 群里的许可状态行（外部员工 Task 12）。外部员工在群里干活时请求许可，群转录里只有一行状态：谁在等谁确认、
 * 结果如何（服务器 `channels/group.ts` 的 `acpPermission`），命令、路径、改动的文件、规则名、审批 id 都不在里面。
 *
 * 群里其他人：只有这一行，没有按钮。招聘人：同一行，另有「去确认」（他自己的审批详情页），并在这里直接给出
 * 请求许可卡——卡片的内容取自他自己读得到的审批收件箱，不是群转录。
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
  threadId,
  meId,
}: {
  line: GroupAcpPermission;
  /** 员工的名字。 */
  employee: string;
  /** 这一行所在的那条线程：招聘人在自己的审批里按它找到这一条。 */
  threadId?: string | null;
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
          <HirerLink line={line} threadId={threadId} />
        ) : null}
      </p>
      {hirerIsMe && waiting ? (
        <HirerCard line={line} threadId={threadId} />
      ) : null}
    </div>
  );
}

/** 招聘人自己收件箱里，这一行等的那一条（同一位员工、同一条线程、还在等）。 */
function useOwnRequest(line: GroupAcpPermission, threadId?: string | null) {
  const inbox = useQuery(approvalInboxOptions());
  return inbox.data?.requests.find(
    (request) =>
      request.status === "pending" &&
      request.action.botId === line.agentId &&
      (threadId == null || request.action.threadId === threadId) &&
      acpCardOf(request.action) !== null,
  );
}

function HirerLink({
  line,
  threadId,
}: {
  line: GroupAcpPermission;
  threadId?: string | null;
}) {
  const request = useOwnRequest(line, threadId);
  return (
    <Link
      className="font-medium text-[color:var(--wb-accent2,var(--primary))] underline underline-offset-2"
      {...(request ? { search: { id: request.id } } : {})}
      to="/approvals"
    >
      去确认
    </Link>
  );
}

function HirerCard({
  line,
  threadId,
}: {
  line: GroupAcpPermission;
  threadId?: string | null;
}) {
  const cache = useQueryClient();
  const request = useOwnRequest(line, threadId);
  const decision = useMutation({
    mutationFn: (choice: AcpChoice) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: ["approvals"] }),
        cache.invalidateQueries({ queryKey: groupKeys.all }),
      ]),
  });
  const card = request ? acpCardOf(request.action) : null;
  if (!request || !card) return null;
  return (
    <AcpPermissionCard
      answered={decision.isSuccess ? decision.variables : null}
      card={card}
      error={decision.error?.message ?? null}
      onDecide={(choice) => decision.mutate(choice)}
      raw={acpRawText(request.action.args)}
      submitting={decision.isPending}
    />
  );
}

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type Proposal,
  type ResultItem,
  useDiscardProposal,
  useRetryProposal,
} from "@/lib/staffing/queries";
import { ActionProblem, CardShell, TAP } from "./card-parts";

/**
 * 执行之后的卡片：逐项写做成了什么——✓、已转申请、需要先连接（带连接按钮）、失败（可重试）——再给
 * 「打开员工」「打开群组」。
 *
 * 应用的状态只在这里出现：起草时算的状态不随提议保存，执行时才按本人此刻的权限与连接决定，所以结果
 * 才是准的。重试只把失败的几步按草稿里的内容再做一遍，已经做成的不动，也不重新比对起草之后的改动。
 */

const STEP_WORDS: Record<string, string> = {
  create: "建员工",
  update: "更新资料",
  model: "模型",
  avatar: "头像",
  skill: "技能",
  app: "应用",
  app_remove: "收回应用",
  routine: "定时任务",
  routine_remove: "删除定时任务",
  staffing_tools: "招聘与组群能力",
  group: "建群",
  rename: "群名",
  add: "加成员",
  remove: "移成员",
  reorder: "调整顺序",
};

/** 结果里点名的对象：技能、应用、定时任务、群名写出来；员工与群组的 id 不给人看。 */
const NAMED_STEPS = new Set([
  "skill",
  "app",
  "app_remove",
  "routine",
  "rename",
]);

export function ProposalResult({
  proposal,
  title,
}: {
  proposal: Proposal;
  title: string;
}) {
  const retry = useRetryProposal(proposal.id);
  const discard = useDiscardProposal(proposal.id);
  const [error, setError] = useState<unknown>(null);
  const items = proposal.result ?? [];
  // 结果的条目顺序固定（服务端按步骤顺序写），同一步可能出现多次（几个技能、几个应用），所以带上位置。
  const rows = items.map((item, position) => ({
    item,
    key: `${item.step}:${item.target ?? ""}:${position}`,
  }));
  const open = openLink(proposal);

  const again = async () => {
    setError(null);
    try {
      await retry.mutateAsync();
    } catch (cause) {
      setError(cause);
    }
  };
  // 失败的步骤重试也做不成（比如群已经不在了）时，作废让它有个了结；做成的几步不回滚。
  const drop = async () => {
    setError(null);
    try {
      await discard.mutateAsync();
    } catch (cause) {
      setError(cause);
    }
  };
  const busy = retry.isPending || discard.isPending;

  return (
    <CardShell proposalId={proposal.id} status={proposal.status} title={title}>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <ResultRow item={row.item} key={row.key} />
        ))}
      </ul>
      {proposal.status === "partially_applied" ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">
            重试只按草稿里的内容把失败或没来得及做的几步再做一遍，已经做成的不会重做。
          </p>
          {error ? <ActionProblem error={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button
              className={TAP}
              disabled={busy}
              onClick={() => void drop()}
              variant="ghost"
            >
              {discard.isPending ? "正在作废…" : "作废"}
            </Button>
            <Button
              className={TAP}
              disabled={busy}
              onClick={() => void again()}
              variant="outline"
            >
              {retry.isPending ? "正在重试…" : "重试"}
            </Button>
          </div>
        </div>
      ) : null}
      {proposal.status === "discarded" ? (
        <p className="mt-3 text-muted-foreground text-xs">
          已作废：做成的几步保留，失败的不再重试。
        </p>
      ) : null}
      {open ? (
        <div className="mt-3 flex justify-end">
          {open.kind === "employee" ? (
            <Link
              className={`${TAP} inline-flex items-center rounded-[9px] border border-border text-sm`}
              params={{ agentId: open.id }}
              to="/bots/$agentId"
            >
              打开员工
            </Link>
          ) : (
            <Link
              className={`${TAP} inline-flex items-center rounded-[9px] border border-border text-sm`}
              params={{ channelId: open.id }}
              to="/group/$channelId"
            >
              打开群组
            </Link>
          )}
        </div>
      ) : null}
    </CardShell>
  );
}

function ResultRow({ item }: { item: ResultItem }) {
  const what = STEP_WORDS[item.step] ?? "一步";
  const named = NAMED_STEPS.has(item.step) && item.target ? item.target : null;
  return (
    <li className="flex flex-col gap-1 border-border border-t pt-2 text-sm first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 break-words">
          <span className="text-muted-foreground">{what}</span>
          {named ? <span>：{named}</span> : null}
        </span>
        <OutcomeTag outcome={item.outcome} />
      </div>
      {item.message ? (
        <p className="break-words text-muted-foreground">{item.message}</p>
      ) : null}
      {item.outcome === "needs_connection" &&
      item.step === "app" &&
      item.target ? (
        <Link
          aria-label={`去连接 ${item.target}`}
          className={`${TAP} inline-flex items-center self-start rounded-[9px] bg-primary font-bold text-primary-foreground text-sm`}
          params={{ key: item.target }}
          to="/connections/$key"
        >
          去连接
        </Link>
      ) : null}
    </li>
  );
}

function OutcomeTag({ outcome }: { outcome: ResultItem["outcome"] }) {
  if (outcome === "done")
    return (
      <span className="shrink-0 font-bold text-foreground">
        <span aria-hidden="true">✓</span>
        <span className="sr-only">已完成</span>
      </span>
    );
  if (outcome === "requested")
    return <span className="shrink-0 text-muted-foreground">已转申请</span>;
  if (outcome === "needs_connection")
    return <span className="shrink-0 text-signal">需要先连接</span>;
  return <span className="shrink-0 font-medium text-destructive">失败</span>;
}

/** 做成之后去哪里看：新员工看建好的那位，新群看建好的群；改动类就是原来那位、原来那个群。 */
function openLink(
  proposal: Proposal,
): { kind: "employee" | "group"; id: string } | null {
  const made = (step: string) =>
    proposal.result?.find(
      (item) => item.step === step && item.outcome !== "failed" && item.target,
    )?.target ?? null;
  switch (proposal.kind) {
    case "employee": {
      const id = made("create");
      return id ? { kind: "employee", id } : null;
    }
    case "employee_change":
      return { kind: "employee", id: proposal.draft.agentId };
    case "group": {
      const id = made("group");
      return id ? { kind: "group", id } : null;
    }
    case "group_change":
      return { kind: "group", id: proposal.draft.channelId };
  }
}

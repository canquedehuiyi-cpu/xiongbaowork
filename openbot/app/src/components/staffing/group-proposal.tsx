import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelQueryOptions } from "@/lib/channels/queries";
import { useConversation } from "@/lib/copilot/conversation";
import type {
  GroupChangeDraft,
  GroupDraft,
  Proposal,
} from "@/lib/staffing/queries";
import {
  ActionProblem,
  CardShell,
  DecisionButtons,
  TAP,
  useDecision,
} from "./card-parts";

/**
 * 建群与改群的提议卡片。
 *
 * 成员按回答顺序排：上面一行头像看顺序，下面逐位列出，每位都有「上移」「下移」两个按钮——键盘和读屏都
 * 能调，手机上也不用拖。改过顺序或群名，确认时先存回服务端再执行。
 *
 * 缺的角色来自员工这次调用写的 `missingRoles`（服务端不保存它，只转述给员工）：「先去招」就是替本人对
 * 小管家说「先帮我招一个××」，作为本人的一条消息发出去，对话里看得到。
 */

/** 员工 id 换成名字；读不到的（列表还没回来）先用 id 顶着。 */
function useNames() {
  const agents = useQuery(agentListQueryOptions());
  return (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
}

export function GroupProposal({
  proposal,
  missingRoles,
}: {
  proposal: Proposal & { kind: "group" };
  missingRoles: string[];
}) {
  const [draft, setDraft] = useState<GroupDraft>(proposal.draft);
  const [edited, setEdited] = useState(false);
  const decision = useDecision(proposal.id);
  const nameId = useId();
  const change = (patch: Partial<GroupDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setEdited(true);
  };
  const blank = draft.name.trim() === "";

  return (
    <CardShell
      caption="你按下「确认建群」之前，什么都不会建。"
      proposalId={proposal.id}
      status="pending"
      title={`组建群聊「${draft.name.trim() || "新群聊"}」`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-muted-foreground text-xs" htmlFor={nameId}>
            群名
          </label>
          <Input
            className="h-11"
            id={nameId}
            maxLength={80}
            onChange={(event) => change({ name: event.target.value })}
            value={draft.name}
          />
        </div>
        <MemberOrder
          members={draft.members}
          onChange={(members) => change({ members })}
        />
        <MissingRoles roles={missingRoles} />
        {blank ? (
          <p className="text-destructive text-sm">群名不能为空。</p>
        ) : null}
        {decision.error ? <ActionProblem error={decision.error} /> : null}
        <DecisionButtons
          busy={decision.busy}
          confirmBlocked={blank}
          confirmLabel="确认建群"
          onConfirm={() => void decision.confirm(edited ? draft : null)}
          onDiscard={() => void decision.discard()}
        />
      </div>
    </CardShell>
  );
}

export function GroupChangeProposal({
  proposal,
}: {
  proposal: Proposal & { kind: "group_change" };
}) {
  const [draft, setDraft] = useState<GroupChangeDraft>(proposal.draft);
  const [edited, setEdited] = useState(false);
  const decision = useDecision(proposal.id);
  const channel = useQuery(channelQueryOptions(draft.channelId));
  const nameOf = useNames();
  const before = channel.data;

  return (
    <CardShell
      caption="只列出要改的地方。你按下「确认调整」之前，什么都不会改。"
      proposalId={proposal.id}
      status="pending"
      title={`调整群聊「${before?.name ?? "群聊"}」`}
    >
      <div className="flex flex-col gap-3 text-sm">
        {draft.name !== undefined ? (
          <BeforeAfter
            after={draft.name}
            before={before?.name ?? null}
            label="群名"
          />
        ) : null}
        {draft.add.length > 0 ? (
          <p>
            <span className="text-muted-foreground">加进群：</span>
            {draft.add.map(nameOf).join("、")}
          </p>
        ) : null}
        {draft.remove.length > 0 ? (
          <p>
            <span className="text-muted-foreground">移出群：</span>
            <s>{draft.remove.map(nameOf).join("、")}</s>
          </p>
        ) : null}
        {draft.order ? (
          <div className="flex flex-col gap-1">
            {before ? (
              <p>
                <span className="text-muted-foreground">原来的顺序：</span>
                <s>{before.agentIds.map(nameOf).join("、")}</s>
              </p>
            ) : null}
            <MemberOrder
              members={draft.order}
              onChange={(order) => {
                setDraft((current) => ({ ...current, order }));
                setEdited(true);
              }}
            />
          </div>
        ) : null}
        {decision.error ? <ActionProblem error={decision.error} /> : null}
        <DecisionButtons
          busy={decision.busy}
          confirmLabel="确认调整"
          onConfirm={() => void decision.confirm(edited ? draft : null)}
          onDiscard={() => void decision.discard()}
        />
      </div>
    </CardShell>
  );
}

/** 一项改动：改前（删除线）→ 改后。改前读不到时只写改后。 */
export function BeforeAfter({
  label,
  before,
  after,
}: {
  label: string;
  before: string | null;
  after: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="break-words">
        {before !== null && before !== "" ? (
          <>
            <s className="text-muted-foreground">{before}</s>
            <span aria-hidden="true"> → </span>
            <span className="sr-only">改为</span>
          </>
        ) : null}
        <span className="whitespace-pre-wrap">{after || "（空）"}</span>
      </p>
    </div>
  );
}

/** 成员的回答顺序：一行头像，加上逐位的上移 / 下移。 */
function MemberOrder({
  members,
  onChange,
}: {
  members: string[];
  onChange: (members: string[]) => void;
}) {
  const nameOf = useNames();
  const move = (from: number, to: number) => {
    const next = [...members];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        成员（按这个顺序依次回答）
      </p>
      <div aria-hidden="true" className="flex flex-wrap gap-1.5">
        {members.map((id) => (
          <ChannelAvatar key={id} participantIds={[id]} size={32} />
        ))}
      </div>
      <ol className="flex flex-col">
        {members.map((id, index) => {
          const name = nameOf(id);
          return (
            <li
              className="flex items-center gap-2 border-border border-t py-1 first:border-t-0"
              data-member={id}
              key={id}
            >
              <span className="w-5 text-right text-muted-foreground text-xs tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
              <Button
                aria-label={`上移 ${name}`}
                className="h-11 min-w-11"
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
                variant="ghost"
              >
                ↑
              </Button>
              <Button
                aria-label={`下移 ${name}`}
                className="h-11 min-w-11"
                disabled={index === members.length - 1}
                onClick={() => move(index, index + 1)}
                variant="ghost"
              >
                ↓
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** 需求里对不上的角色。只在对话里画（能替本人说话）时给「先去招」。 */
function MissingRoles({ roles }: { roles: string[] }) {
  const ask = useConversation()?.ask;
  if (roles.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">还缺这些角色</p>
      <div className="flex flex-col">
        {roles.map((role) => (
          <div className="flex items-center justify-between gap-2" key={role}>
            <span className="min-w-0 break-words text-sm">{role}</span>
            {ask ? (
              <Button
                aria-label={`先去招 ${role}`}
                className={TAP}
                onClick={() => ask(`先帮我招一个${role}`)}
                variant="outline"
              >
                先去招
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

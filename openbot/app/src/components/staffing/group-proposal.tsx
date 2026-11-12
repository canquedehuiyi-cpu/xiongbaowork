import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelQueryOptions } from "@/lib/channels/queries";
import { useConversation } from "@/lib/copilot/conversation";
import type { GroupDraft, Proposal } from "@/lib/staffing/queries";
import {
  ActionProblem,
  CardShell,
  DecisionButtons,
  StaleNotice,
  TAP,
  useCardDraft,
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

/** 员工 id 换成名字；读不到的（列表还没回来，或本人看不到）说「一位员工」，不把 id 给人看。 */
function useNames() {
  const agents = useQuery(agentListQueryOptions());
  return (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? "一位员工";
}

export function GroupProposal({
  proposal,
  missingRoles,
}: {
  proposal: Proposal & { kind: "group" };
  missingRoles: string[];
}) {
  const {
    draft,
    edited,
    stale,
    change: update,
    reload,
  } = useCardDraft(proposal.draft);
  const decision = useDecision(proposal.id);
  const nameId = useId();
  const change = (patch: Partial<GroupDraft>) => {
    update((current) => ({ ...current, ...patch }));
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
        {stale ? <StaleNotice onReload={reload} /> : null}
        {decision.error ? <ActionProblem error={decision.error} /> : null}
        <DecisionButtons
          busy={decision.busy}
          confirmBlocked={blank || stale}
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
  const {
    draft,
    edited,
    stale,
    change: update,
    reload,
  } = useCardDraft(proposal.draft);
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
                update((current) => ({ ...current, order }));
              }}
            />
          </div>
        ) : null}
        {stale ? <StaleNotice onReload={reload} /> : null}
        {decision.error ? <ActionProblem error={decision.error} /> : null}
        <DecisionButtons
          busy={decision.busy}
          confirmBlocked={stale}
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
  signal = false,
}: {
  label: string;
  before: string | null;
  after: string;
  /** 改后的值要醒目（比如公开给全团队）：用信号色写。 */
  signal?: boolean;
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
        <span
          className={
            signal
              ? "whitespace-pre-wrap font-bold text-signal"
              : "whitespace-pre-wrap"
          }
        >
          {after || "（空）"}
        </span>
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
  const list = useRef<HTMLOListElement>(null);
  /** 刚挪过的那位和按的方向：挪完把焦点放回它的同一个按钮上。 */
  const moved = useRef<{ id: string; direction: "up" | "down" } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  /*
   * 列表按 key 重排时，浏览器把挪动的那一行从页面上拿下再放回，焦点随之丢到页面开头，键盘用户连按「下移」
   * 就按不下去了。下一帧把焦点还给同一位成员的同一个按钮；挪到头、那个按钮不能再按时，给另一个。
   * 每次画完都看一眼：只有刚挪过（`moved` 有值）才做事。
   */
  useEffect(() => {
    const target = moved.current;
    if (!target) return;
    moved.current = null;
    const frame = requestAnimationFrame(() => {
      const row = [...(list.current?.querySelectorAll("li") ?? [])].find(
        (item) => item.getAttribute("data-member") === target.id,
      );
      const same = row?.querySelector<HTMLButtonElement>(
        `button[data-move="${target.direction}"]`,
      );
      const other = row?.querySelector<HTMLButtonElement>(
        `button[data-move="${target.direction === "up" ? "down" : "up"}"]`,
      );
      (same && !same.disabled ? same : other)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  });

  const move = (from: number, direction: "up" | "down") => {
    const to = direction === "up" ? from - 1 : from + 1;
    const next = [...members];
    const [member] = next.splice(from, 1);
    next.splice(to, 0, member);
    moved.current = { id: member, direction };
    setAnnouncement(`已把${nameOf(member)}移到第 ${to + 1} 位`);
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
      <ol className="flex flex-col" ref={list}>
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
                data-move="up"
                disabled={index === 0}
                onClick={() => move(index, "up")}
                variant="ghost"
              >
                ↑
              </Button>
              <Button
                aria-label={`下移 ${name}`}
                className="h-11 min-w-11"
                data-move="down"
                disabled={index === members.length - 1}
                onClick={() => move(index, "down")}
                variant="ghost"
              >
                ↓
              </Button>
            </li>
          );
        })}
      </ol>
      {/* 读屏用户听得到挪到了第几位；看得见的人看列表就够了。 */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
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

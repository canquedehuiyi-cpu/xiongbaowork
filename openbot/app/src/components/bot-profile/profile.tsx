import { IconBell, IconMessage, IconPlayerPause } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { BotNeedsYou } from "@/components/needs-you/board";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
import { BotActivityGlance, BotActivityRow } from "./activity";
import { BotPausedBanner } from "./pause-banner";
import { ProfileAlert, ProfilePanel, ProfileSection } from "./profile-kit";
import { AvatarSourcesSection, ProfileCard } from "./waker-detail-sections";

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "全部",
  needs_input: "只在需要我时",
  none: "不提醒（只显示角标）",
};

/** The workbench's 32px select (LabeledSelect's face), kept native for its keyboard and a11y. */
const selectClass =
  "h-[32px] max-w-full rounded-[9px] border border-border bg-background px-[9px] text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60";

/**
 * 员工自己的页面（`/bots/$agentId`，上游 main 的 `BotProfile`）：它的「角色档案」、暂停提示、等你处理的事、
 * 分身的信息来源（只在你自己的分身上）、「对你」、它正在做的事，再加上调用方给的「这位员工的设置」和「管理」两段。
 *
 * 熊宝在上游之上保留了自己的部分：角色档案卡（状态、模型、个人分身标记，`ProfileCard`）、`BotControls`
 * 的暂停开关（上游叫 Active），以及分身的信息来源。「本周完成」和看板上的进行中任务在「动态」分页里。
 */
export function BotProfile({
  agent,
  settings,
  manage,
}: {
  agent: AgentProfile;
  /** 「这位员工的设置」：通往各分页的行。 */
  settings?: React.ReactNode;
  /** 置顶、隐藏、复制、重置、删除。 */
  manage?: React.ReactNode;
}) {
  return (
    <>
      <div className="mt-6">
        <ProfileCard profile={agent} />
      </div>
      <div className="mt-4 empty:hidden">
        <BotPausedBanner agentId={agent.id} />
      </div>

      {/* Its questions and approvals, its tasks, and what its check-ins found, in one card. */}
      <BotNeedsYou agentId={agent.id} />
      <AvatarSourcesSection profile={agent} />
      <BotControls agent={agent} />
      <BotActivityGlance agentId={agent.id} />
      {settings}
      {manage}
    </>
  );
}

/**
 * 对你: this person's relationship with one employee — pause, notifications, a new conversation,
 * and the row to its activity when nothing is running or lined up (`BotActivityRow`; with
 * something under way, `BotActivityGlance` draws its own section under this one). One section of
 * the employee's own page (/bots/$agentId). Reset is a row of 管理 (`ManageSection`), as upstream
 * has it; where updates go is in 设置 › 通知 (`components/settings/update-routing.tsx`).
 */
export function BotControls({ agent }: { agent: AgentProfile }) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
  // The browser's answer, shared with the prompt a conversation offers, so a yes there shows here
  // (upstream: one reading for the browser and OpenBot Desktop alike).
  const permission = useNotificationPermission();

  return (
    <ProfileSection className="mt-12" title="对你">
      {/* Whether this employee's Shared-app calls are being refused right now, with the button that
          asks an administrator. About its present reach, so it lives here, not only where
          publishing happens. */}
      {agent.canManage ? (
        <SharedAppNotice botId={agent.id} reason="publish" />
      ) : null}
      {lifecycle.isPending ? null : lifecycle.error ? (
          <ProfileAlert>读不到这位员工的状态。</ProfileAlert>
        ) : (
          <ProfilePanel>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlayerPause />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>暂停</ItemTitle>
                <ItemDescription>
                  {lifecycle.data.paused
                    ? "不会再为你启动定时任务、长期职责、交接或跟进，正在跑的也已停下。"
                    : "为你运行它的定时任务、长期职责、交接和跟进。"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label="暂停"
                  checked={lifecycle.data.paused}
                  disabled={pause.isPending}
                  onCheckedChange={(paused) =>
                    pause.mutate({ agentId: agent.id, paused })
                  }
                />
              </ItemActions>
            </Item>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBell />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>通知</ItemTitle>
                <ItemDescription>
                  {NOTIFY_LABEL[lifecycle.data.notify]}。侧栏角标始终显示。
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <select
                  aria-label="通知"
                  className={selectClass}
                  disabled={notify.isPending}
                  onChange={(event) =>
                    notify.mutate({
                      agentId: agent.id,
                      notify: event.target.value as BotNotify,
                    })
                  }
                  value={lifecycle.data.notify}
                >
                  {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map((value) => (
                    <option key={value} value={value}>
                      {NOTIFY_LABEL[value]}
                    </option>
                  ))}
                </select>
              </ItemActions>
            </Item>
            {permission === "default" ? (
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBell />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>浏览器通知</ItemTitle>
                  <ItemDescription>
                    这个浏览器里是关着的。打开后，员工需要你时会提醒你。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => void requestNotificationPermission()}
                    size="sm"
                    variant="outline"
                  >
                    打开
                  </Button>
                </ItemActions>
              </Item>
            ) : null}
            <Item
              render={<Link to="/channel/new" search={{ agent: agent.id }} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconMessage />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>给 {agent.name} 发消息</ItemTitle>
                <ItemDescription>开始一段对话。</ItemDescription>
              </ItemContent>
            </Item>
<BotActivityRow agentId={agent.id} />
          </ProfilePanel>
        )}
    </ProfileSection>
  );
}

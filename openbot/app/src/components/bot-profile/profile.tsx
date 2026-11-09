import {
  IconBell,
  IconMessage,
  IconPlayerPause,
  IconRefresh,
  IconRoute,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
=======
import type * as React from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { BotNeedsYou } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  resetBotMutationOptions,
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
  setUpdateRoutingMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
  botResetPlanQueryOptions,
  type ResetPlan,
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======
import { BotActivityGlance, BotActivityRow } from "./activity";
import { BotPausedBanner } from "./pause-banner";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "全部",
  needs_input: "只在需要我时",
  none: "不提醒（只显示角标）",
};

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "进展",
    description: "你没在看时，员工做的事的回复和结果。",
  },
  decision: {
    title: "决定",
    description: "员工动手前需要你批准的事。",
  },
  question: {
    title: "提问",
    description: "员工问了你、正在等你回答的事。",
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: "推送" },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "短信" },
];

const selectClass = "h-8 rounded-md border bg-background px-2 text-sm";

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string][] = [
    [plan.conversations, "段对话"],
    [plan.memorySources, "个记忆来源"],
    [plan.memories, "条导入的记忆"],
    [plan.routines, "个定时任务"],
    [plan.responsibilities, "个长期职责"],
    [plan.followUps, "个已排期的跟进"],
    [plan.formedMemories, "条它自己形成的记忆"],
    [plan.backgroundResearch, "项后台研究"],
    [plan.standingApprovals, "项长期许可"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}`);
}

function ResetDialog({
=======
/**
 * A Bot's own page: what it needs from you, its state for you, what it is doing, the tasks you marked
 * done this week, its settings, and what can be done to it.
 */
export function BotProfile({
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置 {agent.name}？</DialogTitle>
          <DialogDescription>
            这会删除 {agent.name}
            与你之间的东西，只限于你。别人的对话和数据不会被碰。删除后无法撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              算不出重置会删除哪些东西。
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">已重置。{agent.name} 和你从头开始。</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>没有属于你的东西可删。</p>
              ) : (
                <>
                  <p>将会删除：</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  有 {plan.data.sharedConversationsKept}
                  段对话是和其他人或员工共享的，会保留。
                </p>
              ) : null}
              <p className="text-muted-foreground">
                你自己的记忆——你直接告诉员工的那些——会保留。
              </p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess ? "关闭" : "取消"}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending ? "正在重置…" : "删除并重置"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UpdateRoutingSection() {
  const routing = useQuery(updateRoutingQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  return (
    <PageSection
      description="你没在看时，每类消息发到哪里。网页上始终显示全部。对你所有的员工生效。"
      title="消息发到哪里"
    >
      {routing.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          读不到你的消息去向设置。
        </p>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{KIND_LABEL[kind].title}</ItemTitle>
                    <ItemDescription>
                      {KIND_LABEL[kind].description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="gap-4 pl-8">
                    {TRANSPORTS.map((transport) => (
                      <div
                        className="flex items-center gap-2 text-sm"
                        key={transport.id}
                      >
                        <Switch
                          aria-label={`${KIND_LABEL[kind].title}：${transport.label}`}
                          checked={allowed(transport.id)}
                          disabled={save.isPending}
                          onCheckedChange={(checked) => {
                            const next = TRANSPORTS.map((t) => t.id).filter(
                              (id) =>
                                id === transport.id ? checked : allowed(id),
                            );
                            save.mutate({
                              kind,
                              transports:
                                next.length === TRANSPORTS.length
                                  ? "all"
                                  : next,
                            });
                          }}
                          size="sm"
                        />
                        {transport.label}
                      </div>
                    ))}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

/** A Bot's own page: its state for you, what it is doing, and the lifecycle controls. */
/**
 * 对你: this person's relationship with one employee — pause, notifications, a new conversation,
 * reset. One section of the employee's detail page (/wakers/$agentId); the activity feed, tool
 * permissions and update routing that used to share a page with it are their own exports.
 */
export function BotControls({ agent }: { agent: AgentProfile }) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const { done } = useNeedsYou(agent.id);
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  const [resetOpen, setResetOpen] = useState(false);
  const [permission, setPermission] = useState<string>(() => {
    try {
      return typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission;
    } catch {
      return "unsupported";
    }
  });

  return (
    <>
      <PageSection title="对你">
        {lifecycle.isPending ? null : lifecycle.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            读不到这位员工的状态。
=======
  // The browser's answer, shared with the prompt a conversation offers, so a yes there shows here.
  const permission = useNotificationPermission();

  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={40} />
        <div className="min-w-0">
          {agent.title && <p className="truncate font-medium">{agent.title}</p>}
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {agent.roleDescription}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <BotPausedBanner agentId={agent.id} />
      </div>

      {/* Its questions and approvals, its tasks, and what its check-ins found, in one card. */}
      <BotNeedsYou agentId={agent.id} />

      <PageSection title="For you">
        {/* Whether this Bot's Shared-app calls are being refused right now, with the button that
            asks an administrator. About its present reach, so it lives here, not only where
            publishing happens. */}
        {agent.canManage ? (
          <SharedAppNotice botId={agent.id} reason="publish" />
        ) : null}
        {lifecycle.isPending ? null : lifecycle.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load this Bot's settings. Reload the page.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          </p>
        ) : (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlayerPause />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>暂停</ItemTitle>
                <ItemDescription>
                  {lifecycle.data.paused
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
                    ? "不会再为你启动定时任务、长期职责、交接或跟进，正在跑的也已停下。"
                    : "为你运行它的定时任务、长期职责、交接和跟进。"}
=======
                    ? "Paused. Nothing runs for you until you turn it back on."
                    : "Works on its goals, routines, hand-offs and follow-ups for you."}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
            <Separator />
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
              <>
                <Separator />
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
              </>
            ) : null}
            <Separator />
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
            <Separator />
            <Item
              render={
                <button onClick={() => setResetOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconRefresh />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>重置</ItemTitle>
                <ItemDescription>
                  删除你和它的对话、它为你记住的东西和它排期的工作。删除前会先列给你看。
                </ItemDescription>
              </ItemContent>
            </Item>
            <BotActivityRow agentId={agent.id} />
          </PageRows>
        )}
      </PageSection>

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
=======
      <BotActivityGlance agentId={agent.id} />
      <DoneTasks done={done} />
      {settings}
      {manage}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    </>
  );
}

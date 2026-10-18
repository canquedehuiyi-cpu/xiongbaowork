import {
  IconBell,
  IconMessage,
  IconPlayerPause,
  IconRefresh,
  IconRoute,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import { queryClient } from "@/query-client";
import { BotActivitySections } from "./activity";
import { BotPausedBanner } from "./pause-banner";

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "全部",
  needs_input: "只在需要我时",
  none: "不提醒（只显示角标）",
};

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

function UpdateRoutingSection() {
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
export function BotProfile({ agent }: { agent: AgentProfile }) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
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
      <div className="mt-6 flex items-center gap-3">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={40} />
        <div className="min-w-0">
          <p className="truncate font-medium">{agent.title}</p>
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {agent.roleDescription}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <BotPausedBanner agentId={agent.id} />
      </div>

      <PageSection title="对你">
        {lifecycle.isPending ? null : lifecycle.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            读不到这位员工的状态。
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
                      onClick={async () => {
                        try {
                          setPermission(await Notification.requestPermission());
                        } catch {
                          setPermission("unsupported");
                        }
                      }}
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
          </PageRows>
        )}
      </PageSection>

      <BotActivitySections agentId={agent.id} />
      <UpdateRoutingSection />
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
    </>
  );
}

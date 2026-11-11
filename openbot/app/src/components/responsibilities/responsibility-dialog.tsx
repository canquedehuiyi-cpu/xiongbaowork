import {
  IconChevronRight,
  IconCircleCheck,
  IconFlag,
  IconHistory,
  IconMessage,
  IconPlayerPause,
  IconPlayerPlay,
  IconProgress,
  IconTarget,
  IconWebhook,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import { Streamdown } from "streamdown";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import { markdownComponents } from "@/lib/markdown";
import {
  type ResponsibilityRecord,
  responsibilityActionMutationOptions,
  responsibilityRunsQueryOptions,
  type TriggerRecord,
  triggersQueryOptions,
  updateResponsibilityMutationOptions,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";
import { KIND_LABEL, Triggers } from "./triggers";

type Status = ResponsibilityRecord["status"];
type Source = ResponsibilityRecord["subscriptions"][number]["source"];

/** A responsibility's state, as a word and as the mark its row leads with. */
export const STATUS: Record<
  Status,
  { label: string; icon: typeof IconTarget }
> = {
  active: { label: "进行中", icon: IconTarget },
  paused: { label: "已暂停", icon: IconPlayerPause },
  completed: { label: "已完成", icon: IconCircleCheck },
};

const SOURCE_LABEL: Record<Source, string> = {
  manual: "手动",
  slack: "Slack",
  github: "GitHub",
  schedule: "定时",
  connector: "已连接的应用",
  webhook: "Webhook",
  linear: "Linear",
  sentry: "Sentry",
  pagerduty: "PagerDuty",
  email: "邮件",
};

/**
 * What a responsibility's row says under its title: its state, and while it is active, what starts
 * it. Computed from the queries on every render so it follows whatever the dialog just changed.
 *
 * `triggers` is undefined until they load, and then nothing is said about what starts it rather than
 * "Runs when asked", which would be a claim about triggers nobody has read yet.
 */
export function summaryFor(
  goal: ResponsibilityRecord,
  triggers: TriggerRecord[] | undefined,
): string {
  const status = STATUS[goal.status].label;
  if (goal.status === "completed") return status;
  if (goal.status === "paused")
    return `${status} · 恢复之前不会开工`;
  const starts = [
    ...goal.subscriptions.map(
      (subscription) =>
        `${SOURCE_LABEL[subscription.source]} ${subscription.eventType}`,
    ),
    ...(triggers ?? [])
      .filter((trigger) => trigger.enabled)
      .map((trigger) => `${KIND_LABEL[trigger.kind]}触发`),
  ];
  if (starts.length) return `${status} · 由${starts.join("、")}开工`;
  return triggers ? `${status} · 被要求时运行` : status;
}

/**
 * Everything about one responsibility, opened from its row: what can be done to it now (pause, run,
 * complete — each immediate), its wording (a draft, saved by the footer), where it stands, what
 * starts it, and its runs.
 */
export function ResponsibilityDialog({
  goal,
  onClose,
}: {
  goal: ResponsibilityRecord;
  onClose: () => void;
}) {
  const formId = useId();
  const [showRuns, setShowRuns] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [instruction, setInstruction] = useState(goal.instruction);
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria);
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const action = useMutation(responsibilityActionMutationOptions(queryClient));
  const edit = useMutation(updateResponsibilityMutationOptions(queryClient));
  const standing = [
    goal.progress
      ? {
          key: "progress",
          label: "进展",
          icon: IconProgress,
          text: goal.progress,
        }
      : null,
    goal.lastResult
      ? {
          key: "result",
          label: "上次结果",
          icon: IconFlag,
          text: goal.lastResult,
        }
      : null,
  ].filter((entry) => entry !== null);

  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goal.title}</DialogTitle>
          <DialogDescription>
            {summaryFor(goal, triggers.data)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <div className="overflow-hidden rounded-lg">
            {goal.status !== "completed" ? (
              <>
                <Item size="sm" variant="muted">
                  <ItemMedia variant="icon">
                    <IconTarget />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>启用</ItemTitle>
                    <ItemDescription>
                      {goal.status === "active"
                        ? "它订阅的事件和触发方式会让它开工。"
                        : "已暂停，触发方式不会让它开工。"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label="启用"
                      checked={goal.status === "active"}
                      disabled={action.isPending}
                      onCheckedChange={(active) =>
                        action.mutate({
                          id: goal.id,
                          action: active ? "resume" : "pause",
                        })
                      }
                    />
                  </ItemActions>
                </Item>
                <Separator />
              </>
            ) : null}
            {goal.status === "active" ? (
              <>
                <Item
                  render={
                    <button
                      disabled={action.isPending}
                      onClick={() => {
                        setShowRuns(true);
                        action.mutate({ id: goal.id, action: "run" });
                      }}
                      type="button"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemMedia variant="icon">
                    <IconPlayerPlay />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>立即运行</ItemTitle>
                    <ItemDescription>
                      现在就真的运行一次：员工会去做这件事，可能会发消息和执行动作。
                    </ItemDescription>
                  </ItemContent>
                </Item>
                <Separator />
              </>
            ) : null}
            {goal.status !== "completed" ? (
              <>
                <Item
                  render={
                    <button
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({ id: goal.id, action: "complete" })
                      }
                      type="button"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemMedia variant="icon">
                    <IconCircleCheck />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>完成</ItemTitle>
                    <ItemDescription>
                      标为已完成，之后不会再开工。
                    </ItemDescription>
                  </ItemContent>
                </Item>
                <Separator />
              </>
            ) : null}
            <Item
              render={
                <Link
                  params={{ channelId: goal.channelId }}
                  to="/channel/$channelId"
                />
              }
              size="sm"
              variant="muted"
            >
              <ItemMedia variant="icon">
                <IconMessage />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>打开对话</ItemTitle>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </div>
          {action.error || edit.error ? (
            <p role="alert" className="text-destructive text-sm">
              {action.error?.message ?? edit.error?.message}
            </p>
          ) : null}

          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              edit.mutate(
                {
                  id: goal.id,
                  patch: { title, instruction, successCriteria },
                },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-title`}>标题</FieldLabel>
                <Input
                  id={`${formId}-title`}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={160}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-instruction`}>
                  指令
                </FieldLabel>
                <Textarea
                  id={`${formId}-instruction`}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  required
                  maxLength={6000}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-criteria`}>
                  成功标准
                </FieldLabel>
                <Textarea
                  id={`${formId}-criteria`}
                  value={successCriteria}
                  onChange={(event) => setSuccessCriteria(event.target.value)}
                  required
                  maxLength={3000}
                />
              </Field>
            </FieldGroup>
          </form>

          {standing.length || goal.subscriptions.length ? (
            <div className="overflow-hidden rounded-lg">
              {standing.map(({ key, label, icon: Icon, text }, index) => (
                <Fragment key={key}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm" variant="muted">
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{label}</ItemTitle>
                      <RunMarkdown>{text}</RunMarkdown>
                    </ItemContent>
                  </Item>
                </Fragment>
              ))}
              {goal.subscriptions.length > 0 ? (
                <>
                  {standing.length ? <Separator /> : null}
                  <Item size="sm" variant="muted">
                    <ItemMedia variant="icon">
                      <IconWebhook />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>订阅的事件</ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {goal.subscriptions
                          .map(
                            (subscription) =>
                              `${SOURCE_LABEL[subscription.source]} · ${subscription.eventType}`,
                          )
                          .join("、")}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                </>
              ) : null}
            </div>
          ) : null}

          <Triggers goal={goal} />
          <Runs
            channelId={goal.channelId}
            goalId={goal.id}
            onToggle={() => setShowRuns(!showRuns)}
            shown={showRuns}
          />
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            取消
          </Button>
          <Button
            disabled={edit.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {edit.isPending ? "正在保存…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RUN_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等你处理",
  succeeded: "成功",
  failed: "失败",
  skipped: "跳过",
};
function runStatusClass(status: string) {
  return status === "failed"
    ? "text-destructive"
    : status === "succeeded"
      ? "text-emerald-600 dark:text-emerald-500"
      : "text-muted-foreground";
}

/**
 * The runs, fetched only once somebody asks for them — or presses Run now, which opens them so the
 * run it started is there to watch.
 */
function Runs({
  goalId,
  channelId,
  shown,
  onToggle,
}: {
  goalId: string;
  channelId: string;
  shown: boolean;
  onToggle: () => void;
}) {
  const runs = useQuery({
    ...responsibilityRunsQueryOptions(goalId),
    enabled: shown,
  });
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">运行记录</h3>
        <Button onClick={onToggle} size="sm" type="button" variant="ghost">
          {shown ? "收起运行记录" : "查看运行记录"}
        </Button>
      </div>
      {!shown ? null : runs.isPending ? null : runs.error ? (
        <p role="alert" className="text-destructive text-sm">
          {runs.error.message}
        </p>
      ) : runs.data.length ? (
        <div className="overflow-hidden rounded-lg">
          {runs.data.map((run, index) => (
            <Fragment key={run.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm" variant="muted">
                <ItemMedia variant="icon">
                  <IconHistory />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className={runStatusClass(run.status)}>
                    {RUN_LABEL[run.status]}
                  </ItemTitle>
                  <ItemDescription>
                    {new Date(run.createdAt).toLocaleString()}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Link
                    to="/channel/$channelId"
                    params={{ channelId }}
                    className="text-sm underline"
                  >
                    打开对话
                  </Link>
                </ItemActions>
                {run.waiting || run.error || run.replyText ? (
                  <ItemFooter className="min-w-0 flex-col items-stretch">
                    {run.waiting && (
                      <p>
                        在等你{run.waiting.kind === "question" ? "回答问题" : "批准"}。到这位员工页面顶部或对话里处理。
                      </p>
                    )}
                    {run.error && (
                      <p className="text-muted-foreground">{run.error}</p>
                    )}
                    {run.replyText && (
                      <RunMarkdown>{run.replyText}</RunMarkdown>
                    )}
                  </ItemFooter>
                ) : null}
              </Item>
            </Fragment>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">还没有运行记录。</p>
      )}
    </section>
  );
}

/**
 * A Bot's own words, drawn the way the conversation draws them.
 *
 * Progress, the last result and each run's reply are the Bot's markdown, and shown as plain text
 * they read as literal asterisks and backticks. Same renderer and components as the transcript, kept
 * to the row's size: no heading scale, tight paragraph and list spacing.
 */
function RunMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={markdownComponents}
      mode="static"
    >
      {children}
    </Streamdown>
  );
}

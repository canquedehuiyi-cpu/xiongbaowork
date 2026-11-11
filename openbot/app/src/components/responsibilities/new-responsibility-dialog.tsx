import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  createResponsibilityMutationOptions,
  type ResponsibilityRecord,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

type Source = "none" | ResponsibilityRecord["subscriptions"][number]["source"];

/** The event sources a new responsibility can subscribe to, in the order they are offered. */
const SOURCES = {
  none: "被要求时运行",
  github: "GitHub",
  slack: "Slack",
  connector: "已连接的应用",
  schedule: "定时",
} as const satisfies Partial<Record<Source, string>>;

/**
 * A new responsibility: where it runs, what it is for, and what — if anything — starts it on its
 * own. Given a Bot, the Bot is not asked for and only conversations that Bot is in are offered.
 */
export function NewResponsibilityDialog({
  agentId: fixedBot,
  onClose,
}: {
  agentId?: string;
  onClose: () => void;
}) {
  const formId = useId();
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [channelId, setChannelId] = useState("");
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [source, setSource] = useState<Source>("none");
  const [eventType, setEventType] = useState("");
  const selectedChannel = channels.data?.find(
    (channel) => channel.id === channelId,
  );
  const availableBots =
    bots.data?.filter((bot) => selectedChannel?.agentIds.includes(bot.id)) ??
    [];
  const offered =
    channels.data?.filter(
      (channel) =>
        channel.active &&
        (fixedBot === undefined || channel.agentIds.includes(fixedBot)),
    ) ?? [];
  const create = useMutation(createResponsibilityMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建长期职责</DialogTitle>
          <DialogDescription>
            交给员工一件要持续去做的事，它会在你选的那段对话里去做。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                {
                  channelId,
                  agentId,
                  title,
                  instruction,
                  successCriteria,
                  subscriptions:
                    source === "none" ? [] : [{ source, eventType }],
                },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <FieldGroup className="sm:grid sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${formId}-conversation`}>
                    对话
                  </FieldLabel>
                  <Select
                    items={Object.fromEntries(
                      offered.map((channel) => [
                        channel.id,
                        conversationLabel(channel),
                      ]),
                    )}
                    onValueChange={(value) => {
                      setChannelId(value ?? "");
                      setAgentId("");
                    }}
                    required
                    value={channelId || null}
                  >
                    <SelectTrigger
                      className="w-full"
                      id={`${formId}-conversation`}
                    >
                      <SelectValue placeholder="选择一段对话" />
                    </SelectTrigger>
                    <SelectContent>
                      {offered.map((channel) => (
                        <SelectItem key={channel.id} value={channel.id}>
                          {conversationLabel(channel)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {fixedBot === undefined ? (
                  <Field>
                    <FieldLabel htmlFor={`${formId}-bot`}>员工</FieldLabel>
                    <Select
                      items={Object.fromEntries(
                        availableBots.map((bot) => [bot.id, bot.name]),
                      )}
                      onValueChange={(value) => setAgentId(value ?? "")}
                      required
                      value={agentId || null}
                    >
                      <SelectTrigger className="w-full" id={`${formId}-bot`}>
                        <SelectValue placeholder="选择一位员工" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableBots.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
              </FieldGroup>
              {channels.hasNextPage && (
                <Button
                  className="w-fit"
                  onClick={() => channels.fetchNextPage()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  加载更多对话
                </Button>
              )}
              {(channels.error || bots.error) && (
                <p role="alert" className="text-destructive text-sm">
                  {channels.error?.message ?? bots.error?.message}
                </p>
              )}
              <Field>
                <FieldLabel htmlFor={`${formId}-title`}>标题</FieldLabel>
                <Input
                  id={`${formId}-title`}
                  required
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="让客户报告保持最新"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-instruction`}>
                  指令
                </FieldLabel>
                <Textarea
                  id={`${formId}-instruction`}
                  required
                  maxLength={6000}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-criteria`}>
                  成功标准
                </FieldLabel>
                <Textarea
                  id={`${formId}-criteria`}
                  required
                  maxLength={3000}
                  value={successCriteria}
                  onChange={(event) => setSuccessCriteria(event.target.value)}
                  placeholder="报告里有本季度的图表和来源链接。"
                />
              </Field>
              <FieldGroup className="sm:grid sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${formId}-source`}>
                    事件来源
                  </FieldLabel>
                  <Select
                    items={SOURCES}
                    onValueChange={(value) => {
                      if (value && value in SOURCES) setSource(value as Source);
                    }}
                    value={source}
                  >
                    <SelectTrigger className="w-full" id={`${formId}-source`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SOURCES) as (keyof typeof SOURCES)[]).map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {SOURCES[value]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  {source === "github" && (
                    <FieldDescription>
                      事件来自你在
                      <Link className="underline underline-offset-4" to="/connections">
                        连接
                      </Link>
                      里接入的仓库。
                    </FieldDescription>
                  )}
                </Field>
                {source !== "none" && (
                  <Field>
                    <FieldLabel htmlFor={`${formId}-event`}>
                      事件类型
                    </FieldLabel>
                    <Input
                      id={`${formId}-event`}
                      required
                      maxLength={128}
                      value={eventType}
                      onChange={(event) => setEventType(event.target.value)}
                      placeholder={
                        source === "github" ? "issues.opened" : "事件类型"
                      }
                    />
                  </Field>
                )}
              </FieldGroup>
            </FieldGroup>
          </form>
          {create.error && (
            <p role="alert" className="text-destructive text-sm">
              {create.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            取消
          </Button>
          <Button
            disabled={create.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {create.isPending ? "正在创建…" : "创建长期职责"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

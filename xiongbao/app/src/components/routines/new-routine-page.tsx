import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageCard, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { shortName } from "@/lib/brand";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import {
  AUTO_CONVERSATION,
  browserTimeZone,
  cronFrom,
  MONTH_DAYS,
  NEW_CONVERSATION,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  type RoutineFormValues,
  routineFormSchema,
  scheduleSentence,
  WEEKDAY_LABEL,
} from "@/lib/routines/form";
import { createRoutineMutationOptions } from "@/lib/routines/mutations";
import { openingOf } from "@/lib/voice/cut";
import { queryClient } from "@/query-client";

/** The conversations a routine for this Bot may post in: live ones the Bot is in. */
function conversationsWith(
  channels: ChannelSummary[] | undefined,
  agentId: string,
): ChannelSummary[] {
  return (channels ?? []).filter(
    (channel) =>
      channel.active && !channel.task && channel.agentIds.includes(agentId),
  );
}

function conversationName(channel: ChannelSummary): string {
  const title = (channel.summary || untitledLine(channel) || "").trim();
  // What the sidebar calls one nobody has named or written in yet.
  return title ? openingOf(title, 60) : "新对话";
}

const MONTH_DAY_LABEL = Object.fromEntries(
  MONTH_DAYS.map((day) => [day, day]),
) as Record<string, string>;

const WEEKDAY_ITEMS = Object.fromEntries(
  WEEKDAY_LABEL.map((label, index) => [String(index), label]),
) as Record<string, string>;

/** Where the Routines page went: 自主工作, narrowed to schedules (`/routines` redirects there too). */
const ROUTINES_LIST = {
  to: "/autonomous",
  search: { trigger: "schedule" },
} as const;

/**
 * New routine, on a screen of its own: a Bot, what it does, when, and where it posts.
 *
 * The shape other assistants use for scheduled work. A frequency picker with a time, read back as
 * a sentence, and a way out for anything the picker does not cover: ask the Bot, which writes any
 * schedule through the same store this page does. `agentId` and `channelId` arrive pre-filled from
 * a Bot's Routines page and from the clock beside a conversation's message box.
 */
export function NewRoutinePage({
  agentId: presetAgentId,
  channelId: presetChannelId,
}: {
  agentId?: string;
  channelId?: string;
}) {
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const createRoutine = useMutation(createRoutineMutationOptions(queryClient));
  const timeZone = browserTimeZone();

  const defaultValues: RoutineFormValues = {
    agentId: presetAgentId ?? "",
    instruction: "",
    title: "",
    repeat: "weekdays",
    time: "09:00",
    weekday: "1",
    monthDay: "1",
    channelId:
      presetChannelId && presetAgentId ? presetChannelId : NEW_CONVERSATION,
  };

  const form = useForm({
    defaultValues,
    validators: { onSubmit: routineFormSchema },
    onSubmit: async ({ value }) => {
      await createRoutine.mutateAsync({
        agentId: value.agentId,
        instruction: value.instruction.trim(),
        ...(value.title.trim() ? { title: value.title.trim() } : {}),
        cron: cronFrom(value),
        timezone: timeZone,
        // 自动：不传 channelId，由服务端找这个人和这位员工共有的对话。
        ...(value.channelId === AUTO_CONVERSATION
          ? {}
          : { channelId: value.channelId }),
      });
      await navigate(ROUTINES_LIST);
    },
  });

  const botItems = Object.fromEntries(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  ) as Record<string, string>;

  return (
    <PageShell
      backButton={{ label: "定时任务", linkProps: ROUTINES_LIST }}
      description="选一位员工，说说要做什么，再定好时间。它每次做完都会在和你的对话里说一声。"
      title="新建定时任务"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} {...ROUTINES_LIST} />}
                variant="outline"
              >
                取消
              </Button>
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting]}
              >
                {([canSubmit, isSubmitting]) => (
                  <Button
                    disabled={
                      !canSubmit || isSubmitting || createRoutine.isPending
                    }
                    type="submit"
                  >
                    {isSubmitting || createRoutine.isPending
                      ? "正在创建…"
                      : "创建定时任务"}
                  </Button>
                )}
              </form.Subscribe>
            </>
          }
        >
          <FieldGroup>
            <form.Field name="agentId">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>员工</FieldLabel>
                    <Select
                      items={botItems}
                      onValueChange={(value) => {
                        const next = String(value ?? "");
                        field.handleChange(next);
                        // Another Bot is in other conversations: start a new one unless this one is shared.
                        const current = form.getFieldValue("channelId");
                        if (
                          current !== AUTO_CONVERSATION &&
                          !conversationsWith(channels.data, next).some(
                            (channel) => channel.id === current,
                          )
                        ) {
                          form.setFieldValue("channelId", NEW_CONVERSATION);
                        }
                      }}
                      value={field.state.value || null}
                    >
                      <SelectTrigger
                        aria-invalid={isInvalid}
                        className="w-full"
                        id={field.name}
                      >
                        <SelectValue placeholder="选一位员工" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(agents.data ?? []).map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {/* Hidden: the name beside it already says who. */}
                              <span aria-hidden="true" className="contents">
                                <AbstractAvatar
                                  name={agent.name}
                                  seed={agent.avatarSeed}
                                  portrait={{ kind: "coworker", id: agent.id }}
                                  size={18}
                                />
                              </span>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="instruction">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>要做什么</FieldLabel>
                    <FieldDescription>
                      写成做一次的样子，不用写时间安排。
                    </FieldDescription>
                    <Textarea
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="把昨天新增的线索整理成摘要发给我"
                      rows={3}
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            <Field>
              <FieldLabel htmlFor="repeat">什么时候</FieldLabel>
              <div className="flex flex-wrap gap-3">
                <form.Field name="repeat">
                  {(field) => (
                    <Select
                      items={REPEAT_LABEL}
                      onValueChange={(value) =>
                        field.handleChange(value as Repeat)
                      }
                      value={field.state.value}
                    >
                      <SelectTrigger className="min-w-40 flex-1" id="repeat">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {REPEATS.map((repeat) => (
                            <SelectItem key={repeat} value={repeat}>
                              {REPEAT_LABEL[repeat]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                </form.Field>
                <form.Subscribe selector={(state) => state.values.repeat}>
                  {(repeat) => (
                    <>
                      {repeat === "weekly" ? (
                        <form.Field name="weekday">
                          {(field) => (
                            <Select
                              items={WEEKDAY_ITEMS}
                              onValueChange={(value) =>
                                field.handleChange(String(value))
                              }
                              value={field.state.value}
                            >
                              <SelectTrigger
                                aria-label="星期几"
                                className="min-w-36 flex-1"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {WEEKDAY_LABEL.map((label, index) => (
                                    <SelectItem
                                      key={label}
                                      value={String(index)}
                                    >
                                      {label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          )}
                        </form.Field>
                      ) : null}
                      {repeat === "monthly" ? (
                        <form.Field name="monthDay">
                          {(field) => (
                            <Select
                              items={MONTH_DAY_LABEL}
                              onValueChange={(value) =>
                                field.handleChange(String(value))
                              }
                              value={field.state.value}
                            >
                              <SelectTrigger
                                aria-label="每月几号"
                                className="min-w-24"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {MONTH_DAYS.map((day) => (
                                    <SelectItem key={day} value={day}>
                                      {day}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          )}
                        </form.Field>
                      ) : null}
                      {repeat === "hourly" ? null : (
                        <form.Field name="time">
                          {(field) => (
                            <Input
                              aria-label="时间"
                              className="w-32"
                              onChange={(event) =>
                                field.handleChange(event.target.value)
                              }
                              step={900}
                              type="time"
                              value={field.state.value}
                            />
                          )}
                        </form.Field>
                      )}
                    </>
                  )}
                </form.Subscribe>
              </div>
              <form.Subscribe selector={(state) => state.values}>
                {(values) => (
                  <FieldDescription>
                    <span className="font-medium text-foreground">
                      {scheduleSentence(values)}
                    </span>
                    ，按你的时区（{timeZone}
                    ）。别的安排，比如隔周二一次，在对话里跟员工说就行。
                  </FieldDescription>
                )}
              </form.Subscribe>
            </Field>

            <form.Subscribe selector={(state) => state.values.agentId}>
              {(agentId) => {
                const shared = conversationsWith(channels.data, agentId);
                // The conversation the clock was pressed in, second and called what it is to the
                // person who just left it, even when it is past the roster's first page. The server
                // still checks the Bot is in it.
                const here =
                  presetChannelId && agentId === presetAgentId
                    ? { [presetChannelId]: "这段对话" }
                    : {};
                const items: Record<string, string> = {
                  [NEW_CONVERSATION]: "新开一段对话",
                  [AUTO_CONVERSATION]: "自动（由系统找对话）",
                  ...here,
                  ...Object.fromEntries(
                    shared.map((channel) => [
                      channel.id,
                      conversationName(channel),
                    ]),
                  ),
                  ...here,
                };
                const choices = Object.entries(items);
                return (
                  <form.Field name="channelId">
                    {(field) => (
                      <Field>
                        <FieldLabel htmlFor={field.name}>发到哪里</FieldLabel>
                        <FieldDescription>
                          {field.state.value === NEW_CONVERSATION
                            ? `${shortName()}为这条定时任务新开一段对话，用它的名称命名。`
                            : field.state.value === AUTO_CONVERSATION
                              ? "不指定对话：系统会找你和这位员工共有的那段对话；如果有不止一段，会请你改选一段。"
                              : "每次运行都发到这段对话里。"}
                        </FieldDescription>
                        <Select
                          disabled={!agentId}
                          items={items}
                          onValueChange={(value) =>
                            field.handleChange(String(value))
                          }
                          value={
                            field.state.value in items
                              ? field.state.value
                              : NEW_CONVERSATION
                          }
                        >
                          <SelectTrigger className="w-full" id={field.name}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {choices.map(([value, label]) => (
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                  </form.Field>
                );
              }}
            </form.Subscribe>

            <form.Field name="title">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>名称</FieldLabel>
                    <FieldDescription>
                      选填。定时任务列表里用这个名称显示它。
                    </FieldDescription>
                    <Input
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="早间线索"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>
          {createRoutine.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {createRoutine.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  addGroupMemberMutationOptions,
  type GroupMessage,
  type GroupPerson,
  groupQueryOptions,
  removeGroupMemberMutationOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import { markdownComponents } from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { startRunMutationOptions } from "@/lib/pipelines/mutations";
import { pipelineTemplatesQueryOptions } from "@/lib/pipelines/queries";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import { ChannelAvatar } from "./avatar";
import { Composer, type CrewOption, toAgentOptions } from "./composer";
import { TeamBotConsentCard } from "./team-bot-consent";

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the CopilotKit chat. Each Bot answers in a thread of its own on the server, so there is no one
 * agent for a browser run to bind to; the person posts a message, the server runs every addressed
 * Bot through the ordinary headless AG-UI path, and this draws what each of them said, attributed.
 * `@Name` in the composer addresses one Bot; otherwise every Bot answers, one after another.
 */
export function GroupChat({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  /*
   * The crews this person can start a flow from, as `@` options.
   *
   * One entry per template rather than per crew, because a crew with three flows is three different
   * answers to "@组" and picking one should not be a guess. The name carries the flow only when the
   * crew has more than one, so the common single-flow crew stays as short as the coworker beside it.
   */
  const crews = useQuery(wakerGroupsQueryOptions());
  const templates = useQuery(pipelineTemplatesQueryOptions());
  const startRun = useMutation(startRunMutationOptions(queryClient));
  /*
   * The flow this person just started from here, until they dismiss it or say something else.
   *
   * Starting a crew posts nothing into this transcript — the steps are not lines in this conversation —
   * and without this the composer simply empties, which reads exactly like a message that was lost.
   */
  const [started, setStarted] = useState<{
    label: string;
    runId: string;
  } | null>(null);
  const crewOptions: CrewOption[] = (templates.data ?? []).flatMap(
    (template) => {
      const crew = (crews.data ?? []).find(
        (entry) => entry.id === template.groupId,
      );
      if (!crew) return [];
      const siblings = (templates.data ?? []).filter(
        (other) => other.groupId === template.groupId,
      ).length;
      return [
        {
          templateId: template.id,
          label: siblings > 1 ? `${crew.name} · ${template.name}` : crew.name,
          description: `启动流程 · ${template.steps.length} 步`,
        },
      ];
    },
  );
  const send = useMutation(
    sendGroupMessageMutationOptions(queryClient, channelId),
  );
  const bots = group.data?.bots ?? [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const messages = group.data?.messages ?? [];
  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );

  // Follow the conversation down as lines arrive, the way the single-Bot transcript does.
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastKey = `${messages.length}:${messages.at(-1)?.status ?? ""}`;
  useEffect(() => {
    if (lastKey) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastKey]);

  if (group.isPending) return null;
  if (group.isError)
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {group.error.message}
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              跟{bots.map((bot) => bot.name).join("和")}说点什么。
              每位员工都会依次回答；想只问其中一位，就 @它的名字。
            </p>
          ) : null}
          {messages.map((message) => (
            <GroupLine
              key={message.id}
              message={message}
              name={
                message.agentId
                  ? (names.get(message.agentId) ?? "一位已不在本群的员工")
                  : message.ownerUserId === me?.id
                    ? "你"
                    : "一位同事"
              }
              answeredBy={
                message.answeredBy
                  ? (names.get(message.answeredBy) ?? "另一位员工")
                  : undefined
              }
              mine={message.ownerUserId === me?.id}
            />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {send.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {send.error.message}
          </p>
        ) : null}
        {startRun.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {startRun.error.message}
          </p>
        ) : null}
        {started ? (
          <FlowStartedNotice
            label={started.label}
            runId={started.runId}
            onDismiss={() => setStarted(null)}
          />
        ) : null}
        <People
          channelId={channelId}
          me={me?.id}
          people={group.data?.people ?? []}
        />
        <AddPerson channelId={channelId} />
        <Composer
          agents={toAgentOptions(bots)}
          commands={[]}
          disabled={bots.length === 0}
          pending={send.isPending || working}
          autoFocus
          crews={crewOptions}
          onSubmit={async (draft) => {
            /*
             * A crew answers nothing on its own, so this is not a turn: the words become the task the
             * flow runs with, the crew's own steps decide who speaks, and nothing is posted into this
             * transcript as a reply to this message. The mention is cut out by its exact label because
             * a crew or flow name may contain a space, which no prefix pattern could strip safely.
             */
            if (draft.crewTemplateId) {
              const option = crewOptions.find(
                (entry) => entry.templateId === draft.crewTemplateId,
              );
              const run = await startRun.mutateAsync({
                templateId: draft.crewTemplateId,
                task: option
                  ? draft.text.replace(`@${option.label}`, "").trim()
                  : draft.text,
              });
              setStarted({ label: option?.label ?? "小组", runId: run.runId });
              return;
            }
            if (!draft.text) return;
            setStarted(null);
            await send.mutateAsync({
              id: newId(),
              text: draft.text,
              agentId: draft.agentId,
            });
          }}
        />
      </div>
    </div>
  );
}

/**
 * The one sentence a person gets back for starting a crew: which crew took it, and where the run is.
 *
 * `role="status"` rather than an alert — nothing went wrong, the work simply happens somewhere else.
 */
export function FlowStartedNotice({
  label,
  runId,
  onDismiss,
}: {
  label: string;
  runId: string;
  onDismiss: () => void;
}) {
  return (
    <p
      className="flex items-center gap-2 pb-2 text-sm text-muted-foreground"
      role="status"
    >
      <span>已交给「{label}」开始流程 ·</span>
      <Link className="underline" search={{ run: runId }} to="/pipelines">
        查看这次运行
      </Link>
      <button
        aria-label="关闭这条提示"
        className="ml-auto opacity-60 hover:opacity-100"
        onClick={onDismiss}
        type="button"
      >
        ×
      </button>
    </p>
  );
}

/** One attributed line: a person's bubble, and a Bot's named reply on the left. */
function GroupLine({
  message,
  name,
  answeredBy,
  mine,
}: {
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
}) {
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="text-xs font-medium text-muted-foreground">
              {name}
            </MessageHeader>
          )}
          <Bubble align={mine ? "end" : "start"} variant="muted">
            <BubbleContent>
              <span className="whitespace-pre-wrap">{message.text}</span>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </MessageRow>
    );
  return (
    <MessageRow align="start" data-speaker={message.agentId}>
      <div className="shrink-0 pt-0.5">
        <ChannelAvatar participantIds={[message.agentId]} size={24} />
      </div>
      <MessageContent>
        <MessageHeader className="text-xs font-medium text-muted-foreground">
          {name}
          {answeredBy ? ` · 由${answeredBy}代答` : null}
        </MessageHeader>
        {(message.status === "running" || message.status === "queued") &&
        !message.text ? (
          <p
            className="tool-line-running text-sm text-muted-foreground"
            role="status"
          >
            思考中
          </p>
        ) : message.status === "waiting" ? (
          <p className="text-sm text-muted-foreground">
            {message.reason ?? "等你回应。"}{" "}
            <Link className="underline" to="/approvals">
              去审批
            </Link>
          </p>
        ) : message.consent ? (
          // Only the person whose account it asked for can answer; everyone else sees the ask.
          mine ? (
            <TeamBotConsentCard
              botId={message.consent.botId}
              message={message.text}
              serverId={message.consent.serverId}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              已向同事请求授权，以便使用其本人的
              {message.consent.serverId} 账号。
            </p>
          )
        ) : message.status === "failed" ? (
          <p className="text-sm text-destructive" role="alert">
            {message.text || "这位员工没能回答。"}
          </p>
        ) : (
          <Bubble
            align="start"
            aria-busy={message.status === "running"}
            variant="ghost"
            className="w-full"
          >
            <BubbleContent className="w-full">
              <Streamdown components={markdownComponents}>
                {message.text}
              </Streamdown>
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </MessageRow>
  );
}

/** Invite another person who has signed in here. They see this whole conversation. */
function AddPerson({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const add = useMutation(addGroupMemberMutationOptions(channelId));
  if (!open)
    return (
      <div className="flex justify-end pb-2">
        <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
          添加成员
        </Button>
      </div>
    );
  return (
    <form
      className="flex items-center gap-2 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(email, {
          onSuccess: () => {
            setEmail("");
            setOpen(false);
          },
        });
      }}
    >
      <Input
        aria-label="对方的邮箱"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="对方的邮箱"
        type="email"
        value={email}
      />
      <Button disabled={!email.trim() || add.isPending} size="sm" type="submit">
        添加
      </Button>
      {add.error ? (
        <span className="text-sm text-destructive" role="alert">
          {add.error.message}
        </span>
      ) : null}
    </form>
  );
}

/** Who is in the group. The creator can take people out; anyone else can leave. */
function People({
  channelId,
  me,
  people,
}: {
  channelId: string;
  me: string | undefined;
  people: GroupPerson[];
}) {
  const queryClient = useQueryClient();
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const iCreated = people.some(
    (person) => person.creator && person.userId === me,
  );
  if (people.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 text-xs text-muted-foreground">
      <span>成员：</span>
      {people.map((person) => {
        const self = person.userId === me;
        const removable = self ? !person.creator : iCreated;
        return (
          <span
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
            key={person.userId}
          >
            {self ? "你" : (person.name ?? person.email)}
            {removable ? (
              <button
                aria-label={self ? "退出这个群" : `移除 ${person.email}`}
                className="hover:text-foreground"
                disabled={remove.isPending}
                onClick={() => remove.mutate(person.userId)}
                type="button"
              >
                {self ? "退出" : "×"}
              </button>
            ) : null}
          </span>
        );
      })}
      {remove.error ? (
        <span className="text-destructive" role="alert">
          {remove.error.message}
        </span>
      ) : null}
    </div>
  );
}

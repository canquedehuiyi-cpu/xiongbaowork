import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { useEffect, useRef, useState } from "react";
=======
import { useEffect, useLayoutEffect, useRef } from "react";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { Streamdown } from "streamdown";
import {
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  addGroupMemberMutationOptions,
  type GroupMessage,
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
  type GroupPerson,
=======
  groupKeys,
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
  groupQueryOptions,
  removeGroupMemberMutationOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import {
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { startRunMutationOptions } from "@/lib/pipelines/mutations";
import { pipelineTemplatesQueryOptions } from "@/lib/pipelines/queries";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import { ChannelAvatar } from "./avatar";
import {
  Composer,
  type CrewOption,
  toAgentOptions,
  toGroupOptions,
  withGroupMembers,
} from "./composer";
import { TeamBotConsentCard } from "./team-bot-consent";

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the CopilotKit chat. Each Bot answers in a thread of its own on the server, so there is no one
 * agent for a browser run to bind to; the person posts a message, the server runs every addressed
 * Bot through the ordinary headless AG-UI path, and this draws what each of them said, attributed.
 * `@Name` in the composer addresses one Bot; otherwise every Bot answers, one after another.
 *
 * A Bot here can ask the person something (`ask_person`), as it can in a conversation of its own.
 * The question waits above the composer, and what the person sends while it does is their answer,
 * unless they address another Bot. The server puts the answer in the transcript and runs the Bot
 * that asked on it (`approvals/questions.ts`).
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
  const roster = toAgentOptions(bots);
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const messages = group.data?.messages ?? [];
  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );

  const inbox = useQuery(approvalInboxOptions());
  const question = groupQuestion(inbox.data, channelId);
  // The Bot whose conversation it is: for a hand-off, the one that handed the work on.
  const askerId = question?.conversationBotId ?? question?.botId;
  const asker = useQuery(agentListQueryOptions()).data?.find(
    (bot) => bot.id === askerId,
  );
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const answerTo = async (text: string, asked: WaitingQuestion) => {
    await answer.mutateAsync({ id: asked.id, response: text });
    // The answer is in the transcript now, and the Bot's turn on it is queued.
    await queryClient.invalidateQueries({
      queryKey: groupKeys.detail(channelId),
    });
  };
  /*
   * The inbox is read every 10 s, and a Bot that asks ends its turn on the question. Read again the
   * moment the Bots stop, so the question is above the composer when the reply that asks it is.
   */
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working)
      void queryClient.invalidateQueries({
        queryKey: approvalInboxOptions().queryKey,
      });
    wasWorking.current = working;
  }, [working, queryClient]);

  /*
   * LAND AT THE BOTTOM BEFORE THE FIRST PAINT, THEN FOLLOW ONLY A READER WHO IS STILL THERE.
   *
   * This was `scrollIntoView` in a `useEffect`, which runs after the browser has painted: every
   * group chat showed its top for a frame and then jumped. A layout effect moves it before paint.
   * And it followed every new line unconditionally, pulling somebody reading an earlier answer back
   * down each time a Bot spoke; `atBottom` is where the reader was at their last scroll.
   */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  // Once per mount, which is once per channel: the route keys `GroupChat` on its channel id.
  const landed = useRef(false);
  const newest = messages.at(-1);
  const newestIsMine = newest !== undefined && newest.ownerUserId === me?.id;
  const lastKey = `${messages.length}:${newest?.status ?? ""}`;
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null || lastKey === "0:") return;
    if (
      shouldFollowGroup({
        landed: landed.current,
        atBottom: atBottom.current,
        newestIsMine,
      })
    ) {
      element.scrollTop = element.scrollHeight;
      landed.current = true;
      atBottom.current = true;
    }
  }, [lastKey, newestIsMine]);

  if (group.isPending) return null;
  if (group.isError)
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {group.error.message}
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
=======
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          atBottom.current = isNearBottom(event.currentTarget);
        }}
        ref={viewportRef}
      >
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-6"
          data-transcript-column
        >
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {send.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {send.error.message}
          </p>
        ) : null}
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
          /*
           * Groups expand into their members (spec B1), but only the members who are in this
           * conversation: `@` here addresses one of its Bots, and a coworker outside it has no thread
           * here to answer in.
           */
          agents={withGroupMembers(roster, toGroupOptions(crews.data, roster))}
=======
        {answer.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {answer.error.message}
          </p>
        ) : null}
        {/* The same drawer a conversation with one Bot draws its question in. */}
        {question ? (
          <div
            className="mx-5 -mb-4 rounded-t-2xl border border-border border-b-0 bg-muted pb-4"
            data-slot="composer-drawer"
          >
            <QuestionNotice
              avatarSeed={asker?.avatarSeed || (askerId ?? question.id)}
              botName={
                (askerId && names.get(askerId)) || asker?.name || "A Bot"
              }
              onAnswered={(text) => answerTo(text, question)}
              question={question}
            />
          </div>
        ) : null}
        <Composer
          agents={toAgentOptions(bots)}
          className="relative mt-auto w-full"
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          commands={[]}
          disabled={bots.length === 0}
          pending={send.isPending || answer.isPending || working}
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
              setStarted({ label: option?.label ?? "群组", runId: run.runId });
              return;
            }
            if (!draft.text) return;
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            setStarted(null);
=======
            if (question && (!draft.agentId || draft.agentId === askerId)) {
              await answerTo(draft.text, question);
              return;
            }
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
 * The newest open question a Bot asked in this group, from an inbox read. Each Bot here asks from a
 * thread of its own, so it is found by the conversation, not by a thread.
 */
export function groupQuestion(
  inbox: ApprovalInboxData | undefined,
  channelId: string,
): WaitingQuestion | undefined {
  return inbox?.questions.find((question) => question.channelId === channelId);
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
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
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            {message.text || "这位员工没能回答。"}
=======
            {message.text || "This Bot couldn't answer."}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
          </p>
        ) : (
          <Bubble
            align="start"
            aria-busy={message.status === "running"}
            variant="ghost"
            className="w-full"
          >
            <BubbleContent className="w-full">
              <Streamdown
                components={markdownComponents}
                plugins={markdownPlugins}
                remarkPlugins={replyRemarkPlugins}
              >
                {message.text}
              </Streamdown>
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </MessageRow>
  );
}

<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
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
=======
/**
 * Whether a scrolled element is close enough to its end to count as reading the newest line.
 *
 * Exported so it can be checked without mounting anything.
 */
export function isNearBottom(
  element: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 80,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  );
}

/**
 * Whether the group chat moves to its newest line.
 *
 * Always on opening, and always for the person's own message: they just sent it and are looking for
 * it. A Bot's line only for a reader already at the bottom, so somebody reading an earlier answer
 * keeps their place.
 *
 * Exported so it can be checked without mounting anything.
 */
export function shouldFollowGroup({
  landed,
  atBottom,
  newestIsMine,
}: {
  landed: boolean;
  atBottom: boolean;
  newestIsMine: boolean;
}): boolean {
  return !landed || atBottom || newestIsMine;
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { ExternalMark } from "@/components/agents/external/external-marks";
import {
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { GroupTurnArtifacts } from "@/components/channels/turn-artifacts";
import {
  BearMascot,
  WorkbenchEmpty,
} from "@/components/layout/workbench-empty";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import type { AcpHarness } from "@/lib/agents/external";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { CONTINUE_TEXT } from "@/lib/channels/step-limit";
import {
  type GroupMessage,
  groupKeys,
  groupQueryOptions,
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
import { type DeliveryMark, readDeliveryMark } from "@/lib/tasks/delivery-chat";
import { wakerGroupsQueryOptions } from "@/lib/waker-groups/queries";
import {
  DeliveryChatCards,
  GroupDeliveryMark,
} from "@/skins/xiongbao/delivery-chat";
import { AcpGroupPermissionLine } from "./acp-group-line";
import { ChannelAvatar } from "./avatar";
import { WorkingSpinner } from "./chat-transcript";
import {
  Composer,
  type CrewOption,
  toAgentOptions,
  toGroupOptions,
  withGroupMembers,
} from "./composer";
import { GroupPlans } from "./pinned-plans";
import { StepLimitNote } from "./step-limit-note";
import { TeamBotConsentCard } from "./team-bot-consent";
import { ThinkingBlock } from "./thinking-block";

/** Whether `groupId` is the group this channel is the chat of. */
function isThisChat(
  crews: readonly { id: string; channelId?: string | null }[] | undefined,
  groupId: string,
  channelId: string,
) {
  return (
    crews?.some(
      (crew) => crew.id === groupId && crew.channelId === channelId,
    ) ?? false
  );
}

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the agent SDK chat. Each Bot answers in a thread of its own on the server, so there is no one
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
  const crewOptions: CrewOption[] = [...(templates.data ?? [])]
    // This chat's own group first: it is the one a person here means by 「@组」.
    .sort(
      (a, b) =>
        Number(isThisChat(crews.data, b.groupId, channelId)) -
        Number(isThisChat(crews.data, a.groupId, channelId)),
    )
    .flatMap((template) => {
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
    });
  const send = useMutation(
    sendGroupMessageMutationOptions(queryClient, channelId),
  );
  const bots = group.data?.bots ?? [];
  const roster = toAgentOptions(bots);
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  // A colleague's line is signed with the name the group already lists for them.
  const people = new Map(
    (group.data?.people ?? []).map((person) => [
      person.userId,
      person.name ?? person.email,
    ]),
  );
  const messages = group.data?.messages ?? [];
  const deliveryOf = groupDeliveryCards(messages);
  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );
  /*
   * 最后一轮里有员工跑满了步数被收尾（期一）：末尾一行「已用完 N 步 · 继续」，按下就按群里点名的方式发给它。
   * 按下就收起（记下是哪一行触的顶），没发出去时放回；新的一轮一开始它本来就不会再出现。
   */
  const stepLimit = groupStepLimit(messages);
  const [continuedFrom, setContinuedFrom] = useState<string | null>(null);
  const continueAfterLimit = (limit: GroupStepLimit) => {
    setContinuedFrom(limit.messageId);
    const name = names.get(limit.agentId) ?? "";
    void send
      .mutateAsync({
        id: newId(),
        text: name ? `@${name} ${CONTINUE_TEXT}` : CONTINUE_TEXT,
        agentId: limit.agentId,
      })
      .catch(() => setContinuedFrom(null));
  };

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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <BearMascot mood="naughty" size={45} />
        <p className="font-medium text-[14px] text-signal-ink" role="alert">
          {group.error.message}
        </p>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 每位员工各自的计划，钉在对话区顶部（期二）。 */}
      <GroupPlans bots={bots} meId={me?.id} messages={messages} />
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          atBottom.current = isNearBottom(event.currentTarget);
        }}
        ref={viewportRef}
      >
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6"
          data-transcript-column
        >
          {messages.length === 0 ? (
            <WorkbenchEmpty
              description="每位员工都会依次回答；想只问其中一位，就 @它的名字。"
              title={`跟${bots.map((bot) => bot.name).join("和")}说点什么`}
            />
          ) : null}
          {messages.map((message) => (
            <GroupLine
              key={message.id}
              message={message}
              name={
                message.agentId
                  ? (names.get(message.agentId) ?? "一位员工")
                  : message.ownerUserId === me?.id
                    ? "你"
                    : (people.get(message.ownerUserId) ?? "一位同事")
              }
              answeredBy={
                // 外部员工自己的回答记在它自己的行里，不是谁「代答」的。
                message.answeredBy && message.answeredBy !== message.agentId
                  ? (names.get(message.answeredBy) ?? "另一位员工")
                  : undefined
              }
              harness={
                message.agentId
                  ? bots.find((bot) => bot.id === message.agentId)?.harness
                  : undefined
              }
              ownerName={people.get(message.ownerUserId)}
              mine={message.ownerUserId === me?.id}
              delivery={deliveryOf.get(message.id)}
              meId={me?.id}
            />
          ))}
          {/* 这一轮员工留在电脑上的文件，各带下载链接。 */}
          <GroupTurnArtifacts
            channelId={channelId}
            messages={messages}
            nameOf={(botId) => names.get(botId)}
          />
          {stepLimit && continuedFrom !== stepLimit.messageId ? (
            <StepLimitNote
              onContinue={() => continueAfterLimit(stepLimit)}
              steps={stepLimit.steps}
            />
          ) : null}
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
        {/* Who is in the group, and adding someone, moved to the top bar (`GroupPeopleButton`). */}
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
                (askerId && names.get(askerId)) || asker?.name || "一位员工"
              }
              onAnswered={(text) => answerTo(text, question)}
              question={question}
            />
          </div>
        ) : null}
        <Composer
          /*
           * Groups expand into their members (spec B1), but only the members who are in this
           * conversation: `@` here addresses one of its Bots, and a coworker outside it has no thread
           * here to answer in.
           */
          agents={withGroupMembers(roster, toGroupOptions(crews.data, roster))}
          className="relative mt-auto w-full"
          commands={[]}
          disabled={bots.length === 0}
          pending={send.isPending || answer.isPending || working}
          autoFocus
          // The same compact frame a one-to-one conversation uses.
          compact
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
            setStarted(null);
            if (question && (!draft.agentId || draft.agentId === askerId)) {
              await answerTo(draft.text, question);
              return;
            }
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

/**
 * The newest open question a Bot asked in this group, from an inbox read. Each Bot here asks from a
 * thread of its own, so it is found by the conversation, not by a thread.
 */
export function groupQuestion(
  inbox: ApprovalInboxData | undefined,
  channelId: string,
): WaitingQuestion | undefined {
  return inbox?.questions.find((question) => question.channelId === channelId);
}

/** 每行回复带的交付卡状态标记；形状不对的不画。 */
export function groupDeliveryCards(
  messages: readonly GroupMessage[],
): Map<string, DeliveryMark[]> {
  const cards = new Map<string, DeliveryMark[]>();
  for (const message of messages) {
    const marks = (message.delivery ?? []).flatMap(
      (entry) => readDeliveryMark(entry) ?? [],
    );
    if (marks.length > 0) cards.set(message.id, marks);
  }
  return cards;
}

/** 最后一轮里最后那位跑满步数的员工：哪一行、哪位、用了几步。 */
export type GroupStepLimit = {
  messageId: string;
  agentId: string;
  steps: number;
};

/**
 * 群里的「已用完 N 步 · 继续」给谁（期一）。和单聊一样只看最后一轮：最后一句人话之后的员工回复；人刚说了话、
 * 员工还没回，就已经是新的一轮了。这一轮里还有员工在跑或排着时不给。回复行上的 `stepLimit` 是服务器从那一轮的
 * `step-limit` 事件记下的（`server/src/channels/group.ts`）。
 */
export function groupStepLimit(
  messages: readonly GroupMessage[],
): GroupStepLimit | null {
  if (
    messages.some(
      (message) => message.status === "running" || message.status === "queued",
    )
  )
    return null;
  let found: GroupStepLimit | null = null;
  for (const message of messages) {
    if (message.agentId === null) {
      found = null;
      continue;
    }
    const steps = message.stepLimit?.steps;
    if (typeof steps === "number" && Number.isInteger(steps) && steps > 0)
      found = { messageId: message.id, agentId: message.agentId, steps };
  }
  return found;
}

/** One attributed line: a person's bubble, and a Bot's named reply on the left. */
export function GroupLine({
  message,
  name,
  answeredBy,
  harness,
  ownerName,
  mine,
  delivery,
  meId,
}: {
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  /** 外部员工是哪个智能体，名字旁画「外部员工 · Codex」。 */
  harness?: AcpHarness;
  /**
   * 这一行的主人（员工行就是替谁跑的那个人）怎么称呼：等他处理时对别人这样称呼他，交付状态行里「等<他>验收」。
   * 不知道名字时不带，各处用自己的兜底说法。
   */
  ownerName?: string;
  mine: boolean;
  /** 这一轮里员工走到哪一步的标记；完整的卡和按钮只给发起这一轮的人（`ownerUserId`）。 */
  delivery?: readonly DeliveryMark[];
  /** 读这一页的人，外部员工的许可状态行要知道他是不是招聘人。 */
  meId?: string;
}) {
  const mark = harness ? (
    <ExternalMark className="ml-1.5" external={{ harness }} />
  ) : null;
  // 外部员工在等它的招聘人确认一个操作（Task 12）：只有状态，没有内容。
  if (message.acpPermission && message.agentId)
    return (
      <MessageRow align="start" data-speaker={message.agentId}>
        <div className="shrink-0 pt-0.5">
          <ChannelAvatar participantIds={[message.agentId]} size={24} />
        </div>
        <MessageContent className="w-full">
          <MessageHeader className="px-0 font-medium text-[12px] text-muted-foreground">
            {name}
            {mark}
          </MessageHeader>
          <AcpGroupPermissionLine
            approvalId={message.approvalId}
            employee={name}
            line={message.acpPermission}
            meId={meId}
          />
        </MessageContent>
      </MessageRow>
    );
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="text-xs font-medium text-muted-foreground">
              {name}
            </MessageHeader>
          )}
          {/* Mine in the pale bubble; a colleague's on the quieter accent ground, left. */}
          <Bubble
            align={mine ? "end" : "start"}
            className={
              mine ? undefined : "*:data-[slot=bubble-content]:bg-accent"
            }
            variant={mine ? "user" : "muted"}
            // The person's own bubble, for the skins (the default skin's `--wb-me` gradient).
            {...(mine ? { "data-mine": "" } : {})}
          >
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
        <ChannelAvatar
          motion={
            message.status === "running" || message.status === "queued"
              ? "working"
              : undefined
          }
          participantIds={[message.agentId]}
          size={24}
        />
      </div>
      <MessageContent>
        <MessageHeader className="px-0 font-medium text-[12px] text-muted-foreground">
          {name}
          {mark}
          {answeredBy ? ` · 由${answeredBy}代答` : null}
          {/* 已经在往外说了、还没说完：名字旁边转着，和「思考中」前面那个是同一个。 */}
          {message.status === "running" && message.text ? (
            <span className="ml-1.5 inline-flex align-middle">
              <WorkingSpinner />
            </span>
          ) : null}
        </MessageHeader>
        {/* 这一轮的思考（期三），在回复上方，折起来；服务器写进回复行时这一轮已经想完了。 */}
        {message.reasoning?.text ? (
          <ThinkingBlock
            id={`group:${message.id}`}
            text={message.reasoning.text}
            thinking={false}
            {...(message.reasoning.ms === undefined
              ? {}
              : { ms: message.reasoning.ms })}
            truncated={message.reasoning.truncated === true}
          />
        ) : null}
        {(message.status === "running" || message.status === "queued") &&
        !message.text ? (
          <p
            className="tool-line-running flex items-center gap-1.5 text-sm text-muted-foreground"
            role="status"
          >
            <WorkingSpinner />
            思考中
          </p>
        ) : message.status === "waiting" && !mine ? (
          /*
           * 等的是别人（这一行的主人）：同事什么也不用做，只说在等谁、等什么，不写「需要你处理」，不给链接。
           */
          <p
            className="m-0 flex items-center gap-2 text-[13px] text-muted-foreground"
            data-waiting-other=""
            role="status"
          >
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 rounded-full bg-[color:var(--wb-amber,var(--signal))]"
            />
            {message.waitKind === "share"
              ? `${name}的回答要等 ${ownerName ?? "它的主人"} 确认能不能发到群里`
              : `${name}在等 ${ownerName ?? "它的主人"} 处理一件事`}
          </p>
        ) : message.status === "waiting" ? (
          // Waiting on a person: the attention treatment, with the way to act on it beside the reason.
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] leading-relaxed">
            <span className="font-medium text-signal-ink">需要你处理</span>
            <span className="min-w-0">
              {message.waitKind === "share"
                ? `${name}的回答要等你确认能不能发到群里，确认前群里看不到。`
                : (message.reason ?? "等你回应。")}
            </span>{" "}
            <Link
              className="font-medium underline underline-offset-2"
              to="/settings/approvals"
              /*
               * The line knows which approval would resume it, so the link names it and the page
               * lands on that row. A durable wait has none -- nothing to land on -- and goes to the
               * list, which is where its answer is.
               */
              {...(message.approvalId
                ? { search: { focus: message.approvalId } }
                : {})}
            >
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
          <p
            className="rounded-[12px] border border-signal/30 bg-signal-soft px-3 py-2 text-[13px] text-signal-ink"
            role="alert"
          >
            {message.text || "这位员工没能回答。"}
          </p>
        ) : (
          <Bubble
            align="start"
            aria-busy={message.status === "running"}
            variant="card"
            className="w-full max-w-full"
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
        {delivery && delivery.length > 0 ? (
          <DeliveryChatCards>
            {delivery.map((mark) => (
              <GroupDeliveryMark
                agentName={name}
                key={`${mark.kind}:${mark.taskId}:${mark.at}`}
                mark={mark}
                ownerId={message.ownerUserId}
                ownerName={ownerName ?? "派活的人"}
              />
            ))}
          </DeliveryChatCards>
        ) : null}
      </MessageContent>
    </MessageRow>
  );
}

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
}

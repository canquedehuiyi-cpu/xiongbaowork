/**
 * The tool every Bot uses to give a piece of its own work to a subagent.
 *
 * A SUBAGENT IS THE SAME BOT, RUN AGAIN. A fresh headless turn of the Bot that called it, as the same
 * person and the same initiator, one level deeper, in a thread of its own: so it holds exactly the
 * Bot's granted tools, its computer, its approval rules and its standing instructions, and nothing
 * the Bot was not given. What it does not have is the conversation. It starts from the task alone and
 * hands back only its answer, which is the point: the Bot's own context stays clean for planning and
 * deciding, and twenty pages of reading stay in the subagent's thread.
 *
 * EXECUTED HERE, FOR EVERY KIND OF BOT. A built-in Bot holds it among its tools; a remote AG-UI agent
 * is offered it with its grants and calls it like any of them, and the headless middleware runs it on
 * this server. So an agent somebody brings needs no change to have subagents, and a subagent of a
 * remote Bot is that remote Bot again, at its own endpoint.
 *
 * A SUBAGENT NEVER WAITS ON THE PERSON. Nobody watches its thread, so a question put there would be
 * answered by nobody. An action that needs a yes stops it; the request it opened is withdrawn so the
 * person is not asked twice, and the Bot is told exactly what it wanted to do, to do itself in the
 * conversation where the person is asked as usual.
 *
 * No nesting: a subagent is built with no coordination at all, so it is offered neither this nor
 * `message_bot` nor `ask_person`, and its thread is no conversation a coordination callback accepts.
 */

import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/client";
import {
  SUBAGENT_MODEL_DESCRIPTION,
  SUBAGENT_TOOL,
  SUBAGENTS_PER_ANSWER,
  type SubagentProgress,
  type SubagentResult,
  subagentThreadId,
} from "@xiongbao/shared/subagent";
import type {
  GrantedTool,
  ToolExecution,
} from "@xiongbao/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@xiongbao/toolkit/headless-tools";
import { toolSegmentsFor, turnTimeoutFor } from "@xiongbao/toolkit/limits";
import { createTurnRunner } from "@xiongbao/toolkit/run-turn";
import { z } from "zod";
import { currentApprovalContext } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { REFUSAL_MARKER } from "../plugins/tools";
import {
  FAILURE_HANDOFF_CHARS,
  FAILURE_HANDOFF_FILES,
  FAILURE_HANDOFF_STEPS,
  lastStepsOf,
  writtenFilesOf,
} from "../tasks/failure-handoff";
import { type OutputSink, spill } from "../tool-output";
import { resolveSubagentModel } from "./subagent-model";

/**
 * Stable JSON for a value, so the same action keyed by a different argument order still matches.
 * Used by the repeated-hand-back circuit breaker: the person is asked once per action per answer,
 * not once per subagent run that happens to hit it.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

function handedBackActionKey(
  threadId: string,
  toolName: string,
  args: unknown,
): string {
  return `${threadId} ${toolName} ${canonical(args)}`;
}

const parameters = z.object({
  task: z
    .string()
    .describe(
      "交给它的那部分工作，要能独立完成：写清目标和范围，以及它需要的每个名字、日期、编号和约束（它看不到这段对话）",
    ),
  answer: z
    .string()
    .describe(
      "要交回什么、用什么格式：例如一张写明列名的表、一个数字、带来源的简短总结、是或否加理由",
    ),
  // 期七：可选，不写就和以前一样。
  model: z.string().optional().describe(SUBAGENT_MODEL_DESCRIPTION),
});

/**
 * What a withdrawn request says in the person's approvals. The Bot asks again in the conversation,
 * so this is where they say yes, not here.
 */
export const SUBAGENT_HANDED_BACK =
  "Handed back to your conversation with this Bot, where you're asked instead.";

/** The run asking, as this deployment knows it. */
export type SubagentParent = {
  runId?: string;
  actorId: string;
  botId: string;
  threadId: string;
  initiator: AuditInitiator;
  depth?: number;
};

type TurnOptions = Parameters<typeof createTurnRunner>[0];

/**
 * The subagent's only message: the task, framed for a run nobody is watching.
 *
 * Written for the model. It is a user message rather than a prompt, so the Bot's own prompt, role
 * and standing instructions are exactly what they are in the conversation.
 */
function framed(task: string, answer: string): string {
  return [
    "You are a subagent: you were given one part of a larger piece of work, to do on your own. Nobody is watching this run and you cannot ask the person anything. Do the work with your tools, then reply with the answer asked for and nothing else.",
    "If an action needs the person's approval, it is handed back to the main conversation; do not look for another way to do it.",
    `Task: ${task}`,
    `Answer wanted: ${answer}`,
  ].join("\n\n");
}

/** Every tool call the subagent made, which is what its card counts as a step. */
function stepsIn(messages: readonly Message[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      (message.role === "assistant" ? (message.toolCalls?.length ?? 0) : 0),
    0,
  );
}

/**
 * The subagent's thread as the events its run streamed, for reading its tool calls: each call the
 * assistant made (start and arguments), and each tool's answer.
 */
function eventsOf(messages: readonly Message[]): BaseEvent[] {
  return messages.flatMap((message): BaseEvent[] => {
    if (message.role === "assistant")
      return (message.toolCalls ?? []).flatMap(
        (call) =>
          [
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: call.function.name,
            },
            {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: call.id,
              delta: call.function.arguments,
            },
            { type: EventType.TOOL_CALL_END, toolCallId: call.id },
          ] as BaseEvent[],
      );
    if (message.role === "tool")
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: message.toolCallId,
          messageId: message.id,
          content: message.content,
        } as BaseEvent,
      ];
    return [];
  });
}

/**
 * How far a subagent that did not finish got (spec 2026-11-25-borrowed-improvements 5.4): its last
 * {@link FAILURE_HANDOFF_STEPS} tool calls and the files it wrote, masked as a card's failure hand-over
 * is. Kept within {@link FAILURE_HANDOFF_CHARS} once serialised: the files go first, then the oldest
 * steps. Undefined when it made no call.
 */
function progressIn(
  messages: readonly Message[],
): SubagentProgress | undefined {
  const events = eventsOf(messages);
  let steps = lastStepsOf(events, FAILURE_HANDOFF_STEPS);
  let files = writtenFilesOf(events, FAILURE_HANDOFF_FILES);
  if (steps.length === 0 && files.length === 0) return undefined;
  const fits = () =>
    JSON.stringify({ steps, files }).length <= FAILURE_HANDOFF_CHARS;
  if (!fits()) files = [];
  while (!fits() && steps.length > 0) steps = steps.slice(1);
  return { steps, files };
}

/** What it had said before it stopped, which is its own account of why. */
function saidIn(messages: readonly Message[]): string | undefined {
  const said = messages
    .flatMap((message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim()
        ? [message.content.trim()]
        : [],
    )
    .join("\n\n");
  return said || undefined;
}

/** 子代理指定模型要问服务器的三件事。 */
export type SubagentModels = {
  /** 本租户可用的模型名（对话里模型选择器的那份目录）。 */
  allowed: (ownerUserId: string) => Promise<readonly string[]>;
  /** 这位员工设置里的难任务模型（`agents.configuration.hardModel`），没设置就是空。 */
  hardModelOf: (
    ownerUserId: string,
    botId: string,
  ) => Promise<string | undefined>;
  /** 让这条线程的这一次运行用这个模型；返回的函数撤销它（运行结束时调用）。 */
  pin: (threadId: string, model: string) => () => void;
};

export function createSubagents(options: {
  /** The headless turn a subagent runs, as every background turn is built. No components. */
  turn: Omit<TurnOptions, "buildAgentFor" | "components">;
  /** The same Bot as the person's run gets, built for a subagent: no coordination, no nesting. */
  buildAgentFor: TurnOptions["buildAgentFor"];
  /** Close every approval request the subagent's run opened, without carrying that run on. */
  withdrawApprovals: (ownerUserId: string, runId: string) => Promise<unknown>;
  /**
   * Whether the conversation is a check-in task's, where every step is asked about in it. Those are
   * kept in the conversation: a subagent's own thread is not one the gate knows to ask in that way.
   */
  asksEveryStep?: (ownerUserId: string, threadId: string) => Promise<boolean>;
  /**
   * 期七：`model` 参数要用的三样。不给，`model` 不起作用（子代理照旧用员工平时的模型），也不拒绝。
   */
  models?: SubagentModels;
  /**
   * Where a long answer is kept for the Bot that asked: its workspace. Given the run asking, so the
   * file lands where that Bot's own commands and file tools reach. Absent, or a sink that cannot write,
   * an answer is handed back whole whatever its length.
   */
  outputSinkFor?: (parent: SubagentParent) => OutputSink | undefined;
  perAnswer?: number;
}) {
  const perAnswer = options.perAnswer ?? SUBAGENTS_PER_ANSWER;
  return {
    /** The tool for one run. Its count of subagents is that run's, which is one answer. */
    toolForRun(parent: SubagentParent): GrantedTool {
      let started = 0;
      /*
       * Actions this answer has already handed back: the same action again is refused instead of
       * being handed back a second time, so the Bot is not told to try the subagent path again for
       * something the person has to approve here. Reset per run: a new user turn gets a new closure.
       */
      const handedBackActions = new Set<string>();
      let currentRunId = parent.runId;
      return {
        name: SUBAGENT_TOOL,
        ref: `bot/${SUBAGENT_TOOL}`,
        /*
         * Said for doing it (期四). This used to lead with the cost ("slower than doing the work
         * yourself", "only when each part needs a lot of reading"), and the Bots almost never called
         * it, even for three companies side by side. Now it says when to share work out and how to
         * brief it, with the cost one clause, and the hard limits as the facts they are. In Chinese,
         * as the `<delegation>` section of the prompt is (`SUBAGENT_GUIDANCE`).
         */
        description:
          "把你工作里一个独立的部分交给子代理：它是你的一个新副本，带着你的工具、替同一个人办事，看不到这段对话，只交回它的答案。" +
          "任务能拆成两个以上相互独立的部分时（例如分别调研几家公司、分别读几份文件、写完后另派一个做校对），主动给每个部分派一个，在同一步里多次调用就能并行去做；你自己负责计划、汇总和最后的判断。" +
          "一两步就能完成的简单任务自己做，不派。" +
          "task 里写清目标、范围和它需要知道的一切，answer 里写明要交回什么、用什么格式。" +
          `每轮最多 ${perAnswer} 个，子代理不能再派子代理；团队成员不是子代理。每个子代理都会多花一些时间，同一件事不要拆给几个重复做。` +
          "子代理碰到需要这个人批准的操作会停下，把它交还给你。",
        parameters,
        initiator: parent.initiator,
        concurrent: true,
        execute: async (args: unknown, execution?: ToolExecution) => {
          const parsed = parameters.safeParse(args);
          if (!parsed.success)
            return `${REFUSAL_MARKER} No subagent was started: say what the task is and what answer you want back.`;
          /*
           * 期七：先定模型。被拒的（不在可用的模型里）不启动，也不占这一轮的名额；没有难任务模型的
           * "hard" 退回平时的模型，在结果里说明。
           */
          let pinned: string | undefined;
          let modelNote: string | undefined;
          if (options.models && parsed.data.model?.trim()) {
            const chosen = resolveSubagentModel({
              requested: parsed.data.model,
              hardModel: await options.models.hardModelOf(
                parent.actorId,
                parent.botId,
              ),
              allowed: await options.models.allowed(parent.actorId),
            });
            if (chosen.refusal) return `${REFUSAL_MARKER} ${chosen.refusal}`;
            pinned = chosen.use;
            modelNote = chosen.note;
          }
          /*
           * A task from a check-in is asked first, because starting nothing there is not a subagent
           * this answer used: counting it would spend the cap on work that never ran, and a Bot on
           * the sixth call would be told it had already started five.
           */
          if (await options.asksEveryStep?.(parent.actorId, parent.threadId))
            return `${REFUSAL_MARKER} No subagent was started: in a task from a check-in, every step is checked with the person in this conversation. Do this part yourself.`;
          // Checked and counted with nothing awaited between them, so calls arriving together
          // cannot all pass the cap.
          if (started >= perAnswer)
            return `${REFUSAL_MARKER} No subagent was started: one answer can start up to ${perAnswer} subagents, and this one has. Do this part yourself.`;
          started += 1;

          // Reset circuit breaker if runId changed (new run)
          if (parent.runId && parent.runId !== currentRunId) {
            handedBackActions.clear();
            currentRunId = parent.runId;
          }

          const toolCallId =
            execution?.toolCallId ??
            currentApprovalContext()?.toolCallId ??
            crypto.randomUUID();
          const threadId = await subagentThreadId(parent.threadId, toolCallId);
          const runId = crypto.randomUUID();
          let agent: AbstractAgent | undefined;
          const runTurn = createTurnRunner({
            // A subagent does a part of the work, on the working turn's clock unless told (期五).
            turnTimeoutMs: turnTimeoutFor("subagent"),
            maxToolSegments: toolSegmentsFor("subagent"),
            ...options.turn,
            buildAgentFor: async (input) => {
              agent = await options.buildAgentFor(input);
              return agent;
            },
          });
          const messages = () => agent?.messages ?? [];
          const answer = (result: SubagentResult) =>
            JSON.stringify({
              ...result,
              ...(pinned ? { model: pinned } : {}),
              ...(modelNote ? { modelNote } : {}),
            });
          /*
           * Timed here, around the run, because the page cannot: a subtask's card is drawn again
           * long after its turn, and while it worked there was nothing on it to measure from. What
           * the run waited on — the model, its tools, a stop — is inside this span; the withdraw
           * below is not.
           */
          const startedAt = Date.now();
          const elapsed = () => Math.max(0, Date.now() - startedAt);
          // 这条线程的这一次运行用选定的模型；运行怎么结束都撤销（见下面的 finally）。
          const unpin =
            pinned && options.models
              ? options.models.pin(threadId, pinned)
              : undefined;
          try {
            const { replyText } = await runTurn({
              ownerUserId: parent.actorId,
              routineId: SUBAGENT_TOOL,
              agentId: parent.botId,
              threadId,
              runId,
              instruction: parsed.data.task,
              userMessage: {
                id: crypto.randomUUID(),
                role: "user",
                content: framed(parsed.data.task, parsed.data.answer),
              },
              initiator: parent.initiator,
              depth: (parent.depth ?? 0) + 1,
              ...(execution?.signal ? { signal: execution.signal } : {}),
            });
            /*
             * What the subagent says comes back into the asking conversation and is sent again on every
             * step after it. A long one is kept in the workspace and only its head and tail come back,
             * with the path, as a long command output does (`tool-output.ts`); the subagent's own thread
             * still holds all of it. A sink that cannot write leaves the answer whole: nothing is lost.
             */
            const sink = options.outputSinkFor?.(parent);
            const spilled = sink
              ? await spill({
                  tool: SUBAGENT_TOOL,
                  id: toolCallId,
                  full: replyText,
                  sink,
                })
              : null;
            return answer({
              answer: spilled?.savedTo ? spilled.show(replyText) : replyText,
              ...(spilled?.savedTo
                ? { savedTo: spilled.savedTo, truncated: spilled.note }
                : {}),
              threadId,
              steps: stepsIn(messages()),
              ms: elapsed(),
            });
          } catch (error) {
            if (execution?.signal?.aborted) throw error;
            if (!(error instanceof HeadlessToolSuspension)) {
              const progress = progressIn(messages());
              return answer({
                error: `The subagent did not finish: ${error instanceof Error ? error.message : String(error)}`,
                ...(progress ? { progress } : {}),
                threadId,
                steps: stepsIn(messages()),
                ms: elapsed(),
              });
            }
            const waited = error.waiting.continuation as
              | { toolName?: unknown; args?: unknown }
              | undefined;
            const said = saidIn(messages());
            const tool =
              typeof waited?.toolName === "string"
                ? waited.toolName
                : "unknown";
            const key = handedBackActionKey(
              parent.threadId,
              tool,
              waited?.args ?? {},
            );
            if (handedBackActions.has(key))
              return `${REFUSAL_MARKER} 该动作已交还过一次，不再重复交还：请在本对话亲自调用 ${tool}（参数同上），以便用户批准。`;
            handedBackActions.add(key);
            return answer({
              handedBack: {
                tool,
                args: waited?.args ?? {},
                reason: error.message,
                ...(said ? { said } : {}),
              },
              next: "The subagent stopped before this action and nothing was done; the person has not been asked. If it still needs doing, call that tool yourself in this conversation with those arguments, so the person is asked here.",
              threadId,
              steps: stepsIn(messages()),
              ms: elapsed(),
            });
          } finally {
            /*
             * Every way this run can end closes the requests it opened, not only the one that says
             * so by throwing the suspension. A turn stopped by the clock, lost lock or cancelled
             * after it had opened one leaves that request waiting in a thread nobody reads, and a
             * person approving it would do the action a second time; an aborted one never answers at
             * all. Nothing was resumed by any of them, so the Bot is asked for it in the
             * conversation, as above. Withdrawal only closes what is still pending and does nothing
             * twice, so on a run that opened nothing this costs one read.
             */
            unpin?.();
            await options.withdrawApprovals(parent.actorId, runId);
          }
        },
      };
    },
  };
}

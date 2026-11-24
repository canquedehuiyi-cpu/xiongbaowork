import { describe, expect, test } from "bun:test";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { createPersonResponseTick } from "../src/approvals/person-response-sweep";
import {
  PERSON_QUESTION_WAITING,
  resumePersonQuestion,
} from "../src/approvals/question-resume";
import type { PersonQuestion } from "../src/approvals/questions";

/**
 * 批注回到会话的最后一段：排队的消息怎样被续跑。批注不是答复，原样交给发起它的会话，
 * 不借用「回答问题」的措辞，也不去续跑一个正在等答复的目标，也不动看板卡。
 */
const owner = "person-1";
const question = (over: Partial<PersonQuestion> = {}): PersonQuestion => ({
  actorId: owner,
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  question: "要不要改成异步？",
  mode: "completed_question",
  ...over,
});

describe("resuming with notes", () => {
  test("the notes reach the conversation word for word, as the person's own message", async () => {
    const turns: Parameters<TurnRunner>[0][] = [];
    const runTurn: TurnRunner = async (turn) => {
      turns.push(turn);
      return { replyText: "好的" };
    };
    await resumePersonQuestion({
      ownerUserId: owner,
      question: question(),
      response: "关于「要不要改成异步？」，我写了 1 条批注。",
      asNotes: true,
      messageId: "person-response:n1",
      runTurn,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      agentId: "bot-1",
      threadId: "thread-1",
      userMessage: {
        id: "person-response:n1",
        role: "user",
        content: "关于「要不要改成异步？」，我写了 1 条批注。",
      },
    });
  });

  test("an answer still carries the question it answers", async () => {
    const turns: Parameters<TurnRunner>[0][] = [];
    await resumePersonQuestion({
      ownerUserId: owner,
      question: question(),
      response: "改。",
      messageId: "person-response:a1",
      runTurn: async (turn) => {
        turns.push(turn);
        return { replyText: "" };
      },
    });
    expect(turns[0]?.userMessage).toMatchObject({
      content: "In response to your question: 要不要改成异步？\n\n改。",
    });
  });

  test("a goal waiting for its answer is not resumed by notes", async () => {
    const resumed: unknown[] = [];
    const turns: Parameters<TurnRunner>[0][] = [];
    const goal = {
      id: "goal-1",
      threadId: "thread-1",
      agentId: "bot-1",
    };
    const outcome = await resumePersonQuestion({
      ownerUserId: owner,
      question: question({
        initiator: { kind: "responsibility", id: "goal-1" },
      }),
      response: "批注",
      asNotes: true,
      messageId: "person-response:n2",
      runTurn: async () => {
        throw new Error("the ordinary runner must not be used");
      },
      responsibilities: {
        get: async () => goal,
        listRuns: async () => [
          {
            id: "run-asked",
            status: "waiting",
            waiting: { kind: PERSON_QUESTION_WAITING },
          },
        ],
        resumeWaiting: async (...args: unknown[]) => {
          resumed.push(args);
          return true;
        },
      } as never,
      responsibilityTurn: () => async (turn) => {
        turns.push(turn);
        return { replyText: "" };
      },
    });
    expect(resumed).toEqual([]);
    expect(turns[0]?.userMessage).toMatchObject({ content: "批注" });
    expect(outcome.responsibilityId).toBe("goal-1");
  });
});

describe("the person-response loop with notes", () => {
  function tickFor(payload: Record<string, unknown>) {
    const finishedCards: unknown[] = [];
    const turns: Parameters<TurnRunner>[0][] = [];
    const queue = {
      claim: async () => [
        { kind: "person.response", key: "k1", tenantId: owner, payload },
      ],
      finish: async () => true,
      release: async () => undefined,
    };
    const tick = createPersonResponseTick({
      approvalQueue: queue as never,
      personResponseOwner: "sweep",
      authoriseQuestion: async () => undefined,
      approvalContinuationRunner: async (turn) => {
        turns.push(turn);
        return { replyText: "" };
      },
      responsibilityStore: {} as never,
      responsibilityAnswerTurn: (() => () => undefined) as never,
      sourceForCoordinationRun: async () => null,
      channelStore: {} as never,
      actorFor: async () => ({ id: owner }) as never,
      notify: async () => undefined,
      board: {
        finished: async (input: unknown) => {
          finishedCards.push(input);
        },
      } as never,
    });
    return { tick, turns, finishedCards };
  }

  test("notes run as a turn and leave the board card where it was", async () => {
    const { tick, turns, finishedCards } = tickFor({
      ownerUserId: owner,
      question: question(),
      response: "批注原文",
      notes: true,
    });
    await tick();
    expect(turns[0]?.userMessage).toMatchObject({ content: "批注原文" });
    expect(finishedCards).toEqual([]);
  });

  test("an answer still moves the card on to review", async () => {
    const { tick, finishedCards } = tickFor({
      ownerUserId: owner,
      question: question(),
      response: "答复",
    });
    await tick();
    expect(finishedCards).toHaveLength(1);
  });
});

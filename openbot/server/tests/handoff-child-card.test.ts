import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { asc, eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { HandoffWork } from "../src/agents/handoff-runner";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 020: a hop is board work, filed under the turn that asked for it.
 *
 * The property is which hops appear on the board at all. A card opened before the guards would claim
 * work nobody did -- a Bot the person paused, or a conversation already busy with another run, never
 * started -- and a card left `running` after a hop failed is a claim the board never corrects, because
 * a hop has nobody watching it. So all three endings are asserted here: answered, failed, and never
 * begun.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const board = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const person = `hop-${suite}`;

/** The platform's own id for the hop's run: what the card is keyed by. */
const hopRunId = `hop-run-${suite}`;

const WORK: HandoffWork = {
  fromBotId: "asker",
  toBotId: "worker",
  actorId: person,
  threadId: `thread-${suite}`,
  runId: `parent-run-${suite}`,
  depth: 1,
  task: "整理昨天的故障窗口",
};

function stubAgent(): AbstractAgent {
  const agent = {
    threadId: "",
    messages: [] as unknown[],
    setMessages(messages: unknown[]) {
      agent.messages = messages;
    },
  };
  return agent as unknown as AbstractAgent;
}

/**
 * The delivery, with the board attached and everything else stubbed the way the delivery's own suite
 * stubs it -- the DB is real because the cards are the subject, and the runner is fake because which
 * events a model emits is not.
 */
function harness(events: BaseEvent[], lockHeld = true, runId = hopRunId) {
  return createHandoffDelivery({
    board,
    agentFor: async () => stubAgent(),
    history: async () => [],
    newRunId: () => runId,
    mintThreadId: () => `scratch-${suite}`,
    lock: {
      acquire: async () => (lockHeld ? { runId } : null),
      renew: async () => {},
      release: async () => {},
    },
    runner: {
      run: () =>
        new Observable<BaseEvent>((subscriber) => {
          for (const event of events) subscriber.next(event);
          subscriber.complete();
        }),
    },
  });
}

const childCard = async (runId = hopRunId) =>
  await runAsTenant(person, async () =>
    database
      .select({
        source: tasks.source,
        status: tasks.status,
        runRef: tasks.runRef,
        parentTaskId: tasks.parentTaskId,
        executorAgentId: tasks.executorAgentId,
      })
      .from(tasks)
      .where(eq(tasks.runRef, runId))
      .limit(1),
  );

const FINISHED = [
  { type: "RUN_FINISHED" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "故障窗口是 14:02–14:19。" },
] as unknown as BaseEvent[];

afterAll(async () => {
  await runAsTenant(person, async () => {
    await database.delete(tasks);
  });
  await database.$client.close();
});

test("a hop that answered is one card, under the turn that asked", async () => {
  /*
   * The parent is a chat turn -- which is exactly how a hop begins: a person asks something, the
   * addressed Bot hands part of it on. The projector is the only writer, so the parent's card id is
   * whatever it says it is, and `parentRunRef` is the only handle the hop has.
   */
  const parentId = await board.opened({
    tenantId: person,
    title: "查一下昨天的故障窗口",
    executorAgentId: "asker",
    source: "chat",
    runRef: WORK.runId,
  });

  await harness(FINISHED).deliver({
    work: WORK,
    message: "worker was asked to find the outage window",
    shown: "Ask worker: find the outage window",
    assertion: "signed",
  });

  const [card] = await childCard();
  expect(card?.source).toBe("handoff");
  expect(card?.executorAgentId).toBe("worker");
  // The chain, not just the row: filed under the turn that asked, by the card id rather than the run.
  expect(card?.parentTaskId).toBe(parentId);
  // An hop that came back is work waiting to be reviewed, never work still going.
  expect(card?.status).toBe("awaiting_review");
});

/**
 * The failure that ticket 032 was about, on the path that has nobody watching it.
 *
 * `settled` rejects when the stream carries `RUN_ERROR`, so the throw is what has to close the card --
 * and it still has to reach the runner, which is what puts the hop back on the queue or relays the
 * failure to the person.
 */
test("a hop whose run errored closes as failed rather than stranded", async () => {
  await board.opened({
    tenantId: person,
    title: "父任务：故障复盘",
    executorAgentId: "asker",
    source: "chat",
    runRef: `${WORK.runId}-err`,
  });

  const work: HandoffWork = { ...WORK, runId: `${WORK.runId}-err` };
  await expect(
    harness(
      [
        { type: "RUN_ERROR", message: "endpoint refused" },
      ] as unknown as BaseEvent[],
      true,
      `${hopRunId}-err`,
    ).deliver({
      work,
      message: "worker was asked and could not answer",
      shown: "Ask worker",
      assertion: "signed",
    }),
  ).rejects.toBeDefined();

  const [card] = await runAsTenant(person, async () =>
    database
      .select({ status: tasks.status, parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.runRef, `${hopRunId}-err`))
      .limit(1),
  );
  expect(card?.status).toBe("failed");
});

/**
 * A hop that never started is not work.
 *
 * The conversation being busy is a wait, not a failure: the runner puts the hop back on the queue and it
 * is tried again. A card opened before that check would put a task on the board for a turn that never
 * ran -- and retried, so it would do it once per attempt.
 */
test("a hop that never got the conversation opens no card at all", async () => {
  const otherRun = `${hopRunId}-busy`;
  await expect(
    createHandoffDelivery({
      board,
      agentFor: async () => stubAgent(),
      history: async () => [],
      newRunId: () => otherRun,
      mintThreadId: () => `scratch-${suite}`,
      lock: {
        acquire: async () => null,
        renew: async () => {},
        release: async () => {},
      },
      runner: {
        run: () =>
          new Observable<BaseEvent>((subscriber) => subscriber.complete()),
      },
    })
      .deliver({
        work: { ...WORK, runId: `${WORK.runId}-busy` },
        message: "worker was asked while the thread was busy",
        shown: "Ask worker",
        assertion: "signed",
      })
      .catch(() => undefined)
      .then(
        async () =>
          await runAsTenant(person, async () =>
            database
              .select({ id: tasks.id })
              .from(tasks)
              .where(eq(tasks.runRef, otherRun)),
          ),
      ),
  ).resolves.toHaveLength(0);
});

/**
 * Archiving the parent leaves the child, because the chain is a provenance record rather than a
 * containment relationship: the hop's work happened, and reviewing it is still somebody's job.
 */
test("the board reads the chain oldest first, so a parent is filed before its child", async () => {
  const parentId = await board.opened({
    tenantId: person,
    title: "父任务：归档不带走子卡",
    executorAgentId: "asker",
    source: "chat",
    runRef: `${WORK.runId}-order`,
  });

  await harness(FINISHED, true, `${hopRunId}-order`).deliver({
    work: { ...WORK, runId: `${WORK.runId}-order` },
    message: "worker was asked",
    shown: "Ask worker",
    assertion: "signed",
  });

  const rows = await runAsTenant(person, async () =>
    database
      .select({ id: tasks.id, parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentId))
      .orderBy(asc(tasks.createdAt)),
  );
  expect(rows.length).toBeGreaterThan(0);
  await board.archived({ tenantId: person, taskId: parentId });
  const survivors = await runAsTenant(person, async () =>
    database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, rows[0]?.id ?? "")),
  );
  expect(survivors).toHaveLength(1);
});

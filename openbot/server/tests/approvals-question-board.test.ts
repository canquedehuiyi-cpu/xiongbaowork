import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  createApprovalQuestions,
  withQuestionParking,
} from "../src/approvals/questions";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { tasks, users } from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec I3 (and A8 for questions): a run that stops to ask its person a question (`ask_person`) parks its
 * card in 需要操作 under the question's key, and the person's answer -- the same
 * `POST /api/approvals/questions/:id/respond` the 审批 page uses -- moves it back to 进行中.
 *
 * `ask_person` lets the turn END (`completed_question`), and the runner then closes its card with
 * `finished`, which writes `awaiting_review` and clears the park. So the park is the projector's last word
 * after that close (`withQuestionParking`), and the first case below proves the order: the plain close
 * alone leaves the card in review, the wrapped close leaves it waiting on the question.
 *
 * Everything runs in the question row's tenant frame, the way a signed-in request and a claimed worker
 * row do, so row-level security answers the reads. Another tenant, in ITS frame, gets 404 for the owner's
 * question and cannot park, see or move the owner's card.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const plainBoard = createTaskProjector(database);
const questions = createApprovalQuestions(database, async () => {}, plainBoard);
const board = withQuestionParking(plainBoard, questions);
const service = createApprovalService(
  createApprovalStore(database, board),
  questions,
);
const suite = randomUUID().slice(0, 8);
const owner = `board-question-${suite}-owner`;
const stranger = `board-question-${suite}-stranger`;
const questionKeys: string[] = [];

const actorFor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@openbot.test`, role: "user" });
    await next();
  };

const as = (tenant: string) => {
  const approvals = createApprovalRoutes(service, actorFor(tenant));
  const boardRoutes = createTaskRoutes(database, actorFor(tenant), board);
  return {
    answer: (questionId: string, response: string) =>
      runAsTenant(tenant, () =>
        approvals.request(
          new Request(
            `http://openbot.test/questions/${encodeURIComponent(questionId)}/respond`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ response }),
            },
          ),
        ),
      ),
    inbox: () =>
      runAsTenant(tenant, async () => {
        const response = await approvals.request(
          new Request("http://openbot.test/"),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          questions: { id: string; question: string }[];
        };
      }),
    cards: () =>
      runAsTenant(tenant, async () => {
        const response = await boardRoutes.request(
          new Request("http://openbot.test/"),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          tasks: {
            id: string;
            status: string;
            pendingApprovalId: string | null;
          }[];
        };
        return body.tasks;
      }),
  };
};

const ownerSide = as(owner);
const strangerSide = as(stranger);

const ownerCard = async (taskId: string) =>
  (await ownerSide.cards()).find((entry) => entry.id === taskId);

/** A chat card whose run is going, and the question that run saved, in the owner's frame. */
async function askingRun(label: string) {
  const runRef = `run-${label}-${suite}`;
  const taskId = await board.opened({
    tenantId: owner,
    title: `等你回答 ${label}`,
    executorAgentId: `agent-${suite}`,
    source: "chat",
    runRef,
  });
  const key = `question-${label}-${suite}`;
  questionKeys.push(key);
  await runAsTenant(
    owner,
    async () =>
      await database.insert(workItems).values({
        kind: "person.question",
        key,
        payload: {
          actorId: owner,
          botId: `bot-${suite}`,
          threadId: `thread-${label}-${suite}`,
          runId: runRef,
          question: `${label}：合并到哪个分支？`,
          mode: "completed_question",
        },
      }),
  );
  return { taskId, runRef, key };
}

/** The tenant the question's rows were written under, read in the owner's frame. */
const rowTenant = async (kind: string, key: string) => {
  const [row] = await runAsTenant(
    owner,
    async () =>
      await database
        .select({ tenantId: workItems.tenantId })
        .from(workItems)
        .where(and(eq(workItems.kind, kind), eq(workItems.key, key))),
  );
  return row?.tenantId;
};

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
});

afterAll(async () => {
  await runAsTenant(owner, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, owner));
    if (questionKeys.length)
      await database
        .delete(workItems)
        .where(
          and(
            inArray(workItems.kind, ["person.question", "person.response"]),
            inArray(workItems.key, questionKeys),
          ),
        );
  });
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("a run that ends on an open question parks its card in 需要操作 under the question, after the close", async () => {
  const { taskId, runRef, key } = await askingRun("park");
  expect(await rowTenant("person.question", key)).toBe(owner);

  // The plain close is what used to happen: the question is lost behind 查收.
  await plainBoard.finished({ tenantId: owner, runRef });
  expect((await ownerCard(taskId))?.status).toBe("awaiting_review");

  // The deployment's close: the run left a question open, so the card waits on the person.
  await board.finished({ tenantId: owner, runRef });
  const parked = await ownerCard(taskId);
  expect(parked?.status).toBe("needs_action");
  expect(parked?.pendingApprovalId).toBe(key);
  // And the board's inbox read names that question, which is how the card knows to ask for an answer.
  expect(
    (await ownerSide.inbox()).questions.map((entry) => entry.id),
  ).toContain(key);
});

test("a run with no open question, or a failed run, is closed as before", async () => {
  const quiet = `run-quiet-${suite}`;
  const quietCard = await board.opened({
    tenantId: owner,
    title: "没有提问",
    executorAgentId: `agent-${suite}`,
    source: "chat",
    runRef: quiet,
  });
  await board.finished({ tenantId: owner, runRef: quiet });
  const closed = await ownerCard(quietCard);
  expect(closed?.status).toBe("awaiting_review");
  expect(closed?.pendingApprovalId).toBeNull();

  const { taskId, runRef } = await askingRun("failed");
  await board.finished({ tenantId: owner, runRef, failed: true });
  expect((await ownerCard(taskId))?.status).toBe("failed");
});

test("回答 moves the parked card back to 进行中 and queues the answer in the owner's tenant", async () => {
  const { taskId, runRef, key } = await askingRun("answer");
  await board.finished({ tenantId: owner, runRef });
  expect((await ownerCard(taskId))?.status).toBe("needs_action");

  const response = await ownerSide.answer(key, "main 分支");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: key, queued: true });

  const card = await ownerCard(taskId);
  expect(card?.status).toBe("running");
  expect(card?.pendingApprovalId).toBeNull();
  expect(await rowTenant("person.response", key)).toBe(owner);
  expect(
    (await ownerSide.inbox()).questions.map((entry) => entry.id),
  ).not.toContain(key);

  // Answered once: a second answer is refused and the card is not parked again by a later close.
  expect((await ownerSide.answer(key, "再答一次")).status).toBe(400);
  await board.finished({ tenantId: owner, runRef, onlyUnsettled: true });
  expect((await ownerCard(taskId))?.status).toBe("awaiting_review");
});

test("another tenant's answer is a 404 and the owner's card is unchanged", async () => {
  const { taskId, runRef, key } = await askingRun("stranger");
  await board.finished({ tenantId: owner, runRef });
  expect((await ownerCard(taskId))?.pendingApprovalId).toBe(key);

  const refused = await strangerSide.answer(key, "我来替你回答");
  expect(refused.status).toBe(404);
  // The stranger sees neither the question nor the card.
  expect(
    (await strangerSide.inbox()).questions.map((entry) => entry.id),
  ).not.toContain(key);
  expect(
    (await strangerSide.cards()).find((entry) => entry.id === taskId),
  ).toBeUndefined();
  // Nor can the stranger's frame park or close anything of the owner's by naming the run.
  expect(await questions.parkRun({ tenantId: stranger, runRef })).toBe(false);
  await board.finished({ tenantId: stranger, runRef, failed: true });

  const card = await ownerCard(taskId);
  expect(card?.status).toBe("needs_action");
  expect(card?.pendingApprovalId).toBe(key);
  expect(await rowTenant("person.response", key)).toBeUndefined();

  // The question is still the owner's to answer.
  expect((await ownerSide.answer(key, "main")).status).toBe(200);
  expect((await ownerCard(taskId))?.status).toBe("running");
});

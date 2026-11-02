import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  groupTaskRuns,
  tasks,
  users,
  wakerFlows,
  wakerGroups,
} from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Story WF4 (spec D10): a WakerFlow run is reviewed (查收) from the board, and the board's 打开 on
 * either of its cards — the run's parent card or a step's card — lands on the Flow, where the run's
 * steps, outputs and 停止 are. A crew run that no Flow started keeps opening its pipeline panel.
 *
 * The Flow id is the run row's own `flow_id`, read under the caller's tenant: a card cannot name a
 * Flow, and another workspace's run resolves to nothing.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `wf-open-${suite}`;
const stranger = `wf-open-stranger-${suite}`;
const TITLE = `wf-open-target-${suite}`;

const asActor =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  };

const projector = createTaskProjector(database);

type Open = { kind: string; id: string } | null;

/** The board's list, as `who` asks for it: card id → where its 打开 lands. */
async function openByTask(who: string): Promise<Map<string, Open>> {
  const routes = createTaskRoutes(database, asActor(who), projector);
  return runAsTenant(who, async () => {
    const response = await routes.request(
      new Request(`http://openbot.test/?q=${encodeURIComponent(TITLE)}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tasks: { id: string; open: Open; runRef: string | null }[];
    };
    return new Map(body.tasks.map((task) => [task.id, task.open]));
  });
}

const groupIds: Record<string, string[]> = { [tenant]: [], [stranger]: [] };

async function makeUser(id: string) {
  await runAsTenant(id, async () => {
    await database.insert(users).values({ id, email: `${id}@example.test` });
  });
}

/** A crew and a run of it, optionally started from a WakerFlow (the run row's own `flow_id`). */
async function makeRun(owner: string, flowId: string | null) {
  const groupId = randomUUID();
  const runId = randomUUID();
  groupIds[owner]?.push(groupId);
  await runAsTenant(owner, async () => {
    await database
      .insert(wakerGroups)
      .values({ id: groupId, tenantId: owner, name: "流程组" });
    await database.insert(groupTaskRuns).values({
      id: runId,
      tenantId: owner,
      groupId,
      status: "running",
      cursor: 1,
      steps: [],
      flowId,
    });
  });
  return runId;
}

async function makeFlow(owner: string) {
  const [row] = await runAsTenant(owner, async () =>
    database
      .insert(wakerFlows)
      .values({ tenantId: owner, name: "周会准备", idea: "帮我准备周会" })
      .returning({ id: wakerFlows.id }),
  );
  if (!row) throw new Error("flow not written");
  return row.id;
}

/** A run's parent card (run reference = the run id) and one step card hanging under it. */
async function cardsFor(owner: string, runId: string) {
  const parent = await projector.opened({
    tenantId: owner,
    title: `${TITLE} parent`,
    executorAgentId: null,
    source: "group_run",
    runRef: runId,
  });
  const step = await projector.opened({
    tenantId: owner,
    title: `${TITLE} step`,
    executorAgentId: null,
    source: "group_run",
    runRef: randomUUID(),
    parentTaskId: parent,
  });
  return { parent, step };
}

await makeUser(tenant);
await makeUser(stranger);

afterAll(async () => {
  for (const owner of [tenant, stranger]) {
    await runAsTenant(owner, async () => {
      await database.delete(tasks).where(eq(tasks.tenantId, owner));
      await database
        .delete(groupTaskRuns)
        .where(eq(groupTaskRuns.tenantId, owner));
      const ids = groupIds[owner] ?? [];
      if (ids.length > 0)
        await database.delete(wakerGroups).where(inArray(wakerGroups.id, ids));
      await database.delete(wakerFlows).where(eq(wakerFlows.tenantId, owner));
      await database.delete(users).where(eq(users.id, owner));
    });
  }
  await database.$client.end({ timeout: 5 });
});

test("a Flow run's parent card and its step card both open the Flow", async () => {
  const flowId = await makeFlow(tenant);
  const runId = await makeRun(tenant, flowId);
  const { parent, step } = await cardsFor(tenant, runId);

  const opened = await openByTask(tenant);
  expect(opened.get(parent)).toEqual({ kind: "wakerflow", id: flowId });
  expect(opened.get(step)).toEqual({ kind: "wakerflow", id: flowId });

  // The cards themselves are unchanged: the parent still carries the run, the step its parent.
  const rows = await runAsTenant(tenant, async () =>
    database
      .select({
        id: tasks.id,
        runRef: tasks.runRef,
        parentTaskId: tasks.parentTaskId,
      })
      .from(tasks)
      .where(inArray(tasks.id, [parent, step])),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  expect(byId.get(parent)?.runRef).toBe(runId);
  expect(byId.get(step)?.parentTaskId).toBe(parent);
});

test("a crew run no Flow started still opens its pipeline panel", async () => {
  const runId = await makeRun(tenant, null);
  const { parent, step } = await cardsFor(tenant, runId);

  const opened = await openByTask(tenant);
  expect(opened.get(parent)).toEqual({ kind: "pipeline", id: runId });
  expect(opened.get(step)).toEqual({ kind: "pipeline", id: runId });
});

test("a run whose Flow was deleted opens its pipeline panel rather than a page that is gone", async () => {
  const flowId = await makeFlow(tenant);
  const runId = await makeRun(tenant, flowId);
  const { parent, step } = await cardsFor(tenant, runId);
  expect((await openByTask(tenant)).get(parent)).toEqual({
    kind: "wakerflow",
    id: flowId,
  });

  // The Flow screen answers 404 for a deleted Flow, so the card must not point at it.
  await runAsTenant(tenant, async () => {
    await database
      .update(wakerFlows)
      .set({ deletedAt: new Date() })
      .where(eq(wakerFlows.id, flowId));
  });
  const opened = await openByTask(tenant);
  expect(opened.get(parent)).toEqual({ kind: "pipeline", id: runId });
  expect(opened.get(step)).toEqual({ kind: "pipeline", id: runId });
});

test("another workspace sees neither the cards nor the Flow behind them", async () => {
  const flowId = await makeFlow(tenant);
  const runId = await makeRun(tenant, flowId);
  const { parent, step } = await cardsFor(tenant, runId);

  const theirs = await openByTask(stranger);
  expect(theirs.has(parent)).toBe(false);
  expect(theirs.has(step)).toBe(false);
  for (const open of theirs.values()) {
    expect(open?.id).not.toBe(flowId);
    expect(open?.id).not.toBe(runId);
  }

  // A stranger's card that names this workspace's run by its id resolves to nothing, not to the Flow.
  const forged = await projector.opened({
    tenantId: stranger,
    title: `${TITLE} forged`,
    executorAgentId: null,
    source: "group_run",
    runRef: runId,
  });
  const strangerView = await openByTask(stranger);
  expect(strangerView.get(forged)).toBeNull();

  // …while the owner still opens the Flow, so the null above is refusal rather than absence.
  expect((await openByTask(tenant)).get(parent)).toEqual({
    kind: "wakerflow",
    id: flowId,
  });
});

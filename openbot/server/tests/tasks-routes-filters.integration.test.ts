import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/app-variables";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import type { TaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Spec §5 decision #2, at the seam the spec calls highest: the board's read side, queried the way the
 * screen queries it.
 *
 * The routes were already exercised for the model annotation (`model-library-routes.test.ts`), which is
 * why this file exists rather than a larger suite: what had no case were the filters themselves — status,
 * the crew list, and the deliberate empty-crew answer — and the archive transition that takes a card out
 * of a lane. Those are the assertions the spec names, so they are the ones written here.
 *
 * The projector is a stub. These three behaviours read and write the `tasks` table directly; building the
 * real one would mean wiring the whole event pipeline into a test whose subject is a query string.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const tenant = `w-${suite}`;
const dev = `${suite}-dev`;
const reviewer = `${suite}-reviewer`;
const outsider = `${suite}-outsider`;
/**
 * The period/device/search rows run under their own two coworker ids on purpose. Every case queries
 * the same tenant, so sharing an id with the crew case above would make that assertion depend on which
 * block inserted first — a filter test that fails because a later fixture reused a name is testing
 * file order, not the route.
 */
const historian = `${suite}-historian`;
const millwright = `${suite}-millwright`;

const actor = { id: tenant, role: "user" as const };
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const archived: string[] = [];
const projector = {
  archived: async (input: { taskId: string }) => {
    archived.push(input.taskId);
    return true;
  },
} as unknown as TaskProjector;

const routes = createTaskRoutes(database, requireUser, projector);

const get = (query: string) =>
  runAsTenant(tenant, async () => {
    const response = await routes.request(
      new Request(`http://openbot.test/${query}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tasks: { id: string; status: string; executorAgentId: string }[];
    };
    return body.tasks;
  });

const ids = await runAsTenant(tenant, async () => {
  const rows = await database
    .insert(tasks)
    .values([
      {
        title: "Broken build",
        executorAgentId: dev,
        source: "routine",
        status: "failed",
      },
      {
        title: "Live work",
        executorAgentId: reviewer,
        source: "chat",
        status: "running",
      },
      {
        title: "Someone else's",
        executorAgentId: outsider,
        source: "chat",
        status: "done",
      },
    ])
    .returning({ id: tasks.id });
  return rows.map((row) => row.id);
});

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, tenant));
  });
});

test("status narrows the list to what is in that state", async () => {
  const failed = await get("?status=failed");
  expect(failed.map((task) => task.id).sort()).toEqual([ids[0]].sort());
  expect(failed.every((task) => task.status === "failed")).toBe(true);
});

test("executors answers to a crew, and an empty crew is an answer rather than no filter", async () => {
  const crew = await get(`?executors=${dev},${reviewer}`);
  expect(crew.map((task) => task.id).sort()).toEqual([ids[0]!, ids[1]!].sort());

  // The documented edge: `?executors=` with nothing after it names a crew with nobody in it. Truthiness
  // would have ignored the parameter and returned every card — the opposite of what was asked.
  const nobody = await get("?executors=");
  expect(nobody).toEqual([]);
});

test("archiving a card goes through the projector and answers the lane", async () => {
  const response = await runAsTenant(tenant, () =>
    routes.request(
      new Request(`http://openbot.test/${ids[0]}/archive`, { method: "POST" }),
    ),
  );
  expect(response.status).toBe(200);
  expect(archived).toEqual([ids[0]]);
});

/*
 * The other three axes the screen exposes. Spec §5 names them as one decision, and they fail in
 * different ways: a period that is not applied shows last year's work next to today's, a device that
 * is ignored answers "what is running at home" with "what is running everywhere", and a search that
 * matches nothing still returns the whole board — which reads as the box being empty rather than as
 * the filter not running.
 */
const extras = await runAsTenant(tenant, async () => {
  const rows = await database
    .insert(tasks)
    .values([
      {
        title: "Last quarter's migration",
        executorAgentId: historian,
        source: "chat",
        status: "done",
        createdAt: new Date(Date.now() - 45 * 86400000),
      },
      {
        title: "Laptop work",
        executorAgentId: millwright,
        source: "routine",
        status: "running",
        deviceId: `dev-${suite}-laptop`,
      },
      {
        title: "Desktop work",
        executorAgentId: millwright,
        source: "routine",
        status: "running",
        deviceId: `dev-${suite}-desktop`,
      },
    ])
    .returning({ id: tasks.id });
  return rows.map((row) => row.id);
});

test("a period leaves out work older than the window", async () => {
  const every = await get("");
  expect(every.map((task) => task.id)).toContain(extras[0]);

  const month = await get("?period=month");
  expect(month.map((task) => task.id)).not.toContain(extras[0]);

  // The short window is the one a person uses to see what moved this week; a month of rows in it is
  // the same failure wearing a different label.
  const week = await get("?period=week");
  expect(week.map((task) => task.id)).not.toContain(extras[0]);
});

test("deviceId answers for one machine and not for the whole tenant", async () => {
  const laptop = await get(`?deviceId=dev-${suite}-laptop`);
  expect(laptop.map((task) => task.id).sort()).toEqual([extras[1]!].sort());
});

test("q narrows by title", async () => {
  const found = await get(`?q=${encodeURIComponent("Laptop")}`);
  expect(found.map((task) => task.id)).toEqual([extras[1]]);

  const nothing = await get("?q=not-a-title-anywhere");
  expect(nothing).toEqual([]);
});

test("the axes compose rather than overwrite each other", async () => {
  const composed = await get(
    `?source=routine&status=running&deviceId=dev-${suite}-desktop`,
  );
  expect(composed.map((task) => task.id)).toEqual([extras[2]]);
});

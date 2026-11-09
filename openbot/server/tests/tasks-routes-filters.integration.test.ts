import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  groupTaskRuns,
  tasks,
  wakerGroupMembers,
  wakerGroups,
} from "../src/db/schema";
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

const actor = {
  id: tenant,
  email: `${tenant}@example.test`,
  role: "user" as const,
};
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

const crewIds: string[] = [];

afterAll(async () => {
  await runAsTenant(tenant, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, tenant));
    // The runs and the roster follow their crew by cascade.
    for (const crewId of crewIds)
      await database.delete(wakerGroups).where(eq(wakerGroups.id, crewId));
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

/*
 * Spec A4/C2: 触发方式 as the screen asks for it. 自主工作 is two sources at once — a routine firing
 * and a responsibility firing — and that pair is also the board's 无人值守 filter, so `source=` takes a
 * comma list. Run in its own coworker ids, for the reason `historian` gives above, and next to a second
 * workspace holding the very same sources: the list is narrowed inside the caller's tenant, and a
 * neighbour's routine is never part of "my unattended work".
 */
const neighbour = `w-${suite}-neighbour`;
const steward = `${suite}-steward`;
const triggers = await runAsTenant(tenant, async () => {
  const rows = await database
    .insert(tasks)
    .values([
      {
        title: "Nightly digest",
        executorAgentId: steward,
        source: "routine",
        status: "done",
      },
      {
        title: "Inbox duty",
        executorAgentId: steward,
        source: "responsibility",
        status: "running",
      },
      {
        title: "Asked in chat",
        executorAgentId: steward,
        source: "chat",
        status: "running",
      },
      {
        title: "Passed along",
        executorAgentId: steward,
        source: "handoff",
        status: "running",
      },
    ])
    .returning({ id: tasks.id });
  return rows.map((row) => row.id);
});
const theirs = await runAsTenant(neighbour, async () => {
  const rows = await database
    .insert(tasks)
    .values([
      {
        title: "Their nightly digest",
        executorAgentId: steward,
        source: "routine",
        status: "done",
      },
      {
        title: "Their inbox duty",
        executorAgentId: steward,
        source: "responsibility",
        status: "running",
      },
    ])
    .returning({ id: tasks.id });
  return rows.map((row) => row.id);
});

/** The neighbour's own signed-in caller, so its read is a whole request of its own and not a borrowed one. */
const neighbourRoutes = createTaskRoutes(
  database,
  async (context, next) => {
    context.set("actor", { id: neighbour, email: `${neighbour}@example.test`, role: "user" as const });
    await next();
  },
  projector,
);

afterAll(async () => {
  await runAsTenant(neighbour, async () => {
    await database.delete(tasks).where(eq(tasks.tenantId, neighbour));
  });
});

test("source takes a comma list: 自主工作 is routine and responsibility, in this tenant only", async () => {
  const unattended = await get(
    `?executors=${steward}&source=routine,responsibility`,
  );
  expect(unattended.map((task) => task.id).sort()).toEqual(
    [triggers[0]!, triggers[1]!].sort(),
  );
  // The neighbour's rows match the same two sources and the same coworker id, and still are not here.
  for (const id of theirs) {
    expect(unattended.map((task) => task.id)).not.toContain(id);
  }
  // Without the coworker narrowing too: no row of another workspace rides in on a source match.
  const everyUnattended = await get("?source=routine,responsibility");
  for (const id of theirs) {
    expect(everyUnattended.map((task) => task.id)).not.toContain(id);
  }
  expect(everyUnattended.map((task) => task.id)).toEqual(
    expect.arrayContaining([triggers[0]!, triggers[1]!]),
  );

  // And the neighbour, asking the same question, sees only its own two.
  const theirView = await runAsTenant(neighbour, async () => {
    const response = await neighbourRoutes.request(
      new Request(
        `http://openbot.test/?executors=${steward}&source=routine,responsibility`,
      ),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { tasks: { id: string }[] }).tasks;
  });
  expect(theirView.map((task) => task.id).sort()).toEqual([...theirs].sort());
});

test("a single source still narrows to that one, and the list composes with status", async () => {
  const chat = await get(`?executors=${steward}&source=chat`);
  expect(chat.map((task) => task.id)).toEqual([triggers[2]]);

  const runningUnattended = await get(
    `?executors=${steward}&source=routine,responsibility&status=running`,
  );
  expect(runningUnattended.map((task) => task.id)).toEqual([triggers[1]]);
});

test("unknown sources are dropped, and a list that names nothing matches nothing", async () => {
  // An enum value Postgres does not know used to reach it as 22P02 — a 500 on a typed address.
  const mixed = await get(
    `?executors=${steward}&source=handoff,carrier-pigeon`,
  );
  expect(mixed.map((task) => task.id)).toEqual([triggers[3]]);

  expect(await get(`?executors=${steward}&source=carrier-pigeon`)).toEqual([]);
  expect(await get("?source=")).toEqual([]);
  expect(await get("?source=,,")).toEqual([]);
});

/*
 * Spec A4's Group choice. A crew run's parent card names no coworker (its executor is null), so a
 * filter that only matched the roster against `executor_agent_id` dropped the one card that stands for
 * the whole run, from the board and from its stat bar alike (both read this endpoint). `group=` is the
 * crew by id: its members' cards, its runs' parent cards, and those runs' step cards.
 */
test("group answers to a crew by id: its members' cards, its runs' parent cards and their steps", async () => {
  const crewId = randomUUID();
  crewIds.push(crewId);
  const member = `${suite}-crew-member`;
  const departed = `${suite}-crew-departed`;
  const stranger = `${suite}-crew-stranger`;
  const cards = await runAsTenant(tenant, async () => {
    await database
      .insert(wakerGroups)
      .values({ id: crewId, tenantId: tenant, name: `crew-${suite}` });
    await database
      .insert(wakerGroupMembers)
      .values({ groupId: crewId, agentId: member, position: "0" });
    const [parent] = await database
      .insert(tasks)
      .values({
        title: "The crew's ask",
        executorAgentId: null,
        source: "group_run",
        status: "running",
      })
      .returning({ id: tasks.id });
    const rows = await database
      .insert(tasks)
      .values([
        {
          title: "A member's own chat",
          executorAgentId: member,
          source: "chat",
          status: "done",
        },
        {
          // A step of this crew's run whose coworker has since left the crew.
          title: "A step by a coworker who left",
          executorAgentId: departed,
          source: "group_run",
          status: "done",
          parentTaskId: parent!.id,
        },
        {
          title: "Not the crew's",
          executorAgentId: stranger,
          source: "chat",
          status: "done",
        },
        {
          // Another ask with no coworker that is not one of this crew's runs.
          title: "Somebody else's parent",
          executorAgentId: null,
          source: "group_run",
          status: "running",
        },
      ])
      .returning({ id: tasks.id });
    await database
      .insert(groupTaskRuns)
      .values({ groupId: crewId, parentTaskId: parent!.id, steps: [] });
    return { parent: parent!.id, rows: rows.map((row) => row.id) };
  });

  const crew = await get(`?group=${crewId}`);
  expect(crew.map((task) => task.id).sort()).toEqual(
    [cards.parent, cards.rows[0]!, cards.rows[1]!].sort(),
  );
  // The stat bar's read is the same endpoint without status or words: the parent card counts there too.
  const summary = await get(`?period=all&group=${crewId}`);
  expect(summary.map((task) => task.id)).toContain(cards.parent);

  // A malformed id, and a crew id this workspace has no rows for, name nothing.
  expect(await get("?group=not-a-uuid")).toEqual([]);
  expect(await get(`?group=${randomUUID()}`)).toEqual([]);
});

test("executor answers to one coworker by its whole id, commas and all", async () => {
  // A package coworker's id may contain a comma; as `executors=` it would be split into two ids.
  const comma = `${suite}-pkg,with-comma`;
  const [card] = await runAsTenant(tenant, () =>
    database
      .insert(tasks)
      .values({
        title: "A package coworker's card",
        executorAgentId: comma,
        source: "chat",
        status: "done",
      })
      .returning({ id: tasks.id }),
  );
  const one = await get(`?executor=${encodeURIComponent(comma)}`);
  expect(one.map((task) => task.id)).toEqual([card!.id]);
});

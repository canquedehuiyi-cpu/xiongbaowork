import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import { taskArchives } from "../src/db/schema/task-archives";
import { createTaskProjector } from "../src/tasks/projector";
import { createTaskRoutes } from "../src/tasks/routes";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 007 acceptance (spec test decision #1): each fact moves the task it
 * mirrors the way the board expects, and the transitions that are not legal
 * (archiving a running task, reviewing a finished one) refuse.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const projector = createTaskProjector(database);
const suite = randomUUID().slice(0, 8);
const tenant = `t-${suite}`;
const agent = `agent-${suite}`;

test("a chat run opens a task and its approval parks it", async () => {
  const id = await projector.opened({
    tenantId: tenant,
    title: "整理本周用户反馈",
    executorAgentId: agent,
    source: "chat",
    channelRef: "chan-1",
    runRef: `run-${suite}`,
  });
  await projector.needsAction({
    tenantId: tenant,
    runRef: `run-${suite}`,
    approvalId: `ap-${suite}`,
  });
  const [row] = await runAsTenant(tenant, () =>
    database
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [id])),
  );
  expect(row.status).toBe("needs_action");
  expect(row.pendingApprovalId).toBe(`ap-${suite}`);
});

/*
 * The machine is recorded on the card, not looked up from it (ticket 017).
 *
 * A laptop that is later unpaired still has to be the machine the work happened on: the board's
 * `?machineId=` filter is a question about the past, and an answer that disappears when a device row
 * is deleted would be a different answer, not a missing one.
 */
test("a task remembers which machine it ran on, and one with no machine says so", async () => {
  const onMachine = await projector.opened({
    tenantId: tenant,
    title: "跑一遍分轨脚本",
    executorAgentId: agent,
    source: "chat",
    runRef: `run-device-${suite}`,
    deviceId: "studio-1",
  });
  const inCloud = await projector.opened({
    tenantId: tenant,
    title: "整理会议纪要",
    executorAgentId: agent,
    source: "chat",
    runRef: `run-cloud-${suite}`,
  });

  const rows = await runAsTenant(tenant, () =>
    database
      .select({ id: tasks.id, deviceId: tasks.deviceId })
      .from(tasks)
      .where(inArray(tasks.id, [onMachine, inCloud])),
  );
  expect(rows.find((row) => row.id === onMachine)?.deviceId).toBe("studio-1");
  expect(rows.find((row) => row.id === inCloud)?.deviceId).toBeNull();
});

/*
 * Story C2: an autonomous run's card says which trigger set it off, finer than its lane. Background
 * research is filed in the `routine` lane and marked `proactive`; a card that names no trigger keeps
 * the column null, which is what every card written before this read as.
 */
test("a proactive card persists its trigger source, and a card without one stays null", async () => {
  const proactive = await projector.opened({
    tenantId: tenant,
    title: "主动调研",
    executorAgentId: agent,
    source: "routine",
    triggerSource: "proactive",
    channelRef: "chan-1",
    runRef: `run-proactive-${suite}`,
  });
  const plain = await projector.opened({
    tenantId: tenant,
    title: "每日站会提醒",
    executorAgentId: agent,
    source: "routine",
    runRef: `run-plain-${suite}`,
  });

  const rows = await runAsTenant(tenant, () =>
    database
      .select({
        id: tasks.id,
        source: tasks.source,
        triggerSource: tasks.triggerSource,
        tenantId: tasks.tenantId,
        status: tasks.status,
      })
      .from(tasks)
      .where(inArray(tasks.id, [proactive, plain])),
  );
  expect(rows.find((row) => row.id === proactive)).toEqual({
    id: proactive,
    source: "routine",
    triggerSource: "proactive",
    tenantId: tenant,
    status: "running",
  });
  expect(rows.find((row) => row.id === plain)?.triggerSource).toBeNull();

  // Closing the card keeps what set it off.
  await projector.finished({
    tenantId: tenant,
    runRef: `run-proactive-${suite}`,
    failed: false,
  });
  const [closed] = await runAsTenant(tenant, () =>
    database
      .select({ status: tasks.status, triggerSource: tasks.triggerSource })
      .from(tasks)
      .where(inArray(tasks.id, [proactive])),
  );
  expect(closed).toEqual({
    status: "awaiting_review",
    triggerSource: "proactive",
  });
});

test("a decision resumes or fails the parked task, and finishing awaits review", async () => {
  await projector.resumed({
    tenantId: tenant,
    approvalId: `ap-${suite}`,
    failed: false,
  });
  // Re-read by runRef, which is the join the projector itself uses.
  let [row] = await runAsTenant(tenant, () =>
    database
      .select()
      .from(tasks)
      .where(inArray(tasks.runRef, [`run-${suite}`])),
  );
  expect(row.status).toBe("running");
  await projector.finished({
    tenantId: tenant,
    runRef: `run-${suite}`,
    deliverableRef: { file: "report.md" },
  });
  [row] = await runAsTenant(tenant, () =>
    database
      .select()
      .from(tasks)
      .where(inArray(tasks.runRef, [`run-${suite}`])),
  );
  expect(row.status).toBe("awaiting_review");
});

test("review closes it; archive and review refuse from the wrong lanes", async () => {
  const [row] = await runAsTenant(tenant, () =>
    database
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.runRef, [`run-${suite}`])),
  );
  expect(await projector.archived({ tenantId: tenant, taskId: row.id })).toBe(
    true,
  );
  expect(await projector.reviewed({ tenantId: tenant, taskId: row.id })).toBe(
    false,
  );
  const second = await projector.opened({
    tenantId: tenant,
    title: "running 不可归档",
    executorAgentId: agent,
    source: "routine",
    runRef: `run2-${suite}`,
  });
  expect(await projector.archived({ tenantId: tenant, taskId: second })).toBe(
    false,
  );
});

test("another tenant's scope sees none of it", async () => {
  const seen = await runAsTenant(`other-${suite}`, () =>
    database.select({ id: tasks.id }).from(tasks),
  );
  expect(seen).toEqual([]);
});

/*
 * Spec A5/A7: archiving a failure files it away without rewriting it. The card must keep reading
 * 已结束-失败 -- turning it into `done` would report a broken run as finished work -- so the archive
 * is a separate stamp, written once, in the card's own tenant.
 */
const failedCard = async (label: string) => {
  const runRef = `run-${label}-${suite}`;
  const id = await projector.opened({
    tenantId: tenant,
    title: `失败的任务 ${label}`,
    executorAgentId: agent,
    source: "routine",
    runRef,
  });
  await projector.finished({ tenantId: tenant, runRef, failed: true });
  return id;
};

const stampOf = (taskId: string) =>
  runAsTenant(tenant, () =>
    database.select().from(taskArchives).where(eq(taskArchives.taskId, taskId)),
  );

const statusOf = async (taskId: string) => {
  const [row] = await runAsTenant(tenant, () =>
    database
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId)),
  );
  return row?.status;
};

test("archiving a failure keeps it failed and stamps it in the card's own tenant", async () => {
  const id = await failedCard("archive");
  expect(await statusOf(id)).toBe("failed");
  expect(
    await projector.archived({
      tenantId: tenant,
      taskId: id,
      archivedBy: `person-${suite}`,
    }),
  ).toBe(true);
  expect(await statusOf(id)).toBe("failed");
  const stamps = await stampOf(id);
  expect(stamps).toHaveLength(1);
  expect(stamps[0]?.tenantId).toBe(tenant);
  expect(stamps[0]?.archivedBy).toBe(`person-${suite}`);
  expect(stamps[0]?.archivedAt).toBeInstanceOf(Date);
});

test("a second archive of the same failure is refused and leaves the first stamp alone", async () => {
  const id = await failedCard("twice");
  expect(
    await projector.archived({
      tenantId: tenant,
      taskId: id,
      archivedBy: `first-${suite}`,
    }),
  ).toBe(true);
  expect(
    await projector.archived({
      tenantId: tenant,
      taskId: id,
      archivedBy: `second-${suite}`,
    }),
  ).toBe(false);
  const stamps = await stampOf(id);
  expect(stamps).toHaveLength(1);
  expect(stamps[0]?.archivedBy).toBe(`first-${suite}`);
  expect(await statusOf(id)).toBe("failed");
});

test("another tenant cannot archive a failure it does not own", async () => {
  const id = await failedCard("stranger");
  expect(
    await projector.archived({ tenantId: `other-${suite}`, taskId: id }),
  ).toBe(false);
  expect(await stampOf(id)).toEqual([]);
  expect(await statusOf(id)).toBe("failed");
  // Nor did the stranger's scope gain a stamp of its own.
  const strangers = await runAsTenant(`other-${suite}`, () =>
    database.select().from(taskArchives).where(eq(taskArchives.taskId, id)),
  );
  expect(strangers).toEqual([]);
});

test("a card waiting on a person is refused, and nothing is stamped", async () => {
  const runRef = `run-parked-${suite}`;
  const id = await projector.opened({
    tenantId: tenant,
    title: "needs_action 不可归档",
    executorAgentId: agent,
    source: "chat",
    runRef,
  });
  await projector.needsAction({
    tenantId: tenant,
    runRef,
    approvalId: `ap-parked-${suite}`,
  });
  expect(await projector.archived({ tenantId: tenant, taskId: id })).toBe(
    false,
  );
  expect(await statusOf(id)).toBe("needs_action");
  expect(await stampOf(id)).toEqual([]);
});

/*
 * A stamp speaks for the failure it was written against, not for the card forever. A card that moves
 * again after it was filed away -- a re-run that fails afresh -- is a new failure: the board must ask
 * for it again (`archivedAt` back to null on `GET /`), and archiving it again must be accepted rather
 * than refused as "already archived". Read through the real list route so the join is what answers.
 */
const asOwner: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: `person-${suite}`,
    email: `person-${suite}@openbot.test`,
    role: "user",
  });
  await next();
};
const board = createTaskRoutes(database, asOwner, projector);

const boardCard = (taskId: string) =>
  runAsTenant(tenant, async () => {
    const response = await board.request(new Request("http://openbot.test/"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tasks: { id: string; status: string; archivedAt: string | null }[];
    };
    return body.tasks.find((task) => task.id === taskId);
  });

/** Wait until the clock has moved past now, so the next write is strictly later than the last. */
const nextMillisecond = async () => {
  const start = Date.now();
  while (Date.now() <= start) await new Promise((done) => setTimeout(done, 1));
};

test("a card that fails again after it was archived asks again, and can be archived again", async () => {
  const runRef = `run-again-${suite}`;
  const id = await projector.opened({
    tenantId: tenant,
    title: "再次失败的任务",
    executorAgentId: agent,
    source: "routine",
    runRef,
  });
  await projector.finished({ tenantId: tenant, runRef, failed: true });
  expect((await boardCard(id))?.archivedAt).toBeNull();

  expect(
    await projector.archived({
      tenantId: tenant,
      taskId: id,
      archivedBy: `first-${suite}`,
    }),
  ).toBe(true);
  const filed = await boardCard(id);
  expect(filed?.status).toBe("failed");
  expect(filed?.archivedAt).toEqual(expect.any(String));

  await nextMillisecond();
  await projector.finished({ tenantId: tenant, runRef, failed: true });
  const again = await boardCard(id);
  expect(again?.status).toBe("failed");
  expect(again?.archivedAt).toBeNull();

  expect(
    await projector.archived({
      tenantId: tenant,
      taskId: id,
      archivedBy: `second-${suite}`,
    }),
  ).toBe(true);
  const stamps = await stampOf(id);
  expect(stamps).toHaveLength(1);
  expect(stamps[0]?.archivedBy).toBe(`second-${suite}`);
  expect(stamps[0]?.tenantId).toBe(tenant);
  expect((await boardCard(id))?.archivedAt).toEqual(expect.any(String));
  // And that stamp is current, so a third archive is the same refusal as any second one.
  expect(await projector.archived({ tenantId: tenant, taskId: id })).toBe(
    false,
  );
});

afterAll(async () => {
  await runAsTenant(tenant, () => database.delete(tasks));
  await database.$client.close();
});

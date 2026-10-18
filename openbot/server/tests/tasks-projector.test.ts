import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { tasks } from "../src/db/schema";
import { createTaskProjector } from "../src/tasks/projector";
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

afterAll(async () => {
  await runAsTenant(tenant, () => database.delete(tasks));
});

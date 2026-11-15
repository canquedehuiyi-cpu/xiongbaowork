import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAcpRelay } from "../src/agents/acp/relay";
import { type AcpTurnRow, createAcpTurnStore } from "../src/agents/acp/turns";
import { createDatabase } from "../src/db/client";
import { acpTurns, users } from "../src/db/schema";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * 外部员工的轮次表（turns.ts）和它上面的路由（relay.ts），真库。
 * 每个用例用自己的租户，互不依赖先后。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAcpTurnStore(database);
const suite = `acp-${randomUUID().slice(0, 8)}`;
const people: string[] = [];

afterAll(async () => {
  await runAsTenant("platform", async () => {
    await database.delete(acpTurns).where(inArray(acpTurns.tenantId, people));
    await database.delete(users).where(inArray(users.id, people));
  });
  await database.$client.close();
});

async function person(): Promise<string> {
  const id = `${suite}-user-${randomUUID()}`;
  people.push(id);
  await runAsTenant(id, () =>
    database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: "ACP Turns Test" }),
  );
  return id;
}

const turnId = () => `turn-${randomUUID()}`;

async function enqueue(
  tenantId: string,
  lane: { agentId?: string; threadId?: string; deviceId?: string } = {},
): Promise<string> {
  const id = turnId();
  await store.enqueue({
    tenantId,
    agentId: lane.agentId ?? "agent-1",
    threadId: lane.threadId ?? "thread-1",
    deviceId: lane.deviceId ?? "laptop",
    turnId: id,
    prompt: [{ type: "text", text: id }],
  });
  return id;
}

const setStatus = (
  tenantId: string,
  id: string,
  status: AcpTurnRow["status"],
  lastSeq?: number,
) => store.setStatus(tenantId, id, status, lastSeq);

function relayFor(tenantId: string) {
  const started: AcpTurnRow[] = [];
  const logs: string[] = [];
  const relay = createAcpRelay({
    channel: {
      notify: () => true,
      isReachable: () => true,
      connectionOf: () => "conn-1",
    },
    turns: store,
    startQueuedTurn: async (row) => {
      started.push(row);
    },
    log: (message) => logs.push(message),
  });
  return {
    relay,
    started,
    logs,
    target: { tenantId, deviceId: "laptop" },
  };
}

describe("acp turn store", () => {
  test("enqueue is idempotent and reads are scoped to the tenant", async () => {
    const owner = await person();
    const stranger = await person();
    const id = await enqueue(owner);
    await store.enqueue({
      tenantId: owner,
      agentId: "agent-1",
      threadId: "thread-1",
      deviceId: "laptop",
      turnId: id,
      prompt: [{ type: "text", text: "again" }],
    });
    const row = await store.get(owner, id);
    expect(row?.status).toBe("queued");
    expect(row?.prompt).toEqual([{ type: "text", text: id }]);
    expect(await store.get(stranger, id)).toBeNull();
    expect(await store.claim(stranger, id)).toBeNull();
    expect((await store.get(owner, id))?.status).toBe("queued");
  });

  test("nextForThread is the oldest queued turn of the lane, and none while one of it is active", async () => {
    const owner = await person();
    const first = await enqueue(owner);
    const second = await enqueue(owner);
    const otherAgent = await enqueue(owner, { agentId: "agent-2" });
    expect(
      (await store.nextForThread(owner, "thread-1", "agent-1"))?.turnId,
    ).toBe(first);
    await setStatus(owner, first, "awaiting");
    expect(await store.nextForThread(owner, "thread-1", "agent-1")).toBeNull();
    // Another employee in the same group thread is its own lane.
    expect(
      (await store.nextForThread(owner, "thread-1", "agent-2"))?.turnId,
    ).toBe(otherAgent);
    await setStatus(owner, first, "done");
    expect(
      (await store.nextForThread(owner, "thread-1", "agent-1"))?.turnId,
    ).toBe(second);
  });

  test("a final status is never changed, and lastSeq only grows", async () => {
    const owner = await person();
    const id = await enqueue(owner);
    expect(await setStatus(owner, id, "running", 4)).toBeTrue();
    await store.recordSeq(owner, id, 2);
    expect((await store.get(owner, id))?.lastSeq).toBe(4);
    expect(await setStatus(owner, id, "interrupted", 7)).toBeTrue();
    expect(await setStatus(owner, id, "done")).toBeFalse();
    expect(await setStatus(owner, id, "running")).toBeFalse();
    const row = await store.get(owner, id);
    expect(row?.status).toBe("interrupted");
    expect(row?.lastSeq).toBe(7);
  });

  test("setStatus naming another tenant changes nothing", async () => {
    const owner = await person();
    const stranger = await person();
    const id = await enqueue(owner);
    expect(await setStatus(stranger, id, "done")).toBeFalse();
    // Whatever frame the caller is in, only the tenant it names.
    expect(
      await runAsTenant("platform", () =>
        store.setStatus(stranger, id, "done"),
      ),
    ).toBeFalse();
    expect((await store.get(owner, id))?.status).toBe("queued");
  });

  test("countQueued counts what the device has not taken yet", async () => {
    const owner = await person();
    const queued = await enqueue(owner);
    const sent = await enqueue(owner, { threadId: "thread-2" });
    const running = await enqueue(owner, { threadId: "thread-3" });
    await enqueue(owner, { agentId: "agent-2" });
    await setStatus(owner, sent, "sent");
    await setStatus(owner, running, "running");
    expect(await store.countQueued(owner, "agent-1")).toBe(2);
    await setStatus(owner, queued, "cancelled");
    expect(await store.countQueued(owner, "agent-1")).toBe(1);
  });

  test("queuedForDevice and activeForDevice list one device's turns, oldest first", async () => {
    const owner = await person();
    const a = await enqueue(owner);
    const b = await enqueue(owner, { threadId: "thread-2" });
    const elsewhere = await enqueue(owner, { deviceId: "desktop" });
    const busy = await enqueue(owner, { threadId: "thread-3" });
    await setStatus(owner, busy, "running");
    expect(
      (await store.queuedForDevice(owner, "laptop")).map((r) => r.turnId),
    ).toEqual([a, b]);
    expect(
      (await store.activeForDevice(owner, "laptop")).map((r) => r.turnId),
    ).toEqual([busy]);
    expect(
      (await store.queuedForDevice(owner, "desktop")).map((r) => r.turnId),
    ).toEqual([elsewhere]);
  });

  test("claim takes a queued turn once; unclaim puts a sent one back", async () => {
    const owner = await person();
    const id = await enqueue(owner);
    const [one, two] = await Promise.all([
      store.claim(owner, id),
      store.claim(owner, id),
    ]);
    expect([one?.status, two?.status].sort()).toEqual(
      ["sent", undefined].sort(),
    );
    await store.unclaim(owner, id);
    expect((await store.get(owner, id))?.status).toBe("queued");
    await setStatus(owner, id, "running");
    await store.unclaim(owner, id);
    expect((await store.get(owner, id))?.status).toBe("running");
  });

  test("openInLane is null for a lane this device never had", async () => {
    const owner = await person();
    const id = await enqueue(owner);
    expect(
      (await store.openInLane(owner, "laptop", "agent-1", "thread-1"))?.map(
        (r) => r.turnId,
      ),
    ).toEqual([id]);
    await setStatus(owner, id, "done");
    expect(
      await store.openInLane(owner, "laptop", "agent-1", "thread-1"),
    ).toEqual([]);
    expect(
      await store.openInLane(owner, "desktop", "agent-1", "thread-1"),
    ).toBeNull();
    expect(
      await store.openInLane(owner, "laptop", "agent-2", "thread-1"),
    ).toBeNull();
  });
});

describe("acp relay on the real store", () => {
  test("a frame for another tenant's turn is dropped", async () => {
    const owner = await person();
    const intruder = await person();
    const id = await enqueue(owner);
    await setStatus(owner, id, "running");
    const { relay, logs } = relayFor(intruder);
    const heard: unknown[] = [];
    relay.subscribe(id, (frame) => heard.push(frame));
    // The intruder's own device, same device id, frames naming the owner's turn.
    const from = { tenantId: intruder, deviceId: "laptop" };
    relay.fromRunner(from, {
      type: "acp.update",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: id,
      seq: 1,
      update: { sessionUpdate: "agent_message_chunk" },
    });
    relay.fromRunner(from, {
      type: "acp.turn.end",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: id,
      stopReason: "end_turn",
      interrupted: false,
    });
    relay.fromRunner(from, {
      type: "acp.inventory",
      instanceId: "x",
      turns: [],
      requestIds: [],
    });
    expect(await relay.drain(from)).toBeTrue();
    expect(heard).toEqual([]);
    expect(logs.length).toBe(2);
    const row = await store.get(owner, id);
    expect(row?.status).toBe("running");
    expect(row?.lastSeq).toBe(0);
  });

  test("resumeQueued starts queued turns per thread in creation order, one at a time per thread", async () => {
    const owner = await person();
    const { relay, started, target } = relayFor(owner);
    const first = await enqueue(owner);
    const second = await enqueue(owner);
    const third = await enqueue(owner);
    expect(await relay.resumeQueued(target)).toBe(1);
    expect(await relay.resumeQueued(target)).toBe(0);
    expect(started.map((row) => row.turnId)).toEqual([first]);
    expect((await store.get(owner, first))?.status).toBe("sent");
    const end = (id: string) => ({
      type: "acp.turn.end",
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: id,
      stopReason: "end_turn",
      interrupted: false,
    });
    // An end lets the thread's next turn go, without waiting for a heartbeat.
    relay.fromRunner(target, end(first));
    await relay.drain(target);
    await Bun.sleep(50);
    await relay.drain(target);
    expect(started.map((row) => row.turnId)).toEqual([first, second]);
    relay.fromRunner(target, end(second));
    await relay.drain(target);
    await Bun.sleep(50);
    await relay.drain(target);
    expect(started.map((row) => row.turnId)).toEqual([first, second, third]);
    expect((await store.get(owner, first))?.status).toBe("done");
  });

  test("a turn awaiting permission holds only its own lane", async () => {
    const owner = await person();
    const { relay, started, target } = relayFor(owner);
    const waiting = await enqueue(owner, { threadId: "thread-a" });
    await setStatus(owner, waiting, "awaiting");
    await enqueue(owner, { threadId: "thread-a" });
    const other = await enqueue(owner, { threadId: "thread-b" });
    expect(await relay.resumeQueued(target)).toBe(1);
    expect(started.map((row) => row.turnId)).toEqual([other]);
    // The other lane's turn runs while the first still waits.
    relay.fromRunner(target, {
      type: "acp.turn.ack",
      agentId: "agent-1",
      threadId: "thread-b",
      turnId: other,
    });
    expect(await relay.drain(target)).toBeTrue();
    expect((await store.get(owner, other))?.status).toBe("running");
    expect((await store.get(owner, waiting))?.status).toBe("awaiting");
    expect(await relay.resumeQueued(target)).toBe(0);
  });

  test("two threads on one device run in parallel", async () => {
    const owner = await person();
    const { relay, started, target } = relayFor(owner);
    const a1 = await enqueue(owner, { threadId: "thread-a" });
    await enqueue(owner, { threadId: "thread-a" });
    const b1 = await enqueue(owner, { threadId: "thread-b" });
    // A second employee in thread-a is its own lane too.
    const c1 = await enqueue(owner, {
      threadId: "thread-a",
      agentId: "agent-2",
    });
    expect(await relay.resumeQueued(target)).toBe(3);
    expect(started.map((row) => row.turnId).sort()).toEqual(
      [a1, b1, c1].sort(),
    );
  });
});

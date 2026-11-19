import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import {
  createDeviceQueue,
  QUEUE_ATTENTION_THRESHOLD,
  runnerQueueKind,
} from "../src/devices/queue";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ticket 018 acceptance: a machine that was away does not lose work, does not repeat it, and does not
 * have to be the same process that noticed it was gone.
 *
 * The queue is the deployment's existing durable one, so these tests drive it through the channel the
 * gateway dispatches over — the path an action actually takes — rather than poking the table.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createDeviceQueue(database);
const suite = randomUUID().slice(0, 8);
const tenant = `q-${suite}`;
const target = { tenantId: tenant, deviceId: "studio-1" };

function answeringSocket(frames: Record<string, unknown>[], fail = false) {
  const socket = {
    send(value: string) {
      const frame = JSON.parse(value) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type !== "action" || typeof frame.id !== "string") return;
      queueMicrotask(() => {
        channel.settle(target, {
          type: "result",
          id: frame.id,
          ok: !fail,
          ...(fail
            ? { error: "the folder is on an unmounted drive" }
            : { output: { exitCode: 0 } }),
        });
      });
    },
  };
  return socket;
}

let channel = createDeviceChannel({ queue });

const pending = () => queue.pending(target);
const waiting = async () =>
  runAsTenant(tenant, () =>
    database
      .select({ key: workItems.key })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, runnerQueueKind(target)),
          isNull(workItems.finishedAt),
        ),
      )
      .then((rows) => rows.map((row) => row.key)),
  );

/** A reconnect: the channel is rebuilt, as it is when a new server process takes the socket. */
function reconnect(options: { fail?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  channel = createDeviceChannel({ queue });
  channel.attach(target, answeringSocket(frames, options.fail));
  return frames;
}

test("an action for an absent machine waits, and the same action twice is one row", async () => {
  const first = await channel.dispatch<{ queued?: boolean }>(
    target,
    "exec",
    { command: "npm test" },
    undefined,
    "run-42",
  );
  expect(first).toMatchObject({ queued: true });
  expect(await pending()).toBe(1);

  // The caller retried the same work with the same key: nothing new is queued, and nothing will run
  // twice when the laptop opens.
  await channel.dispatch(
    target,
    "exec",
    { command: "npm test" },
    undefined,
    "run-42",
  );
  expect(await pending()).toBe(1);
  expect(await waiting()).toHaveLength(1);
});

test("reconnecting runs what waited, oldest first, and empties the backlog", async () => {
  await channel.dispatch(
    target,
    "exec",
    { command: "second" },
    undefined,
    "k-second",
  );
  await channel.dispatch(
    target,
    "exec",
    { command: "third" },
    undefined,
    "k-third",
  );
  expect(await pending()).toBe(3);

  const frames = reconnect();
  // Sending the third frame precedes its acknowledgement and the awaited queue.finish() write.
  // Wait for the durable backlog too, so the assertions cannot race that last database operation.
  await poll(async () => frames.length === 3 && (await pending()) === 0);

  expect(
    frames.map((frame) => (frame.payload as { command: string }).command),
  ).toEqual(["npm test", "second", "third"]);
  expect(await pending()).toBe(0);
  expect(await waiting()).toEqual([]);
});

test("one action the machine cannot do stops the drain with the rest still waiting", async () => {
  // Clear the backlog first, so this test describes a fresh queue rather than the last one's tail.
  await runAsTenant(tenant, () =>
    database
      .delete(workItems)
      .where(eq(workItems.kind, runnerQueueKind(target))),
  );
  // Nobody is connected: the previous test's socket belongs to the channel being replaced here.
  channel = createDeviceChannel({ queue });
  await channel.dispatch(
    target,
    "files.write",
    { path: "a.md" },
    undefined,
    "k-a",
  );
  await channel.dispatch(
    target,
    "exec",
    { command: "danger" },
    undefined,
    "k-b",
  );
  await channel.dispatch(
    target,
    "files.write",
    { path: "c.md" },
    undefined,
    "k-c",
  );

  const frames = reconnect({ fail: true });
  await poll(
    async () => frames.length >= 1 && (await queue.uncertain(target)) === 1,
  );
  // A machine that answers and then breaks is a thing to look at, not a reason to spend the ninety
  // actions behind it in the same broken state.
  expect(frames).toHaveLength(1);
  expect(await pending()).toBe(2);
  expect(await queue.uncertain(target)).toBe(1);
  const afterReconnect = reconnect();
  await poll(async () => (await queue.uncertain(target)) === 1);
  expect(afterReconnect).toHaveLength(0);
});

test("the backlog has a size at which it becomes somebody's decision", async () => {
  expect(QUEUE_ATTENTION_THRESHOLD).toBe(20);
  // What is waiting now is small and quiet; the constant is what the board compares against, and it
  // lives here so the screen and the queue cannot disagree about when a backlog is a problem.
  expect(await pending()).toBeLessThan(QUEUE_ATTENTION_THRESHOLD);
});

async function poll(
  done: () => boolean | Promise<boolean>,
  attempts = 80,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the queue never caught up");
}

afterAll(async () => {
  await runAsTenant(tenant, () =>
    database
      .delete(workItems)
      .where(eq(workItems.kind, runnerQueueKind(target))),
  );
  await database.$client.end({ timeout: 5 });
});

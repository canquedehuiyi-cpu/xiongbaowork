import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import { computerActionIdentity } from "../src/computer/action-identity";
import { personSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { createRunnerTransport } from "../src/computer/runner-transport";
import { createDatabase } from "../src/db/client";
import { threadRuns, threads, workItems } from "../src/db/schema";
import {
  createDeviceChannel,
  type DispatchTarget,
} from "../src/devices/channel";
import { createDeviceQueue, runnerQueueKind } from "../src/devices/queue";
import {
  createQueuedResultNotices,
  createThreadResultPoster,
  queuedResultRunId,
  queuedResultText,
} from "../src/devices/queued-results";
import { runAsTenant } from "../src/tenant/context";
import { PostgresAgentRunner } from "../src/threads/postgres-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A command a Bot queued for the person's away machine runs when the machine reconnects, and its
 * outcome is then told — once — in the conversation that asked for it, by that Bot.
 *
 * The real gateway, runner transport, device channel and queue carry the action; the real thread
 * runner (the one a person's chat turn runs through) writes the message, and PostgreSQL is where it
 * is read back from, in the owner's tenant frame and in another tenant's.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createDeviceQueue(database);
const runner = new PostgresAgentRunner(database);
const suite = randomUUID().slice(0, 8);
const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function poll(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await settle(20);
  }
  throw new Error("The condition was not met in time.");
}

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

/** One person, their Bot, and one conversation with that Bot holding a question and an answer. */
async function conversation(name: string) {
  const tenant = `qres-${name}-${suite}`;
  const botId = `qres-${name}-bot-${suite}`;
  const threadId = `qres-${name}-thread-${suite}`;
  await runAsTenant(tenant, async () => {
    await database.insert(threads).values({
      id: threadId,
      tenantId: tenant,
      agentId: botId,
      messagesSnapshot: [
        { id: `${threadId}-u1`, role: "user", content: "帮我跑一下测试" },
        {
          id: `${threadId}-a1`,
          role: "assistant",
          content: "你的电脑现在不在线，命令已排队。",
        },
      ],
    });
    await database.insert(threadRuns).values({
      id: `${threadId}-run-1`,
      tenantId: tenant,
      threadId,
      agentId: botId,
      eventCount: 0,
    });
  });
  return { tenant, botId, threadId };
}

/** The conversation as its owner's next turn would read it: the runner's store, in their frame. */
function messagesOf(tenant: string, threadId: string): Promise<Message[]> {
  return runAsTenant(tenant, async () => {
    await runner.hydrate();
    return runner.getThreadMessages(threadId);
  });
}

const notices = (messages: Message[]) =>
  messages.filter(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.startsWith("之前排队的"),
  );

/** A machine whose runner answers every action with `answer`, the way the real socket settles it. */
function machine(
  channel: ReturnType<typeof createDeviceChannel>,
  target: DispatchTarget,
  answer: Record<string, unknown>,
) {
  const frames: Record<string, unknown>[] = [];
  return {
    frames,
    attach: () =>
      channel.attach(target, {
        send(raw) {
          const frame = JSON.parse(raw) as Record<string, unknown>;
          frames.push(frame);
          if (frame.type !== "action") return;
          queueMicrotask(() =>
            channel.settle(target, { id: frame.id, ...answer }),
          );
        },
      }),
  };
}

/** A device-mode gateway whose coworker's machine is `target`, governed with no approval gate. */
function gatewayFor(
  channel: ReturnType<typeof createDeviceChannel>,
  target: DispatchTarget,
) {
  return createComputerGateway({
    provider: {
      name: "unused",
      isolation: "per-person",
      locate: async () => {
        throw new Error("A paired machine is never located through the provider.");
      },
      status: async (seat) => ({ botId: seat.botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    },
    transport: createRunnerTransport(channel),
    resolveDevice: async () => target,
    auditStore: { insert: async () => undefined },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  });
}

/** The Bot's `computer_run_command`, from inside its run in `threadId`, as the tool middleware calls it. */
function runCommand(
  gateway: ReturnType<typeof gatewayFor>,
  input: { tenant: string; botId: string; threadId: string },
  command: string,
) {
  const toolCallId = `${input.botId}-call-${randomUUID()}`;
  const context: ApprovalContinuation = {
    runId: `${input.threadId}-run-2`,
    threadId: input.threadId,
    toolCallId,
    toolName: "computer_run_command",
    args: { command },
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
  };
  return runAsTenant(input.tenant, () =>
    withApprovalContext(context, () =>
      computerActionIdentity.run(toolCallId, () =>
        gateway.runCommand(
          personSeat(input.tenant, input.botId),
          { id: input.tenant, userId: input.tenant },
          { command },
        ),
      ),
    ),
  );
}

function noticeOf(target: DispatchTarget) {
  return runAsTenant(target.tenantId, async () =>
    (
      await database
        .select({ key: workItems.key, payload: workItems.payload })
        .from(workItems)
        .where(
          and(
            eq(workItems.tenantId, target.tenantId),
            eq(workItems.kind, runnerQueueKind(target)),
          ),
        )
    ).map((row) => ({
      key: row.key.slice(`${runnerQueueKind(target)}:`.length),
      notice: (row.payload as Record<string, unknown>).notice as
        | { state?: string }
        | undefined,
      origin: (row.payload as Record<string, unknown>).origin,
    })),
  );
}

function deployment() {
  const results = createQueuedResultNotices({
    queue,
    post: createThreadResultPoster({ database, runner }),
  });
  const channel = createDeviceChannel({
    queue,
    afterFlush: (target) => results.announce(target),
  });
  return { channel, results };
}

test("a command queued for an away machine reports its result into the conversation that asked, once", async () => {
  const asked = await conversation("done");
  const target = { tenantId: asked.tenant, deviceId: "laptop" };
  const { channel, results } = deployment();
  const gateway = gatewayFor(channel, target);

  const queued = await runCommand(gateway, asked, "npm test");
  expect(queued).toMatchObject({ queued: true });
  expect(notices(await messagesOf(asked.tenant, asked.threadId))).toEqual([]);

  const laptop = machine(channel, target, {
    ok: true,
    output: {
      command: "npm test",
      exitCode: 3,
      stdout: "12 passed\nAPI_TOKEN=abc123verysecretvalue",
      stderr: "1 failed: login.test.ts",
      truncated: false,
      timedOut: false,
      elapsedMs: 900,
    },
  });
  laptop.attach();

  await poll(
    async () =>
      notices(await messagesOf(asked.tenant, asked.threadId)).length > 0,
  );
  const said = notices(await messagesOf(asked.tenant, asked.threadId));
  expect(said).toHaveLength(1);
  const text = String(said[0]?.content);
  expect(text).toContain("npm test");
  expect(text).toContain("退出码 3");
  expect(text).toContain("12 passed");
  expect(text).toContain("1 failed: login.test.ts");
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("abc123verysecretvalue");
  // The action ran once, on reconnect, and nothing was sent again to say so.
  expect(laptop.frames.filter((frame) => frame.type === "action")).toHaveLength(
    1,
  );

  await poll(
    async () => (await noticeOf(target))[0]?.notice?.state === "posted",
  );
  const [row] = await noticeOf(target);
  expect(row?.origin).toMatchObject({
    botId: asked.botId,
    actorId: asked.tenant,
    threadId: asked.threadId,
  });
  expect(row?.notice?.state).toBe("posted");
  // On record in PostgreSQL as a run of that Bot in that thread, not only in this process's memory.
  const runId = queuedResultRunId(target, row?.key ?? "");
  await poll(async () =>
    runAsTenant(asked.tenant, async () => {
      const [run] = await database
        .select({ threadId: threadRuns.threadId, agentId: threadRuns.agentId })
        .from(threadRuns)
        .where(eq(threadRuns.id, runId));
      return run?.threadId === asked.threadId && run.agentId === asked.botId;
    }),
  );
  await poll(async () =>
    runAsTenant(asked.tenant, async () => {
      const [stored] = await database
        .select({ messages: threads.messagesSnapshot })
        .from(threads)
        .where(eq(threads.id, asked.threadId));
      return notices((stored?.messages ?? []) as Message[]).length === 1;
    }),
  );

  // A second flush, a fresh reconnect and two replicas racing all find nothing left to tell.
  await channel.flush(target);
  const second = machine(createDeviceChannel({ queue }), target, { ok: true });
  second.attach();
  const replicas = await Promise.all([
    results.announce(target),
    deployment().results.announce(target),
  ]);
  expect(replicas).toEqual([0, 0]);
  await settle(100);
  expect(notices(await messagesOf(asked.tenant, asked.threadId))).toHaveLength(
    1,
  );
  expect(second.frames.filter((frame) => frame.type === "action")).toEqual([]);
});

test("two replicas told at once post the result once", async () => {
  const asked = await conversation("race");
  const target = { tenantId: asked.tenant, deviceId: "laptop" };
  // The machine drains on a channel that tells nobody, so the race below is the only telling.
  const quiet = createDeviceChannel({ queue });
  await runCommand(gatewayFor(quiet, target), asked, "ls");
  machine(quiet, target, {
    ok: true,
    output: { exitCode: 0, stdout: "a.txt", stderr: "" },
  }).attach();
  await poll(async () => (await queue.pending(target)) === 0);
  await poll(async () =>
    runAsTenant(asked.tenant, async () => {
      const [receipt] = await noticeOf(target);
      return (
        (await queue.receipt(target, receipt?.key ?? ""))?.state === "completed"
      );
    }),
  );

  const posted = await Promise.all([
    deployment().results.announce(target),
    deployment().results.announce(target),
    deployment().results.announce(target),
  ]);
  expect(posted.reduce((sum, value) => sum + value, 0)).toBe(1);
  const said = notices(await messagesOf(asked.tenant, asked.threadId));
  expect(said).toHaveLength(1);
  expect(String(said[0]?.content)).toContain("退出码 0");
  expect(String(said[0]?.content)).toContain("a.txt");
});

test("an outcome the machine never confirmed is reported as unknown, and the device as paused", async () => {
  const asked = await conversation("unknown");
  const target = { tenantId: asked.tenant, deviceId: "laptop" };
  const { channel } = deployment();
  await runCommand(gatewayFor(channel, target), asked, "rm -f build.log");
  machine(channel, target, {
    ok: false,
    error: "the folder is on an unmounted drive",
  }).attach();

  await poll(
    async () =>
      notices(await messagesOf(asked.tenant, asked.threadId)).length > 0,
  );
  const said = notices(await messagesOf(asked.tenant, asked.threadId));
  expect(said).toHaveLength(1);
  expect(String(said[0]?.content)).toContain("没有收到确认结果");
  expect(String(said[0]?.content)).toContain("暂停");
  expect((await queue.receipt(target, (await noticeOf(target))[0]?.key ?? ""))?.state).toBe(
    "unknown",
  );
});

test("a refused action and a non-command action read as what they are", () => {
  const origin = { botId: "b", actorId: "p", threadId: "t" };
  expect(
    queuedResultText({
      key: "k",
      action: "exec",
      payload: { command: "deploy --token=hunter2hunter2" },
      origin,
      receipt: { state: "failed" },
    }),
  ).toBe(
    "之前排队的命令 `deploy --token=[REDACTED]`被设备拒绝，没有执行。需要的话可以让我重新发起。",
  );
  expect(
    queuedResultText({
      key: "k",
      action: "files.write",
      payload: { path: "notes.md", contents: "secret body" },
      origin,
      receipt: { state: "completed", output: { bytes: 11 } },
    }),
  ).toBe(
    "之前排队的操作（files.write，`notes.md`）已在设备重新连上后执行完成。",
  );
  const long = queuedResultText({
    key: "k",
    action: "exec",
    payload: { command: "cat big.log" },
    origin,
    receipt: {
      state: "completed",
      output: { exitCode: 0, stdout: `${"x".repeat(5000)}\`\`\`end`, stderr: "" },
    },
  });
  expect(long).toContain("（已截断）");
  expect(long.length).toBeLessThan(2000);
  expect(long.split("```")).toHaveLength(3);
});

test("another tenant never sees the result, and a conversation that is not the asker's is never written", async () => {
  const asked = await conversation("owner");
  const other = await conversation("other");
  const target = { tenantId: asked.tenant, deviceId: "laptop" };
  const { channel } = deployment();
  await runCommand(gatewayFor(channel, target), asked, "whoami");
  /*
   * And one whose origin names the OTHER tenant's conversation, as a forged or confused thread id
   * would: it must not land there, or anywhere.
   */
  await runCommand(
    gatewayFor(channel, target),
    { ...asked, threadId: other.threadId },
    "hostname",
  );
  machine(channel, target, {
    ok: true,
    output: { exitCode: 0, stdout: "owner-only-output", stderr: "" },
  }).attach();
  await poll(async () => {
    const rows = await noticeOf(target);
    return (
      rows.length === 2 &&
      rows.every((row) => ["posted", "skipped"].includes(String(row.notice?.state)))
    );
  });
  const rows = await noticeOf(target);
  expect(rows.map((row) => row.notice?.state).sort()).toEqual([
    "posted",
    "skipped",
  ]);
  expect(notices(await messagesOf(asked.tenant, asked.threadId))).toHaveLength(1);

  // The other tenant: its own conversation is untouched, and the owner's reads as nothing at all.
  expect(notices(await messagesOf(other.tenant, other.threadId))).toEqual([]);
  expect(await messagesOf(other.tenant, asked.threadId)).toEqual([]);
  const visible = await runAsTenant(other.tenant, () =>
    database
      .select({ id: threadRuns.id })
      .from(threadRuns)
      .where(eq(threadRuns.threadId, asked.threadId)),
  );
  expect(visible).toEqual([]);
  // Its own device of the same name has nothing owed to it.
  expect(
    await queue.claimNotices(
      { tenantId: other.tenant, deviceId: "laptop" },
      randomUUID(),
    ),
  ).toEqual([]);
});

test("a conversation that is mid-run is not interrupted: the result waits and is posted after", async () => {
  const asked = await conversation("busy");
  const target = { tenantId: asked.tenant, deviceId: "laptop" };
  const quiet = createDeviceChannel({ queue });
  await runCommand(gatewayFor(quiet, target), asked, "date");
  machine(quiet, target, {
    ok: true,
    output: { exitCode: 0, stdout: "Fri", stderr: "" },
  }).attach();
  await poll(async () => (await queue.pending(target)) === 0);

  const real = createThreadResultPoster({ database, runner });
  let busy = true;
  const results = createQueuedResultNotices({
    queue,
    retryMs: 30,
    post: async (input) => (busy ? "busy" : real(input)),
  });
  expect(await results.announce(target)).toBe(0);
  // Handed back, not spent: the next telling can take it.
  expect((await noticeOf(target))[0]?.notice).toBeUndefined();
  busy = false;
  await poll(
    async () =>
      notices(await messagesOf(asked.tenant, asked.threadId)).length === 1,
  );
  await settle(100);
  expect(notices(await messagesOf(asked.tenant, asked.threadId))).toHaveLength(1);
  expect((await noticeOf(target))[0]?.notice?.state).toBe("posted");
});

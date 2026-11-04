import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createRunnerExecutor } from "../../runner/src/execute";
import { createActionJournal } from "../../runner/src/journal";
import { createDatabase } from "../src/db/client";
import {
  devicePairCodes,
  registeredDevices,
  revokedAccess,
  users,
  workItems,
} from "../src/db/schema";
import { createDeviceChannel } from "../src/devices/channel";
import { createDeviceQueue, runnerQueueKind } from "../src/devices/queue";
import { createDeviceRoutes } from "../src/devices/routes";
import {
  type RunnerSocketData,
  runnerClose,
  runnerMessage,
  runnerOpen,
} from "../src/devices/socket";
import { createDeviceStore } from "../src/devices/store";
import { TOOL_DISABLED } from "../src/approvals/policy";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalContinuation,
  ApprovalRefusedError,
  withApprovalContext,
} from "../src/approvals/types";
import { createComputerGateway } from "../src/computer/gateway";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createRunnerTransport } from "../src/computer/runner-transport";
import { computerActionIdentity } from "../src/computer/action-identity";
import { Database as Sqlite } from "bun:sqlite";
import { mkdir, stat } from "node:fs/promises";
import { runAsTenant } from "../src/tenant/context";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `device-safety-${randomUUID()}`;
const targets: { tenantId: string; deviceId: string }[] = [];
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "device-safety-"));
  roots.push(root);
  const target = { tenantId: `${suite}-${targets.length}`, deviceId: "studio" };
  targets.push(target);
  const execute = createRunnerExecutor(root);
  const item = {
    key: "append-once",
    action: "files.write",
    payload: { path: "proof.txt", contents: "one\n", append: true },
  };
  return { root, target, execute, item };
}

test("two online dispatches with one action identity append a real file once", async () => {
  const { root, target, execute, item } = await fixture();
  const channel = createDeviceChannel();
  let frames = 0;
  const connection = channel.attach(target, {
    send(value) {
      const frame = JSON.parse(value);
      frames += 1;
      expect(frame.key).toBe(item.key);
      void execute(frame).then((outcome) =>
        channel.settle(target, { id: frame.id, ...outcome }),
      );
    },
  });
  await Promise.all([
    channel.dispatch(target, item.action, item.payload, 1000, item.key),
    channel.dispatch(target, item.action, item.payload, 1000, item.key),
  ]);
  expect(frames).toBe(1);
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\n");
  await expect(
    channel.dispatch(
      target,
      item.action,
      { ...item.payload, contents: "different" },
      1000,
      item.key,
    ),
  ).rejects.toThrow("different request");
  channel.detach(connection);
});

test("durable online claims fence replicas and replay the recorded result after reconstruction", async () => {
  const { root, target, execute, item } = await fixture();
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return execute(item);
  };
  await Promise.all([
    createDeviceQueue(database).executeOnce(target, item, invoke, 1000),
    createDeviceQueue(database).executeOnce(target, item, invoke, 1000),
  ]);
  expect(calls).toBe(1);
  expect(
    await createDeviceQueue(database).executeOnce(target, item, invoke),
  ).toMatchObject({ ok: true });
  expect(calls).toBe(1);
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\n");
});

test("a lost acknowledgement leaves unknown work and never repeats a real append", async () => {
  const { root, target, execute, item } = await fixture();
  const queue = createDeviceQueue(database);
  await queue.enqueue(target, item);
  await queue.drain(target, "before-disconnect", async (action) => {
    await execute(action);
    throw new Error("reply lost after the write");
  });
  expect(await queue.receipt(target, item.key)).toMatchObject({
    state: "unknown",
  });
  expect(await queue.uncertain(target)).toBe(1);
  expect(
    await createDeviceQueue(database).drain(target, "after-restart", execute),
  ).toBe(0);
  await expect(
    createDeviceQueue(database).executeOnce(
      target,
      item,
      () => execute(item),
      1000,
    ),
  ).rejects.toThrow("may already have run");
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\n");
});

test("a crashed owner's expired durable claim is not a fresh action", async () => {
  const { target, item } = await fixture();
  const queue = createDeviceQueue(database);
  await queue.enqueue(target, item);
  await runAsTenant(target.tenantId, () =>
    database
      .update(workItems)
      .set({
        attempts: 1,
        claimedBy: "dead-process",
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(
        and(
          eq(workItems.tenantId, target.tenantId),
          eq(workItems.kind, runnerQueueKind(target)),
        ),
      ),
  );
  let calls = 0;
  await expect(
    createDeviceQueue(database).executeOnce(
      target,
      item,
      async () => {
        calls += 1;
        return "duplicate";
      },
      1000,
    ),
  ).rejects.toThrow("may already have run");
  expect(calls).toBe(0);
  expect(await queue.receipt(target, item.key)).toMatchObject({
    state: "unknown",
  });
});

test("unknown online outcomes block fresh identities across replicas until the owner reviews them", async () => {
  const { root, target, execute, item } = await fixture();
  const queue = createDeviceQueue(database);
  const actualDrain = queue.drain;
  let initialDrain = Promise.resolve(0);
  queue.drain = (...args) => (initialDrain = actualDrain(...args));
  const channel = createDeviceChannel({ queue });
  const journal = createActionJournal(join(root, "online-actions.sqlite"));
  let frames = 0;
  let firstFrameId = "";
  const connection = channel.attach(target, {
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type !== "action") return;
      frames += 1;
      firstFrameId ||= frame.id;
      void journal
        .execute("own-deployment/device", frame.key, frame, execute)
        .then((outcome) => {
          if (frame.key === item.key) return;
          channel.settle(target, { id: frame.id, ...outcome });
        });
    },
  });
  await initialDrain;
  await expect(
    channel.dispatch(target, item.action, item.payload, 1000, item.key),
  ).rejects.toThrow();
  expect(await queue.uncertain(target)).toBe(1);
  await expect(
    channel.dispatch(
      target,
      item.action,
      item.payload,
      1000,
      "fresh-model-toolcall",
    ),
  ).rejects.toThrow("paused");
  const replica = createDeviceQueue(database);
  await expect(
    replica.executeOnce(
      target,
      { ...item, key: "fresh-after-restart" },
      () => execute(item),
      1000,
    ),
  ).rejects.toThrow("paused");
  await expect(
    replica.enqueue(target, { ...item, key: "offline-fresh" }),
  ).rejects.toThrow("paused");
  expect(
    channel.settle(target, { id: firstFrameId, ok: true, output: {} }),
  ).toBeFalse();
  expect(frames).toBe(1);
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\n");

  await runAsTenant(target.tenantId, () =>
    database
      .insert(users)
      .values({
        id: target.tenantId,
        email: `${target.tenantId}@example.test`,
        name: "Owner",
      }),
  );
  const store = createDeviceStore(database);
  const code = await store.mintPairCode(target.tenantId);
  const registered = await store.redeemPairCode({
    code: code.code,
    deviceId: target.deviceId,
    name: "Own device",
    platform: "linux",
  });
  if (!registered) throw new Error("Own fixture pairing failed.");
  const app = (actorId: string) =>
    createDeviceRoutes(
      store,
      async (context, next) => {
        context.set("actor", { id: actorId, role: "user" });
        await next();
      },
      replica,
    );
  const path = `/${registered.device.id}/actions`;
  expect((await app("foreign-owner").request(path)).status).toBe(404);
  expect(
    (
      await app("foreign-owner").request(`${path}/review`, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(404);
  const records = await (await app(target.tenantId).request(path)).json();
  expect(records.actions).toHaveLength(1);
  expect(records.actions[0]).toMatchObject({
    key: item.key,
    action: item.action,
    payload: item.payload,
    review: null,
  });
  const reviewInput = {
    key: item.key,
    resolution: "checked_executed",
    note: "Checked proof.txt and stopped related commands.",
  };
  expect(
    (
      await app(target.tenantId).request(`${path}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reviewInput),
      })
    ).status,
  ).toBe(400);
  expect(await replica.uncertain(target)).toBe(1);
  const reviewed = await app(target.tenantId).request(`${path}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...reviewInput, confirmedChecked: true }),
  });
  expect(reviewed.status).toBe(200);
  expect(await reviewed.json()).toMatchObject({ paused: false, uncertain: 0 });
  expect((await replica.reviews(target))[0]?.review).toMatchObject({
    by: target.tenantId,
    resolution: "checked_executed",
  });
  await expect(
    replica.executeOnce(target, item, () => execute(item)),
  ).rejects.toThrow("may already have run");
  await channel.dispatch(
    target,
    item.action,
    item.payload,
    1000,
    "owner-approved-next-action",
  );
  expect(frames).toBe(2);
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\none\n");
  journal.close();
  channel.detach(connection);
}, 10000);

test("a simultaneous new action waits for the current receipt and stops when it becomes unknown", async () => {
  const { root, target, execute, item } = await fixture();
  const queue = createDeviceQueue(database);
  let firstWritten: () => void = () => {};
  const written = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  let loseReceipt: () => void = () => {};
  const lost = new Promise<void>((resolve) => {
    loseReceipt = resolve;
  });
  const first = queue
    .executeOnce(
      target,
      item,
      async () => {
        await execute(item);
        firstWritten();
        await lost;
        throw new Error("lost receipt");
      },
      1000,
    )
    .catch((error) => error);
  await written;
  let secondCalls = 0;
  const second = createDeviceQueue(database)
    .executeOnce(
      target,
      { ...item, key: "concurrent-new-identity" },
      async () => {
        secondCalls += 1;
        return execute(item);
      },
      1000,
    )
    .catch((error) => error);
  loseReceipt();
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toBeInstanceOf(Error);
  expect(secondCalls).toBe(0);
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\n");
});

test("the runner's local journal fences duplicates, another connection, and reconstruction", async () => {
  const { root, execute, item } = await fixture();
  const path = join(root, "actions.sqlite");
  const journal = createActionJournal(path);
  const second = createActionJournal(path);
  const action = { action: item.action, payload: item.payload };
  const results = await Promise.all([
    journal.execute("deployment/device", item.key, action, execute),
    second.execute("deployment/device", item.key, action, execute),
  ]);
  expect(results.some((r) => r.ok)).toBeTrue();
  journal.close();
  second.close();
  const restarted = createActionJournal(path);
  expect(
    await restarted.execute("deployment/device", item.key, action, execute),
  ).toMatchObject({ ok: true });
  expect(
    await restarted.execute(
      "deployment/device",
      "lost-reply",
      action,
      async (value) => {
        await execute(value);
        throw new Error("crash after write");
      },
    ),
  ).toMatchObject({ ok: false, outcomeUnknown: true });
  restarted.close();
  const again = createActionJournal(path);
  expect(
    await again.execute("deployment/device", "lost-reply", action, execute),
  ).toMatchObject({ ok: false, outcomeUnknown: true });
  again.close();
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\none\n");
});

test("a separate runner process dying after an append leaves a durable unknown receipt", async () => {
  const { root, execute, item } = await fixture();
  const path = join(root, "process-actions.sqlite");
  const journalModule = new URL("../../runner/src/journal.ts", import.meta.url)
    .pathname;
  const executorModule = new URL("../../runner/src/execute.ts", import.meta.url)
    .pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { createActionJournal } = await import(${JSON.stringify(journalModule)});
    const { createRunnerExecutor } = await import(${JSON.stringify(executorModule)});
    const journal = createActionJournal(${JSON.stringify(path)});
    const executor = createRunnerExecutor(${JSON.stringify(root)});
    await journal.execute('deployment/device', 'process-crash', ${JSON.stringify(item)}, async (action) => {
      await executor(action);
      process.exit(23);
    });
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(23);
  const recovered = createActionJournal(path);
  expect(
    await recovered.execute(
      "deployment/device",
      "process-crash",
      item,
      execute,
    ),
  ).toMatchObject({ ok: false, outcomeUnknown: true });
  recovered.close();
  expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("one\n");
});

test("real runner sockets stop after removal, credential rotation, ban, or owner deletion", async () => {
  for (const reason of ["remove", "rotate", "ban", "delete-owner"]) {
    const { target } = await fixture();
    const email = `${target.tenantId}@example.test`;
    await runAsTenant(target.tenantId, () =>
      database
        .insert(users)
        .values({ id: target.tenantId, email, name: reason }),
    );
    // This is a separate replica's channel: there is no local onRevoked callback to save the test.
    const store = createDeviceStore(database);
    const channel = createDeviceChannel({
      authorize: (t, version) => store.isRegistered(t, version),
      validationIntervalMs: 10,
    });
    const pair = async () => {
      const code = await store.mintPairCode(target.tenantId);
      const paired = await store.redeemPairCode({
        code: code.code,
        deviceId: target.deviceId,
        name: reason,
        platform: null,
      });
      if (!paired) throw new Error("Pairing failed.");
      return paired;
    };
    const first = await pair();
    const server = Bun.serve<RunnerSocketData>({
      port: 0,
      async fetch(request, server) {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        const owner = await store.deviceForToken(token);
        if (!owner) return new Response("Not a device", { status: 401 });
        if (server.upgrade(request, { data: { runner: owner } })) return;
        return new Response("Upgrade required", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          void runnerOpen(ws, store, channel).catch(() => ws.close(1008));
        },
        message: (ws, value) => {
          void runnerMessage(ws, store, channel, value).catch(() =>
            ws.close(1008),
          );
        },
        close: (ws) => runnerClose(ws, channel),
      },
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/?token=${first.token}`,
    );
    const messages: string[] = [];
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (e) => resolve(e.code)),
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (e) => {
        messages.push(String(e.data));
        if (String(e.data).includes("welcome")) resolve();
      });
      socket.addEventListener("error", () =>
        reject(new Error("Socket failed")),
      );
    });
    const pending = channel
      .dispatch(
        target,
        "files.write",
        { path: "not-executed" },
        1000,
        "during-revocation",
      )
      .then(
        () => "unexpected-success",
        (e: Error & { outcomeUnknown?: boolean }) => e,
      );
    // No executor is installed on this fixture socket, so no side effect is produced by this probe.
    if (reason === "remove")
      await store.remove(target.tenantId, first.device.id);
    if (reason === "rotate") await pair();
    if (reason === "ban")
      await runAsTenant("platform", () =>
        database.insert(revokedAccess).values({ email, revokedBy: suite }),
      );
    if (reason === "delete-owner")
      await runAsTenant("platform", () =>
        database.delete(users).where(eq(users.id, target.tenantId)),
      );
    await channel.validateConnections();
    expect(await closed).toBe(1008);
    expect(channel.isReachable(target)).toBeFalse();
    expect(await pending).toBeInstanceOf(Error);
    const before = messages.length;
    await expect(
      channel.dispatch(target, "files.write", {}, 1000, "after-revocation"),
    ).rejects.toBeInstanceOf(Error);
    expect(messages.length).toBe(before);
    expect(await store.deviceForToken(first.token)).toBeNull();
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/?token=${first.token}`))
        .status,
    ).toBe(401);
    channel.revoke(target);
    server.stop(true);
  }
});

/*
 * SEC1 (docs/specs/2026-11-02-sec1-employee-tool-permissions.md §6.3): the employee's settings drive
 * the gate in front of a paired machine. The real gateway, the real runner transport and device
 * channel, a real runner executor behind its real journal, and the real approval store: an action
 * the gate refuses or holds sends the runner no frame and leaves its journal empty, and an approved
 * one runs on the machine exactly once.
 */
async function governedRunner(
  options: { hostCommandsCap?: "allow" | "ask" | "never" } = {},
) {
  const { root, target } = await fixture();
  const botId = `${suite}-bot-${targets.length}`;
  await runAsTenant(target.tenantId, () =>
    database.insert(users).values({
      id: target.tenantId,
      email: `${target.tenantId}@example.test`,
      name: "Owner",
    }),
  );
  const store = createApprovalStore(database);
  const policy = store.policy;
  if (!policy) throw new Error("The approval store has no policy surface.");
  if (options.hostCommandsCap) {
    // The team row is written by an administrator's request (covered in
    // approvals-policy.integration); here only the value the gate reads is changed.
    const teamSettings = policy.teamSettings.bind(policy);
    policy.teamSettings = async () => ({
      ...(await teamSettings()),
      hostCommandsCap: options.hostCommandsCap as "allow" | "ask" | "never",
    });
  }
  const service = createApprovalService(store);
  const execute = createRunnerExecutor(root);
  const journalPath = join(root, "runner-actions.sqlite");
  const journal = createActionJournal(journalPath);
  const channel = createDeviceChannel();
  let frames = 0;
  const connection = channel.attach(target, {
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type !== "action") return;
      frames += 1;
      void journal
        .execute("sec1/device", frame.key ?? frame.id, frame, execute)
        .then((outcome) => channel.settle(target, { id: frame.id, ...outcome }));
    },
  });
  const gateway = createComputerGateway({
    provider: {
      name: "unused",
      isolation: "per-bot",
      locate: async () => {
        throw new Error("A paired machine is never located through the provider.");
      },
      status: async (id) => ({ botId: id, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    },
    transport: createRunnerTransport(channel),
    resolveDevice: async () => target,
    auditStore: { insert: async () => undefined },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    approvalGate: service.gate,
  });
  const context = (command: string): ApprovalContinuation => ({
    runId: `${botId}-run`,
    threadId: `${botId}-thread`,
    toolCallId: `${botId}-call-${command}`,
    toolName: "computer_run_command",
    args: { command },
    messages: [],
    state: {},
    context: [],
    forwardedProps: {},
    initiator: { kind: "routine", id: `${botId}-routine` },
  });
  const run = (command: string) =>
    runAsTenant(target.tenantId, () =>
      withApprovalContext(context(command), () =>
        computerActionIdentity.run(`${botId}-call-${command}`, () =>
          gateway.runCommand(
            botId,
            { id: target.tenantId, userId: target.tenantId },
            { command },
          ),
        ),
      ),
    );
  const journalRows = () => {
    const db = new Sqlite(journalPath, { readonly: true });
    try {
      return (
        db.query("SELECT count(*) AS n FROM actions").get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };
  return {
    root,
    target,
    botId,
    store,
    service,
    run,
    frames: () => frames,
    journalRows,
    close: () => {
      journal.close();
      channel.detach(connection);
    },
  };
}

test("SEC1: a runner command the employee disabled is refused at the gate; the runner gets no frame and its journal stays empty", async () => {
  const runner = await governedRunner();
  try {
    await runAsTenant(runner.target.tenantId, () =>
      runner.service.createRule(runner.target.tenantId, {
        botId: runner.botId,
        toolRef: "computer_run_command",
        effect: "*",
        scope: "*",
        behaviour: "deny",
      }),
    );
    await mkdir(join(runner.root, "keep"));
    const refused = await runner.run("rm -rf keep").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApprovalRefusedError);
    expect((refused as Error).message).toBe(TOOL_DISABLED);
    // A harmless command is refused just the same: the tool itself is off.
    await expect(runner.run("pwd")).rejects.toThrow(TOOL_DISABLED);
    expect(runner.frames()).toBe(0);
    expect(runner.journalRows()).toBe(0);
    expect((await stat(join(runner.root, "keep"))).isDirectory()).toBeTrue();
    // Nothing was opened for anybody to approve.
    expect(
      await runAsTenant(runner.target.tenantId, () =>
        runner.store.list(runner.target.tenantId),
      ),
    ).toEqual([]);
  } finally {
    runner.close();
  }
});

test("SEC1: a dangerous runner command waits for approval with no frame sent, then runs on the machine exactly once", async () => {
  const runner = await governedRunner();
  try {
    await mkdir(join(runner.root, "scratch"));
    await Bun.write(join(runner.root, "scratch", "data.txt"), "x");
    const held = await runner.run("rm -rf scratch").catch((error: unknown) => error);
    expect(held).toBeInstanceOf(HeadlessToolSuspension);
    expect(runner.frames()).toBe(0);
    expect(runner.journalRows()).toBe(0);
    expect((await stat(join(runner.root, "scratch"))).isDirectory()).toBeTrue();
    const [request] = await runAsTenant(runner.target.tenantId, () =>
      runner.store.list(runner.target.tenantId),
    );
    expect(request?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "dangerous_command",
    });
    // Asking again while it waits sends nothing either.
    await expect(runner.run("rm -rf scratch")).rejects.toBeInstanceOf(
      HeadlessToolSuspension,
    );
    expect(runner.frames()).toBe(0);
    await runAsTenant(runner.target.tenantId, () =>
      runner.service.decide(
        runner.target.tenantId,
        request?.id as string,
        "allow_once",
      ),
    );
    await expect(runner.run("rm -rf scratch")).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(runner.frames()).toBe(1);
    expect(runner.journalRows()).toBe(1);
    await expect(stat(join(runner.root, "scratch"))).rejects.toThrow();
    // The approval is spent: the same call again is not a second run.
    await runner.run("rm -rf scratch").catch(() => undefined);
    expect(runner.frames()).toBe(1);
  } finally {
    runner.close();
  }
});

test("SEC1: with the team's host-command cap at never, a runner command is refused before anything reaches the machine (D5)", async () => {
  const runner = await governedRunner({ hostCommandsCap: "never" });
  try {
    await expect(runner.run("ls")).rejects.toThrow("set to never run");
    expect(runner.frames()).toBe(0);
    expect(runner.journalRows()).toBe(0);
  } finally {
    runner.close();
  }
});

test("SEC1: with the cap at ask, a harmless runner command waits for approval and sends nothing (D5)", async () => {
  const runner = await governedRunner({ hostCommandsCap: "ask" });
  try {
    await expect(runner.run("ls")).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(runner.frames()).toBe(0);
    const [request] = await runAsTenant(runner.target.tenantId, () =>
      runner.store.list(runner.target.tenantId),
    );
    expect(request?.action.policy?.source).toBe("host_command_cap");
  } finally {
    runner.close();
  }
});

afterAll(async () => {
  for (const target of targets) {
    await runAsTenant(target.tenantId, async () => {
      await database
        .delete(workItems)
        .where(eq(workItems.tenantId, target.tenantId));
      await database
        .delete(registeredDevices)
        .where(eq(registeredDevices.tenantId, target.tenantId));
      await database
        .delete(devicePairCodes)
        .where(eq(devicePairCodes.tenantId, target.tenantId));
    });
    await runAsTenant("platform", async () => {
      await database
        .delete(revokedAccess)
        .where(eq(revokedAccess.email, `${target.tenantId}@example.test`));
      await database.delete(users).where(eq(users.id, target.tenantId));
    });
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await database.$client.end({ timeout: 5 });
});

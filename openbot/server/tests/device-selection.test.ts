import { describe, expect, test } from "bun:test";
import type { AuditStore } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import { createRunnerTransport } from "../src/computer/runner-transport";
import {
  createDeviceChannel,
  type DeviceChannel,
  DeviceOfflineError,
  type DispatchTarget,
  runnerAddress,
} from "../src/devices/channel";
import type { DeviceQueue, QueuedAction } from "../src/devices/queue";
import {
  computerProviderFor,
  createDeviceSelector,
  type DeviceCandidate,
} from "../src/devices/selection";

/**
 * Audit defect #12: device mode builds a gateway, picks a machine per task, and keeps work for a
 * machine that is away instead of throwing it.
 *
 * The queue here is an in-memory stand-in with the durable queue's contract; the durable one is
 * proven against Postgres in device-queue.test.ts. What is under test is the path an action takes to
 * it: selector → gateway → runner transport → channel.
 */
const ACTOR = { id: "owner-1" };
const ENFORCE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const TENANT = "tenant-1";

function memoryQueue() {
  const items = new Map<string, QueuedAction[]>();
  const keyOf = (target: DispatchTarget) =>
    `${target.tenantId}/${target.deviceId}`;
  const queue: DeviceQueue = {
    async enqueue(target, item) {
      const list = items.get(keyOf(target)) ?? [];
      if (list.some((queued) => queued.key === item.key)) return "already";
      list.push(item);
      items.set(keyOf(target), list);
      return "queued";
    },
    pending: async (target) => items.get(keyOf(target))?.length ?? 0,
    uncertain: async () => 0,
    reviews: async () => [],
    review: async () => false,
    receipt: async (target, key) =>
      items.get(keyOf(target))?.some((item) => item.key === key)
        ? { state: "waiting" }
        : null,
    executeOnce: (_target, _item, execute) => execute(),
    async drain(target, _owner, execute) {
      const list = items.get(keyOf(target)) ?? [];
      let ran = 0;
      while (list.length > 0) {
        const item = list[0] as QueuedAction;
        await execute(item);
        list.shift();
        ran += 1;
      }
      return ran;
    },
    claimNotices: async () => [],
    settleNotice: async () => false,
  };
  return { queue, items };
}

/** A runner's socket that answers every action it is sent. */
function answeringSocket(
  channel: () => DeviceChannel,
  target: DispatchTarget,
  frames: Record<string, unknown>[],
) {
  return {
    send(value: string) {
      const frame = JSON.parse(value) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type !== "action" || typeof frame.id !== "string") return;
      const id = frame.id;
      queueMicrotask(() => {
        channel().settle(target, {
          type: "result",
          id,
          ok: true,
          output: { exitCode: 0, stdout: target.deviceId, stderr: "" },
        });
      });
    },
  };
}

function selectorFor(
  devices: DeviceCandidate[],
  reachable: (target: DispatchTarget) => boolean,
) {
  return createDeviceSelector({
    ownerOf: async (botId) => (botId.startsWith("bot-") ? TENANT : null),
    devicesOf: async (tenantId) => (tenantId === TENANT ? devices : []),
    isReachable: reachable,
  });
}

describe("device mode builds a computer gateway", () => {
  test("with no container configured, device mode still gets a provider and a working gateway", async () => {
    expect(computerProviderFor("cloud", undefined)).toBeUndefined();
    const provider = computerProviderFor("device", undefined);
    expect(provider?.name).toBe("device");
    // A configured container is kept: device mode only adds what was missing.
    const container = { name: "docker" } as unknown as ComputerProvider;
    expect(computerProviderFor("device", container)).toBe(container);

    const channel = createDeviceChannel();
    const target = { tenantId: TENANT, deviceId: "studio-1" };
    const frames: Record<string, unknown>[] = [];
    channel.attach(
      target,
      answeringSocket(() => channel, target, frames),
    );
    const selector = selectorFor(
      [{ deviceId: "studio-1", online: true }],
      (t) => channel.isReachable(t),
    );
    const fetched: string[] = [];
    const audit: AuditStore = { insert: async () => undefined };
    const gateway = createComputerGateway({
      provider: provider as ComputerProvider,
      auditStore: audit,
      policy: () => ENFORCE,
      transport: createRunnerTransport(channel),
      resolveDevice: (botId) => selector.forBot(botId),
      fetchImpl: (async (url: string) => {
        fetched.push(String(url));
        return new Response("{}", { status: 500 });
      }) as unknown as typeof fetch,
    });
    const result = await gateway.runCommand(personSeat(ACTOR.id, "bot-1"), ACTOR, {
      command: "pwd",
    });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(frames.map((frame) => frame.action)).toEqual(["exec"]);
    expect(fetched).toEqual([]);
    // The lifecycle answers are truthful for a machine the deployment does not host.
    expect(await gateway.status(personSeat(ACTOR.id, "bot-1"))).toMatchObject({ state: "absent" });
  });
});

describe("each task picks its own machine", () => {
  test("concurrent tasks spread over the reachable machines and each keeps its pick", async () => {
    const devices = [
      { deviceId: "laptop", online: true },
      { deviceId: "desktop", online: true },
    ];
    const selector = selectorFor(devices, () => true);
    const first = await selector.forTask("bot-1", "run-a");
    const second = await selector.forTask("bot-2", "run-b");
    expect(first.deviceId).not.toBe(second.deviceId);
    // Asked again, a task answers with the machine it already picked.
    expect((await selector.forTask("bot-1", "run-a")).deviceId).toBe(
      first.deviceId,
    );
    // The Bot's actions follow the task it most recently started.
    expect((await selector.forBot("bot-2")).deviceId).toBe(second.deviceId);
    expect((await selector.forBot("bot-1")).deviceId).toBe(first.deviceId);
  });

  test("a reachable machine is preferred over one that is away", async () => {
    const selector = selectorFor(
      [
        { deviceId: "away", online: false },
        { deviceId: "here", online: true },
      ],
      (target) => target.deviceId === "here",
    );
    expect((await selector.forTask("bot-1", "run-1")).deviceId).toBe("here");
  });

  test("a task stays on its machine when it goes away, and moves only when it is unpaired", async () => {
    const devices = [{ deviceId: "laptop", online: true }];
    let reachable = true;
    const selector = selectorFor(devices, () => reachable);
    expect((await selector.forTask("bot-1", "run-1")).deviceId).toBe("laptop");
    devices.push({ deviceId: "desktop", online: true });
    reachable = false;
    expect((await selector.forTask("bot-1", "run-1")).deviceId).toBe("laptop");
    devices.splice(0, 1);
    expect((await selector.forTask("bot-1", "run-1")).deviceId).toBe("desktop");
  });

  test("a tenant with no paired machine is refused, and a Bot with no tenant too", async () => {
    const selector = selectorFor([], () => false);
    await expect(selector.forTask("bot-1", "run-1")).rejects.toThrow(
      "no paired machine",
    );
    await expect(selector.forBot("stray")).rejects.toThrow(
      "does not belong to a tenant",
    );
  });
});

describe("a machine that is away", () => {
  test("a browser action is refused as offline, not queued to run later on a stale page", async () => {
    const { queue, items } = memoryQueue();
    const channel = createDeviceChannel({ queue });
    const target = { tenantId: TENANT, deviceId: "laptop" };
    const transport = createRunnerTransport(channel);
    await expect(
      transport.navigate(
        runnerAddress(target),
        "bot-1",
        "https://example.test",
      ),
    ).rejects.toBeInstanceOf(DeviceOfflineError);
    expect(items.get(`${TENANT}/laptop`) ?? []).toEqual([]);
  });

  test("its work is queued rather than thrown, and runs when it reconnects", async () => {
    const { queue, items } = memoryQueue();
    const channel = createDeviceChannel({ queue });
    const target = { tenantId: TENANT, deviceId: "laptop" };
    const selector = selectorFor([{ deviceId: "laptop", online: false }], (t) =>
      channel.isReachable(t),
    );
    const gateway = createComputerGateway({
      provider: computerProviderFor("device", undefined) as ComputerProvider,
      auditStore: { insert: async () => undefined },
      policy: () => ENFORCE,
      transport: createRunnerTransport(channel),
      resolveDevice: (botId) => selector.forBot(botId),
    });

    const result = await gateway.runCommand(personSeat(ACTOR.id, "bot-1"), ACTOR, {
      command: "make report",
    });
    expect(result).toMatchObject({ queued: true });
    expect(items.get(`${TENANT}/laptop`)?.map((item) => item.action)).toEqual([
      "exec",
    ]);

    // The runner dials back in: what waited is carried to it, and the backlog empties.
    const frames: Record<string, unknown>[] = [];
    // `attach` starts the drain itself; nothing else asks for it here.
    channel.attach(
      target,
      answeringSocket(() => channel, target, frames),
    );
    for (let turn = 0; turn < 50 && (await queue.pending(target)) > 0; turn++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(frames.map((frame) => frame.action)).toEqual(["exec"]);
    expect(
      (frames[0]?.payload as { command?: string } | undefined)?.command,
    ).toBe("make report");
    expect(await queue.pending(target)).toBe(0);
  });
});

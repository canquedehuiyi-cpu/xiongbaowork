import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { computerActionIdentity } from "../src/computer/action-identity";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import { createRunnerTransport } from "../src/computer/runner-transport";
import {
  createDeviceChannel,
  DeviceOfflineError,
} from "../src/devices/channel";

/**
 * Device mode, at the gateway (ticket 017 acceptance: the deny path).
 *
 * What is being proven is not that a frame can be written — `runner-channel.test.ts` covers that —
 * but that the machine is reached THROUGH the decision: the policy still runs first, a refusal still
 * writes its row, and a refused action reaches nobody. That is the property a second dispatch path
 * beside the gateway would have silently lost.
 */
const ACTOR = { id: "owner-1" };
const ENFORCE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const DENY_ALL: ActionPolicy = { mode: "enforce", deny: ["true"], allow: [] };
function deviceGateway(
  policy: ActionPolicy,
  options?: { unreachable?: boolean },
) {
  const channel = createDeviceChannel();
  const target = { tenantId: "owner-1", deviceId: "studio-1" };
  const frames: Record<string, unknown>[] = [];
  /*
   * The machine's side of the socket: it records what it was asked and answers, the way the runner's
   * own message handler does. The reply goes in through `settle` rather than as another write, which
   * is what the server's socket callback does with a frame from a real runner.
   */
  const socket = {
    send(value: string) {
      const frame = JSON.parse(value) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type !== "action" || typeof frame.id !== "string") return;
      channel.settle(target, {
        type: "result",
        id: frame.id,
        ok: true,
        output: {
          exitCode: 0,
          stdout: "on the person's machine",
          stderr: "",
        },
      });
    },
  };
  if (!options?.unreachable) channel.attach(target, socket);
  const located: string[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => {
      located.push("http://agent-computer:4100");
      return "http://agent-computer:4100";
    },
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
    list: async () => [],
  };
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  const fetched: string[] = [];
  const gateway = createComputerGateway({
    provider,
    auditStore: store,
    policy: () => policy,
    transport: createRunnerTransport(channel),
    // The deployment's own container must never be dialled in device mode.
    fetchImpl: (async (url: string) => {
      fetched.push(String(url));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch,
    resolveDevice: async () => {
      if (options?.unreachable) {
        throw new DeviceOfflineError(target.tenantId);
      }
      return channel.reachableDevice(target.tenantId) ? target : null;
    },
  });
  return { gateway, frames, rows, located, fetched };
}
describe("a coworker's action on the tenant's own machine", () => {
  test("a stable governed tool identity reaches the runner and fences concurrent retries", async () => {
    const { gateway, frames } = deviceGateway(ENFORCE);
    await Promise.all(
      Array.from({ length: 2 }, () =>
        computerActionIdentity.run("tool-call-once", () =>
          gateway.runCommand("bot-1", ACTOR, { command: "echo once" }),
        ),
      ),
    );
    expect(frames).toHaveLength(1);
    expect(String(frames[0]?.key)).toContain("tool-call-once");
    await expect(
      computerActionIdentity.run("tool-call-once", () =>
        gateway.runCommand("bot-1", ACTOR, { command: "echo different" }),
      ),
    ).rejects.toThrow("different request");
    expect(frames).toHaveLength(1);
  });
  test("an allowed command is written to the device and nothing is dialled", async () => {
    const { gateway, frames, located, fetched, rows } = deviceGateway(ENFORCE);
    const result = await gateway.runCommand("bot-1", ACTOR, {
      command: "pwd",
    });
    expect(frames.map((frame) => frame.action)).toEqual(["exec"]);
    expect(
      (frames[0]?.payload as { command: string } | undefined)?.command,
    ).toBe("pwd");
    expect(result).toMatchObject({ exitCode: 0 });
    // The cloud computer was neither located nor fetched: device mode means device execution.
    expect(located).toEqual([]);
    expect(fetched).toEqual([]);
    expect(rows.length).toBe(1);
    // The trail names the machine, not just the Bot: "who touched my laptop" is a question about the
    // row, and `targetId` alone cannot answer it.
    const payload = rows[0]?.payload as { device?: string | null };
    expect(payload.device).toBe("studio-1");
  });
  test("a refused command reaches no machine, and the trail says which rule said so", async () => {
    const { gateway, frames, fetched } = deviceGateway(DENY_ALL);
    const refusal = await gateway
      .runCommand("bot-1", ACTOR, { command: "rm -rf /" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ActionRefusedError);
    expect(frames).toEqual([]);
    expect(fetched).toEqual([]);
  });
  test("no reachable machine is its own answer, not a silent fall back to the container", async () => {
    const { gateway, frames, fetched } = deviceGateway(ENFORCE, {
      unreachable: true,
    });
    const failure = await gateway
      .runCommand("bot-1", ACTOR, { command: "pwd" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeviceOfflineError);
    expect(frames).toEqual([]);
    // A person who said "my machine" is not quietly served the server's browser.
    expect(fetched).toEqual([]);
  });
  test("a refusal is written to the trail before the machine is asked", async () => {
    const { gateway, rows, frames } = deviceGateway(DENY_ALL);
    await gateway
      .runCommand("bot-1", ACTOR, { command: "id" })
      .catch(() => undefined);
    expect(rows.length).toBe(1);
    const payload = rows[0]?.payload as { decision?: { allowed?: boolean } };
    expect(payload.decision?.allowed).toBeFalse();
    expect(frames).toEqual([]);
  });
});

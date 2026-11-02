import { ComputerUnavailableError } from "../computer/client";
import type { ComputerProvider } from "../computer/provider";
import type { DispatchTarget } from "./channel";

/**
 * Which of a tenant's machines a piece of work runs on, in device mode (audit defect #12).
 *
 * The earlier answer was "whichever socket this process happens to hold first", asked afresh on every
 * action and refused outright when there was none. That made one machine the tenant's only machine,
 * let consecutive actions of one task land on different machines, and threw away work the queue
 * (ticket 018) exists to keep for a machine that is away.
 *
 * Here a task picks once and keeps its pick: a reachable machine first, the least busy of those, then
 * one the screen calls online, then the most recently seen registered one. A pick that is offline is
 * still a pick — the channel queues for it and drains when it reconnects. Only a tenant with no
 * registered machine at all is refused, because there is nobody to queue for.
 */

export type DeviceCandidate = { deviceId: string; online: boolean };

export type DeviceSelectorOptions = {
  /** The tenant a Bot belongs to, or null. */
  ownerOf: (botId: string) => Promise<string | null>;
  /** The tenant's registered machines, most recently seen first (the device store's own order). */
  devicesOf: (tenantId: string) => Promise<DeviceCandidate[]>;
  /** Whether a frame can be written to this machine from this process right now. */
  isReachable: (target: DispatchTarget) => boolean;
  now?: () => number;
  /** How long a task keeps its machine without being asked about again. */
  pinTtlMs?: number;
  /** A ceiling on remembered picks, so a long-lived process does not grow without bound. */
  maxPins?: number;
};

export type DeviceSelector = {
  /** The machine for one task, chosen on first ask and the same one for every later ask. */
  forTask: (botId: string, taskRef: string) => Promise<DispatchTarget>;
  /** The machine for an action of this Bot: the one its latest task picked, else its own default. */
  forBot: (botId: string) => Promise<DispatchTarget>;
};

const DEFAULT_PIN_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_PINS = 10_000;

type Pin = { tenantId: string; deviceId: string; at: number };

export function createDeviceSelector(
  options: DeviceSelectorOptions,
): DeviceSelector {
  const now = options.now ?? Date.now;
  const ttl = options.pinTtlMs ?? DEFAULT_PIN_TTL_MS;
  const maxPins = options.maxPins ?? DEFAULT_MAX_PINS;
  /** `tenant/taskRef` → the machine that task picked. Insertion order is age order. */
  const pins = new Map<string, Pin>();
  /** Bot → the key of the task it most recently started. */
  const latestTask = new Map<string, string>();

  const fresh = (pin: Pin | undefined) =>
    pin !== undefined && now() - pin.at < ttl;

  const prune = () => {
    for (const [key, pin] of pins) {
      if (pins.size <= maxPins && fresh(pin)) break;
      pins.delete(key);
    }
  };

  const load = (tenantId: string, deviceId: string) => {
    let count = 0;
    for (const pin of pins.values()) {
      if (pin.tenantId === tenantId && pin.deviceId === deviceId && fresh(pin))
        count += 1;
    }
    return count;
  };

  const choose = (tenantId: string, devices: DeviceCandidate[]) => {
    const rank = (device: DeviceCandidate) =>
      options.isReachable({ tenantId, deviceId: device.deviceId })
        ? 0
        : device.online
          ? 1
          : 2;
    const ordered = devices
      .map((device, index) => ({
        device,
        index,
        rank: rank(device),
        load: load(tenantId, device.deviceId),
      }))
      .sort((a, b) => a.rank - b.rank || a.load - b.load || a.index - b.index);
    return ordered[0]?.device.deviceId ?? null;
  };

  const pick = async (botId: string, taskRef: string) => {
    const tenantId = await options.ownerOf(botId);
    if (!tenantId) {
      throw new ComputerUnavailableError(
        `${botId} does not belong to a tenant with machines of its own.`,
      );
    }
    const key = `${tenantId}/${taskRef}`;
    const devices = await options.devicesOf(tenantId);
    const pinned = pins.get(key);
    // A task stays on its machine while that machine is still registered, online or not: work for an
    // absent machine waits for it rather than moving to another one halfway through.
    if (
      pinned &&
      fresh(pinned) &&
      devices.some((device) => device.deviceId === pinned.deviceId)
    ) {
      return { key, target: { tenantId, deviceId: pinned.deviceId } };
    }
    pins.delete(key);
    const deviceId = choose(tenantId, devices);
    if (!deviceId) {
      throw new ComputerUnavailableError(
        "This workspace has no paired machine to carry out the work on. Pair one from the Devices page.",
      );
    }
    pins.set(key, { tenantId, deviceId, at: now() });
    prune();
    return { key, target: { tenantId, deviceId } };
  };

  return {
    async forTask(botId, taskRef) {
      const { key, target } = await pick(botId, `task:${taskRef}`);
      latestTask.set(botId, key);
      return target;
    },
    async forBot(botId) {
      const key = latestTask.get(botId);
      const pinned = key ? pins.get(key) : undefined;
      if (key && fresh(pinned)) {
        const taskRef = key.slice(key.indexOf("/") + 1);
        return (await pick(botId, taskRef)).target;
      }
      latestTask.delete(botId);
      return (await pick(botId, `bot:${botId}`)).target;
    },
  };
}

/**
 * The computer provider of a device-mode deployment with no container of its own.
 *
 * Every action is carried to the tenant's machine through the gateway's `resolveDevice`, which is
 * asked before the provider; this only answers the lifecycle questions, truthfully, for a machine the
 * deployment does not host. Without it, device mode built no gateway at all unless a container was
 * also configured, and every coworker lost its computer tools.
 */
export function createDeviceComputerProvider(): ComputerProvider {
  return {
    name: "device",
    isolation: "per-bot",
    locate: async () => {
      throw new ComputerUnavailableError(
        "This deployment runs coworkers on the tenant's own machines and hosts no computer of its own.",
      );
    },
    status: async (botId) => ({ botId, state: "absent" }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
    list: async () => [],
  };
}

/** The provider a deployment builds its computer gateway on, or none when the feature is off. */
export function computerProviderFor(
  tenantRuntime: "cloud" | "device",
  container: ComputerProvider | undefined,
): ComputerProvider | undefined {
  if (container) return container;
  return tenantRuntime === "device"
    ? createDeviceComputerProvider()
    : undefined;
}

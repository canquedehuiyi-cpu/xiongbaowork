import type { RegisteredDevice } from "./queries";

/**
 * Spec F4: whether a machine is online, said where the work is shown (the board's cards, and the
 * coworker cards on /wakers). Read only from facts that already exist: a task's own `deviceId` (the
 * machine device mode picked for it when it opened) and this person's `GET /api/devices`, whose
 * `online` the server derives from the runner's last heartbeat. Nothing here is stored.
 */
export type DevicePresence = {
  /** The machine's name, or the start of its id when it is not (or no longer) one of this person's. */
  name: string;
  /** Online or offline per the device list; null when the list does not know this machine. */
  online: boolean | null;
};

/** The machine a task is bound to, as this person's device list knows it, or null for no binding. */
export function presenceOf(
  deviceId: string | null | undefined,
  devices: readonly RegisteredDevice[] | undefined,
): DevicePresence | null {
  if (!deviceId) return null;
  const known = devices?.find((device) => device.deviceId === deviceId);
  return known
    ? { name: known.name, online: known.online }
    : // Unpaired since, or the list has not answered: the work still happened there.
      { name: deviceId.slice(0, 8), online: null };
}

/** The word a card shows for a presence. A machine the list does not know is not called offline. */
export const presenceWord = (online: boolean | null): string =>
  online === null ? "状态未知" : online ? "在线" : "离线";

/**
 * How many of this person's machines are online, when they have any. This is the OWNER's presence,
 * not a task's binding: a coworker with no running task bound to a machine has no machine of its own
 * to name, so a card can only say what the owner's machines are doing. Null in cloud mode, or for a
 * person with no paired machine, where there is nothing to say.
 */
export function ownerPresence(
  devices: readonly RegisteredDevice[] | undefined,
): { online: number; total: number } | null {
  if (!devices || devices.length === 0) return null;
  return {
    online: devices.filter((device) => device.online).length,
    total: devices.length,
  };
}

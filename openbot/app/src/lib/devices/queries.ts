import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One of this tenant's own machines, as the server can currently see it.
 *
 * `online` is derived, not stored: it is how recently the runner spoke. That is the whole of presence,
 * which is why killing a runner needs no cleanup hook anywhere — the machine simply stops being seen.
 */
export type RegisteredDevice = {
  /** The row's own id, which is what removal addresses. */
  id: string;
  /** This machine's stable id, chosen by the runner and carried across restarts. */
  deviceId: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  online: boolean;
  /** Actions parked while this machine was away. Only present when the deployment queues them. */
  queued?: number;
  /** Actions that may have run and require checking on the machine. Never automatically replayed. */
  uncertain?: number;
  /** The backlog is big enough that it is a decision, not a queue. */
  needsAttention?: boolean;
};

export const deviceKeys = {
  all: ["devices"] as const,
  list: () => ["devices", "list"] as const,
  actions: (id: string) => ["devices", id, "actions"] as const,
};

export type DeviceActionReview = {
  key: string;
  action: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  review: { at: string; by: string; resolution: string; note: string } | null;
};

export function deviceActionsQueryOptions(id: string) {
  return queryOptions({
    queryKey: deviceKeys.actions(id),
    queryFn: () =>
      client(`/api/devices/${encodeURIComponent(id)}/actions`, "actions", {
        fallback: "动作核查记录加载失败。",
      }) as Promise<DeviceActionReview[]>,
    refetchInterval: 10_000,
  });
}

export function devicesQueryOptions() {
  return queryOptions({
    queryKey: deviceKeys.list(),
    queryFn: () =>
      client("/api/devices", "devices", {
        fallback: "Your devices could not be loaded.",
      }) as Promise<RegisteredDevice[]>,
    // Presence is a fact about a machine that is not here, so the only way to learn it is to ask
    // again. Ten seconds is well inside the window that decides online or offline.
    refetchInterval: 10_000,
  });
}

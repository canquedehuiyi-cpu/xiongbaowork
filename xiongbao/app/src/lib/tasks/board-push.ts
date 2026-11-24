import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Pilot: the board hears which cards moved over the channel socket (`XIONGBAO_PILOT_BOARD_PUSH`).
 *
 * The socket is opened once for the whole app by `useChannelEvents`; the board only needs to know
 * whether it is up, so it can poll less while it is and go back to polling at the old pace the moment
 * it is not. The poll is never removed: a push is a hint that may be missed, and the poll is what
 * makes a missed one cost seconds rather than a stale screen.
 */

/** How often the board reads again when nothing is pushed to it: the pace it always had. */
const POLL_MS = 5_000;
/** The slower safety net while pushes are arriving. */
const POLL_WHILE_PUSHED_MS = 30_000;

let connected = false;
const listeners = new Set<() => void>();

/** Called by the channel socket as it opens and closes. */
export function setBoardPushConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of listeners) listener();
}

export function isBoardPushConnected(): boolean {
  return connected;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * How often the board's list reads again. Only a server that says it pushes (`boardPush`) and a
 * socket that is up slow it; anything else, including a server that does not say, is the old pace.
 */
export function boardPollMs(state: {
  boardPush: boolean | undefined;
  connected: boolean;
}): number {
  return state.boardPush === true && state.connected
    ? POLL_WHILE_PUSHED_MS
    : POLL_MS;
}

export function useBoardPollMs(): number {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const socketUp = useSyncExternalStore(
    subscribe,
    isBoardPushConnected,
    () => false,
  );
  return boardPollMs({
    boardPush: capabilities.data?.boardPush,
    connected: socketUp,
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { QueuedOrigin } from "../devices/queue";

/** The tool call or HTTP action id follows a governed action to the runner's durable receipt. */
export const computerActionIdentity = new AsyncLocalStorage<string>();

/**
 * Which Bot, person and conversation a governed action was carried out for.
 *
 * Set by the gateway around the one call it forwards, from what the server already holds (the Bot it
 * governed for, the actor it authenticated, the run's own thread), so the device queue can remember
 * where to report an action that waits for a machine that is away. Nothing a model or a browser
 * writes into an action's arguments reaches it.
 */
export const computerActionOrigin = new AsyncLocalStorage<QueuedOrigin>();

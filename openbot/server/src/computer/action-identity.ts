import { AsyncLocalStorage } from "node:async_hooks";

/** The tool call or HTTP action id follows a governed action to the runner's durable receipt. */
export const computerActionIdentity = new AsyncLocalStorage<string>();

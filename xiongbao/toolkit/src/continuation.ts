import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, RunAgentInput } from "@ag-ui/client";
import type { AuditInitiator } from "./initiator";

/**
 * Everything needed to pick a turn up again at the tool call it stopped on, once a person has
 * answered. Re-exported from approvals/types.ts, which parses and stores it.
 */
export type ApprovalContinuation = {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  messages: Message[];
  state: unknown;
  context: RunAgentInput["context"];
  forwardedProps: unknown;
  initiator?: AuditInitiator;
};

const actionContext = new AsyncLocalStorage<ApprovalContinuation>();

/** Run a tool call with its continuation in scope, so a refusal inside it can be resumed later. */
export const withApprovalContext = <T>(
  context: ApprovalContinuation,
  run: () => Promise<T>,
): Promise<T> => actionContext.run(context, run);

export const currentApprovalContext = () => actionContext.getStore();

/**
 * Run work that is not part of the tool call it sits inside, with no continuation in scope: a call
 * the work makes to the computer then has no conversation to be asked in, so it is refused rather
 * than parking this call's turn on an approval about something else.
 */
export const outsideApprovalContext = <T>(run: () => T): T =>
  actionContext.exit(run);

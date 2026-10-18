import { dirname, join, resolve } from "node:path";
import { createShell } from "../../agent-computer/src/shell";
import { createWorkspace } from "../../agent-computer/src/workspace";
import {
  BROWSER_ACTIONS,
  BrowserFailure,
  browserIdentityOf,
  createRunnerBrowser,
  type RunnerBrowser,
} from "./browser";

/**
 * What a runner does when the server asks it to do something (ticket 017).
 *
 * The work is agent-computer's own: the same `createShell` and the same `createWorkspace`, imported
 * rather than re-implemented, because the file confinement in `workspace.ts` is a three-layer security
 * boundary and a second copy of it on this side would be a boundary with two answers. The desktop is
 * not more trusted than the container — it is the same code, in a different building.
 *
 * Nothing here decides whether an action may happen. The gateway decides that, writes the audit row,
 * and only then sends the frame; a runner that received a frame the policy refused would be a runner
 * that was never asked to judge.
 */
export type RunnerAction = {
  action: string;
  payload: unknown;
  signal?: AbortSignal;
};

export type ActionOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string; outcomeUnknown?: boolean };

export type RunnerExecutor = ((
  action: RunnerAction,
) => Promise<ActionOutcome>) & {
  /** Hand every browser back before this process dies, so their profiles are flushed. */
  closeBrowser: () => Promise<void>;
};

/**
 * Where a coworker's browser keeps its cookies on this machine.
 *
 * Beside the workspace, never inside it. `files.read` is confined to the workspace and reaches
 * everything within it, and a Chromium profile is a jar of the owner's live sessions: a Bot that could
 * list its own working folder could otherwise read the cookies that log them in.
 */
export function browserProfileRootFor(workspaceDir: string): string {
  return join(resolve(dirname(workspaceDir)), "runner-browser-profiles");
}

/**
 * The caller's own fields, with the identity the transport injected taken back out.
 *
 * The identity selects the profile in `browser.ts` and nothing else, so it is removed from what the
 * action handlers read. Two independent reasons: a leftover `tenantId` in a payload is a field a
 * handler could one day read as a caller's claim rather than the server's fact, and `snapshotId` is a
 * real field of the browser contract that has nothing to do with who is asking.
 */
function callerPayload(body: Record<string, unknown>): Record<string, unknown> {
  const { tenantId: _tenantId, botId: _botId, ...rest } = body;
  return rest;
}

/** Where a runner's files live, where its commands run, and whose browser it drives. */
export function createRunnerExecutor(
  workspaceDir: string,
  browser?: RunnerBrowser,
): RunnerExecutor {
  const workspace = createWorkspace(workspaceDir);
  const shell = createShell(workspaceDir);
  /*
   * Built here, used only when a browser action arrives.
   *
   * Constructing the browser costs no disk and no process: a machine whose runner is only being asked
   * to run a command must not end up with a browser profile directory and a snapshot counter beside
   * it, and `createRunnerExecutor` is called by tests and probes that never open a page.
   */
  const owned =
    browser ??
    createRunnerBrowser({ profileRoot: browserProfileRootFor(workspaceDir) });

  async function execute({
    action,
    payload,
    signal,
  }: RunnerAction): Promise<ActionOutcome> {
    const body = (payload ?? {}) as Record<string, unknown>;
    if (signal?.aborted)
      return {
        ok: false,
        error: "The device action was stopped before execution.",
      };
    try {
      if (BROWSER_ACTIONS.has(action)) {
        // The identity is the server's fact about the frame; the rest is what the caller asked for.
        const identity = browserIdentityOf(body);
        const output = await owned.act({
          action,
          identity,
          payload: callerPayload(body),
          ...(signal ? { signal } : {}),
        });
        return { ok: true, output };
      }
      switch (action) {
        case "exec": {
          const command =
            typeof body.command === "string" ? body.command : undefined;
          if (!command?.trim()) {
            return { ok: false, error: "A command is required." };
          }
          const output = await shell.run({
            command,
            signal,
            ...(typeof body.timeoutMs === "number"
              ? { timeoutMs: body.timeoutMs }
              : {}),
          });
          return output.stopped
            ? { ok: false, error: "The command was stopped on the device." }
            : { ok: true, output };
        }
        case "files.list":
          return {
            ok: true,
            output: await workspace.list(
              typeof body.path === "string" ? body.path : undefined,
            ),
          };
        case "files.read":
          return {
            ok: true,
            output: await workspace.read(String(body.path ?? "")),
          };
        case "files.write": {
          if (typeof body.contents !== "string") {
            return { ok: false, error: "The contents to write are required." };
          }
          return {
            ok: true,
            output: await workspace.write(
              String(body.path ?? ""),
              body.contents,
              { append: body.append === true },
            ),
          };
        }
        default:
          return {
            ok: false,
            error: `Nothing on this machine handles "${action}".`,
          };
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "The action failed on this machine.";
      /*
       * A click that was cancelled on the way may still have landed, and the safe answer is the one
       * that stops the device until the person who owns it looks. Everything else is a plain failure:
       * a refused address or a missing element did nothing, and saying otherwise would pause a
       * machine that has nothing to check.
       */
      return error instanceof BrowserFailure && error.outcomeUnknown
        ? { ok: false, error: message, outcomeUnknown: true }
        : { ok: false, error: message };
    }
  }

  return Object.assign(execute, { closeBrowser: () => owned.close() });
}

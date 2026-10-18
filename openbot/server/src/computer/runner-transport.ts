import {
  type DeviceChannel,
  type DispatchTarget,
  parseRunnerAddress,
} from "../devices/channel";
import {
  type ComputerDownload,
  type ComputerTransport,
  ComputerUnavailableError,
} from "./client";
import type { NavigateResult } from "./schema";

/**
 * The same `ComputerTransport` the gateway already speaks, answered by a frame over the tenant's own
 * machine rather than an HTTP call to this deployment's container (ticket 017).
 *
 * It exists at this seam on purpose. `ComputerGateway` decides an action, writes the audit row, and
 * then asks the transport to carry it; nothing between those steps knows or needs to know whether the
 * answer came from a container or from a laptop in somebody's study. A second dispatch path built
 * beside the gateway would be a policy, an approval gate and an audit trail with two implementations —
 * the shape in which one of them is always the stale one.
 */

/**
 * The calls that drive a browser, and so need to say whose browser it is.
 *
 * Not the file and shell calls: those reach this machine as itself, confined by the workspace it was
 * started in, and adding an identity to a frame they do not read would only make the audit trail and
 * the wire disagree about what a `files.write` contains.
 */
const BROWSER_ACTIONS = new Set([
  "navigate",
  "read",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "key",
  "scroll",
]);

export function createRunnerTransport(
  channel: DeviceChannel,
): ComputerTransport {
  const targetOf = (address: string): DispatchTarget => {
    const target = parseRunnerAddress(address);
    if (!target) {
      throw new ComputerUnavailableError(
        "That computer is not a device this deployment can dispatch to.",
      );
    }
    return target;
  };

  /** The paths the gateway posts to, in the words the runner answers to. */
  const actionFor = (path: string): string => {
    const bare = path.replace(/^\//, "").split("?")[0];
    return bare === "exec"
      ? "exec"
      : bare === "files/list"
        ? "files.list"
        : bare === "files/read"
          ? "files.read"
          : bare === "files/write"
            ? "files.write"
            : bare;
  };

  /**
   * One coworker's browser, named by the server rather than by the caller.
   *
   * The runner keys a browser profile by these two values, and a profile is a jar of one person's live
   * sessions. Everything the model can write into an action's JSON is therefore overwritten from the
   * two facts the gateway already had: the tenant the device is paired to, and the Bot whose computer
   * this call was governed for. Written last, so an earlier `tenantId` in the payload is the one that
   * loses.
   *
   * An action with no employee to name is refused here rather than passed on, because the runner's
   * alternative is a shared profile — and on a machine a person works on, "shared" means every
   * coworker's logins are one jar any of them can reach.
   */
  const withIdentity = (
    target: DispatchTarget,
    botId: string,
    payload: unknown,
  ): Record<string, unknown> | string => {
    const body: unknown = payload ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return "A browser action's request has to be a set of fields.";
    }
    const tenantId = target.tenantId.trim();
    const employee = botId.trim();
    if (!tenantId || !employee) {
      return "A browser action needs the employee it belongs to, and this one arrived without one.";
    }
    return {
      ...(body as Record<string, unknown>),
      tenantId,
      botId: employee,
    };
  };

  /** The one dispatch path, with the identity stamped on the calls that need it. */
  function carry<T>(
    action: string,
    target: DispatchTarget,
    botId: string,
    payload: unknown,
    timeoutMs?: number,
    idempotencyKey?: string,
    caller?: AbortSignal,
  ): Promise<T> {
    if (!BROWSER_ACTIONS.has(action)) {
      return channel.dispatch<T>(
        target,
        action,
        payload,
        timeoutMs,
        idempotencyKey,
        caller,
      );
    }
    const body = withIdentity(target, botId, payload);
    if (typeof body === "string") {
      return Promise.reject(new ComputerUnavailableError(body));
    }
    return channel.dispatch<T>(
      target,
      action,
      body,
      timeoutMs,
      idempotencyKey,
      caller,
    );
  }

  return {
    call<T>(
      baseUrl: string,
      botId: string,
      path: string,
      init?: RequestInit,
      caller?: AbortSignal,
      timeoutMs?: number,
      idempotencyKey?: string,
    ): Promise<T> {
      // A GET on a computer is a read of its state; the runner answers the same body it would over
      // HTTP, so the payload is whatever the path's own reader wants and the action name is the path.
      const action = actionFor(path);
      return carry<T>(
        action,
        targetOf(baseUrl),
        botId,
        init?.body ? JSON.parse(String(init.body)) : {},
        timeoutMs,
        idempotencyKey,
        caller,
      );
    },

    post<T>(
      baseUrl: string,
      botId: string,
      path: string,
      payload: unknown,
      caller?: AbortSignal,
      timeoutMs?: number,
      idempotencyKey?: string,
    ): Promise<T> {
      return carry<T>(
        actionFor(path),
        targetOf(baseUrl),
        botId,
        payload,
        timeoutMs,
        idempotencyKey,
        caller,
      );
    },

    navigate(
      baseUrl: string,
      botId: string,
      url: string,
      toolCallId?: string,
    ): Promise<NavigateResult> {
      return carry<NavigateResult>(
        "navigate",
        targetOf(baseUrl),
        botId,
        { url },
        // A page on a real machine over a home connection is slower than the container's, and the
        // deadline that matters is the one the person is waiting on.
        90_000,
        toolCallId,
      );
    },

    /**
     * Bytes do not cross this channel yet.
     *
     * `ComputerDownload` carries a stream, and a frame carries JSON. Saying so is the whole
     * implementation: answering with a base64 body the caller would never read as a stream would look
     * like a download that worked and a file that is corrupt.
     */
    download(): Promise<ComputerDownload> {
      return Promise.reject(
        new ComputerUnavailableError(
          "Reading a file's bytes off a device is not wired yet; the runner can list, read and write text.",
        ),
      );
    },
  };
}

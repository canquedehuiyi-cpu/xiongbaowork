import { desktopMessage } from "../../../shared/desktop-control";
import { DESKTOP_SESSION_TOOL } from "../approvals/desktop-policy";
import {
  type ApprovalCandidate,
  type ApprovalSubject,
  currentApprovalContext,
  type DesktopWriteAction,
} from "../approvals/types";
import { type AuditStore, recordPersonAuditEvent } from "../audit";
import { type DispatchTarget, runnerAddress } from "../devices/channel";
import type { DesktopStoppedInfo } from "../devices/socket";
import { ComputerUnavailableError } from "./client";
import {
  DESKTOP_BACKSTOP_MS,
  DESKTOP_OWNER_ONLY,
  DESKTOP_UNAVAILABLE_RULE,
  NO_DESKTOP,
} from "./desktop-gateway";
import {
  DESKTOP_SESSION_TOKEN,
  type DesktopSessionCache,
  type DesktopSessionStatus,
  desktopSessionKey,
  mintDesktopSessionToken,
} from "./desktop-session";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGatewayOptions,
} from "./gateway";

/**
 * The one gate every desktop write passes through (desktop write, phase 2; plan Task 16). The write
 * tools themselves come later (Task 22); each hands this gate a `send` that carries its one action
 * to the device with the session token.
 *
 * In order, and nothing is sent to the device before the step that allows it:
 *
 *  1. The Bot owner, on their own paired machine. Anyone else is refused, and nothing is sent.
 *  2. Refused outright (the desktop or the tool disabled; Task 17 adds the team's cap of `never`):
 *     recorded and refused before the device is asked anything.
 *  3. `desktop.session_status`: a device that cannot be written to (Linux, a Windows still on the
 *     old engine, a runner without the device app's banner and stop key, a Mac without permission)
 *     is refused in its own words before any card. Its answer also says which session is current:
 *     the device is authoritative, so a session it does not report is no session, whatever this
 *     replica remembers, and a replica that does not know the session uses the device's token.
 *  4. `govern` with `subject.desktopWrite`, whose `session` is that answer and never the model's.
 *     With no session the policy's session floor asks the owner, once only.
 *  5. Let through with no session: open one. Only after an approval: a gateway that let the write
 *     run unasked (no approval gate) is refused rather than opening a session nobody agreed to. A
 *     fresh token is handed to the device with `desktop.session_start`; a device that refuses it
 *     (its banner or stop key not ready, `guard_unready`) is a refusal in its words, and the action
 *     is not sent.
 *  6. `send(token, approved)`. A device that answers its session was stopped, expired or is gone
 *     drops this replica's session and the error goes back as it is. No new session is opened on
 *     the way: the next write asks again.
 */

/** A runner from before desktop writes answers "Nothing on this machine handles ...". */
export const DESKTOP_WRITE_OLD_RUNNER =
  "设备端版本太旧，不支持操作桌面，请先更新设备端。";
/** A gateway that let a write through with no approval: no session is opened without the owner. */
export const DESKTOP_SESSION_UNAPPROVED =
  "开始操作桌面需要你批准，但这次没有经过审批，所以没有开始。";
/** The reason on the row a heartbeat's stop writes. */
export const DESKTOP_STOPPED_REASON = "用户已停止桌面操作";
/** The rule that row names. */
export const DESKTOP_STOPPED_RULE = "desktop.stopped";

/** The ways the device app lets the owner stop a session. Anything else is recorded as unknown. */
const STOP_METHODS: ReadonlySet<string> = new Set([
  "hotkey",
  "mouse",
  "button",
]);

/** The device's answers that mean its session is over. The gate never opens a new one for them. */
const SESSION_OVER: ReadonlySet<string> = new Set([
  desktopMessage("stopped"),
  desktopMessage("session_expired"),
  desktopMessage("no_session"),
]);

export type DesktopWriteSubject = NonNullable<ApprovalSubject["desktopWrite"]>;

/**
 * The gateway's `govern` for a desktop write. `desktopWrite` goes to the approval gate as
 * `subject.desktopWrite`. `run` is told whether the write was asked about and approved.
 */
export type DesktopWriteGovern = <T>(
  toolName: string,
  botId: string,
  actor: ActionActor,
  subject: {
    device: { tenantId: string; deviceId: string };
    /** Absent only on a refusal, which never reaches the approval gate. */
    desktopWrite?: DesktopWriteSubject;
    windowId?: string;
    ref?: string;
    signal?: AbortSignal;
    refusal?: string;
    refusalRule?: string;
  },
  run: (approved: boolean) => Promise<T>,
) => Promise<T>;

/** The gateway's post to a desktop path on the owner's machine (`DesktopPost`, any desktop path). */
export type DesktopWritePost = <T>(
  botId: string,
  path: `/desktop/${string}`,
  payload: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  address: string,
) => Promise<T>;

export type DesktopWriteGate = {
  /**
   * 先早拒（禁用、团队上限 never）；再问 session_status（不可写就拒）；带 subject.desktopWrite 走 govern；
   * 放行后：会话为 none 就生成令牌并发 session_start；最后 send(token, approved)。approved 表示这一步是被底线抬成询问之后批准的。
   */
  run<T>(
    toolName: string,
    botId: string,
    actor: ActionActor,
    input: {
      action: DesktopWriteAction;
      windowId?: string;
      ref?: string;
      subject: Omit<DesktopWriteSubject, "session">;
      signal?: AbortSignal;
    },
    send: (session: string, approved: boolean) => Promise<T>,
  ): Promise<T>;
};

export function createDesktopWriteGate(deps: {
  resolveDevice?: ComputerGatewayOptions["resolveDevice"];
  approvalRefusal?: ComputerGatewayOptions["approvalRefusal"];
  govern: DesktopWriteGovern;
  post: DesktopWritePost;
  sessions: DesktopSessionCache;
}): DesktopWriteGate {
  /** The owner's machine, or a refusal: the same lock as the desktop reads (desktop-gateway.ts). */
  async function ownersMachine(botId: string, actor: ActionActor) {
    const machine = deps.resolveDevice ? await deps.resolveDevice(botId) : null;
    if (!machine) throw new ComputerUnavailableError(NO_DESKTOP);
    if (machine.tenantId !== actor.id)
      throw new ActionRefusedError(
        DESKTOP_OWNER_ONLY,
        DESKTOP_UNAVAILABLE_RULE,
      );
    return machine;
  }

  /** The machine's answer, with an old runner's English "does not handle this" made Chinese. */
  async function post<T>(...args: Parameters<DesktopWritePost>): Promise<T> {
    try {
      return await deps.post<T>(...args);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Nothing on this machine handles")
      )
        // Nothing was carried out: a refusal, never an outcome to wonder about.
        throw new ActionRefusedError(
          DESKTOP_WRITE_OLD_RUNNER,
          DESKTOP_UNAVAILABLE_RULE,
        );
      throw error;
    }
  }

  /*
   * Sessions being opened in this replica now, per key: approved or waiting for the owner, then
   * `desktop.session_start`. A second write for the same key waits here and uses that session's
   * token instead of asking the owner again and minting a second token (which would replace the
   * first on the device and fail the first write). Settles with undefined when the opening failed or
   * was refused; the waiter then goes on as if it were first.
   */
  const opening = new Map<string, Promise<string | undefined>>();

  return {
    async run<T>(
      toolName: string,
      botId: string,
      actor: ActionActor,
      input: {
        action: DesktopWriteAction;
        windowId?: string;
        ref?: string;
        subject: Omit<DesktopWriteSubject, "session">;
        signal?: AbortSignal;
      },
      send: (session: string, approved: boolean) => Promise<T>,
    ): Promise<T> {
      const machine = await ownersMachine(botId, actor);
      const { signal } = input;
      const refuse = (refusal: string) =>
        deps.govern<never>(
          toolName,
          botId,
          actor,
          {
            device: machine,
            ...(signal ? { signal } : {}),
            refusal,
            refusalRule: DESKTOP_UNAVAILABLE_RULE,
          },
          () =>
            Promise.reject(
              new ActionRefusedError(refusal, DESKTOP_UNAVAILABLE_RULE),
            ),
        );

      // 2. Refused outright: operating the desktop at all, then this tool. The device is not asked.
      const args = currentApprovalContext()?.args ?? {
        action: input.action,
        ...(input.windowId ? { windowId: input.windowId } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
      };
      for (const toolRef of [DESKTOP_SESSION_TOOL, toolName]) {
        const asked: ApprovalCandidate = {
          actorId: actor.id,
          botId,
          toolRef,
          effect: "write",
          scope: "desktop",
          args,
          subject: { runner: true },
        };
        const refused = await deps.approvalRefusal?.(asked);
        if (refused) return refuse(refused);
      }

      // 3. Whether the device can be written to now, and which session it holds.
      const address = runnerAddress(machine);
      let status: DesktopSessionStatus;
      try {
        status = await post<DesktopSessionStatus>(
          botId,
          "/desktop/session_status",
          { botId, actorId: actor.id },
          signal,
          DESKTOP_BACKSTOP_MS,
          address,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        // One refusal row, and the caller still gets the machine's own answer (offline, too old).
        const reason =
          error instanceof Error && error.message
            ? error.message
            : desktopMessage("failed");
        await refuse(reason).catch((refused: unknown) => {
          if (!(refused instanceof ActionRefusedError)) throw refused;
        });
        throw error instanceof Error ? error : new Error(reason);
      }
      if (status?.writable !== true)
        return refuse(
          typeof status?.reason === "string" && status.reason
            ? status.reason
            : desktopMessage("failed"),
        );

      const key = desktopSessionKey(machine, botId, actor.id);
      const reported = status.session?.token;
      let current =
        typeof reported === "string" && DESKTOP_SESSION_TOKEN.test(reported)
          ? reported
          : undefined;
      // The device is authoritative: its session replaces whatever this replica remembered.
      if (!current) deps.sessions.drop(key);
      else if (deps.sessions.get(key) !== current)
        deps.sessions.set(key, current);
      // No session on the device, but this replica is opening one for the same key: wait for it.
      for (
        let pending = current ? undefined : opening.get(key);
        pending && !current;
        pending = current ? undefined : opening.get(key)
      ) {
        current = await pending;
        signal?.throwIfAborted();
      }
      // Still none: this write opens it, and any write for the same key from now on waits for it.
      let opened: (token: string | undefined) => void = () => undefined;
      const mine = current
        ? undefined
        : new Promise<string | undefined>((resolve) => {
            opened = resolve;
          });
      if (mine) opening.set(key, mine);
      const session = current;

      // 4. Decided, recorded and, with no session, asked about (the session floor).
      try {
        return await deps.govern<T>(
          toolName,
          botId,
          actor,
          {
            device: machine,
            desktopWrite: {
              ...input.subject,
              // Last, so nothing the caller passed can claim a session the device did not report.
              session: session ? "active" : "none",
            },
            ...(input.windowId ? { windowId: input.windowId } : {}),
            ...(input.ref ? { ref: input.ref } : {}),
            ...(signal ? { signal } : {}),
          },
          async (approved) => {
            let token = session;
            if (token) deps.sessions.touch(key);
            else {
              // 5. Open the session, and only on the owner's approval.
              if (!approved)
                throw new ActionRefusedError(
                  DESKTOP_SESSION_UNAPPROVED,
                  DESKTOP_UNAVAILABLE_RULE,
                );
              const minted = mintDesktopSessionToken();
              try {
                await post(
                  botId,
                  "/desktop/session_start",
                  { token: minted, botId, actorId: actor.id },
                  signal,
                  DESKTOP_BACKSTOP_MS,
                  address,
                );
              } catch (error) {
                deps.sessions.drop(key);
                if (signal?.aborted) throw error;
                // Nothing was done on the screen: a refusal in the device's words, never "unknown".
                throw new ActionRefusedError(
                  error instanceof Error && error.message
                    ? error.message
                    : desktopMessage("guard_unready"),
                  DESKTOP_UNAVAILABLE_RULE,
                );
              }
              deps.sessions.set(key, minted);
              opened(minted);
              token = minted;
            }
            // 6. The write itself.
            try {
              return await send(token, approved);
            } catch (error) {
              if (error instanceof Error && SESSION_OVER.has(error.message))
                deps.sessions.drop(key);
              throw error;
            }
          },
        );
      } finally {
        // Refused, failed or done: whoever waits goes on (with the token, if the session opened).
        opened(undefined);
        if (mine && opening.get(key) === mine) opening.delete(key);
      }
    },
  };
}

/**
 * A heartbeat's `desktopStopped` (the owner stopped a session on the device): this replica forgets
 * the session and the trail gets one refusal row naming how it was stopped. Wired to the runner
 * socket's `onDesktopStopped`. Other replicas learn it from the device on their next write.
 *
 * The row is filed in the machine owner's tenant (G01): `target.tenantId` comes from the runner's
 * credential, the identity layer, never from the frame. The person the frame names is recorded only
 * when it is that owner; a device cannot write anyone else into the trail.
 */
export function createDesktopStoppedHandler(deps: {
  sessions: DesktopSessionCache;
  auditStore: AuditStore;
}): (target: DispatchTarget, info: DesktopStoppedInfo) => Promise<void> {
  return async (target, info) => {
    deps.sessions.drop(desktopSessionKey(target, info.botId, info.actorId));
    await recordPersonAuditEvent(deps.auditStore, target.tenantId, {
      eventType: "computer.action_refused",
      targetType: "computer",
      targetId: info.botId,
      actorUserId: target.tenantId,
      payload: {
        action: DESKTOP_SESSION_TOOL,
        bot: info.botId,
        ...(info.actorId === target.tenantId ? { actor: info.actorId } : {}),
        device: target.deviceId,
        reason: DESKTOP_STOPPED_REASON,
        stoppedBy: STOP_METHODS.has(info.reason) ? info.reason : "unknown",
        decision: {
          allowed: false,
          source: "deny",
          rule: DESKTOP_STOPPED_RULE,
          carriedOut: false,
        },
      },
    });
  };
}

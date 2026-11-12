import {
  classifyDesktopKeys,
  DESKTOP_APP_NAME,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_TEXT_ROLES,
  DESKTOP_WINDOW_ID,
  type DesktopWindow,
  desktopActionWordsOf,
  desktopMessage,
  desktopTextNeedsApproval,
} from "../../../shared/desktop-control";
import {
  DESKTOP_SESSION_TOOL,
  desktopSelfWindowWords,
} from "../approvals/desktop-policy";
import { approvedActionUnderway } from "../approvals/service";
import {
  type ApprovalCandidate,
  ApprovalRefusedError,
  type ApprovalSubject,
  currentApprovalContext,
  type DesktopWriteAction,
} from "../approvals/types";
import { type AuditStore, recordPersonAuditEvent } from "../audit";
import {
  DeviceActionError,
  type DispatchTarget,
  runnerAddress,
} from "../devices/channel";
import type { DesktopStoppedInfo } from "../devices/socket";
import { withUntrustedNotice } from "../untrusted-content";
import { computerActionIdentity } from "./action-identity";
import {
  DESKTOP_BACKSTOP_MS,
  DESKTOP_UNAVAILABLE_RULE,
  type DesktopPost,
  desktopOwnersMachine,
  windowsOf,
} from "./desktop-gateway";
import {
  DESKTOP_SESSION_TOKEN,
  type DesktopSessionCache,
  type DesktopSessionStatus,
  desktopSessionKey,
  mintDesktopSessionToken,
} from "./desktop-session";
import {
  type DesktopControlCache,
  type DesktopControlEntry,
  type DesktopWindowCache,
  desktopCacheKey,
} from "./desktop-state";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGatewayOptions,
} from "./gateway";

/**
 * The one gate every desktop write passes through (desktop write, phase 2; plan Task 16), and the four
 * writes that use it (plan Task 22, `createDesktopWriteMethods` below). Each write hands this gate a
 * `send` that carries its one action to the device with the session token.
 *
 * In order, and nothing is sent to the device before the step that allows it:
 *
 *  1. The Bot owner, on their own paired machine (`desktopOwnersMachine`, the one check the reads
 *     use too). Anyone else is refused, and nothing is sent.
 *  2. Refused outright (the desktop or the tool disabled, the team's cap of `never`): asked with
 *     `subject.desktopWrite` on the candidate, so the cap knows it is a desktop write; recorded and
 *     refused before the device is asked anything.
 *  2b. What the write is about, from this server's caches (`subject` may be worked out only now, with
 *     the machine known): the window's title and process, the control. A window list missing here is
 *     asked for once.
 *  3. `desktop.session_status`: a device that cannot be written to (Linux, a Windows still on the
 *     old engine, a runner without the device app's banner and stop key, a Mac without permission)
 *     is refused in its own words before any card. Its answer also says which session is current:
 *     the device is authoritative, so a session it does not report is no session, whatever this
 *     replica remembers, and a replica that does not know the session uses the device's token.
 *  4. `govern` with `subject.desktopWrite`, whose `session` is that answer and never the model's.
 *     With no session the policy's session floor asks the owner, once only.
 *  5. Let through with no session: open one. Only after an approval (the gate handed a permit, or
 *     this is the approved action carried out by its approval): a write let through unasked (a rule,
 *     no approval gate) is refused rather than opening a session nobody agreed to. A
 *     fresh token is handed to the device with `desktop.session_start`; a device that refuses it
 *     (its banner or stop key not ready, `guard_unready`) is a refusal in its words, and the action
 *     is not sent.
 *  6. `send(token, approved)`. Done, the session's idle clock starts again. A device that answers
 *     its session was stopped, expired or is gone (its exact copy) drops this replica's session and
 *     the error goes back as it is. No new session is opened on the way: the next write asks again.
 *     Whatever comes back, the token is taken out of it first.
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

/**
 * The device's answers that mean its session is over. The gate never opens a new one for them. Matched
 * as the whole message, never as a part of one: only the device's own copy, as it is, ends a session.
 */
const SESSION_OVER: ReadonlySet<string> = new Set([
  desktopMessage("stopped"),
  desktopMessage("session_expired"),
  desktopMessage("no_session"),
]);

export type DesktopWriteSubject = NonNullable<ApprovalSubject["desktopWrite"]>;
/** What a write's subject says before the device says which session is current. */
export type DesktopWriteFacts = Omit<DesktopWriteSubject, "session">;

/**
 * A desktop write on its audit row: which window and control, the action, the keys, and of typed text
 * ONLY ITS LENGTH. The text itself is never on a row (it goes to the device and, for the owner to read
 * before approving, on the approval card). How long it took is on the row that says it failed, or on
 * the `computer.desktop_write_done` row that says it was done, with whether a real pointer or
 * keyboard was used and whether the device verified it (gateway.ts).
 */
export type DesktopWriteRow = {
  windowId: string;
  title: string;
  process: string;
  control?: { type: string; name: string };
  action: DesktopWriteAction;
  keys?: string;
  /**
   * How long the typed text was, in UTF-16 code units (`text.length`). The limit a write is refused
   * at is counted differently: `textMaxBytes`, in UTF-8 bytes.
   */
  textLength?: number;
  physical?: boolean;
  delivery?: string;
  durationMs?: number;
};

/** Facts known only once the machine is: the subject, and the window it is in when there is one. */
export type DesktopWriteResolved =
  | { subject: DesktopWriteFacts; windowId?: string }
  | { refusal: string };

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
    /** The audit row's `desktop`: what the write is about, typed text by its length only. */
    row?: DesktopWriteRow;
    windowId?: string;
    ref?: string;
    signal?: AbortSignal;
    refusal?: string;
    refusalRule?: string;
  },
  run: (approved: boolean) => Promise<T>,
) => Promise<T>;

/** The gateway's post to a desktop path on the owner's machine: the reads' own `DesktopPost`. */
export type DesktopWritePost = DesktopPost;

/** The input `run` takes: a subject given outright, or worked out once the machine is known. */
export type DesktopWriteInput = {
  action: DesktopWriteAction;
  windowId?: string;
  ref?: string;
  subject:
    | DesktopWriteFacts
    | ((machine: {
        tenantId: string;
        deviceId: string;
      }) => Promise<DesktopWriteResolved>);
  /**
   * What is known of a write worked out only once the machine is (`subject` a function) before it
   * is: for the row and the candidate of a refusal before that (a write with no window, by its
   * program). The subject worked out later replaces it.
   */
  known?: DesktopWriteFacts;
  /** Typed text, by its length: for the row. */
  textLength?: number;
  signal?: AbortSignal;
};

export type DesktopWriteGate = {
  /**
   * 先早拒（禁用、团队上限 never）；再问 session_status（不可写就拒）；带 subject.desktopWrite 走 govern；
   * 放行后：会话为 none 就生成令牌并发 session_start；最后 send(token, approved)。approved 表示这一步是被底线抬成询问之后批准的。
   */
  run<T>(
    toolName: string,
    botId: string,
    actor: ActionActor,
    input: DesktopWriteInput,
    send: (session: string, approved: boolean) => Promise<T>,
  ): Promise<T>;
  /**
   * Refused before anything is asked or sent (a system key, text too long, a password box): the owner
   * check first, then one refusal row.
   */
  refuse(
    toolName: string,
    botId: string,
    actor: ActionActor,
    input: { refusal: string; row: DesktopWriteRow; signal?: AbortSignal },
  ): Promise<never>;
};

/** The row for a write, from what is known of it. */
function rowOf(
  facts: DesktopWriteFacts,
  windowId: string | undefined,
  textLength: number | undefined,
): DesktopWriteRow {
  return {
    windowId: windowId ?? "",
    title: facts.title ?? "",
    process: facts.process ?? "",
    ...(facts.control
      ? { control: { type: facts.control.type, name: facts.control.name } }
      : {}),
    action: facts.action,
    ...(facts.keys !== undefined ? { keys: facts.keys } : {}),
    ...(textLength !== undefined ? { textLength } : {}),
  };
}

/**
 * The same error with the session token taken out of its message (and stack). The token is a
 * credential for the owner's screen: whatever a machine or a transport says back, it never reaches a
 * row, the model or a log. The error keeps its class and fields (`outcomeUnknown` included).
 */
function withoutToken(error: unknown, token: string): unknown {
  if (!(error instanceof Error) || !token) return error;
  const hide = (text: string) => text.split(token).join("[会话令牌]");
  if (error.message.includes(token)) error.message = hide(error.message);
  if (typeof error.stack === "string" && error.stack.includes(token))
    error.stack = hide(error.stack);
  return error;
}

export function createDesktopWriteGate(deps: {
  resolveDevice?: ComputerGatewayOptions["resolveDevice"];
  approvalRefusal?: ComputerGatewayOptions["approvalRefusal"];
  govern: DesktopWriteGovern;
  post: DesktopWritePost;
  sessions: DesktopSessionCache;
}): DesktopWriteGate {
  /** The owner's machine, or a refusal: the one lock the desktop reads use (desktop-gateway.ts). */
  const ownersMachine = (botId: string, actor: ActionActor) =>
    desktopOwnersMachine(deps.resolveDevice, botId, actor);

  /** One refusal row, then the refusal. */
  const refuseOn = (
    machine: { tenantId: string; deviceId: string },
    toolName: string,
    botId: string,
    actor: ActionActor,
    refusal: string,
    row: DesktopWriteRow | undefined,
    signal: AbortSignal | undefined,
  ) =>
    deps.govern<never>(
      toolName,
      botId,
      actor,
      {
        device: machine,
        ...(signal ? { signal } : {}),
        ...(row ? { row } : {}),
        refusal,
        refusalRule: DESKTOP_UNAVAILABLE_RULE,
      },
      () =>
        Promise.reject(
          new ActionRefusedError(refusal, DESKTOP_UNAVAILABLE_RULE),
        ),
    );

  /** A machine that could not be asked: one refusal row, and the caller gets its own answer. */
  async function unreachable(
    error: unknown,
    refuse: (reason: string) => Promise<never>,
    signal: AbortSignal | undefined,
  ): Promise<never> {
    if (signal?.aborted) throw error;
    const reason =
      error instanceof Error && error.message
        ? error.message
        : desktopMessage("failed");
    await refuse(reason).catch((refused: unknown) => {
      if (!(refused instanceof ActionRefusedError)) throw refused;
    });
    throw error instanceof Error ? error : new Error(reason);
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
  /*
   * How many sessions this replica has opened, per key. A device's "no session" answer that left the
   * device before an opening here finished is out of date by the time it arrives (the opening may
   * already be done and gone from `opening`): when the count moved while the question was on its way,
   * the device is asked again rather than a second session opened over the first.
   */
  const opened = new Map<string, number>();

  return {
    async refuse(toolName, botId, actor, input) {
      const machine = await ownersMachine(botId, actor);
      return refuseOn(
        machine,
        toolName,
        botId,
        actor,
        input.refusal,
        input.row,
        input.signal,
      );
    },

    async run<T>(
      toolName: string,
      botId: string,
      actor: ActionActor,
      input: DesktopWriteInput,
      send: (session: string, approved: boolean) => Promise<T>,
    ): Promise<T> {
      const machine = await ownersMachine(botId, actor);
      const { signal } = input;
      const given =
        typeof input.subject === "function" ? undefined : input.subject;
      const early = given ?? input.known ?? { action: input.action };
      let row = rowOf(early, input.windowId, input.textLength);
      const refuse = (refusal: string) =>
        refuseOn(machine, toolName, botId, actor, refusal, row, signal);

      /*
       * 2. Refused outright: operating the desktop at all, then this tool. The device is not asked.
       * The candidate says it is a desktop write (`subject.desktopWrite`), so the team's cap of `never`
       * refuses it here too; which session is current is not known yet, so it says none.
       */
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
          subject: {
            runner: true,
            desktopWrite: { ...early, session: "none" },
          },
        };
        const refused = await deps.approvalRefusal?.(asked);
        if (refused) return refuse(refused);
      }

      // 2b. What the write is about, from this server's caches (a window list may be asked for once).
      let facts: DesktopWriteFacts;
      let windowId = input.windowId;
      if (given) facts = given;
      else {
        let resolved: DesktopWriteResolved;
        try {
          resolved = await (
            input.subject as Exclude<
              DesktopWriteInput["subject"],
              DesktopWriteFacts
            >
          )(machine);
        } catch (error) {
          return unreachable(error, refuse, signal);
        }
        if ("refusal" in resolved) return refuse(resolved.refusal);
        facts = resolved.subject;
        windowId = resolved.windowId ?? windowId;
        row = rowOf(facts, windowId, input.textLength);
      }

      // 3. Whether the device can be written to now, and which session it holds.
      const address = runnerAddress(machine);
      const key = desktopSessionKey(machine, botId, actor.id);
      let status: DesktopSessionStatus;
      try {
        for (;;) {
          const before = opened.get(key) ?? 0;
          status = await post<DesktopSessionStatus>(
            botId,
            "/desktop/session_status",
            { botId, actorId: actor.id },
            signal,
            DESKTOP_BACKSTOP_MS,
            address,
          );
          if (
            status?.writable !== true ||
            status.session?.token ||
            (opened.get(key) ?? 0) === before
          )
            break;
        }
      } catch (error) {
        // One refusal row, and the caller still gets the machine's own answer (offline, too old).
        return unreachable(error, refuse, signal);
      }
      if (status?.writable !== true)
        return refuse(
          typeof status?.reason === "string" && status.reason
            ? status.reason
            : desktopMessage("failed"),
        );

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
        // Given up on its own, the waiter leaves: the opening it waited for goes on for the others.
        current = await untilAborted(pending, signal);
      }
      // Still none: this write opens it, and any write for the same key from now on waits for it.
      let settle: (token: string | undefined) => void = () => undefined;
      const mine = current
        ? undefined
        : new Promise<string | undefined>((resolve) => {
            settle = resolve;
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
              ...facts,
              // Last, so nothing the caller passed can claim a session the device did not report.
              session: session ? "active" : "none",
            },
            row,
            ...(windowId ? { windowId } : {}),
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
                withoutToken(error, minted);
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
              opened.set(key, (opened.get(key) ?? 0) + 1);
              settle(minted);
              token = minted;
            }
            // 6. The write itself. Done: the session's idle clock starts again.
            try {
              const sent = await send(token, approved);
              deps.sessions.touch(key);
              return sent;
            } catch (error) {
              withoutToken(error, token);
              if (error instanceof Error && SESSION_OVER.has(error.message))
                deps.sessions.drop(key);
              throw error;
            }
          },
        );
      } finally {
        // Refused, failed or done: whoever waits goes on (with the token, if the session opened).
        settle(undefined);
        if (mine && opening.get(key) === mine) opening.delete(key);
      }
    },
  };
}

/** `pending`, or the caller's abort first. Giving up never settles or cancels `pending` itself. */
function untilAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
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

/*
 * THE FOUR WRITES (plan Task 22): click, type, key and focus, each through the gate above. Three more
 * with no window (plan Task 25): launch a program by its name, read the clipboard (asked every time,
 * by its own floor; what it held is outside content, and its row has its length only), and put text
 * on the clipboard (its row has the length, the card the text).
 *
 * What each is about comes from this server, never from the model: the window's title and process
 * from the window list (asked for once more when this replica has none), the control from the
 * controls a snapshot read showed (`null` when this replica never saw the ref: asked as an unknown
 * control). Refused before the gate, with one row each: a ref or window id that cannot be one, a
 * system key or keys that do not parse, text over `textMaxBytes`, and (once the control is known) a
 * password box. What is typed is on the device's payload and the approval card, never on a row: the
 * row has its length.
 *
 * The device checks every write again with the same shared rules, and with the team's action words
 * this server sends it (`actionWords`), and with the product's own names (`selfWindowWords`, final
 * review C1) for a write in a window. It is told the title the owner saw (`approvedTitle`) and, for a
 * click or a type, the control's name (`approvedControlName`, null when the card named none or nothing
 * was asked: final review I1). When it still asks for approval, the owner is asked once with the
 * device's reason and the write is sent once more, approved, with that reason (`approvedReason`):
 * whether or not this server had asked already (final review I1: an approval is for what the card
 * showed, and the device sees the whole name and title). At most once per call: asked again after
 * that, the device's answer goes back to the model as it is. A write whose outcome the device could
 * not tell (`outcomeUnknown`) is never sent again. A done write forgets its window's controls: the
 * window may have changed.
 */

/** What an approved write's dispatch key adds to the tool call's (see `send` in `carry`). */
export const DESKTOP_APPROVED_RESEND = ":approved";
/**
 * What the write sent again after an approved one, once the owner approved the device's reason,
 * adds instead (final review I1): another payload, so another key.
 */
export const DESKTOP_APPROVED_AGAIN = ":approved2";
/** The writes that happen in a window: they carry the product's own names for the device. */
const IN_A_WINDOW: ReadonlySet<DesktopWriteAction> = new Set([
  "click",
  "type",
  "key",
  "focus",
]);
/** The model's text is longer than a desktop write may type. */
export const DESKTOP_TEXT_TOO_LONG = `文字太长，最多 ${DESKTOP_LIMITS.textMaxBytes} 字节。`;
/** A program to launch named by a path, a flag or anything else that is not a name (the device's words). */
export const DESKTOP_BAD_APP = desktopMessage(
  "failed",
  "应用名只能是应用的名字，不能带路径或参数",
);
/** What a launch tells the model, when the device did not say. */
const DESKTOP_LAUNCH_NOTE =
  "The app may have opened a new window: list the windows to find it.";
/** What a done write tells the model, when the device did not say. */
const DESKTOP_WRITE_NOTE =
  "The window may have changed: read it again before the next step.";
/** The device's `needs_approval` copy around its reason. */
const [NEEDS_HEAD, NEEDS_TAIL] = desktopMessage(
  "needs_approval",
  "\u0000",
).split("\u0000") as [string, string];

export type DesktopWriteResult = {
  ok: true;
  physical: boolean;
  /** Whether the device verified the write took effect, when it said. */
  delivery?: "verified" | "unverified";
  window: { windowId: string; title: string; process: string };
  control?: { type: string; name: string };
  note: string;
};

/** A launch that went through: the program was asked to start. */
export type DesktopLaunchResult = {
  ok: true;
  app: string;
  delivery?: "verified" | "unverified";
  note: string;
};
/** What the clipboard held, cut to `clipboardReadMaxChars` characters by the device. */
export type DesktopClipboardReadResult = {
  ok: true;
  text: string;
  truncated: boolean;
};
/** Text put on the clipboard: how many UTF-8 bytes, never the text. */
export type DesktopClipboardWriteResult = { ok: true; bytes: number };

/** The device's reason when it answered that this step needs approval first, else undefined. */
function deviceAsks(error: unknown): string | undefined {
  if (!(error instanceof DeviceActionError) || error.outcomeUnknown)
    return undefined;
  const { message } = error;
  if (
    !message.startsWith(NEEDS_HEAD) ||
    !message.endsWith(NEEDS_TAIL) ||
    message.length <= NEEDS_HEAD.length + NEEDS_TAIL.length
  )
    return undefined;
  const reason = message
    .slice(NEEDS_HEAD.length, message.length - NEEDS_TAIL.length)
    .trim();
  return reason ? reason.slice(0, DESKTOP_LIMITS.titleMax) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The control an approval bound, for the approved write's own re-check and run only: an approval
 * answered later than this replica keeps its controls (or carried out by another replica) is carried
 * out on the window and control the owner saw, never on "unknown". Nothing is looser for it: the
 * approval compares the whole action again (the window title included, from this replica's window
 * list, asked of the machine again once that list is too old), and the device resolves the ref
 * strictly against its own snapshot (stale otherwise) and checks the live title again
 * (`needs_approval` if it turned sensitive). Only the same tool, action and ref.
 */
function boundControl(
  toolName: string,
  action: DesktopWriteAction,
  ref: string,
): DesktopControlEntry | undefined {
  const bound = approvedActionUnderway();
  if (!bound || bound.toolRef !== toolName) return undefined;
  if (!isRecord(bound.args) || bound.args.ref !== ref) return undefined;
  const target = bound.target;
  if (!isRecord(target) || target.action !== action) return undefined;
  const window = isRecord(target.window) ? target.window : undefined;
  const control = isRecord(target.control) ? target.control : undefined;
  if (
    !window ||
    typeof window.windowId !== "string" ||
    !DESKTOP_WINDOW_ID.test(window.windowId) ||
    !control ||
    typeof control.type !== "string" ||
    typeof control.name !== "string"
  )
    return undefined;
  return { windowId: window.windowId, type: control.type, name: control.name };
}

/*
 * WHAT THE DEVICE FOUND, KEPT FOR THE NEXT CALL (final review, round 3). In production one tool call
 * has one approval request (`approval_requests_action_idx`), so a card asked again after an approval
 * cannot open in the same call. The device's reason is kept here instead, in this replica only, for
 * a while: the model is told to call again, and the next call's first card names what the device
 * found, under that card's own approval. Used once: a write that goes through forgets it.
 */
export const DESKTOP_REASONS_TTL_MS = 600_000;
export const DESKTOP_REASONS_KEPT = 500;
/** At most this many reasons kept for one write: one more each time the device still asks. */
const REASONS_PER_WRITE = 3;

/**
 * What is kept for one write: the reasons, and for those kept while a card asked in this very call
 * waits (`call`), that call: those are only for that card's own run, never put on another card.
 */
export type DesktopReasonEntry = { reasons: string[]; call?: string };
export type DesktopReasonMemory = {
  recall(key: string): DesktopReasonEntry | undefined;
  remember(key: string, reasons: string[], call?: string): void;
  forget(key: string): void;
};

export function createDesktopReasonMemory(
  options: { now?: () => number; ttlMs?: number; max?: number } = {},
): DesktopReasonMemory {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DESKTOP_REASONS_TTL_MS;
  const max = options.max ?? DESKTOP_REASONS_KEPT;
  const kept = new Map<
    string,
    { reasons: string[]; call?: string; at: number }
  >();
  return {
    recall(key) {
      const entry = kept.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttl) {
        kept.delete(key);
        return undefined;
      }
      return {
        reasons: [...entry.reasons],
        ...(entry.call !== undefined ? { call: entry.call } : {}),
      };
    },
    remember(key, reasons, call) {
      kept.delete(key);
      kept.set(key, {
        reasons: [...reasons],
        ...(call !== undefined ? { call } : {}),
        at: now(),
      });
      // The oldest first: a Map keeps the order things were put in.
      while (kept.size > max) {
        const oldest = kept.keys().next().value as string;
        kept.delete(oldest);
      }
    },
    forget(key) {
      kept.delete(key);
    },
  };
}

/** What the model is told when the device found something the card did not say (round 3). */
export function desktopCallAgain(reason: string): string {
  return `设备发现了确认卡上没写的情况：${reason.replace(/[。.\s]+$/u, "")}。请再调用一次，下一张确认卡会写明，由主人重新确认。`;
}

/**
 * The approval store's own words when a tool call that has a request already asks for another
 * (server/src/approvals/store.ts, `openStoredApprovalInTransaction`): only that, as it is.
 */
export const APPROVAL_ACTION_CHANGED = "The approved action has changed.";

/**
 * The device's reason when this call is the re-check or the run of a card asked again after an
 * approval (`reasked` in its target, I1 round 2) for this same tool, action and target; else
 * undefined. The gate still compares the whole action: a write that reads differently now is not
 * carried out on it.
 */
function reaskUnderway(
  toolName: string,
  action: DesktopWriteAction,
  payload: Record<string, unknown>,
): string | undefined {
  const bound = approvedActionUnderway();
  if (!bound || bound.toolRef !== toolName) return undefined;
  const target = bound.target;
  if (!isRecord(target) || target.action !== action) return undefined;
  if (typeof target.reasked !== "string" || !target.reasked) return undefined;
  const args = isRecord(bound.args) ? bound.args : {};
  for (const key of ["ref", "windowId"] as const)
    if (payload[key] !== undefined && args[key] !== payload[key])
      return undefined;
  return target.reasked;
}

export function createDesktopWriteMethods(deps: {
  gate: DesktopWriteGate;
  windows: DesktopWindowCache;
  controls: DesktopControlCache;
  /** The team's action words, or the default (`desktopActionWordsOf` is applied again here). */
  actionWords: () => Promise<readonly string[]>;
  post: DesktopPost;
  /**
   * The approval store keeps one request per tool call (production's does): a card asked again
   * after an approval is never tried in the same call, and the device's reason is kept for the next
   * one (round 3). Without it the card is tried, and the store refusing it is taken the same way.
   */
  oneApprovalPerCall?: boolean;
  /** What the device found, kept for the next call; one per replica by default. */
  reasons?: DesktopReasonMemory;
  now?: () => number;
}) {
  const reasons =
    deps.reasons ??
    createDesktopReasonMemory(deps.now ? { now: deps.now } : {});
  /** The window from the list this server holds, or from the machine's list asked for once more. */
  async function windowOf(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    windowId: string,
    signal: AbortSignal | undefined,
  ): Promise<DesktopWindow | undefined> {
    const key = desktopCacheKey(machine, botId);
    const known = deps.windows.find(key, windowId);
    if (known) return known;
    const listed = await deps.post<{ windows?: unknown }>(
      botId,
      "/desktop/windows",
      {},
      signal,
      DESKTOP_BACKSTOP_MS,
      runnerAddress(machine),
    );
    deps.windows.remember(key, windowsOf(listed));
    return deps.windows.find(key, windowId);
  }

  /** What a done write returns, from the device's answer; anything malformed falls back to ours. */
  function resultOf(
    output: unknown,
    facts: DesktopWriteFacts | undefined,
    windowId: string | undefined,
  ): DesktopWriteResult {
    const answer = isRecord(output) ? output : {};
    const window = isRecord(answer.window) ? answer.window : {};
    const text = (value: unknown, fallback: string) =>
      typeof value === "string" ? value : fallback;
    const control = isRecord(answer.control) ? answer.control : undefined;
    return {
      ok: true,
      physical: answer.physical === true,
      ...(answer.delivery === "verified" || answer.delivery === "unverified"
        ? { delivery: answer.delivery }
        : {}),
      window: {
        windowId: text(window.windowId, windowId ?? ""),
        title: text(window.title, facts?.title ?? ""),
        process: text(window.process, facts?.process ?? ""),
      },
      ...(control &&
      typeof control.type === "string" &&
      typeof control.name === "string"
        ? { control: { type: control.type, name: control.name } }
        : {}),
      note: text(answer.note, DESKTOP_WRITE_NOTE),
    };
  }

  /** One write, through the gate; asked again once only when the device asks (I1). */
  async function carry<R = DesktopWriteResult>(plan: {
    toolName: string;
    action: DesktopWriteAction;
    botId: string;
    actor: ActionActor;
    signal: AbortSignal | undefined;
    /** The model's window (key, focus); a click or type finds it from the control. */
    windowId?: string;
    ref?: string;
    keys?: string;
    textLength?: number;
    /** More facts once the control is known (type), or a refusal (a password box). */
    facts?: (
      control: DesktopControlEntry | undefined,
    ) => Partial<DesktopWriteFacts> | { refusal: string };
    payload: Record<string, unknown>;
    /** What a write with no window returns, from the device's answer (default: a window's write). */
    result?: (output: unknown) => R;
  }): Promise<R> {
    let machine: { tenantId: string; deviceId: string } | undefined;
    let facts: DesktopWriteFacts | undefined;
    let windowId = plan.windowId;
    const resolve = async (owner: {
      tenantId: string;
      deviceId: string;
    }): Promise<DesktopWriteResolved> => {
      machine = owner;
      const key = desktopCacheKey(owner, plan.botId);
      const control =
        plan.ref === undefined
          ? undefined
          : (deps.controls.control(key, plan.ref) ??
            boundControl(plan.toolName, plan.action, plan.ref));
      if (plan.ref !== undefined) windowId = control?.windowId;
      const more = plan.facts?.(control) ?? {};
      if ("refusal" in more) return { refusal: more.refusal };
      const window =
        windowId === undefined
          ? undefined
          : await windowOf(owner, plan.botId, windowId, plan.signal);
      // A window this server knows of and the machine no longer lists: refused, as a read is.
      if (windowId !== undefined && !window)
        return { refusal: desktopMessage("no_window") };
      facts = {
        action: plan.action,
        ...(window ? { title: window.title, process: window.process } : {}),
        ...(plan.ref !== undefined
          ? {
              control: control
                ? { type: control.type, name: control.name }
                : null,
            }
          : {}),
        ...(plan.keys !== undefined ? { keys: plan.keys } : {}),
        ...more,
      };
      // What the device found when this same write last went through approved (round 3).
      memoryKey = JSON.stringify([
        owner.tenantId,
        owner.deviceId,
        plan.botId,
        plan.actor.id,
        windowId ?? "",
        facts.title ?? "",
        facts.control?.name ?? facts.keys ?? facts.process ?? "",
        plan.action,
      ]);
      const entry = reasons.recall(memoryKey);
      remembered = entry && entry.call === undefined ? entry.reasons : [];
      waiting = entry?.call !== undefined ? entry.reasons : [];
      if (remembered.length > 0)
        facts = { ...facts, rememberedReasons: remembered };
      return { subject: facts, ...(windowId ? { windowId } : {}) };
    };
    /** This write's key in `reasons`, once its facts are known. */
    let memoryKey: string | undefined;
    /** What `reasons` held for it then, for its card (an earlier call's). */
    let remembered: string[] = [];
    /** And what was kept for the card asked in one call, waiting for that card's run. */
    let waiting: string[] = [];
    /** The device's reason for this write kept for the next call, with whatever was kept before. */
    const keep = (reason: string) => {
      if (!memoryKey) return;
      const all = [
        ...remembered,
        ...waiting,
        ...(reasons.recall(memoryKey)?.reasons ?? []),
        reason,
      ];
      reasons.remember(
        memoryKey,
        all
          .filter((item, index) => all.indexOf(item) === index)
          .slice(-REASONS_PER_WRITE),
      );
    };
    /**
     * The device's reason on a card asked in this call that waits for the owner: kept for that
     * card's own run (`resume`), which reads it only if the card said it. Never over what is kept
     * for the next call.
     */
    const keepForThisCall = (reason: string) => {
      if (!memoryKey) return;
      const entry = reasons.recall(memoryKey);
      if (entry && entry.call === undefined) return;
      reasons.remember(
        memoryKey,
        [reason],
        computerActionIdentity.getStore() ?? "",
      );
    };
    /** Whether the card this write is carried out on (its approval's run) said each of `list`. */
    const cardSaid = (list: string[]) => {
      const said = approvedActionUnderway()?.reason ?? "";
      return list.every((reason) =>
        said.includes(reason.replace(/[。.\s]+$/u, "")),
      );
    };
    /**
     * Whether the owner saw the kept reasons on the card this write was approved on: a card answered
     * in this run was made from these very facts; one carried out by its approval's run (`resume`)
     * says so in its own words (the card's reason), or the reasons are not sent.
     */
    const rememberedSeen = () =>
      !approvedActionUnderway() || cardSaid(remembered);
    /** Whether the last write sent had been approved; undefined until one is sent. */
    let approvedSent: boolean | undefined;
    /** The device's reason the owner approved, once asked again with it (I1). */
    let approvedReason: string | undefined;
    /** The suffix an approved write's key takes: the second approved payload has its own (I1). */
    let approvedSuffix = DESKTOP_APPROVED_RESEND;
    /*
     * ONE KEY PER KIND OF PAYLOAD. The runner's journal carries out a key once and answers the same
     * key with the same payload from what it kept, but refuses the same key with another payload
     * ("This action id belongs to another request."). A write said `approved: false` and then
     * `approved: true` under one tool call (the device asked; the owner approved, in this run or in
     * the approval's own run of the tool, `resume`) is two requests, so the approved one always goes
     * under the call's key with a fixed suffix, and the unapproved one under the call's key. Each key
     * only ever has one payload, and the same call replayed meets the journal's answer for each.
     * Approved, then asked again by the device and approved again with its reason (I1), is a third:
     * `DESKTOP_APPROVED_AGAIN`.
     */
    const send = async (session: string, approved: boolean) => {
      approvedSent = approved;
      const words = [...desktopActionWordsOf(await deps.actionWords())];
      const identity = computerActionIdentity.getStore();
      const write = () =>
        deps.post<unknown>(
          plan.botId,
          `/desktop/${plan.action}`,
          {
            session,
            botId: plan.botId,
            actorId: plan.actor.id,
            approved,
            actionWords: words,
            /*
             * The title the owner saw on the card, or the one this server holds when not asked; empty
             * when none is known. The device compares it only when the live title is sensitive, so an
             * empty one only ever asks again.
             */
            approvedTitle: facts?.title ?? "",
            // The product's own names, for the device's check of the live title (C1).
            ...(IN_A_WINDOW.has(plan.action)
              ? { selfWindowWords: desktopSelfWindowWords() }
              : {}),
            // The control's name the card showed, or null (I1): the device checks the whole name.
            ...(plan.action === "click" || plan.action === "type"
              ? {
                  approvedControlName: approved
                    ? (facts?.control?.name ?? null)
                    : null,
                }
              : {}),
            /*
             * The device's own reasons the owner approved (I1): asked again in this call, and those
             * kept from an earlier call and named on this card (round 3). One as a string, as before.
             */
            ...(() => {
              if (!approved) return {};
              const seen = [
                ...(approvedReason !== undefined ? [approvedReason] : []),
                ...(remembered.length > 0 && rememberedSeen()
                  ? remembered
                  : []),
                // Kept while this call's card waited: only in that card's run, as the card said.
                ...(waiting.length > 0 &&
                approvedActionUnderway() &&
                cardSaid(waiting)
                  ? waiting
                  : []),
              ].filter((item, index, all) => all.indexOf(item) === index);
              if (seen.length === 0) return {};
              return { approvedReason: seen.length === 1 ? seen[0] : seen };
            })(),
            /*
             * Approved, the process the card showed, or null when it showed none (round 2,
             * Important-2): the device asks again in the product's own window or a terminal the
             * owner was not shown.
             */
            ...(approved && IN_A_WINDOW.has(plan.action)
              ? { approvedProcess: facts?.process ?? null }
              : {}),
            ...plan.payload,
          },
          plan.signal,
          DESKTOP_BACKSTOP_MS,
          runnerAddress(machine as { tenantId: string; deviceId: string }),
        );
      const sent = await (approved && identity !== undefined
        ? computerActionIdentity.run(`${identity}${approvedSuffix}`, write)
        : write());
      // Gone through: whatever was kept for it is used up (round 3).
      if (memoryKey) reasons.forget(memoryKey);
      return sent;
    };
    /*
     * A write with no window and no control is known in full before the machine is: its refusal
     * before then (the team's cap, a disabled tool) names it too, a launch by its program.
     */
    const windowless =
      plan.windowId === undefined && plan.ref === undefined
        ? plan.facts?.(undefined)
        : undefined;
    const known: DesktopWriteFacts | undefined =
      windowless && !("refusal" in windowless)
        ? { action: plan.action, ...windowless }
        : undefined;
    const run = (subject: DesktopWriteInput["subject"]) =>
      deps.gate.run(
        plan.toolName,
        plan.botId,
        plan.actor,
        {
          action: plan.action,
          ...(known ? { known } : {}),
          ...(windowId ? { windowId } : {}),
          ...(plan.ref !== undefined ? { ref: plan.ref } : {}),
          subject,
          ...(plan.textLength !== undefined
            ? { textLength: plan.textLength }
            : {}),
          ...(plan.signal ? { signal: plan.signal } : {}),
        },
        send,
      );
    /** The window may have changed already: its controls are asked about again. */
    const forget = (...ids: (string | undefined)[]) => {
      if (!machine) return;
      const key = desktopCacheKey(machine, plan.botId);
      for (const id of new Set(ids))
        if (id) deps.controls.forgetWindow(key, id);
    };
    const failed = (error: unknown) => {
      if ((error as { outcomeUnknown?: unknown })?.outcomeUnknown === true)
        forget(windowId);
      return error;
    };

    /*
     * THE CARD ASKED AGAIN AFTER AN APPROVAL (final review I1, round 2) is an action of its own: the
     * device's reason is in its target (`reask`), so neither the first approval nor that approval's
     * own run (`resume`) lets it through. When this call is that card's own re-check or run, it
     * starts from it: the same write with the same reason, sent approved with it, under the key of
     * an approved write asked again. Only once in a call either way.
     */
    const reasked = reaskUnderway(plan.toolName, plan.action, plan.payload);
    let output: unknown;
    try {
      if (reasked !== undefined) {
        approvedReason = reasked;
        approvedSuffix = DESKTOP_APPROVED_AGAIN;
        output = await run(async (owner) => {
          const resolved = await resolve(owner);
          if ("refusal" in resolved) return resolved;
          facts = { ...resolved.subject, deviceReason: reasked, reask: true };
          return { ...resolved, subject: facts };
        });
      } else output = await run(resolve);
    } catch (error) {
      const reason = deviceAsks(error);
      // Approved, and the device still asks: what it found is kept for the next call (round 3).
      if (reason !== undefined && approvedSent === true) keep(reason);
      // Never sent, not the device asking, or asked again already: its answer as it is.
      if (
        reason === undefined ||
        approvedSent === undefined ||
        !facts ||
        reasked !== undefined
      )
        throw failed(error);
      // One request per call: a second card cannot open here. The next call's first card says it.
      if (approvedSent && deps.oneApprovalPerCall)
        throw new ActionRefusedError(
          desktopCallAgain(reason),
          DESKTOP_UNAVAILABLE_RULE,
        );
      // Not approved yet: the card asked now may be carried out by its own run, which reads it here.
      if (!approvedSent) keepForThisCall(reason);
      /*
       * Asked once more with the device's reason, approved or not before (I1: an approval is for
       * what the card showed). Sent again approved, with that reason: under the approved key, or,
       * after an approved write, under a key of its own (see `send`), as a card of its own
       * (`reask`). Only once: whatever comes back from that goes to the model as it is.
       */
      if (approvedSent) approvedSuffix = DESKTOP_APPROVED_AGAIN;
      approvedReason = reason;
      const asked: DesktopWriteFacts = {
        ...facts,
        deviceReason: reason,
        ...(approvedSent ? { reask: true as const } : {}),
      };
      try {
        output = await run(asked);
      } catch (again) {
        // The store would not open a second request for this call: as above.
        if (
          approvedSent &&
          again instanceof ApprovalRefusedError &&
          again.message === APPROVAL_ACTION_CHANGED
        )
          throw new ActionRefusedError(
            desktopCallAgain(reason),
            DESKTOP_UNAVAILABLE_RULE,
          );
        const still = deviceAsks(again);
        if (still !== undefined) keep(still);
        throw failed(again);
      }
    }
    if (plan.result) {
      forget(windowId);
      return plan.result(output);
    }
    const result = resultOf(output, facts, windowId);
    forget(windowId, result.window.windowId);
    return result as R;
  }

  /** A refusal before the gate: the owner check, then one row. */
  const refuse = (
    toolName: string,
    botId: string,
    actor: ActionActor,
    refusal: string,
    row: Omit<DesktopWriteRow, "title" | "process" | "windowId"> & {
      windowId?: string;
    },
    signal: AbortSignal | undefined,
  ) =>
    deps.gate.refuse(toolName, botId, actor, {
      refusal,
      row: { title: "", process: "", ...row, windowId: row.windowId ?? "" },
      ...(signal ? { signal } : {}),
    });

  const validRef = (ref: unknown): ref is string =>
    typeof ref === "string" && DESKTOP_REF.test(ref);
  const validWindow = (windowId: unknown): windowId is string =>
    typeof windowId === "string" && DESKTOP_WINDOW_ID.test(windowId);

  return {
    /** Click a control a snapshot showed. */
    async clickDesktop(
      botId: string,
      actor: ActionActor,
      input: { ref: string },
      signal?: AbortSignal,
    ): Promise<DesktopWriteResult> {
      const toolName = "computer_desktop_click";
      const ref = input?.ref;
      if (!validRef(ref))
        return refuse(
          toolName,
          botId,
          actor,
          desktopMessage("stale"),
          { action: "click" },
          signal,
        );
      return carry({
        toolName,
        action: "click",
        botId,
        actor,
        signal,
        ref,
        payload: { ref },
      });
    },

    /** Type into a control a snapshot showed: replace its text, or add to it. */
    async typeDesktop(
      botId: string,
      actor: ActionActor,
      input: { ref: string; text: string; mode: "replace" | "append" },
      signal?: AbortSignal,
    ): Promise<DesktopWriteResult> {
      const toolName = "computer_desktop_type";
      const { ref, text, mode } = input ?? ({} as typeof input);
      const row = {
        action: "type" as const,
        ...(typeof text === "string" ? { textLength: text.length } : {}),
      };
      const refusal = !validRef(ref)
        ? desktopMessage("stale")
        : typeof text !== "string"
          ? desktopMessage("failed", "没有要输入的文字")
          : mode !== "replace" && mode !== "append"
            ? desktopMessage("failed", "输入方式不对")
            : Buffer.byteLength(text, "utf8") > DESKTOP_LIMITS.textMaxBytes
              ? DESKTOP_TEXT_TOO_LONG
              : undefined;
      if (refusal !== undefined)
        return refuse(toolName, botId, actor, refusal, row, signal);
      return carry({
        toolName,
        action: "type",
        botId,
        actor,
        signal,
        ref,
        textLength: text.length,
        facts: (control) => {
          if (control?.password)
            return { refusal: desktopMessage("password_field") };
          // The shared rules, the device's own (Task 21): a textarea, or a textfield not marked
          // single-line, takes new lines; anything else typed with one submits.
          const role = control?.type ?? "";
          const multiline =
            role === "textarea" ||
            (role === "textfield" && control?.singleLine !== true);
          return {
            ...(control && !DESKTOP_TEXT_ROLES.has(role)
              ? { notTextTarget: true }
              : {}),
            ...(!multiline && /[\r\n]/.test(text)
              ? { newlineInSingleLine: true }
              : {}),
            ...(desktopTextNeedsApproval(text, multiline)
              ? { controlCharacters: true }
              : {}),
          };
        },
        payload: { ref, text, mode },
      });
    },

    /** Press a key combination in the window in front. A system key is never pressed. */
    async pressDesktopKey(
      botId: string,
      actor: ActionActor,
      input: { windowId: string; keys: string },
      signal?: AbortSignal,
    ): Promise<DesktopWriteResult> {
      const toolName = "computer_desktop_key";
      const { windowId, keys } = input ?? ({} as typeof input);
      const keysText = typeof keys === "string" ? keys : "";
      const row = {
        action: "key" as const,
        keys: keysText,
        ...(validWindow(windowId) ? { windowId } : {}),
      };
      const kind = classifyDesktopKeys(keysText)?.kind;
      if (kind === undefined || kind === "system")
        return refuse(
          toolName,
          botId,
          actor,
          desktopMessage("system_keys", keysText),
          row,
          signal,
        );
      if (!validWindow(windowId))
        return refuse(
          toolName,
          botId,
          actor,
          desktopMessage("no_window"),
          row,
          signal,
        );
      return carry({
        toolName,
        action: "key",
        botId,
        actor,
        signal,
        windowId,
        keys: keysText,
        payload: { windowId, keys: keysText },
      });
    },

    /** Bring a window to the front. */
    async focusDesktopWindow(
      botId: string,
      actor: ActionActor,
      input: { windowId: string },
      signal?: AbortSignal,
    ): Promise<DesktopWriteResult> {
      const toolName = "computer_desktop_focus";
      const windowId = input?.windowId;
      if (!validWindow(windowId))
        return refuse(
          toolName,
          botId,
          actor,
          desktopMessage("no_window"),
          { action: "focus" },
          signal,
        );
      return carry({
        toolName,
        action: "focus",
        botId,
        actor,
        signal,
        windowId,
        payload: { windowId },
      });
    },

    /**
     * Start a program by its name. Only a name (`DESKTOP_APP_NAME`: no path, no flag) is ever sent,
     * checked here before anything is asked or sent and again on the device. The program is the
     * write's `process`: on the card, the row and the scope (`desktop/<app>`). A write like any
     * other: in a session, and under the team's cap on commands.
     */
    async launchDesktopApp(
      botId: string,
      actor: ActionActor,
      input: { app: string },
      signal?: AbortSignal,
    ): Promise<DesktopLaunchResult> {
      const toolName = "computer_desktop_launch";
      const app = input?.app;
      if (typeof app !== "string" || !DESKTOP_APP_NAME.test(app))
        return refuse(
          toolName,
          botId,
          actor,
          DESKTOP_BAD_APP,
          { action: "launch" },
          signal,
        );
      return carry({
        toolName,
        action: "launch",
        botId,
        actor,
        signal,
        facts: () => ({ process: app }),
        payload: { app },
        result: (output): DesktopLaunchResult => {
          const answer = isRecord(output) ? output : {};
          return {
            ok: true,
            app,
            ...(answer.delivery === "verified" ||
            answer.delivery === "unverified"
              ? { delivery: answer.delivery }
              : {}),
            note:
              typeof answer.note === "string"
                ? answer.note
                : DESKTOP_LAUNCH_NOTE,
          };
        },
      });
    },

    /**
     * Read the clipboard. Asked every time, in a session or not (`desktopActionFloor`), so it is
     * always sent approved, under the approved key. What it held is outside content: marked as
     * untrusted for the model, and on the row by its length only (gateway.ts).
     */
    async readDesktopClipboard(
      botId: string,
      actor: ActionActor,
      signal?: AbortSignal,
    ): Promise<{ untrusted: string } & DesktopClipboardReadResult> {
      return carry({
        toolName: "computer_desktop_clipboard_read",
        action: "clipboard_read",
        botId,
        actor,
        signal,
        payload: {},
        result: (output) => {
          const answer = isRecord(output) ? output : {};
          return withUntrustedNotice(
            {
              ok: true as const,
              text: typeof answer.text === "string" ? answer.text : "",
              truncated: answer.truncated === true,
            },
            "desktop clipboard",
            ["text"],
          );
        },
      });
    },

    /**
     * Put text on the clipboard: at most `textMaxBytes` of UTF-8, refused here before anything is
     * asked or sent. The text goes to the device and, in the call's arguments, on the card; the row
     * has its length.
     */
    async writeDesktopClipboard(
      botId: string,
      actor: ActionActor,
      input: { text: string },
      signal?: AbortSignal,
    ): Promise<DesktopClipboardWriteResult> {
      const toolName = "computer_desktop_clipboard_write";
      const text = input?.text;
      const row = {
        action: "clipboard_write" as const,
        ...(typeof text === "string" ? { textLength: text.length } : {}),
      };
      const refusal =
        typeof text !== "string"
          ? desktopMessage("failed", "没有要写入剪贴板的文字")
          : Buffer.byteLength(text, "utf8") > DESKTOP_LIMITS.textMaxBytes
            ? DESKTOP_TEXT_TOO_LONG
            : undefined;
      if (refusal !== undefined)
        return refuse(toolName, botId, actor, refusal, row, signal);
      return carry({
        toolName,
        action: "clipboard_write",
        botId,
        actor,
        signal,
        textLength: text.length,
        payload: { text },
        result: (output): DesktopClipboardWriteResult => {
          const answer = isRecord(output) ? output : {};
          return {
            ok: true,
            bytes:
              typeof answer.bytes === "number"
                ? answer.bytes
                : Buffer.byteLength(text, "utf8"),
          };
        },
      });
    },
  };
}

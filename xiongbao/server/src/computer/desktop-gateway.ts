import {
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
  DESKTOP_WINDOW_WORDS,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
  sensitiveWord,
} from "../../../shared/desktop-control";
import {
  DESKTOP_SNAPSHOT_TOOL,
  DESKTOP_WAIT_TOOL,
} from "../approvals/desktop-policy";
import { currentApprovalContext } from "../approvals/types";
import { runnerAddress } from "../devices/channel";
import { withUntrustedNotice } from "../untrusted-content";
import { ComputerUnavailableError } from "./client";
import {
  type DesktopControlCache,
  type DesktopWindowCache,
  desktopCacheKey,
} from "./desktop-state";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGatewayOptions,
} from "./gateway";

/**
 * Looking at the Bot owner's desktop, read only (device-side desktop viewing, Phase 1).
 *
 * Three calls and no more: list the windows on the owner's paired machine, read one of them (its
 * control tree, and a screenshot when asked), and wait in one of them for a control to show up, then
 * read it as a snapshot (desktop write, phase 2, plan Task 25). Nothing here clicks, types, launches
 * or focuses anything: the writes are in desktop-write.ts.
 *
 * Both go through the gateway's `govern`, so each is decided, recorded and, for a window whose title
 * is sensitive, asked about before anything is read. The title that decides it comes from the
 * machine's own window list, kept by the server, never from the model's arguments.
 */

/** The rule a refusal names for a desktop the Bot cannot use or a window it cannot read. */
export const DESKTOP_UNAVAILABLE_RULE = "desktop.unavailable";
/** Outlasts the runner's own deadlines: helper start 30s plus a request of 15s, with room to spare. */
export const DESKTOP_BACKSTOP_MS = 90_000;

/** A runner from before desktop viewing answers "Nothing on this machine handles ...". */
export const DESKTOP_OLD_RUNNER =
  "设备端版本太旧，不支持查看桌面，请先更新设备端。";
/** The machine could not be asked for its windows (offline, paused, too slow). */
export const DESKTOP_LIST_FAILED = desktopMessage(
  "failed",
  "没能取得这台电脑的窗口列表，请确认设备在线后再试。",
);

/** Why someone other than the Bot's owner cannot use the owner's desktop. */
export const DESKTOP_OWNER_ONLY =
  "桌面操作在员工主人自己的电脑上，只有员工的主人本人才能让员工使用。";
/** Why a Bot has no desktop to look at: not device mode, or no owner's machine. */
export const NO_DESKTOP =
  "桌面操作只能在员工主人自己配对的电脑上使用，这个员工现在用不了。";
/** A sensitive title, and no approval gate in this deployment to ask the owner with. */
export function desktopNoGate(word: string): string {
  return `窗口标题含「${word}」，读取前需要你批准，但这里没有审批功能，所以没有读取。`;
}

/** A wait that names neither the control's name nor its type, or names one that cannot be one. */
export const DESKTOP_WAIT_TARGET = desktopMessage(
  "failed",
  "要等的控件写得不对",
);
/** A wait shorter than a second or longer than `waitMaxSec`, or not in whole seconds. */
export const DESKTOP_WAIT_SECONDS = desktopMessage(
  "failed",
  `等待时间要在 1～${DESKTOP_LIMITS.waitMaxSec} 秒之间`,
);
/**
 * How long the server gives one wait: the whole wait, a command's budget each for the window list
 * the device reads first and the snapshot that ends the wait, and 10 s more for its command queue;
 * never less than a snapshot's own backstop.
 */
export function desktopWaitBudgetMs(timeoutSec: number): number {
  return Math.max(
    timeoutSec * 1000 + 2 * DESKTOP_LIMITS.adCommandTimeoutMs + 10_000,
    DESKTOP_BACKSTOP_MS,
  );
}
/** A control type to wait for: a role such as `button`, never a colon (the device's own rule). */
const WAIT_TYPE = /^[A-Za-z][A-Za-z0-9_ -]{0,59}$/;

/** What `govern` is told about the window a read is for. */
export type DesktopSubject = {
  windowId: string;
  title: string;
  process: string;
  sensitiveWord?: string;
  screenshot: boolean;
};

export type DesktopGovern = <T>(
  toolName:
    | "computer_desktop_windows"
    | "computer_desktop_snapshot"
    | "computer_desktop_wait",
  botId: string,
  actor: ActionActor,
  subject: {
    device: { tenantId: string; deviceId: string };
    desktop?: DesktopSubject;
    signal?: AbortSignal;
    refusal?: string;
    refusalRule?: string;
  },
  run: () => Promise<T>,
) => Promise<T>;

/** The gateway's post to a desktop path on the owner's machine: the reads here, the writes in desktop-write.ts. */
export type DesktopPost = <T>(
  botId: string,
  path: `/desktop/${string}`,
  payload: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  address: string,
) => Promise<T>;

/**
 * A machine's answer, kept to the windows this server can judge. Untrusted input: an entry whose
 * `windowId` is not a window id, or whose `title` or `process` is not a string, is dropped, so a
 * malformed one never reaches the sensitive-word check, the approval scope or a row. Anything that
 * is not an array is an empty list.
 */
export function windowsOf(result: { windows?: unknown }): DesktopWindow[] {
  if (!Array.isArray(result?.windows)) return [];
  return result.windows.flatMap((entry: unknown): DesktopWindow[] => {
    if (!entry || typeof entry !== "object") return [];
    const { windowId, title, process, focused, minimized } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof windowId !== "string" ||
      !DESKTOP_WINDOW_ID.test(windowId) ||
      typeof title !== "string" ||
      typeof process !== "string"
    )
      return [];
    return [
      {
        windowId,
        title,
        process,
        focused: focused === true,
        minimized: minimized === true,
      },
    ];
  });
}

/**
 * The owner's machine, or a refusal: no machine, or someone other than the owner. The same lock as
 * the local apps: the desktop is the owner's, so nothing is sent for anyone else. The one owner check
 * for the desktop, reading (below) and writing (desktop-write.ts) alike.
 */
export async function desktopOwnersMachine(
  resolveDevice: ComputerGatewayOptions["resolveDevice"],
  botId: string,
  actor: ActionActor,
): Promise<{ tenantId: string; deviceId: string }> {
  const machine = resolveDevice ? await resolveDevice(botId) : null;
  if (!machine) throw new ComputerUnavailableError(NO_DESKTOP);
  if (machine.tenantId !== actor.id)
    throw new ActionRefusedError(DESKTOP_OWNER_ONLY, DESKTOP_UNAVAILABLE_RULE);
  return machine;
}

export function createDesktopMethods(deps: {
  resolveDevice?: ComputerGatewayOptions["resolveDevice"];
  approvalRefusal?: ComputerGatewayOptions["approvalRefusal"];
  hasApprovalGate: boolean;
  govern: DesktopGovern;
  post: DesktopPost;
  windows: DesktopWindowCache;
  /** Where a window's controls are kept for the writes (desktop-write.ts). */
  controls?: DesktopControlCache;
}) {
  /** The machine's answer, with an old runner's English "does not handle this" made Chinese. */
  const post = async <T>(...args: Parameters<DesktopPost>): Promise<T> => {
    try {
      return await deps.post<T>(...args);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Nothing on this machine handles")
      )
        throw new Error(DESKTOP_OLD_RUNNER);
      throw error;
    }
  };

  const ownersMachine = (botId: string, actor: ActionActor) =>
    desktopOwnersMachine(deps.resolveDevice, botId, actor);

  /** Ask the machine for its windows and keep the answer as the list a read is judged against. */
  async function fetchWindows(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ windows: DesktopWindow[] }> {
    const result = await post<{ windows?: unknown }>(
      botId,
      "/desktop/windows",
      {},
      signal,
      DESKTOP_BACKSTOP_MS,
      runnerAddress(machine),
    );
    const windows = windowsOf(result);
    deps.windows.remember(desktopCacheKey(machine, botId), windows);
    return { ...result, windows };
  }

  /**
   * One read of one window, a snapshot or a wait. The window is found in the machine's own list
   * (kept, or asked for once more); one that is not there is refused and nothing is read. A sensitive
   * title is asked about by the gate's floor, and only a read the gate let through tells the machine
   * it may read a sensitive window. `refusal` is what the call's own arguments are refused with.
   */
  async function readWindow(read: {
    toolName: "computer_desktop_snapshot" | "computer_desktop_wait";
    botId: string;
    actor: ActionActor;
    input: { windowId: string };
    refusal: string | undefined;
    path: "/desktop/snapshot" | "/desktop/wait";
    payload: Record<string, unknown>;
    screenshot: boolean;
    timeoutMs: number;
    signal: AbortSignal | undefined;
  }): Promise<{ untrusted: string } & DesktopSnapshot> {
    const { toolName, botId, actor, input, signal } = read;
    const machine = await ownersMachine(botId, actor);
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
    const { windowId } = input;
    if (typeof windowId !== "string" || !DESKTOP_WINDOW_ID.test(windowId))
      return refuse(desktopMessage("no_window"));
    if (read.refusal !== undefined) return refuse(read.refusal);
    /*
     * Refused outright (a disabled tool): before the machine is asked anything, the list included.
     * A wait reads the window as a snapshot does, so 查看桌面 disabled refuses it too: asked as the
     * snapshot first, then as itself (as a write is asked as 操作桌面, then as itself).
     */
    for (const toolRef of toolName === DESKTOP_WAIT_TOOL
      ? [DESKTOP_SNAPSHOT_TOOL, toolName]
      : [toolName]) {
      const refused = await deps.approvalRefusal?.({
        actorId: actor.id,
        botId,
        toolRef,
        effect: "read",
        scope: "desktop",
        args: currentApprovalContext()?.args ?? input,
        subject: { runner: true },
      });
      if (refused) return refuse(refused);
    }
    const key = desktopCacheKey(machine, botId);
    let window = deps.windows.find(key, windowId);
    if (!window) {
      try {
        await fetchWindows(machine, botId, signal);
      } catch (error) {
        // The person's Stop stays a Stop. Anything else leaves one refusal row, not nothing, and
        // the caller still gets the machine's own answer (offline, not Windows, too old).
        if (signal?.aborted) throw error;
        const reason =
          error instanceof Error && error.message
            ? error.message
            : DESKTOP_LIST_FAILED;
        await refuse(reason).catch((refused: unknown) => {
          if (!(refused instanceof ActionRefusedError)) throw refused;
        });
        throw error instanceof Error ? error : new Error(DESKTOP_LIST_FAILED);
      }
      window = deps.windows.find(key, windowId);
    }
    if (!window) return refuse(desktopMessage("no_window"));
    const word = sensitiveWord(window.title, DESKTOP_WINDOW_WORDS);
    if (word && !deps.hasApprovalGate) return refuse(desktopNoGate(word));
    const result = await deps.govern<DesktopSnapshot>(
      toolName,
      botId,
      actor,
      {
        device: machine,
        ...(signal ? { signal } : {}),
        desktop: {
          windowId,
          title: window.title,
          process: window.process,
          screenshot: read.screenshot,
          ...(word ? { sensitiveWord: word } : {}),
        },
      },
      /*
       * Reaching here means the gate let the read through: a plain title passes, and a sensitive one
       * is raised to an ask by the floor and runs only once approved. So this is the one place the
       * machine is told it may read a sensitive window.
       */
      async () => {
        const snapshot = await post<DesktopSnapshot>(
          botId,
          read.path,
          { windowId, ...read.payload, allowSensitive: word !== undefined },
          signal,
          read.timeoutMs,
          runnerAddress(machine),
        );
        // The controls a write may name next, filed under the window asked for, not the one claimed.
        deps.controls?.rememberSnapshot(key, {
          ...snapshot,
          window: { ...snapshot?.window, windowId },
        });
        return snapshot;
      },
    );
    return withUntrustedNotice(result, "desktop window", [
      "window",
      "elements",
    ]);
  }

  return {
    /** The windows on the owner's desktop. A read: governed and recorded; titles are outside content. */
    async listDesktopWindows(
      botId: string,
      actor: ActionActor,
      signal?: AbortSignal,
    ): Promise<{ untrusted: string; windows: DesktopWindow[] }> {
      const machine = await ownersMachine(botId, actor);
      const result = await deps.govern(
        "computer_desktop_windows",
        botId,
        actor,
        { device: machine, ...(signal ? { signal } : {}) },
        () => fetchWindows(machine, botId, signal),
      );
      return withUntrustedNotice(result, "desktop window", ["windows"]);
    },

    /**
     * One window's control tree, and its screenshot when asked. The window is found in the machine's
     * own list (kept, or asked for once more); one that is not there is refused and nothing is read.
     * A sensitive title is asked about by the gate's floor, and only a read the gate let through
     * tells the machine it may read a sensitive window.
     */
    async snapshotDesktop(
      botId: string,
      actor: ActionActor,
      input: { windowId: string; from?: string; screenshot?: boolean },
      signal?: AbortSignal,
    ): Promise<{ untrusted: string } & DesktopSnapshot> {
      const { from } = input;
      const screenshot = input.screenshot === true;
      return readWindow({
        toolName: "computer_desktop_snapshot",
        botId,
        actor,
        input,
        refusal:
          from !== undefined &&
          (typeof from !== "string" || !DESKTOP_REF.test(from))
            ? desktopMessage("stale")
            : undefined,
        path: "/desktop/snapshot",
        payload: {
          ...(from ? { from } : {}),
          ...(screenshot ? { screenshot: true } : {}),
        },
        screenshot,
        timeoutMs: DESKTOP_BACKSTOP_MS,
        signal,
      });
    },

    /**
     * Waits in one window for a control (by its name, its type, or both) to show up, for up to
     * `timeoutSec` seconds, then reads the window as a snapshot does (plan Task 25). A read, under the
     * snapshot's rules: the window from the machine's own list, a sensitive title asked about first,
     * and the controls it shows are the ones a write may name next. A wait that runs out of time comes
     * back as the device's failure; nothing changed, so never an unknown outcome.
     */
    async waitDesktop(
      botId: string,
      actor: ActionActor,
      input: {
        windowId: string;
        name?: string;
        type?: string;
        timeoutSec: number;
      },
      signal?: AbortSignal,
    ): Promise<{ untrusted: string } & DesktopSnapshot> {
      const { name, type, timeoutSec } = input;
      const nameOk =
        name === undefined ||
        (typeof name === "string" &&
          name.trim() !== "" &&
          name.length <= DESKTOP_LIMITS.nameMax &&
          // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
          !/[\u0000-\u001f\u007f]/.test(name));
      const typeOk =
        type === undefined ||
        (typeof type === "string" && WAIT_TYPE.test(type));
      const secondsOk =
        typeof timeoutSec === "number" &&
        Number.isInteger(timeoutSec) &&
        timeoutSec >= 1 &&
        timeoutSec <= DESKTOP_LIMITS.waitMaxSec;
      return readWindow({
        toolName: "computer_desktop_wait",
        botId,
        actor,
        input,
        refusal:
          !nameOk || !typeOk || (name === undefined && type === undefined)
            ? DESKTOP_WAIT_TARGET
            : !secondsOk
              ? DESKTOP_WAIT_SECONDS
              : undefined,
        path: "/desktop/wait",
        payload: {
          ...(name !== undefined ? { name } : {}),
          ...(type !== undefined ? { type } : {}),
          timeoutSec,
        },
        screenshot: false,
        timeoutMs: secondsOk ? desktopWaitBudgetMs(timeoutSec) : 0,
        signal,
      });
    },
  };
}

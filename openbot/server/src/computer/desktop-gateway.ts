import {
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
  DESKTOP_WINDOW_WORDS,
  type DesktopSnapshot,
  type DesktopWindow,
  desktopMessage,
  sensitiveWord,
} from "../../../shared/desktop-control";
import { currentApprovalContext } from "../approvals/types";
import { runnerAddress } from "../devices/channel";
import { withUntrustedNotice } from "../untrusted-content";
import { ComputerUnavailableError } from "./client";
import { type DesktopWindowCache, desktopCacheKey } from "./desktop-state";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGatewayOptions,
} from "./gateway";

/**
 * Looking at the Bot owner's desktop, read only (device-side desktop viewing, Phase 1).
 *
 * Two calls and no more: list the windows on the owner's paired machine, and read one of them (its
 * control tree, and a screenshot when asked). Nothing here clicks, types, launches or focuses
 * anything; a write is a later revision of the spec, not another method in this file.
 *
 * Both go through the gateway's `govern`, so each is decided, recorded and, for a window whose title
 * is sensitive, asked about before anything is read. The title that decides it comes from the
 * machine's own window list, kept by the server, never from the model's arguments.
 */

/** The rule a refusal names for a desktop the Bot cannot use or a window it cannot read. */
export const DESKTOP_UNAVAILABLE_RULE = "desktop.unavailable";
/** Outlasts the runner's own deadlines: helper start 30s plus a request of 15s, with room to spare. */
export const DESKTOP_BACKSTOP_MS = 90_000;

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

/** What `govern` is told about the window a read is for. */
export type DesktopSubject = {
  windowId: string;
  title: string;
  process: string;
  sensitiveWord?: string;
  screenshot: boolean;
};

export type DesktopGovern = <T>(
  toolName: "computer_desktop_windows" | "computer_desktop_snapshot",
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

export type DesktopPost = <T>(
  botId: string,
  path: "/desktop/windows" | "/desktop/snapshot",
  payload: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  address: string,
) => Promise<T>;

/** A machine's answer, kept to an array: anything else is an empty list. */
function windowsOf(result: { windows?: unknown }): DesktopWindow[] {
  return Array.isArray(result?.windows)
    ? (result.windows as DesktopWindow[])
    : [];
}

export function createDesktopMethods(deps: {
  resolveDevice?: ComputerGatewayOptions["resolveDevice"];
  approvalRefusal?: ComputerGatewayOptions["approvalRefusal"];
  hasApprovalGate: boolean;
  govern: DesktopGovern;
  post: DesktopPost;
  windows: DesktopWindowCache;
}) {
  /**
   * The owner's machine, or a refusal: no machine, or someone other than the owner. The same lock as
   * the local apps: the desktop is the owner's, so nothing is sent for anyone else.
   */
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

  /** Ask the machine for its windows and keep the answer as the list a read is judged against. */
  async function fetchWindows(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ windows: DesktopWindow[] }> {
    const result = await deps.post<{ windows?: unknown }>(
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
      const machine = await ownersMachine(botId, actor);
      const refuse = (refusal: string) =>
        deps.govern<never>(
          "computer_desktop_snapshot",
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
      const { windowId, from } = input;
      if (typeof windowId !== "string" || !DESKTOP_WINDOW_ID.test(windowId))
        return refuse(desktopMessage("no_window"));
      if (
        from !== undefined &&
        (typeof from !== "string" || !DESKTOP_REF.test(from))
      )
        return refuse(desktopMessage("stale"));
      // Refused outright (a disabled tool): before the machine is asked anything, the list included.
      const refused = await deps.approvalRefusal?.({
        actorId: actor.id,
        botId,
        toolRef: "computer_desktop_snapshot",
        effect: "read",
        scope: "desktop",
        args: currentApprovalContext()?.args ?? input,
        subject: { runner: true },
      });
      if (refused) return refuse(refused);
      const key = desktopCacheKey(machine, botId);
      let window = deps.windows.find(key, windowId);
      if (!window) {
        await fetchWindows(machine, botId, signal);
        window = deps.windows.find(key, windowId);
      }
      if (!window) return refuse(desktopMessage("no_window"));
      const word = sensitiveWord(window.title, DESKTOP_WINDOW_WORDS);
      if (word && !deps.hasApprovalGate) return refuse(desktopNoGate(word));
      const screenshot = input.screenshot === true;
      const result = await deps.govern<DesktopSnapshot>(
        "computer_desktop_snapshot",
        botId,
        actor,
        {
          device: machine,
          ...(signal ? { signal } : {}),
          desktop: {
            windowId,
            title: window.title,
            process: window.process,
            screenshot,
            ...(word ? { sensitiveWord: word } : {}),
          },
        },
        /*
         * Reaching here means the gate let the read through: a plain title passes, and a sensitive one
         * is raised to an ask by the floor and runs only once approved. So this is the one place the
         * machine is told it may read a sensitive window.
         */
        () =>
          deps.post<DesktopSnapshot>(
            botId,
            "/desktop/snapshot",
            {
              windowId,
              ...(from ? { from } : {}),
              ...(screenshot ? { screenshot: true } : {}),
              allowSensitive: word !== undefined,
            },
            signal,
            DESKTOP_BACKSTOP_MS,
            runnerAddress(machine),
          ),
      );
      return withUntrustedNotice(result, "desktop window", [
        "window",
        "elements",
      ]);
    },
  };
}

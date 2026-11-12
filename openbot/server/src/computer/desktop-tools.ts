import { z } from "zod";
import {
  DESKTOP_KEYS,
  DESKTOP_LIMITS,
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
} from "../../../shared/desktop-control";
import { LOCAL_TOOL_DESCRIPTIONS } from "../../../shared/local-tools";
import type { ActionActor, ComputerGateway } from "./gateway";
import type { HeadlessTool } from "./headless-tools";

/*
 * The Bot's desktop tools on the owner's paired computer.
 *
 * Two read tools (phase 1): list the windows (Windows, macOS, or Linux as a trial), and read one of
 * them. Four write tools (phase 2, plan docs/plans/2026-11-12-desktop-write.md, Task 23): click a
 * control, type into one, press a key combination, bring a window to the front. They are named as
 * `DESKTOP_WRITE_TOOLS` (approvals/desktop-policy.ts) has them, so disabling 操作桌面 hides all four
 * (`createHeadlessComputerTools`) and the gateway refuses them anyway.
 *
 * Offered only where the local apps are (the owner's own run on a device), and governed, recorded
 * and asked about by the gateway: a session first, then whatever each write needs on its own.
 */

// The words the model reads, kept once in `shared/local-tools.ts` so the web chat's copy is the same.
export const DESKTOP_WINDOWS_DESCRIPTION: string =
  LOCAL_TOOL_DESCRIPTIONS.computer_desktop_windows;

export const DESKTOP_SNAPSHOT_DESCRIPTION: string =
  LOCAL_TOOL_DESCRIPTIONS.computer_desktop_snapshot;

/** What every write tool says about the session, stale refs and Linux. */
const DESKTOP_WRITE_TERMS =
  "Needs a desktop session: the first call asks the person, who sees a banner and can stop it by moving the mouse or pressing Ctrl+Alt+Esc. A refusal or a stop is final for that step: do not retry it in other words. After any change, read the window again; refs from before are refused. Linux computers are read-only.";

export const DESKTOP_CLICK_DESCRIPTION = `Click one control in a window on the person's own paired computer, by its ref from the latest computer_desktop_snapshot of that window. Clicking a control named like Send, Delete or Pay asks every time. ${DESKTOP_WRITE_TERMS}`;

export const DESKTOP_TYPE_DESCRIPTION = `Type text into one text box in a window on the person's own paired computer, by its ref from the latest computer_desktop_snapshot of that window. mode replace (the default) replaces what the box holds; append adds to the end. At most ${DESKTOP_LIMITS.textMaxBytes} bytes of UTF-8. Never types Enter for you; a newline into a one-line field counts as submitting. Password fields are refused: use computer_request_secret. Tab and other control characters ask every time. ${DESKTOP_WRITE_TERMS}`;

export const DESKTOP_KEY_DESCRIPTION = `Press one key combination in a window on the person's own paired computer, by its windowId from the latest computer_desktop_windows: lower case, joined by +, up to three modifiers (ctrl, alt, shift, cmd, win) and one key, such as cmd+s or ctrl+shift+z. Use cmd on macOS and ctrl on Windows. Enter and Ctrl+Enter ask every time; closing a program (Alt+F4, Cmd+Q) asks; system shortcuts (Win+R, Cmd+Space, Ctrl+Alt+Del, lock, log out) are refused. The window must be in front: call computer_desktop_focus first. Space alone, or with Shift, asks every time (it presses the focused button). ${DESKTOP_WRITE_TERMS}`;

export const DESKTOP_FOCUS_DESCRIPTION = `Bring one window on the person's own paired computer to the front, by its windowId from the latest computer_desktop_windows; computer_desktop_key needs it in front. ${DESKTOP_WRITE_TERMS}`;

/** The factory of `headless-tools.ts`: parses the arguments and runs as the tool call. */
export type DesktopToolFactory = <T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  execute: (
    input: z.output<T>,
    context: { toolCallId: string; signal: AbortSignal },
  ) => Promise<unknown>,
) => HeadlessTool;

export function desktopTools(
  tool: DesktopToolFactory,
  deps: { gateway: ComputerGateway; botId: string; actor: ActionActor },
): HeadlessTool[] {
  const { gateway, botId, actor } = deps;
  const ref = z.string().regex(DESKTOP_REF);
  const windowId = z.string().regex(DESKTOP_WINDOW_ID);
  return [
    tool(
      "computer_desktop_windows",
      DESKTOP_WINDOWS_DESCRIPTION,
      z.strictObject({}),
      async (_input, { signal }) => ({
        ok: true,
        ...(await gateway.listDesktopWindows(botId, actor, signal)),
      }),
    ),
    tool(
      "computer_desktop_snapshot",
      DESKTOP_SNAPSHOT_DESCRIPTION,
      z.strictObject({
        windowId,
        from: ref.optional(),
        screenshot: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.snapshotDesktop(botId, actor, input, signal)),
      }),
    ),
    // The writes return the gateway's own answer, which already says `ok: true`.
    tool(
      "computer_desktop_click",
      DESKTOP_CLICK_DESCRIPTION,
      z.strictObject({ ref }),
      async (input, { signal }) =>
        gateway.clickDesktop(botId, actor, input, signal),
    ),
    tool(
      "computer_desktop_type",
      DESKTOP_TYPE_DESCRIPTION,
      z.strictObject({
        ref,
        text: z
          .string()
          .min(1)
          .refine(
            (text) =>
              Buffer.byteLength(text, "utf8") <= DESKTOP_LIMITS.textMaxBytes,
            {
              message: `At most ${DESKTOP_LIMITS.textMaxBytes} bytes of UTF-8.`,
            },
          ),
        mode: z.enum(["replace", "append"]).default("replace"),
      }),
      async (input, { signal }) =>
        gateway.typeDesktop(botId, actor, input, signal),
    ),
    tool(
      "computer_desktop_key",
      DESKTOP_KEY_DESCRIPTION,
      z.strictObject({ windowId, keys: z.string().regex(DESKTOP_KEYS) }),
      async (input, { signal }) =>
        gateway.pressDesktopKey(botId, actor, input, signal),
    ),
    tool(
      "computer_desktop_focus",
      DESKTOP_FOCUS_DESCRIPTION,
      z.strictObject({ windowId }),
      async (input, { signal }) =>
        gateway.focusDesktopWindow(botId, actor, input, signal),
    ),
  ];
}

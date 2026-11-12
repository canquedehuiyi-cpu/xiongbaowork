import { z } from "zod";
import {
  DESKTOP_REF,
  DESKTOP_WINDOW_ID,
} from "../../../shared/desktop-control";
import { LOCAL_TOOL_DESCRIPTIONS } from "../../../shared/local-tools";
import type { ActionActor, ComputerGateway } from "./gateway";
import type { HeadlessTool } from "./headless-tools";

/*
 * The Bot's two desktop tools (device-side desktop viewing, Phase 1): list the windows on the owner's
 * paired computer (Windows, macOS, or Linux as a trial), and read one of them. Read only, and nothing
 * more: neither tool takes anything that clicks, types, presses a key or launches a program.
 * Offered only where the local apps are (the owner's own run on a device), and governed, recorded
 * and asked about by the gateway.
 */

// The words the model reads, kept once in `shared/local-tools.ts` so the web chat's copy is the same.
export const DESKTOP_WINDOWS_DESCRIPTION: string =
  LOCAL_TOOL_DESCRIPTIONS.computer_desktop_windows;

export const DESKTOP_SNAPSHOT_DESCRIPTION: string =
  LOCAL_TOOL_DESCRIPTIONS.computer_desktop_snapshot;

/** The `tool()` factory of `headless-tools.ts`: parses the arguments and runs as the tool call. */
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
        windowId: z.string().regex(DESKTOP_WINDOW_ID),
        from: z.string().regex(DESKTOP_REF).optional(),
        screenshot: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.snapshotDesktop(botId, actor, input, signal)),
      }),
    ),
  ];
}

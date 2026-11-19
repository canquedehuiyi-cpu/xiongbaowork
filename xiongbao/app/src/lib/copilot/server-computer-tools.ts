import { createContext, useContext } from "react";
import {
  COMPUTER_TOOLS_PROP,
  SERVER_COMPUTER_TOOLS,
} from "../../../../shared/turn-notices";

/**
 * Who runs a chat's computer tools: the page, or the server (期九).
 *
 * The page used to run every one of them: the Bot's run ended at each call, the page forwarded it to
 * the computer and started the next run, so a page that closed took the task with it. With the
 * deployment's switch on (`chatServerComputerTools` on `/api/capabilities`), the page says so in each
 * run's `forwardedProps`, the server runs the turn from its first model step to its last, and the page
 * is only a viewer: it draws the tools and registers nothing that runs them.
 *
 * ONE ANSWER, TWO HALVES. The declaration and the tools' lack of handlers come from the same flag, so a
 * page can never tell the server to run a tool and also run it itself.
 */

/** What every run carries when the server runs its computer tools: nothing otherwise. */
export function serverComputerRunProperties(
  serverRuns: boolean,
): Record<string, unknown> {
  return serverRuns ? { [COMPUTER_TOOLS_PROP]: SERVER_COMPUTER_TOOLS } : {};
}

/**
 * The tools the server holds when it runs a chat's computer: the same names it drops from the page's
 * own offer (`isComputerToolName` in `server/src/threads/chat-server-tools.ts`).
 */
export function isServerHeldTool(name: string): boolean {
  return name.startsWith("computer_") || name === "report_refusal";
}

/** Whether this page's computer tools are the server's, so it registers their drawing and nothing else. */
const ServerComputerToolsContext = createContext(false);

export const ServerComputerToolsProvider = ServerComputerToolsContext.Provider;

export function useServerComputerTools(): boolean {
  return useContext(ServerComputerToolsContext);
}

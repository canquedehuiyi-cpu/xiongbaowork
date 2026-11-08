/**
 * 「发现的应用」: the rules of the list that sits above 手动添加, with nothing that needs a window,
 * so `tests/discover.test.ts` can check them under Bun. `main.js` wires them to the page.
 *
 * The runner's `--discover-apps` reply is names only (name, a fixed source label, a status and a
 * note, an opaque reference); no command, path or key is in it, and none is shown here. The switch
 * is the owner's own act on their own computer, so turning it on asks nothing first.
 */

export const EMPTY_HINT =
  "没有发现可用的本机应用。可以在下面「高级：手动添加」里自己添加。";

/** @typedef {(command: string, args?: Record<string, unknown>) => Promise<unknown>} Invoke */

/**
 * @param {any} reply the runner's discovery reply
 * @returns {{ items: { ref: string, app: string | undefined, name: string, source: string, on: boolean, disabled: boolean, note: string }[], empty?: string, installedCount: number }}
 */
export function describeCandidates(reply) {
  const candidates = Array.isArray(reply?.candidates) ? reply.candidates : [];
  const installedCount = Array.isArray(reply?.installed)
    ? reply.installed.length
    : 0;
  if (reply?.platform !== "win32" || candidates.length === 0) {
    return { items: [], empty: EMPTY_HINT, installedCount };
  }
  return {
    items: candidates.map((candidate) => ({
      ref: candidate.ref,
      app: candidate.app,
      name: candidate.name,
      source: candidate.sourceLabel ?? "",
      on: candidate.enabled === true,
      disabled: candidate.status !== "ready",
      note: candidate.note ?? "",
    })),
    installedCount,
  };
}

/**
 * Switch one candidate. Turning on one that is not registered yet registers and tests it; one that
 * is registered is only switched. Resolves to the sentence to show.
 *
 * @param {{ ref: string, app?: string | undefined }} item
 * @param {boolean} on
 * @param {Invoke} invoke
 * @returns {Promise<{ message: string } | { error: string }>}
 */
export async function toggleCandidate(item, on, invoke) {
  try {
    if (on && !item.app) {
      await invoke("enable_candidate", { candidate: item.ref });
    } else {
      await invoke("set_app_enabled", { target: item.app, enabled: on });
    }
    return { message: on ? "已启用，员工可以使用" : "已停用" };
  } catch (error) {
    return { error: String(error) };
  }
}

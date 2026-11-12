import { mkdirSync, rmSync } from "node:fs";
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
import { AppHostError, type createAppHost } from "./app-host";
// --- app discovery (sub-project 3) ---
import {
  DISCOVER_ACTIONS,
  DISCOVER_FAILED,
  type DiscoverActions,
} from "./discover-actions";
// --- end app discovery ---
// --- desktop control (sub-project 2) ---
import { DESKTOP_ACTION_PREFIX } from "../../shared/desktop-control";
import { createDesktopActions, type DesktopActions } from "./desktop/actions";
// --- end desktop control ---
import { createGit, type Git } from "./git";
import { isRootRef, PROJECTS_DIR, type RootRegistry } from "./roots";

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
  /** Close every local app's connection (and its child process) before this process dies. */
  closeApps: () => Promise<void>;
  // --- desktop control (sub-project 2) ---
  /** Close the desktop helper (and its process) before this process dies. */
  closeDesktop: () => Promise<void>;
  // --- end desktop control ---
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

/**
 * The actions that may name a read-only root (story F1, stage 2). Everything else that names one is
 * refused: a write, a command run with a root as its folder, and any action added later, because a
 * root is a folder the owner offered to be read and nothing more.
 */
const ROOT_READS = new Set(["files.list", "files.read"]);
/**
 * The actions that may write in a root (story RES2, decision D3): a file write and a command run
 * there. Only in a root its owner registered `write` on this machine, and only when the server's own
 * frame says the project is writable (`writable: true`, which the gateway writes from the project and
 * never from a model's arguments). Either one missing and the root is read-only, as every F1 folder
 * always is.
 */
const ROOT_WRITES = new Set(["files.write", "exec"]);
const READ_ONLY =
  "That folder is read-only on this machine: it can be listed and read, never written to, changed or run in.";

/** The runner actions for a Git project (story RES2, §3.3). */
export const PROJECT_SYNC_ACTION = "projects.sync";
export const PROJECT_BRANCHES_ACTION = "projects.branches";

/** A clone's display name on this machine: the repository's own name, from its address. */
function repositoryName(url: string): string {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return tail.replace(/\.git$/, "") || "项目";
}

/** Where a runner's files live, where its commands run, and whose browser it drives. */
export function createRunnerExecutor(
  workspaceDir: string,
  browser?: RunnerBrowser,
  /** The owner's read-only folders. Absent means this machine offers none, so any root is unknown. */
  roots?: RootRegistry,
  /** `git`, for a Git project's clone and branch list. Tests hand in their own. */
  git: Git = createGit(),
  /** The owner's local MCP apps. Absent means this machine offers none. */
  apps?: ReturnType<typeof createAppHost>,
  // --- app discovery (sub-project 3) ---
  /** Discovery of the apps this machine could offer. Absent means this machine offers none. */
  // --- end app discovery ---
  // --- desktop control (sub-project 2) ---
  /** The same object carries the desktop actions; absent means the executor builds its own. */
  extras?: { discovery?: DiscoverActions; desktop?: DesktopActions },
  // --- end desktop control ---
): RunnerExecutor {
  // --- desktop control (sub-project 2) ---
  // Built here, started by nothing: the helper process only exists once a desktop action needs it.
  const desktop = extras?.desktop ?? createDesktopActions();
  // --- end desktop control ---
  const workspace = createWorkspace(workspaceDir);
  /*
   * A shell of its own for each command (`oneShot`), not agent-computer's live shell: this runs on a
   * person's own machine, where a Mac's bash is too old for the live shell and nobody watches it.
   */
  const shell = createShell(workspaceDir, process.env, { oneShot: true });
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

  /**
   * An app action's failure, in the words the owner and the model read.
   *
   * Only a call can have acted: a call that timed out, lost its connection or was stopped once it
   * was sent may have changed something in the app, so it is "outcome unknown" and pauses the device
   * until its owner looks. A call refused or stopped before it was sent (the host marks that abort
   * `sent: false`), one whose app was not even listening (`unreachable`), and every list did nothing.
   */
  function appFailure(error: unknown, calling: boolean): ActionOutcome {
    if (error instanceof Error && error.name === "AbortError") {
      return calling && (error as { sent?: boolean }).sent !== false
        ? { ok: false, error: "已在设备上停止。", outcomeUnknown: true }
        : { ok: false, error: "已在设备上停止。" };
    }
    if (error instanceof AppHostError) {
      const unknown =
        calling &&
        error.phase === "call" &&
        (error.kind === "timeout" || error.kind === "connect");
      return unknown
        ? { ok: false, error: error.userMessage, outcomeUnknown: true }
        : { ok: false, error: error.userMessage };
    }
    return { ok: false, error: "本机应用这次没有成功。" };
  }

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
      /*
       * A root is checked before anything else looks at the frame, so no action can reach a root's
       * files except the two reads below, and an unknown one is refused rather than read as "the
       * workspace". A command aimed at a root as its folder (`cwd`) is refused the same way: a
       * command can write wherever it runs.
       */
      const rootAsFolder = isRootRef(body.cwd);
      if (body.root !== undefined || rootAsFolder) {
        const writes = ROOT_WRITES.has(action);
        if (
          rootAsFolder ||
          (!ROOT_READS.has(action) && !writes) ||
          (writes && body.writable !== true)
        ) {
          return { ok: false, error: READ_ONLY };
        }
        if (typeof body.root !== "string" || !roots) {
          return {
            ok: false,
            error: "This machine has no folder by that reference.",
          };
        }
        const folder = roots.open(body.root);
        if (writes) {
          // The owner's say on this machine wins over the server's: a `read` root stays read-only.
          if (folder.mode !== "write" || !folder.write) {
            return {
              ok: false,
              error: `${READ_ONLY} Its owner registered it for reading only.`,
            };
          }
          if (action === "exec") {
            const command =
              typeof body.command === "string" ? body.command : undefined;
            if (!command?.trim()) {
              return { ok: false, error: "A command is required." };
            }
            // The command runs in the project's folder. The file tools stay confined to it whatever
            // the command does; the command itself is the gateway's to allow (SEC1 and the gate).
            const output = await createShell(folder.path, process.env, {
              oneShot: true,
            }).run({
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
          if (typeof body.contents !== "string") {
            return { ok: false, error: "The contents to write are required." };
          }
          return {
            ok: true,
            output: await folder.write(String(body.path ?? ""), body.contents, {
              append: body.append === true,
            }),
          };
        }
        return {
          ok: true,
          output:
            action === "files.list"
              ? await folder.list(
                  typeof body.path === "string" ? body.path : undefined,
                )
              : await folder.read(String(body.path ?? "")),
        };
      }
      /*
       * A Git project's sync: clone the branch, or bring this machine's clone to its tip (story RES2,
       * §3.3). The server sends the stored address and branch; `git.ts` checks both again before
       * anything runs. The clone lives in `<dataDir>/runner-projects/<ref>/` and is registered as a
       * `write` root only once `git` succeeded, so a failed clone leaves no root behind.
       */
      if (action === PROJECT_SYNC_ACTION) {
        if (!roots) {
          return { ok: false, error: "这台设备不能保存项目。" };
        }
        const asked = body.rootRef ?? null;
        if (asked !== null && !isRootRef(asked)) {
          return { ok: false, error: "项目的本机副本引用不对。" };
        }
        if (asked !== null && roots.list().some((root) => root.ref === asked)) {
          return {
            ok: false,
            error: "这个引用属于本机的一个文件夹，不是项目副本。",
          };
        }
        const ref = asked ?? roots.mintCloneRef();
        const known = roots.clone(ref);
        const dir = roots.clonePath(ref);
        const url = typeof body.url === "string" ? body.url : "";
        mkdirSync(join(dir, ".."), { recursive: true });
        try {
          const { commit } = await git.sync({
            url,
            branch: String(body.branch ?? ""),
            dir,
            ...(signal ? { signal } : {}),
          });
          if (!known) roots.registerClone(ref, repositoryName(url));
          return { ok: true, output: { rootRef: ref, commit } };
        } catch (error) {
          // A clone that never became a root is not left on disk for nothing to point at.
          if (!known && dir.includes(PROJECTS_DIR))
            rmSync(dir, { recursive: true, force: true });
          throw error;
        }
      }
      if (action === PROJECT_BRANCHES_ACTION) {
        return {
          ok: true,
          output: {
            branches: await git.branches({
              url: typeof body.url === "string" ? body.url : "",
              ...(signal ? { signal } : {}),
            }),
          },
        };
      }
      /*
       * The person removed the information source that pointed at a root, so the server asks this
       * machine to forget the folder too (spec §6.5). Only ever a removal: nothing the server sends
       * can register a folder, and forgetting one only takes access away.
       */
      if (action === "roots.forget") {
        return {
          ok: true,
          output: {
            removed:
              isRootRef(body.ref) && roots ? roots.remove(body.ref) : false,
          },
        };
      }
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
      // --- desktop control (sub-project 2) ---
      // Never throws and never says "outcome unknown": every desktop action here only reads. The
      // coworker goes in the context, from the transport, like the browser's identity: the caller's
      // payload never names the session it acts in.
      if (action.startsWith(DESKTOP_ACTION_PREFIX))
        return await desktop(action, callerPayload(body), signal, {
          botId: typeof body.botId === "string" ? body.botId : undefined,
        });
      // --- end desktop control ---
      // --- app discovery (sub-project 3) ---
      if (extras?.discovery && DISCOVER_ACTIONS.has(action)) {
        try {
          // Awaited here, so a handler that rejects is answered below and never reaches the journal
          // as "outcome unknown", which would pause the device.
          return await extras.discovery(action, body, signal);
        } catch {
          // Discovery only reads: a failure is never "unknown", and its message may name a path.
          return { ok: false, error: DISCOVER_FAILED };
        }
      }
      // --- end app discovery ---
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
        case "apps.tools": {
          if (!apps || typeof body.app !== "string" || !body.app) {
            return { ok: false, error: "这台电脑上没有这个本机应用，或它已停用。" };
          }
          try {
            return {
              ok: true,
              output: { tools: await apps.tools(body.app, signal) },
            };
          } catch (error) {
            return appFailure(error, false);
          }
        }
        case "apps.call": {
          if (!apps || typeof body.app !== "string" || !body.app) {
            return { ok: false, error: "这台电脑上没有这个本机应用，或它已停用。" };
          }
          if (typeof body.tool !== "string" || !body.tool) {
            return { ok: false, error: "没有指明要调用本机应用的哪个工具。" };
          }
          /*
           * What runs must be what the approval card showed: an array, a string or a number is never
           * quietly turned into empty arguments. Only an absent `args` means "none".
           */
          if (
            body.args !== undefined &&
            (body.args === null ||
              typeof body.args !== "object" ||
              Array.isArray(body.args))
          ) {
            return {
              ok: false,
              error: "本机应用的参数格式不对，应为一个 JSON 对象。",
            };
          }
          const args = (body.args ?? {}) as Record<string, unknown>;
          try {
            return {
              ok: true,
              output: await apps.call(body.app, body.tool, args, signal),
            };
          } catch (error) {
            return appFailure(error, true);
          }
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

  return Object.assign(execute, {
    closeBrowser: () => owned.close(),
    closeApps: () => apps?.closeAll() ?? Promise.resolve(),
    // --- desktop control (sub-project 2) ---
    closeDesktop: () => desktop.close(),
    // --- end desktop control ---
  });
}

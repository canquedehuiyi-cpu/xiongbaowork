import { and, eq } from "drizzle-orm";
import {
  checkProjectSource,
  type ProjectSource,
} from "../../../shared/projects";
import type { Database } from "../db/client";
import {
  projectContextBindings,
  registeredDevices,
  resourceProjects,
} from "../db/schema";
import { reportedRoots } from "../devices/store";
import { runAsTenant } from "../tenant/context";
import { withUntrustedNotice } from "../untrusted-content";

/**
 * A coworker's current project, as the gateway and the prompt see it (story RES2, spec §3.5).
 *
 * THE ROOT IS THE SERVER'S FACT. When a coworker's file or shell action is about to go to a machine,
 * the gateway asks `resolve` with the coworker and the machine the action resolved to, and the frame
 * it sends carries the project's `root` and `writable` from here. Nothing the model put in its
 * arguments names a root for those actions: the gateway builds the frame itself.
 *
 * NO QUIET FALLBACK (decision D9). A coworker that has a current project and cannot use it on this
 * machine is refused, with the reason, rather than sent to its own workspace as if it had none:
 *  - its project is on another machine (the action resolved to a different one);
 *  - the project's folder is no longer offered by the machine, or its Git clone does not exist yet;
 *  - the project it was told about at the start of this run is gone (deleted, or unpicked) — the
 *    binding row goes with a deleted project, so the run remembers what it was told (`announced`).
 * A coworker that never had a project works in its workspace, as before.
 *
 * WHOSE ROWS. The machine's owner's: an action goes to the owner's machine (`deviceForBot` resolves
 * a Team Bot to its owner), so the owner's binding for that machine and coworker is the one that
 * applies. Read in the owner's frame.
 *
 * NO PATH. The prompt section names the project, its description (inside the untrusted-content
 * envelope: the person typed it, it is not an instruction), its kind, a Git project's branch and last
 * commit, and whether files may be changed. Never a folder path, which the server does not have.
 */

export type ProjectRoot =
  | { ok: true; projectId: string; rootRef: string; writable: boolean }
  | { ok: false; reason: string };

export type ProjectForPrompt = {
  name: string;
  description: string;
  source: ProjectSource;
  /** Whether files may be changed: the project's setting and the folder's mode on the machine. */
  writable: boolean;
};

export type MachineTarget = { tenantId: string; deviceId: string };

export type ProjectContext = {
  /** The project an action of `botId` on `machine` runs in; null for none; a refusal for D9. */
  resolve: (
    botId: string,
    machine: MachineTarget,
  ) => Promise<ProjectRoot | null>;
  /** What the prompt says about the current project, and remembered for `resolve` (see above). */
  forPrompt: (
    botId: string,
    machine: MachineTarget | null,
  ) => Promise<ProjectForPrompt | null>;
};

const ANNOUNCED_LIMIT = 10_000;

const DELETED =
  "这位员工的当前项目已被删除或取消选用，动作没有执行，也没有改在员工自己的工作区里执行。请重新选择项目，或开始新的对话。";
const ELSEWHERE = (name: string) =>
  `这位员工的当前项目在另一台设备上（${name}），这次动作会发到别的设备，所以没有执行。请在这台设备上为它选择项目，或让任务在那台设备上运行。`;
const FOLDER_GONE =
  "当前项目的本地目录已不在设备上提供（可能在设备上被移除），动作没有执行。请在设备上重新登记目录，或为员工换一个项目。";
const NOT_SYNCED =
  "当前 Git 项目还没有同步到这台设备，动作没有执行。请先在「能力与资源 › 项目」里点「同步」。";
const NOT_ALLOWED = "当前项目已不允许这位员工使用，动作没有执行。";

export function createProjectContext(database: Database): ProjectContext {
  /** `tenant/bot` → the project this bot's latest prompt named, or absent for none. */
  const announced = new Map<string, string>();
  const keyOf = (tenantId: string, botId: string) => `${tenantId}/${botId}`;

  /** Every binding of the coworker in the owner's frame, with its project and machine. */
  async function bindings(tenantId: string, botId: string) {
    return runAsTenant(tenantId, () =>
      database
        .select({
          project: resourceProjects,
          runnerDeviceId: registeredDevices.deviceId,
          deviceName: registeredDevices.name,
          roots: registeredDevices.roots,
        })
        .from(projectContextBindings)
        .innerJoin(
          resourceProjects,
          eq(resourceProjects.id, projectContextBindings.projectId),
        )
        .innerJoin(
          registeredDevices,
          eq(registeredDevices.id, projectContextBindings.deviceId),
        )
        .where(
          and(
            eq(projectContextBindings.tenantId, tenantId),
            eq(projectContextBindings.agentId, botId),
          ),
        ),
    );
  }

  type Bound = Awaited<ReturnType<typeof bindings>>[number];

  /** The bound project on this machine, checked, or the sentence that says why it cannot be used. */
  function usable(
    bound: Bound,
    botId: string,
  ): { root: ProjectRoot; prompt: ProjectForPrompt | null } {
    const { project } = bound;
    const checked = checkProjectSource(project.source);
    if (!checked.ok || (project.scope === "agent" && project.agentId !== botId))
      return { root: { ok: false, reason: NOT_ALLOWED }, prompt: null };
    const source = checked.source;
    let writable = source.writable;
    if (source.kind === "local") {
      const root = (reportedRoots(bound.roots) ?? []).find(
        (entry) => entry.ref === source.rootRef,
      );
      if (!root)
        return { root: { ok: false, reason: FOLDER_GONE }, prompt: null };
      // Never wider than the folder's mode on the machine (D3); the runner enforces it again.
      writable = writable && root.mode === "write";
    } else if (!source.rootRef) {
      return { root: { ok: false, reason: NOT_SYNCED }, prompt: null };
    }
    const rootRef = source.rootRef as string;
    return {
      root: { ok: true, projectId: project.id, rootRef, writable },
      prompt: {
        name: project.name,
        description: project.description,
        source,
        writable,
      },
    };
  }

  return {
    async resolve(botId, machine) {
      const rows = await bindings(machine.tenantId, botId);
      const here = rows.find((row) => row.runnerDeviceId === machine.deviceId);
      if (here) return usable(here, botId).root;
      const elsewhere = rows[0];
      if (elsewhere)
        return { ok: false, reason: ELSEWHERE(elsewhere.deviceName) };
      // No binding anywhere. If this run was told it works in a project, that project went away.
      return announced.has(keyOf(machine.tenantId, botId))
        ? { ok: false, reason: DELETED }
        : null;
    },

    async forPrompt(botId, machine) {
      if (!machine) return null;
      const key = keyOf(machine.tenantId, botId);
      const rows = await bindings(machine.tenantId, botId);
      const here = rows.find((row) => row.runnerDeviceId === machine.deviceId);
      const prompt = here ? usable(here, botId).prompt : null;
      // Remembered so a project deleted during this run refuses instead of falling back (D9). A
      // binding that exists but cannot be used is refused by `resolve` on its own.
      if (here) {
        if (announced.size >= ANNOUNCED_LIMIT && !announced.has(key)) {
          const oldest = announced.keys().next().value;
          if (oldest !== undefined) announced.delete(oldest);
        }
        announced.set(key, here.project.id);
      } else announced.delete(key);
      return prompt;
    },
  };
}

/**
 * The prompt section for a current project, or null for none.
 *
 * The project's name and description are the person's own typing and go inside the untrusted-content
 * envelope; the sentence around them is ours. No path: the file tools take no root for a project,
 * because the gateway supplies it.
 */
export function projectGuidance(
  project: ProjectForPrompt | null | undefined,
): string | null {
  if (!project) return null;
  const access = project.writable
    ? "You may change files in it with computer_write_file and run commands in it with computer_run_command, subject to the same approvals as anywhere else."
    : "It is read-only: you can list and read its files, but writing a file or running a command there is refused. Say so if the task needs a change, instead of trying.";
  return [
    `You are working in the person's current project on their computer. Files and commands run in the project's root folder by default: computer_list_files, computer_read_file, computer_write_file and computer_run_command all act there, and paths are relative to the project's root. Do not pass a root for it; the project is chosen by the person, not by you, and you cannot switch to another one. ${access} If an action is refused because the project is unavailable, tell the person why and stop; do not try to do the work somewhere else.`,
    JSON.stringify(
      withUntrustedNotice(
        {
          project: {
            name: project.name,
            description: project.description,
            kind:
              project.source.kind === "git" ? "git repository" : "local folder",
            ...(project.source.kind === "git"
              ? {
                  branch: project.source.branch,
                  lastSyncedCommit: project.source.commit,
                }
              : {}),
            writable: project.writable,
          },
        },
        "project description",
        ["project"],
      ),
    ),
  ].join("\n");
}

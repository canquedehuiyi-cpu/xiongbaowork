import { Hono, type MiddlewareHandler } from "hono";
import { gitUrlProblem } from "../../../shared/projects";
import type { AppVariables } from "../auth/guards";
import { shortName } from "../brand";
import {
  isProjectId,
  ProjectRefusal,
  type ProjectStore,
  parseProjectChange,
  parseProjectInput,
} from "./store";

/**
 * `/api/projects` (story RES2): the signed-in person's projects, on their own machines.
 *
 *   GET    /?device=<id>[&agent=<id>]   a machine's projects; with `agent`, only those that
 *                                       coworker may pick, and which one it works in now
 *   GET    /:id                         one project
 *   POST   /                            a new project
 *   PATCH  /:id                         a change, made against the revision it was read at
 *   DELETE /:id                         remove it (and every binding to it)
 *   PUT    /current                     choose a coworker's current project on a machine, or clear it
 *   POST   /:id/sync                    fetch a Git project's branch on its machine (never on the server)
 *   POST   /branches                    list a repository's branches, asked of the machine
 *
 * Only a person reaches these, through `requireUser`: no coworker has a tool that creates, changes or
 * picks a project (decision D8). Every read and write is keyed by the person the session names.
 *
 * GIT RUNS ON THE MACHINE. The sync and the branch list are frames to the machine's runner, which
 * runs `git` there with its owner's own credentials (decision D4); this server checks the address's
 * shape and never connects to it. The address and branch in a sync frame are the stored project's,
 * not anything the request body says. A machine that is not connected right now is told so instead of
 * having the request parked for later: a sync is something a person is waiting to see.
 */

/** How the routes reach a machine. Absent in a deployment with no device channel. */
export type ProjectDevices = {
  isReachable: (target: { tenantId: string; deviceId: string }) => boolean;
  dispatch: <T>(
    target: { tenantId: string; deviceId: string },
    action: string,
    payload: unknown,
    timeoutMs?: number,
  ) => Promise<T>;
};

/** The runner actions these routes send. */
export const PROJECT_SYNC_ACTION = "projects.sync";
export const PROJECT_BRANCHES_ACTION = "projects.branches";
/** A clone of a large repository over a home connection takes a while. */
const SYNC_TIMEOUT_MS = 10 * 60_000;
const BRANCHES_TIMEOUT_MS = 60_000;
const BRANCH_LIST_LIMIT = 500;

export function createProjectRoutes(
  store: ProjectStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  devices?: ProjectDevices,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** A refusal is answered with its sentence and status; anything else is the server's own failure. */
  const refusal = (error: unknown): ProjectRefusal => {
    if (error instanceof ProjectRefusal) return error;
    throw error;
  };

  /** The machine a request names, connected now, or the sentence that says why not. */
  async function reachable(personId: string, deviceId: string) {
    if (!devices) throw new ProjectRefusal("这个部署没有连接设备的通道。", 409);
    const machine = await store.machineOf(personId, deviceId);
    if (!machine) throw new ProjectRefusal("找不到这台设备。", 404);
    const target = { tenantId: personId, deviceId: machine.runnerDeviceId };
    if (!devices.isReachable(target))
      throw new ProjectRefusal(
        `设备当前离线，无法同步或列出分支。请在设备上打开${shortName()}设备端后再试。`,
        409,
      );
    return target;
  }

  const deviceError = (error: unknown) =>
    new ProjectRefusal(
      `设备没有完成这个请求：${error instanceof Error && error.message ? error.message : "未知错误"}`,
      409,
    );

  routes.get("/", requireUser, async (context) => {
    const device = context.req.query("device") ?? "";
    if (!isProjectId(device))
      return context.json({ error: "请先选择一台设备。" }, 400);
    const agent = context.req.query("agent")?.trim() || undefined;
    const personId = context.var.actor.id;
    const projects = await store.list(personId, device, agent);
    if (!agent) return context.json({ projects });
    const current = await store.current(personId, device, agent);
    return context.json({ projects, currentProjectId: current?.id ?? null });
  });

  routes.put("/current", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      deviceId?: unknown;
      agentId?: unknown;
      projectId?: unknown;
    };
    if (!isProjectId(body.deviceId))
      return context.json({ error: "请先选择一台设备。" }, 400);
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) return context.json({ error: "请选择一位员工。" }, 400);
    if (body.projectId !== null && !isProjectId(body.projectId))
      return context.json({ error: "找不到这个项目。" }, 404);
    try {
      const project = await store.choose(
        context.var.actor.id,
        body.deviceId,
        agentId,
        body.projectId,
      );
      return context.json({ project });
    } catch (error) {
      const { message, status } = refusal(error);
      return context.json({ error: message }, status);
    }
  });

  routes.post("/branches", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      deviceId?: unknown;
      url?: unknown;
    };
    if (!isProjectId(body.deviceId))
      return context.json({ error: "请先选择一台设备。" }, 400);
    const problem = gitUrlProblem(body.url);
    if (problem) return context.json({ error: problem }, 400);
    try {
      const target = await reachable(context.var.actor.id, body.deviceId);
      const answer = await devices
        ?.dispatch<{ branches?: unknown }>(
          target,
          PROJECT_BRANCHES_ACTION,
          { url: String(body.url).trim() },
          BRANCHES_TIMEOUT_MS,
        )
        .catch((error) => {
          throw deviceError(error);
        });
      // What a machine sends is untrusted: only names, only strings, only so many.
      const branches = Array.isArray(answer?.branches)
        ? answer.branches
            .filter(
              (name): name is string =>
                typeof name === "string" && name.length <= 200,
            )
            .slice(0, BRANCH_LIST_LIMIT)
        : [];
      return context.json({ branches });
    } catch (error) {
      const { message, status } = refusal(error);
      return context.json({ error: message }, status);
    }
  });

  routes.get("/:id", requireUser, async (context) => {
    const project = await store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    return project
      ? context.json({ project })
      : context.json({ error: "找不到这个项目。" }, 404);
  });

  routes.post("/", requireUser, async (context) => {
    const body = await context.req.json().catch(() => undefined);
    try {
      const project = await store.create(
        context.var.actor.id,
        parseProjectInput(body),
      );
      return context.json({ project }, 201);
    } catch (error) {
      const { message, status } = refusal(error);
      return context.json({ error: message }, status);
    }
  });

  routes.patch("/:id", requireUser, async (context) => {
    const body = await context.req.json().catch(() => undefined);
    try {
      const project = await store.update(
        context.var.actor.id,
        context.req.param("id"),
        parseProjectChange(body),
      );
      return context.json({ project });
    } catch (error) {
      const { message, status } = refusal(error);
      return context.json({ error: message }, status);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const removed = await store.remove(
      context.var.actor.id,
      context.req.param("id"),
    );
    return removed
      ? context.json({ removed: true })
      : context.json({ error: "找不到这个项目。" }, 404);
  });

  routes.post("/:id/sync", requireUser, async (context) => {
    const personId = context.var.actor.id;
    try {
      const project = await store.get(personId, context.req.param("id"));
      if (!project) throw new ProjectRefusal("找不到这个项目。", 404);
      if (project.source.kind !== "git")
        throw new ProjectRefusal("只有 Git 项目可以同步。", 400);
      const target = await reachable(personId, project.deviceId);
      // The stored project's address and branch, never the request's (spec §3.3).
      const report = await devices
        ?.dispatch<{ rootRef?: unknown; commit?: unknown }>(
          target,
          PROJECT_SYNC_ACTION,
          {
            rootRef: project.source.rootRef,
            url: project.source.url,
            branch: project.source.branch,
          },
          SYNC_TIMEOUT_MS,
        )
        .catch((error) => {
          throw deviceError(error);
        });
      const synced = await store.recordSync(personId, project.id, {
        rootRef: typeof report?.rootRef === "string" ? report.rootRef : "",
        commit: typeof report?.commit === "string" ? report.commit : "",
      });
      return context.json({ project: synced });
    } catch (error) {
      const { message, status } = refusal(error);
      return context.json({ error: message }, status);
    }
  });

  return routes;
}

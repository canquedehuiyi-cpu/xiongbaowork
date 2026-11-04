import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import {
  checkProjectSource,
  COMMIT_PATTERN,
  type GitProjectSource,
  gitBranchProblem,
  gitUrlProblem,
  isRootRef,
  PROJECT_DESCRIPTION_LIMIT,
  PROJECT_LIMIT_PER_DEVICE,
  PROJECT_NAME_LIMIT,
  type ProjectSource,
} from "../../../shared/projects";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  OFFLINE_AFTER_MS,
  projectContextBindings,
  registeredDevices,
  resourceProjects,
} from "../db/schema";
import { TEAM_TENANT } from "../db/schema/tenant";
import { reportedRoots } from "../devices/store";
import { runAsTenant } from "../tenant/context";

/**
 * Projects (story RES2, phase 1): a folder or a Git repository on one of the person's paired machines,
 * which their coworkers can be told to work in.
 *
 * WHAT A PROJECT IS. A row of `resource_projects` (the dormant 0104 table, made live by 0138): a name,
 * a description and a source (`shared/projects.ts`). A local project names a folder the machine's
 * owner registered there, by the runner's opaque reference; a Git project names a repository and a
 * branch, and after the first sync the reference of the runner's own clone. The server keeps no
 * path and no credential, and never connects to a repository (decision D4).
 *
 * WHO SEES ONE. A project belongs to one machine. `public` is offered to every coworker of this person
 * on that machine, their Team Bots included; `agent` is offered to the one coworker it names and to
 * nobody else, whoever knows its id. Only a person makes, changes or picks a project (decision D8):
 * every function here takes the person the session names, runs in that person's frame, and is
 * reached only from the person's own routes. No coworker has a tool that calls into it.
 *
 * THE CURRENT PROJECT. `project_context_bindings` holds, per (machine, coworker), the project that
 * coworker works in there. The database's own policies (0104, 0122) refuse a binding to a project on
 * another machine or to another coworker's own project, whoever writes it; this module asks the same
 * questions first so the person reads a sentence instead of a policy violation.
 */

export type ProjectScope = "public" | "agent";

export type Project = {
  id: string;
  /** The machine's row id (`registered_devices.id`), as the device list's `id`. */
  deviceId: string;
  scope: ProjectScope;
  /** The one coworker an `agent` project is for; null for `public`. */
  agentId: string | null;
  name: string;
  description: string;
  source: ProjectSource;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** What a new project's source is, as a person states it. The server fills in the rest. */
export type ProjectSourceInput =
  | { kind: "local"; rootRef: string; writable: boolean }
  | { kind: "git"; url: string; branch: string; writable: boolean };

export type ProjectInput = {
  deviceId: string;
  scope: ProjectScope;
  agentId: string | null;
  name: string;
  description: string;
  source: ProjectSourceInput;
};

/** The fields a change may touch. Absent fields are left as they are. */
export type ProjectChange = {
  /** The revision the change was made against; a project changed since is not overwritten. */
  revision: number;
  name?: string;
  description?: string;
  scope?: ProjectScope;
  agentId?: string | null;
  writable?: boolean;
  branch?: string;
};

/** A refusal a person can read and act on. The route answers each with its status and message. */
export class ProjectRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "ProjectRefusal";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const characters = (value: string) => [...value].length;

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function checkedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ProjectRefusal("请给项目起个名字。", 400);
  if (characters(name) > PROJECT_NAME_LIMIT)
    throw new ProjectRefusal(`项目名称最多 ${PROJECT_NAME_LIMIT} 个字。`, 400);
  return name;
}

function checkedDescription(value: unknown): string {
  if (value !== undefined && typeof value !== "string")
    throw new ProjectRefusal("项目简介必须是文字。", 400);
  const description = (value ?? "").trim();
  if (characters(description) > PROJECT_DESCRIPTION_LIMIT)
    throw new ProjectRefusal(
      `项目简介最多 ${PROJECT_DESCRIPTION_LIMIT} 个字。`,
      400,
    );
  return description;
}

function checkedScope(
  scope: unknown,
  agentId: unknown,
): { scope: ProjectScope; agentId: string | null } {
  if (scope === undefined || scope === "public") {
    if (agentId !== undefined && agentId !== null && agentId !== "")
      throw new ProjectRefusal("公开项目不属于某一位员工。", 400);
    return { scope: "public", agentId: null };
  }
  if (scope === "agent") {
    const id = typeof agentId === "string" ? agentId.trim() : "";
    if (!id) throw new ProjectRefusal("员工专属项目需要选择一位员工。", 400);
    return { scope: "agent", agentId: id };
  }
  throw new ProjectRefusal("项目范围只能是公开或员工专属。", 400);
}

/** A new project as the person sent it, checked, or the sentence that says why not. */
export function parseProjectInput(body: unknown): ProjectInput {
  const input = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  const deviceId = input.deviceId;
  if (!isProjectId(deviceId))
    throw new ProjectRefusal("请先选择一台设备。", 400);
  const source = (
    typeof input.source === "object" && input.source !== null
      ? input.source
      : {}
  ) as Record<string, unknown>;
  const writable = source.writable === true;
  if (source.writable !== undefined && typeof source.writable !== "boolean")
    throw new ProjectRefusal("请说明项目是否可写。", 400);
  let parsed: ProjectSourceInput;
  if (source.kind === "local") {
    if (!isRootRef(source.rootRef))
      throw new ProjectRefusal("请选择设备上已登记的本地目录。", 400);
    parsed = { kind: "local", rootRef: source.rootRef, writable };
  } else if (source.kind === "git") {
    const urlProblem = gitUrlProblem(source.url);
    if (urlProblem) throw new ProjectRefusal(urlProblem, 400);
    const branchProblem = gitBranchProblem(source.branch);
    if (branchProblem) throw new ProjectRefusal(branchProblem, 400);
    parsed = {
      kind: "git",
      url: String(source.url).trim(),
      branch: String(source.branch).trim(),
      // A clone is the machine's own copy, not the person's working folder, so it is writable unless
      // the person says otherwise (spec §3.3).
      writable: source.writable === undefined ? true : writable,
    };
  } else {
    throw new ProjectRefusal("请选择项目来源：本地目录或 Git 仓库。", 400);
  }
  return {
    deviceId,
    ...checkedScope(input.scope, input.agentId),
    name: checkedName(input.name),
    description: checkedDescription(input.description),
    source: parsed,
  };
}

/** A change as the person sent it, checked. */
export function parseProjectChange(body: unknown): ProjectChange {
  const input = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  if (
    typeof input.revision !== "number" ||
    !Number.isInteger(input.revision) ||
    input.revision < 1
  )
    throw new ProjectRefusal("修改需要带上项目当前的版本号。", 400);
  const change: ProjectChange = { revision: input.revision };
  if (input.name !== undefined) change.name = checkedName(input.name);
  if (input.description !== undefined)
    change.description = checkedDescription(input.description);
  if (input.scope !== undefined) {
    const scoped = checkedScope(input.scope, input.agentId);
    change.scope = scoped.scope;
    change.agentId = scoped.agentId;
  } else if (input.agentId !== undefined) {
    throw new ProjectRefusal("修改员工时请同时说明项目范围。", 400);
  }
  if (input.writable !== undefined) {
    if (typeof input.writable !== "boolean")
      throw new ProjectRefusal("请说明项目是否可写。", 400);
    change.writable = input.writable;
  }
  if (input.branch !== undefined) {
    const problem = gitBranchProblem(input.branch);
    if (problem) throw new ProjectRefusal(problem, 400);
    change.branch = String(input.branch).trim();
  }
  return change;
}

/**
 * Whether the database refused the statement for want of privilege (SQLSTATE 42501), or because a
 * CHECK did not hold (23514). The query builder wraps the driver's error, so it may sit on the error
 * or on its cause; Bun's driver puts the SQLSTATE in `errno`, other drivers in `code`.
 */
function sqlState(error: unknown): string | undefined {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 4;
    current = (current as Error & { cause?: unknown }).cause, depth += 1
  ) {
    const { code, errno } = current as Error & {
      code?: unknown;
      errno?: unknown;
    };
    for (const value of [errno, code])
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value))
        return value;
  }
  return undefined;
}

type Row = typeof resourceProjects.$inferSelect;

/** A row as the person sees it. A source the shared check cannot read is not shown at all. */
function shown(row: Row): Project | null {
  const checked = checkProjectSource(row.source);
  if (!checked.ok) return null;
  return {
    id: row.id,
    deviceId: row.deviceId,
    scope: row.scope === "agent" ? "agent" : "public",
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    source: checked.source,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const visible = (rows: Row[]) =>
  rows.map(shown).filter((project): project is Project => project !== null);

/** What a machine's runner reported after a sync of a Git project. */
export type SyncReport = { rootRef: string; commit: string };

/** The machine a project is on, as the device channel addresses it. */
export type ProjectMachine = {
  /** `registered_devices.device_id`: the runner's own id, which the device channel is keyed by. */
  runnerDeviceId: string;
  online: boolean;
};

export type ProjectStore = {
  /**
   * A machine's projects. With `agentId`, only those that coworker may pick there: the public ones
   * and its own. Without, every project on the machine, for the person's own list.
   */
  list: (
    personId: string,
    deviceId: string,
    agentId?: string,
  ) => Promise<Project[]>;
  get: (personId: string, projectId: string) => Promise<Project | null>;
  create: (personId: string, input: ProjectInput) => Promise<Project>;
  update: (
    personId: string,
    projectId: string,
    change: ProjectChange,
  ) => Promise<Project>;
  remove: (personId: string, projectId: string) => Promise<boolean>;
  /** The project a coworker currently works in on a machine, or null. */
  current: (
    personId: string,
    deviceId: string,
    agentId: string,
  ) => Promise<Project | null>;
  /** Make a project the coworker's current one on its machine, or, with null, clear it. */
  choose: (
    personId: string,
    deviceId: string,
    agentId: string,
    projectId: string | null,
  ) => Promise<Project | null>;
  /** The runner id of the machine a project is on, for the sync and branch requests. */
  machineOf: (
    personId: string,
    deviceId: string,
  ) => Promise<ProjectMachine | null>;
  /** Record what a sync of a Git project left on the machine. */
  recordSync: (
    personId: string,
    projectId: string,
    report: SyncReport,
  ) => Promise<Project>;
};

export function createProjectStore(database: Database): ProjectStore {
  type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

  /** The person's machine, read in their frame and filtered by their id as well. */
  async function machine(tx: Tx | Database, personId: string, id: string) {
    if (!isProjectId(id)) return null;
    const [device] = await tx
      .select({
        id: registeredDevices.id,
        deviceId: registeredDevices.deviceId,
        roots: registeredDevices.roots,
        lastSeenAt: registeredDevices.lastSeenAt,
      })
      .from(registeredDevices)
      .where(
        and(
          eq(registeredDevices.tenantId, personId),
          eq(registeredDevices.id, id),
        ),
      )
      .limit(1);
    return device ?? null;
  }

  /**
   * Whether a coworker is this person's to give a project to: one of their own, or a Team Bot whose
   * profile names them. The same two families the 0104 and 0122 policies admit, asked first so the
   * answer is a sentence; the policies stay the floor.
   */
  async function ownCoworker(tx: Tx, personId: string, agentId: string) {
    const [row] = await tx
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      .where(
        and(
          eq(agents.id, agentId),
          or(eq(agents.tenantId, personId), eq(agents.tenantId, TEAM_TENANT)),
          eq(agentProfiles.ownerUserId, personId),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async function row(tx: Tx | Database, personId: string, projectId: string) {
    if (!isProjectId(projectId)) return null;
    const [found] = await tx
      .select()
      .from(resourceProjects)
      .where(
        and(
          eq(resourceProjects.tenantId, personId),
          eq(resourceProjects.id, projectId),
        ),
      )
      .limit(1);
    return found ?? null;
  }

  /**
   * A local folder's mode on the machine right now: `write` only when the machine's owner registered
   * it so (decision D3). The server can make a project stricter than its folder, never wider.
   */
  function folderOf(
    device: { roots: unknown },
    rootRef: string,
  ): { name: string; writable: boolean } | null {
    const root = (reportedRoots(device.roots) ?? []).find(
      (entry) => entry.ref === rootRef,
    );
    if (!root) return null;
    // The mode is read from the stored report itself: no mode, or anything but `write`, is read-only.
    const stored = Array.isArray(device.roots)
      ? (device.roots as Array<{ ref?: unknown; mode?: unknown }>).find(
          (entry) => entry?.ref === rootRef,
        )
      : undefined;
    return { name: root.name, writable: stored?.mode === "write" };
  }

  /** Run a write, turning the database's refusals into sentences. */
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProjectRefusal) throw error;
      const state = sqlState(error);
      if (state === "42501")
        throw new ProjectRefusal("没有权限为这位员工或这台设备保存项目。", 403);
      if (state === "23514")
        throw new ProjectRefusal("项目内容不符合要求。", 400);
      throw error;
    }
  }

  const lockDevice = (tx: Tx, deviceId: string) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`resource_projects:${deviceId}`}, 0))`,
    );

  return {
    list: (personId, deviceId, agentId) =>
      runAsTenant(personId, async () => {
        if (!isProjectId(deviceId)) return [];
        const rows = await database
          .select()
          .from(resourceProjects)
          .where(
            and(
              eq(resourceProjects.tenantId, personId),
              eq(resourceProjects.deviceId, deviceId),
              agentId === undefined
                ? undefined
                : or(
                    eq(resourceProjects.scope, "public"),
                    and(
                      eq(resourceProjects.scope, "agent"),
                      eq(resourceProjects.agentId, agentId),
                    ),
                  ),
            ),
          )
          .orderBy(asc(resourceProjects.createdAt), asc(resourceProjects.id));
        return visible(rows);
      }),

    get: (personId, projectId) =>
      runAsTenant(personId, async () => {
        const found = await row(database, personId, projectId);
        return found ? shown(found) : null;
      }),

    create: (personId, input) =>
      runAsTenant(personId, () =>
        guarded(() =>
          database.transaction(async (tx) => {
            const device = await machine(tx, personId, input.deviceId);
            if (!device) throw new ProjectRefusal("找不到这台设备。", 404);
            // One machine's projects are counted one save at a time, so two at once cannot both be
            // the fifty-first.
            await lockDevice(tx, device.id);
            const [held] = await tx
              .select({ value: count() })
              .from(resourceProjects)
              .where(
                and(
                  eq(resourceProjects.tenantId, personId),
                  eq(resourceProjects.deviceId, device.id),
                ),
              );
            if ((held?.value ?? 0) >= PROJECT_LIMIT_PER_DEVICE)
              throw new ProjectRefusal(
                `每台设备最多 ${PROJECT_LIMIT_PER_DEVICE} 个项目。请先删掉不再需要的。`,
                409,
              );
            if (
              input.scope === "agent" &&
              (!input.agentId ||
                !(await ownCoworker(tx, personId, input.agentId)))
            )
              throw new ProjectRefusal("找不到这位员工。", 404);
            let source: ProjectSource;
            if (input.source.kind === "local") {
              const folder = folderOf(device, input.source.rootRef);
              if (!folder)
                throw new ProjectRefusal(
                  "这台设备上没有这个本地目录。请先在设备端登记它，并确认设备已连接。",
                  400,
                );
              if (input.source.writable && !folder.writable)
                throw new ProjectRefusal(
                  "这个目录在设备上登记为只读，项目不能设为可写。如需写入，请在设备上把它登记为可读写。",
                  400,
                );
              source = {
                kind: "local",
                rootRef: input.source.rootRef,
                label: folder.name,
                writable: input.source.writable,
              };
            } else {
              source = {
                kind: "git",
                url: input.source.url,
                branch: input.source.branch,
                rootRef: null,
                writable: input.source.writable,
                syncedAt: null,
                commit: null,
              };
            }
            const [created] = await tx
              .insert(resourceProjects)
              .values({
                id: randomUUID(),
                tenantId: personId,
                deviceId: device.id,
                scope: input.scope,
                agentId: input.agentId,
                name: input.name,
                description: input.description,
                source,
              })
              .returning();
            const project = created && shown(created);
            if (!project) throw new Error("project insert returned no row");
            return project;
          }),
        ),
      ),

    update: (personId, projectId, change) =>
      runAsTenant(personId, () =>
        guarded(() =>
          database.transaction(async (tx) => {
            const found = await row(tx, personId, projectId);
            const current = found && shown(found);
            if (!found || !current)
              throw new ProjectRefusal("找不到这个项目。", 404);
            if (found.revision !== change.revision)
              throw new ProjectRefusal(
                "项目已经被修改过了，请刷新后再改。",
                409,
              );
            let source: ProjectSource = current.source;
            if (change.writable !== undefined) {
              if (change.writable && source.kind === "local") {
                const device = await machine(tx, personId, found.deviceId);
                const folder = device && folderOf(device, source.rootRef);
                if (!folder?.writable)
                  throw new ProjectRefusal(
                    "这个目录在设备上登记为只读，项目不能设为可写。如需写入，请在设备上把它登记为可读写。",
                    400,
                  );
              }
              source = { ...source, writable: change.writable };
            }
            if (change.branch !== undefined) {
              if (source.kind !== "git")
                throw new ProjectRefusal("只有 Git 项目有分支。", 400);
              if (change.branch !== source.branch)
                // The clone stays; the next sync checks the new branch out. Until then nothing says
                // which commit the project is at.
                source = {
                  ...source,
                  branch: change.branch,
                  syncedAt: null,
                  commit: null,
                } satisfies GitProjectSource;
            }
            const scope = change.scope ?? current.scope;
            const agentId =
              change.scope !== undefined
                ? (change.agentId ?? null)
                : current.agentId;
            if (
              change.scope === "agent" &&
              agentId &&
              agentId !== current.agentId &&
              !(await ownCoworker(tx, personId, agentId))
            )
              throw new ProjectRefusal("找不到这位员工。", 404);
            const [updated] = await tx
              .update(resourceProjects)
              .set({
                name: change.name ?? current.name,
                description: change.description ?? current.description,
                scope,
                agentId,
                source,
                revision: sql`${resourceProjects.revision} + 1`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(resourceProjects.tenantId, personId),
                  eq(resourceProjects.id, projectId),
                  eq(resourceProjects.revision, change.revision),
                ),
              )
              .returning();
            if (!updated)
              throw new ProjectRefusal(
                "项目已经被修改过了，请刷新后再改。",
                409,
              );
            /*
             * A project that became one coworker's own is no longer any other coworker's current
             * project. The database would not have let the binding be written now; it does not look
             * back at bindings written before, so they are removed here, in the same transaction.
             */
            if (scope === "agent" && agentId)
              await tx
                .delete(projectContextBindings)
                .where(
                  and(
                    eq(projectContextBindings.tenantId, personId),
                    eq(projectContextBindings.projectId, projectId),
                    sql`${projectContextBindings.agentId} <> ${agentId}`,
                  ),
                );
            const project = shown(updated);
            if (!project) throw new Error("project update returned no row");
            return project;
          }),
        ),
      ),

    remove: async (personId, projectId) => {
      if (!isProjectId(projectId)) return false;
      // The bindings that named it go with it (`ON DELETE CASCADE`): nobody is left working in a
      // project that no longer exists, and the gateway refuses rather than falls back (D9).
      const removed = await runAsTenant(personId, () =>
        database
          .delete(resourceProjects)
          .where(
            and(
              eq(resourceProjects.tenantId, personId),
              eq(resourceProjects.id, projectId),
            ),
          )
          .returning({ id: resourceProjects.id }),
      );
      return removed.length === 1;
    },

    current: (personId, deviceId, agentId) =>
      runAsTenant(personId, async () => {
        if (!isProjectId(deviceId)) return null;
        const [found] = await database
          .select({ project: resourceProjects })
          .from(projectContextBindings)
          .innerJoin(
            resourceProjects,
            eq(resourceProjects.id, projectContextBindings.projectId),
          )
          .where(
            and(
              eq(projectContextBindings.tenantId, personId),
              eq(projectContextBindings.deviceId, deviceId),
              eq(projectContextBindings.agentId, agentId),
            ),
          )
          .limit(1);
        return found ? shown(found.project) : null;
      }),

    choose: (personId, deviceId, agentId, projectId) =>
      runAsTenant(personId, () =>
        guarded(() =>
          database.transaction(async (tx) => {
            const device = await machine(tx, personId, deviceId);
            if (!device) throw new ProjectRefusal("找不到这台设备。", 404);
            if (projectId === null) {
              await tx
                .delete(projectContextBindings)
                .where(
                  and(
                    eq(projectContextBindings.tenantId, personId),
                    eq(projectContextBindings.deviceId, device.id),
                    eq(projectContextBindings.agentId, agentId),
                  ),
                );
              return null;
            }
            const found = await row(tx, personId, projectId);
            const project = found && shown(found);
            if (!project) throw new ProjectRefusal("找不到这个项目。", 404);
            if (project.deviceId !== device.id)
              throw new ProjectRefusal(
                "这个项目在另一台设备上，不能在这台设备上选用。",
                400,
              );
            if (project.scope === "agent" && project.agentId !== agentId)
              throw new ProjectRefusal(
                "这是另一位员工的专属项目，不能选用。",
                403,
              );
            if (!(await ownCoworker(tx, personId, agentId)))
              throw new ProjectRefusal("找不到这位员工。", 404);
            await tx
              .insert(projectContextBindings)
              .values({
                tenantId: personId,
                deviceId: device.id,
                agentId,
                projectId: project.id,
              })
              .onConflictDoUpdate({
                target: [
                  projectContextBindings.tenantId,
                  projectContextBindings.deviceId,
                  projectContextBindings.agentId,
                ],
                set: { projectId: project.id, updatedAt: new Date() },
              });
            return project;
          }),
        ),
      ),

    machineOf: (personId, deviceId) =>
      runAsTenant(personId, async () => {
        const device = await machine(database, personId, deviceId);
        if (!device) return null;
        return {
          runnerDeviceId: device.deviceId,
          online:
            device.lastSeenAt !== null &&
            Date.now() - device.lastSeenAt.getTime() < OFFLINE_AFTER_MS,
        };
      }),

    recordSync: (personId, projectId, report) =>
      runAsTenant(personId, () =>
        guarded(() =>
          database.transaction(async (tx) => {
            if (
              !isRootRef(report.rootRef) ||
              !COMMIT_PATTERN.test(report.commit)
            )
              throw new ProjectRefusal("设备返回的同步结果不对。", 400);
            const found = await row(tx, personId, projectId);
            const project = found && shown(found);
            if (!project) throw new ProjectRefusal("找不到这个项目。", 404);
            if (project.source.kind !== "git")
              throw new ProjectRefusal("只有 Git 项目可以同步。", 400);
            const [updated] = await tx
              .update(resourceProjects)
              .set({
                source: {
                  ...project.source,
                  rootRef: report.rootRef,
                  commit: report.commit,
                  syncedAt: new Date().toISOString(),
                } satisfies GitProjectSource,
                revision: sql`${resourceProjects.revision} + 1`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(resourceProjects.tenantId, personId),
                  eq(resourceProjects.id, projectId),
                ),
              )
              .returning();
            const synced = updated && shown(updated);
            if (!synced) throw new Error("project sync returned no row");
            return synced;
          }),
        ),
      ),
  };
}

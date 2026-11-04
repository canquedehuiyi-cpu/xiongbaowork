import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ProjectSource } from "../../../../shared/projects";

export {
  gitBranchProblem,
  gitUrlProblem,
  PROJECT_DESCRIPTION_LIMIT,
  PROJECT_LIMIT_PER_DEVICE,
  PROJECT_NAME_LIMIT,
  type ProjectSource,
} from "../../../../shared/projects";

/**
 * Projects (story RES2): a folder or a Git repository on one of the person's paired machines, which
 * a coworker can be told to work in. Read and written through `/api/projects`, which answers only the
 * signed-in person's own machines. The address and branch checks are the server's own
 * (`shared/projects.ts`), so a form says what is wrong before a request is sent and the two never
 * disagree.
 *
 * Only a person creates, changes or picks a project (decision D8). There is no path anywhere here: a
 * local project names the machine's folder by its reference and the name its owner gave it.
 */
export type Project = {
  id: string;
  /** The machine's row id, as `/api/devices` lists it in `id`. */
  deviceId: string;
  scope: "public" | "agent";
  agentId: string | null;
  name: string;
  description: string;
  source: ProjectSource;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectList = {
  projects: Project[];
  /** With an `agent` asked for: the project that coworker works in on this machine now. */
  currentProjectId?: string | null;
};

export type NewProject = {
  deviceId: string;
  name: string;
  description: string;
  scope: "public" | "agent";
  agentId: string | null;
  source:
    | { kind: "local"; rootRef: string; writable: boolean }
    | { kind: "git"; url: string; branch: string; writable: boolean };
};

export const projectKeys = {
  all: ["projects"] as const,
  device: (deviceId: string, agentId?: string) =>
    ["projects", deviceId, agentId ?? null] as const,
};

export function projectsQueryOptions(deviceId: string, agentId?: string) {
  const search = new URLSearchParams({ device: deviceId });
  if (agentId) search.set("agent", agentId);
  return queryOptions({
    queryKey: projectKeys.device(deviceId, agentId),
    queryFn: async (): Promise<ProjectList> => {
      const response = await client(`/api/projects?${search}`, {
        fallback: "项目列表加载失败。",
      });
      return (await response.json()) as ProjectList;
    },
  });
}

/** Every write changes what a picker or the list shows, wherever it is open. */
const refresh = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    queryKey: projectKeys.all,
    refetchType: "all",
  });

export function createProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: NewProject) =>
      client<Project>("/api/projects", "project", {
        method: "POST",
        body: input,
        fallback: "项目没有保存成功。",
      }),
    onSuccess: () => refresh(queryClient),
  });
}

export function removeProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "项目没有删除成功。",
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}

/** 同步: the machine fetches the branch. Never done before a task on its own (decision D6). */
export function syncProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client<Project>(
        `/api/projects/${encodeURIComponent(id)}/sync`,
        "project",
        {
          method: "POST",
          fallback: "项目没有同步成功。",
        },
      ),
    onSuccess: () => refresh(queryClient),
  });
}

/** The repository's branches, asked of the machine, which is the one that can reach it. */
export function listBranchesMutationOptions() {
  return mutationOptions({
    mutationFn: (input: { deviceId: string; url: string }) =>
      client<string[]>("/api/projects/branches", "branches", {
        method: "POST",
        body: input,
        fallback: "没有列出分支。",
      }),
  });
}

/** A coworker's current project on a machine, or, with null, none (it works in its workspace). */
export function chooseProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      deviceId: string;
      agentId: string;
      projectId: string | null;
    }) =>
      client<Project | null>("/api/projects/current", "project", {
        method: "PUT",
        body: input,
        fallback: "当前项目没有设置成功。",
      }),
    onSuccess: () => refresh(queryClient),
  });
}

/** One line saying where a project's files are and whether they may be changed. Never a path. */
export function sourceSummary(source: ProjectSource): string {
  const access = source.writable ? "可读写" : "只读";
  if (source.kind === "local") return `本地目录 · ${source.label} · ${access}`;
  const synced = source.commit
    ? `已同步到 ${source.commit.slice(0, 7)}`
    : "尚未同步";
  return `Git 仓库 · ${source.url} · 分支 ${source.branch} · ${synced} · ${access}`;
}

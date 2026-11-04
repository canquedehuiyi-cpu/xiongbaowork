import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import type { RoleProfile } from "../../../../shared/role-profile";

/**
 * Role templates (story ROLE1): a person's own, the package's read-only official ones, applying
 * one to a coworker, where a coworker's role came from, and smart generation.
 *
 * A coworker made from a template keeps a pointer back but never follows it on its own (D2): it is
 * told "新版本" and its owner updates it, after seeing what changes.
 */
export type RoleTemplate = {
  id: string;
  name: string;
  profile: RoleProfile;
  version: number;
  updatedAt: string;
  official: false;
};

export type OfficialRoleTemplate = {
  id: string;
  name: string;
  profile: RoleProfile;
  version: 1;
  official: true;
};

export type AnyRoleTemplate = RoleTemplate | OfficialRoleTemplate;

/** What the agent DTO adds for roles. Optional: a profile drawn before ROLE1 carries none. */
export type AgentRoleFields = {
  bible?: string | null;
  roleTemplate?: { id: string; version: number } | null;
  acceptsRoleTemplate?: boolean;
};

export type RoleSourceStatus = {
  acceptsRoleTemplate: boolean;
  source: {
    id: string;
    version: number;
    name: string | null;
    latestVersion: number | null;
    hasUpdate: boolean;
    modified: boolean | null;
  } | null;
};

export type RoleGeneration = {
  requestId: string;
  state: "pending" | "completed" | "failed" | "unknown";
  profile: RoleProfile | null;
  error: string | null;
};

export type RoleModelChoice = { id: string; name: string; label: string };

export const roleKeys = {
  all: ["role-templates"] as const,
  list: () => ["role-templates", "list"] as const,
  source: (agentId: string) => ["role-templates", "source", agentId] as const,
  models: () => ["role-templates", "models"] as const,
};

export function roleTemplatesQueryOptions() {
  return queryOptions({
    queryKey: roleKeys.list(),
    queryFn: async (): Promise<{
      templates: RoleTemplate[];
      official: OfficialRoleTemplate[];
    }> => {
      const response = await client("/api/role-templates", {
        fallback: "读不到角色模板。",
      });
      const body = (await response.json().catch(() => null)) as {
        templates?: RoleTemplate[];
        official?: OfficialRoleTemplate[];
      } | null;
      return {
        templates: body?.templates ?? [],
        official: body?.official ?? [],
      };
    },
  });
}

export function roleSourceQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: roleKeys.source(agentId),
    queryFn: async (): Promise<RoleSourceStatus> => {
      const response = await client(
        `/api/role-templates/employees/${encodeURIComponent(agentId)}`,
        { fallback: "读不到这位员工的角色来源。" },
      );
      return (await response.json()) as RoleSourceStatus;
    },
  });
}

export function roleModelsQueryOptions() {
  return queryOptions({
    queryKey: roleKeys.models(),
    queryFn: async (): Promise<RoleModelChoice[]> => {
      const response = await client("/api/role-templates/models", {
        fallback: "读不到可用的模型。",
      });
      const body = (await response.json().catch(() => null)) as {
        models?: RoleModelChoice[];
      } | null;
      return body?.models ?? [];
    },
  });
}

function refresh(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: roleKeys.all }),
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  ]);
}

export function saveRoleTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      id?: string;
      name: string;
      profile: RoleProfile;
      version?: number;
    }): Promise<RoleTemplate> =>
      input.id
        ? client<RoleTemplate>(`/api/role-templates/${input.id}`, "template", {
            method: "PUT",
            body: {
              name: input.name,
              profile: input.profile,
              version: input.version,
            },
            fallback: "模板保存失败。",
          })
        : client<RoleTemplate>("/api/role-templates", "template", {
            method: "POST",
            body: { name: input.name, profile: input.profile },
            fallback: "模板保存失败。",
          }),
    onSuccess: () => refresh(queryClient),
  });
}

export function deleteRoleTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/role-templates/${id}`, {
        method: "DELETE",
        fallback: "模板删除失败。",
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}

export function applyRoleTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      templateId: string;
      agentId: string;
      version: number;
    }): Promise<RoleSourceStatus> =>
      client<RoleSourceStatus>(
        `/api/role-templates/${input.templateId}/apply`,
        "status",
        {
          method: "POST",
          body: { agentId: input.agentId, version: input.version },
          fallback: "套用模板失败。",
        },
      ),
    onSuccess: () => refresh(queryClient),
  });
}

/** One smart generation. The request id is the caller's, so a retry of the same click is one call. */
export async function generateRoleProfile(input: {
  requestId: string;
  modelRef: string;
  description: string;
}): Promise<RoleGeneration> {
  const response = await client("/api/role-templates/generate", {
    method: "POST",
    body: input,
    fallback: "智能生成失败。",
  });
  return (await response.json()) as RoleGeneration;
}

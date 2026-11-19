import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { Persona } from "../../../../shared/persona";

/**
 * The tenant's saved personas.
 *
 * A template is handed over by copy: picking one writes its text onto the coworker, and deleting the
 * template afterwards changes nobody's behaviour. That is the whole reason a template needs no
 * reference check and no cascade — the coworker never points at it.
 */
export type PersonaTemplate = {
  id: string;
  name: string;
  persona: Persona;
  updatedAt: string;
};

export const personaKeys = {
  all: ["personas"] as const,
  list: () => ["personas", "list"] as const,
};

export function personaTemplatesQueryOptions() {
  return queryOptions({
    queryKey: personaKeys.list(),
    queryFn: async (): Promise<PersonaTemplate[]> => {
      const response = await client("/api/personas", {
        fallback: "读不到你存下的角色。",
      });
      const body = (await response.json().catch(() => null)) as {
        templates?: PersonaTemplate[];
      } | null;
      return body?.templates ?? [];
    },
  });
}

function refresh(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: personaKeys.all });
}

export function savePersonaTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      name: string;
      persona: Persona;
    }): Promise<PersonaTemplate> => {
      return client<PersonaTemplate>("/api/personas", "template", {
        method: "POST",
        body: input,
        fallback: "这个角色没能存下来。",
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}

export function deletePersonaTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/personas/${id}`, {
        method: "DELETE",
        fallback: "这个角色没能删掉。",
      });
    },
    onSuccess: () => refresh(queryClient),
  });
}

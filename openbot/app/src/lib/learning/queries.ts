import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  LearningAutoAssignState,
  LearningDeliveryStatus,
  LearningOverview,
  LearningSettings,
} from "@openbot/shared/learning";

export const learningKeys = {
  all: ["learning"] as const,
  settings: ["learning", "settings"] as const,
  automatic: ["learning", "automatic"] as const,
};
export function learningSettingsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.settings,
    queryFn: (): Promise<LearningSettings> =>
      client("/api/admin/learning/settings", "settings", {
        fallback: "读取自动学习设置失败。",
      }),
  });
}
/** Why no container was assigned automatically, or `null` when the server has nothing to say. */
export function learningAutomaticQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.automatic,
    retry: false,
    queryFn: async (): Promise<LearningAutoAssignState | null> =>
      (await client<LearningAutoAssignState | undefined>(
        "/api/admin/learning/settings",
        "automatic",
        { fallback: "Learning settings could not be loaded." },
      )) ?? null,
  });
}
export function learningOverviewQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: ["learning", "overview", agentId],
    retry: false,
    queryFn: (): Promise<LearningOverview> =>
      client(
        `/api/admin/learning/overview${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
        "overview",
        { fallback: "读取学习状态失败。" },
      ),
  });
}
export function learningDeliveryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: ["learning", "delivery", agentId],
    enabled: Boolean(agentId),
    retry: false,
    queryFn: (): Promise<LearningDeliveryStatus> =>
      client(
        `/api/admin/learning/status/${encodeURIComponent(agentId)}`,
        "status",
        { fallback: "读取技能下发状态失败。" },
      ),
  });
}
/** Create the project's container with the deployment's credential, then report what assignment found. */
export function createLearningContainer(): Promise<LearningAutoAssignState> {
  return client("/api/admin/learning/container", "automatic", {
    method: "POST",
    body: {},
    fallback: "The Learning container could not be created.",
  });
}
export function saveLearningSettings(
  settings: LearningSettings,
): Promise<LearningSettings> {
  return client("/api/admin/learning/settings", "settings", {
    method: "PUT",
    body: settings,
    fallback: "保存自动学习设置失败。",
  });
}

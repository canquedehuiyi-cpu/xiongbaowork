import type {
  LocalLearningOverview,
  LocalSkillCandidateDetail,
} from "@openbot/shared/local-learning";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 从对话中学习（`/api/local-learning`）：本人的开关、上次学习的结果和员工提出的技能草案。
 */
export const localLearningKeys = {
  all: ["local-learning"] as const,
  overview: ["local-learning", "overview"] as const,
  candidate: (candidateId: string) =>
    ["local-learning", "candidate", candidateId] as const,
};

/** 正在学习时多久读一次总览。 */
export const LOCAL_LEARNING_POLL_MS = 3_000;

/** 「现在学一次」刚开始、学习记录还没出现时，最多等这么久。 */
const AWAIT_START_MS = 60_000;

/**
 * 「现在学一次」按下时看到的上次学习（`from`），和按下的时间（`at`）。
 *
 * 服务端回 202 时学习记录可能还没写进去，总览读到的仍是上一次，`running` 为 false。
 * 有了它，总览会一直读到出现新的一次为止，而不是读一次就停下。
 */
export type StartedLocalLearning = { from: string | null; at: number };

/** 这次总览之后还要不要接着读：正在学，或刚按了「现在学一次」还没看到新的一次。 */
export function shouldPollLocalLearning(
  overview: LocalLearningOverview | undefined,
  started: StartedLocalLearning | null,
): boolean {
  if (overview?.running) return true;
  if (!started || Date.now() - started.at > AWAIT_START_MS) return false;
  return (overview?.lastRun?.startedAt ?? null) === started.from;
}

export function localLearningQueryOptions(
  started: StartedLocalLearning | null = null,
) {
  return queryOptions({
    queryKey: localLearningKeys.overview,
    queryFn: (): Promise<LocalLearningOverview> =>
      client("/api/local-learning", {
        fallback: "读不到从对话中学习的设置。请刷新页面。",
      }).then((response) => response.json()),
    refetchInterval: (query) =>
      shouldPollLocalLearning(query.state.data, started)
        ? LOCAL_LEARNING_POLL_MS
        : false,
  });
}

export function localCandidateQueryOptions(candidateId: string) {
  return queryOptions({
    queryKey: localLearningKeys.candidate(candidateId),
    queryFn: (): Promise<LocalSkillCandidateDetail> =>
      client(
        `/api/local-learning/candidates/${encodeURIComponent(candidateId)}`,
        "candidate",
        { fallback: "读不到这条技能草案。" },
      ),
  });
}

import type {
  LocalLearningOverview,
  LocalSkillCandidateDetail,
  LocalSkillCandidateSummary,
} from "@openbot/shared/local-learning";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  grantPlugin,
  invalidatePlugins,
  saveSkill,
} from "@/lib/plugins/mutations";
import { localLearningKeys } from "./queries";

const FALLBACK = "从对话中学习的设置没能修改。";

function invalidateLocalLearning(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: localLearningKeys.all });
}

/** 打开或关掉从对话中学习。 */
export function setLocalLearningEnabledMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (enabled: boolean): Promise<LocalLearningOverview> =>
      client("/api/local-learning", {
        method: "PUT",
        body: { enabled },
        fallback: FALLBACK,
      }).then((response) => response.json()),
    onSuccess: () => invalidateLocalLearning(queryClient),
  });
}

/**
 * 「现在学一次」。服务端不等学完就回 202；正在学、已关闭或部署没开启时回 409，
 * 它的说法直接给人看。
 */
export function startLocalLearningMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      await client("/api/local-learning/learn", {
        method: "POST",
        fallback: "没能开始学习。请稍后再试。",
      });
    },
    onSuccess: () => invalidateLocalLearning(queryClient),
  });
}

/**
 * 批准一条草案：先存进本人的技能库，再交给提出它的员工，最后把草案记为已批准。
 *
 * 和「员工起草技能 → 本人确认保存」走同一条路（`POST /api/plugins/skills`、`POST /api/plugins/grants`），
 * 所以谁的员工、能不能授予都由那两处检查。任何一步失败就停下，抛出那一步的说法。
 * 技能已经存下、交给员工失败时，要让人知道技能已在技能库里。
 *
 * 在 `onSettled` 里刷新：失败的那一步之前可能已经写下了技能，界面要按服务端现在的样子画。
 */
export function approveLocalCandidateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      candidate: LocalSkillCandidateDetail;
      slug: string;
    }): Promise<LocalSkillCandidateSummary> => {
      const { candidate, slug } = variables;
      await saveSkill({
        slug,
        title: candidate.title,
        summary: candidate.summary,
        instructions: candidate.instructions,
        tools: [],
      });
      try {
        await grantPlugin({
          kind: "skill",
          ref: slug,
          agentId: candidate.agentId,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`技能已保存，但没能交给这位员工：${reason}`);
      }
      return client(
        `/api/local-learning/candidates/${encodeURIComponent(candidate.id)}/approve`,
        "candidate",
        {
          method: "POST",
          body: { slug },
          fallback: "技能已交给员工，但这条草案没能记为已批准。",
        },
      );
    },
    onSettled: () =>
      Promise.all([
        invalidateLocalLearning(queryClient),
        invalidatePlugins(queryClient),
      ]),
  });
}

/** 不要这一条草案。只改它的状态，技能库不变。 */
export function rejectLocalCandidateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (candidateId: string): Promise<LocalSkillCandidateSummary> =>
      client(
        `/api/local-learning/candidates/${encodeURIComponent(candidateId)}/reject`,
        "candidate",
        { method: "POST", fallback: "这条草案没能拒绝。" },
      ),
    onSuccess: () => invalidateLocalLearning(queryClient),
  });
}

import { queryOptions } from "@tanstack/react-query";
import type {
  PersonalReview,
  RecordingSkills,
} from "@xiongbao/shared/learning";
import { client } from "@/lib/client";

/*
 * What the Recorder's Teach a Bot page reads about the skills learned from a person's recordings. Only
 * it is left here; Task 14b removes it with the Recorder.
 */
export const learningKeys = {
  all: ["learning"] as const,
  review: ["learning", "review"] as const,
  recordingSkills: (title: string, since: number, revision: string) =>
    ["learning", "recording-skills", { title, since, revision }] as const,
};

/** Settings, Learning: the skills proposed from your own recordings that wait for your decision. */
export function personalReviewQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.review,
    retry: false,
    // While a run is going the review is read again, so what it proposes (or approves) shows up without a reload.
    refetchInterval: (query) =>
      query.state.data?.sources.some(
        (source) =>
          source.latestRun &&
          !["succeeded", "failed"].includes(source.latestRun.status),
      )
        ? 10_000
        : false,
    queryFn: async (): Promise<PersonalReview> =>
      (
        await client("/api/settings/learning/review", {
          fallback: "读不到待你审核的技能。请刷新页面。",
        })
      ).json(),
  });
}

/**
 * Teach a Bot, after a recording saves: the skills Learning proposed from it, named `title` and stopped at `since`
 * (milliseconds). `revision` changes whenever the person's review does (a run moves on, a proposal is approved), which
 * is when there can be something new to find.
 */
export function recordingSkillsQueryOptions(
  title: string,
  since: number,
  revision: string,
) {
  return queryOptions({
    queryKey: learningKeys.recordingSkills(title, since, revision),
    retry: false,
    queryFn: async (): Promise<RecordingSkills> =>
      (
        await client(
          `/api/settings/learning/recording-skills?title=${encodeURIComponent(title)}&since=${since}`,
          { fallback: "刚才没能读到你的技能。请再试一次。" },
        )
      ).json(),
  });
}

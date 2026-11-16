/**
 * 本地学习（`/api/local-learning`）在浏览器和服务端之间的形状。
 *
 * 本地学习从这个人自己的对话里提出技能草案，草案在本人批准之前不会给任何员工用；对话不出库。
 */

export type LocalLearningOutcome =
  | "running"
  | "proposed"
  | "nothing"
  | "skipped"
  | "failed";

export type LocalLearningSkipReason =
  | "off"
  | "quota"
  | "no_evidence"
  | "no_model";

export type LocalCandidateStatus = "pending_review" | "approved" | "rejected";

export type LocalLearningRunSummary = {
  startedAt: string;
  finishedAt: string | null;
  outcome: LocalLearningOutcome;
  skipReason: LocalLearningSkipReason | null;
  runsRead: number;
  candidates: number;
};

export type LocalSkillCandidateSummary = {
  id: string;
  agentId: string;
  /** null：这位员工已经不在了。 */
  agentName: string | null;
  slug: string;
  title: string;
  summary: string;
  status: LocalCandidateStatus;
  /** 批准时存进技能库用的命令名。 */
  skillSlug: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type LocalCandidateEvidenceView = {
  threadId: string;
  runId: string;
  at: string;
  /** 对话的名字；对话已经删了时为 null，`exists` 为 false。 */
  name: string | null;
  exists: boolean;
};

export type LocalSkillCandidateDetail = LocalSkillCandidateSummary & {
  instructions: string;
  reason: string;
  evidence: LocalCandidateEvidenceView[];
};

export type LocalLearningOverview = {
  /** 这个部署开着本地学习（`OPENBOT_LOCAL_LEARNING` 不是 `off`）。 */
  available: boolean;
  /** 这个人开着。 */
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRun: LocalLearningRunSummary | null;
  pending: LocalSkillCandidateSummary[];
  /** 最近处理过的，最多 20 条。 */
  reviewed: LocalSkillCandidateSummary[];
};

/** 没学的原因，给本人看的说法。 */
export const LOCAL_LEARNING_SKIPPED: Record<LocalLearningSkipReason, string> = {
  off: "你关掉了从对话中学习。",
  quota: "本月的任务额度用完了，额度恢复后再学。",
  no_evidence: "最近的对话还不够多，看不出反复出现的做法。",
  no_model: "员工没有可用的模型。",
};

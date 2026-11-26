/*
 * The shapes of the retained learning tables' JSON columns (server/src/db/schema/learning.ts). The cloud learning these
 * tables served is gone, and the tables stay until a later phase drops them; nothing here reads or writes them now.
 */
export type LearningTarget = { containerId: string; revision?: string };
export type LearningSettings = {
  enabled: boolean;
  defaultTarget: LearningTarget | null;
  /** Missing inherits the default; null explicitly excludes this Bot. */
  agents: Record<string, LearningTarget | null>;
  /** Who reviews what a person's own Learning space proposes. Missing means "admins". */
  personalReview?: LearningPersonalReview;
  /** Whether proposals are approved without a review. Only the personal edition read it; there, missing meant true. */
  autoApprove?: boolean;
};

/** Who else's Bots use the Skills a person's own Learning space published. */
export const LEARNING_SHARING_MODES = ["closed", "open", "choose"] as const;
export type LearningSharingMode = (typeof LEARNING_SHARING_MODES)[number];

/** Who reviews what a person's own Learning space proposes: the administrators, or the people themselves. */
export const LEARNING_PERSONAL_REVIEW = ["admins", "people"] as const;
export type LearningPersonalReview = (typeof LEARNING_PERSONAL_REVIEW)[number];

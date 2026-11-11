/*
 * 上游 0088（#1397）：管理员用平常话写给自动审核的指引，存在团队审批设置上。
 */
ALTER TABLE "approval_team_settings" ADD COLUMN "reviewer_guidance" text;

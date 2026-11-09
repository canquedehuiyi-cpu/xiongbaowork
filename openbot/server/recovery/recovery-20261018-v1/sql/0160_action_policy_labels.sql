/*
 * 上游 0062：部署级动作边界的每条规则可以有名字和说明（`action_policy` 是部署级表，无租户列）。
 */
ALTER TABLE "action_policy" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;

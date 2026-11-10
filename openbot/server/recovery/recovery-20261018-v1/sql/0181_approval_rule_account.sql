/*
 * 审批规则按账号区分（上游 0085，#1298）：一个人在同一个应用上有多个账号时，「这里始终允许」保存的规则
 * 只针对卡片点名的那个账号。NULL 是「这个应用，不论哪个账号」，旧规则都是 NULL，含义见
 * approvals/policy.ts 的 `ruleMatches`：它对每个账号仍然询问或拒绝，但不再放行点名了账号的调用。
 *
 * 只加一列，表的租户与行安全不变（approval_rules 自 0072 起已是四条 tenant_isolation 策略）。
 */
ALTER TABLE "public"."approval_rules" ADD COLUMN "account" text;

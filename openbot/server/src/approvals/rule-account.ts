import { sql } from "drizzle-orm";

/**
 * `approval_rules.account`（迁移 0181，上游 0085 / #1298）：规则针对这个人在该应用上的哪一个账号，NULL 是
 * 「这个应用，不论哪个账号」。能放行什么见 `./policy` 的 `ruleMatches`。
 *
 * 不在 `db/schema/approvals.ts` 里声明：那个文件被 AP2/AP4 的恢复测试按字节冻结（只允许列出的逆向编辑），
 * 原有测试不能改。所以这一列由这里以 SQL 片段读写，`./store` 是唯一的读写者。
 */
export const ruleAccount = sql<string | null>`"approval_rules"."account"`;

import { getTableColumns, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { approvalRules, approvalTeamSettings } from "../db/schema/approvals";
import { TEAM_TENANT } from "../db/schema/tenant";
import type { ActionKind, ActionKindPolicy } from "./types";

/*
 * 已有审批表上、合并上游后才有的列，用 drizzle 的 `sql` 片段读写，类型在这里声明。
 *
 * 为什么不放进 `db/schema/approvals.ts`：那份 schema 文件被恢复测试按字节冻结
 * （tests/recovery-ap2-parent-schema-reconcile.test.ts、tests/recovery-approval-exact-input-objects.test.ts），
 * 连同 approvalRequests 的 ORM 元数据，只允许测试里列出的逆向编辑。数据库这一侧由恢复层迁移加列：
 *
 *   approval_rules.kind                       text，可空            0177（上游 #1394）
 *   approval_rules.account                    text，可空            0181（X1，上游 #1298）
 *   approval_team_settings.action_kinds       jsonb，非空，默认 {}  0177（上游 #1394）
 *   approval_team_settings.reviewer_guidance  text，可空            0178（上游 #1397）
 *
 * 新表 approval_conversation_grants 不受冻结限制，在 db/schema/approval-conversation-grants.ts。
 * approval_requests 的 decision 约束由 0177 改成含 'allow_conversation'；schema 里的 check 保持 fork
 * 原样（drizzle 运行时不检查 check，只有 `generate` 读它），类型由 `ApprovalDecision` 放宽。
 *
 * 以后同类的列照同样的办法加在这里：一个 `SQL<T>` 读片段、并进 `*Columns` 供 select/returning 用，
 * 再加一个写函数（X 系列多账号的 `approval_rules.account` 就是这样加的，原来的 `approvals/rule-account.ts`
 * 已并进这里）。
 *
 * DRIZZLE 不知道这些列，它们只由恢复层迁移（recovery/recovery-20261018-v1/sql）手写加上。
 * `db:generate` 只比对 schema 与 drizzle/meta 的快照，两边都没有这些列，所以生成的迁移既不加也不删它们；
 * 但任何对照真实数据库同步 schema 的做法（例如 `drizzle-kit push`）会把它们当成多余的列删掉，连同审批的
 * 种类、团队设置和规则针对的账号。不要对部署的库那样做。
 *
 * 这些片段只在单表查询里用（`from(approvalRules)` / `from(approvalTeamSettings)`、对应表的
 * returning）；表名限定列名，所以不会和别的表的同名列混。
 */

/** Anything that can run one statement: the tenant-bound database or a transaction on it. */
type Executor = { execute: (query: SQL) => PromiseLike<unknown> };

const columnOf = <T>(table: PgTable, name: string) =>
  sql<T>`${table}.${sql.identifier(name)}`;

/* ---- approval_rules ---- */

/**
 * `approval_rules.kind`: the kind of action the rule was saved from ("Always allow here" on a send
 * card is `sending`), or null. An allow reaches a kind only when it was saved from it (`reachesKind`
 * in approvals/policy.ts).
 */
export const ruleKind: SQL<ActionKind | null> = columnOf<ActionKind | null>(
  approvalRules,
  "kind",
);

/**
 * `approval_rules.account`: which one of the person's accounts in the app the rule is for, or null
 * for the app whichever account (X1, upstream #1298). It holds the account's stable binding
 * (`ApprovalCandidate.accountBinding`: the address the vendor reports, or the account row's id when
 * it reports none), never a position like 「账号 2」, so a rule does not move to another account
 * when an earlier one is disconnected. What it allows is `ruleMatches` in approvals/policy.ts.
 */
export const ruleAccount: SQL<string | null> = columnOf<string | null>(
  approvalRules,
  "account",
);

/** Every `approval_rules` column, the schema's and the ones above, for `select()` and `returning()`. */
export const ruleColumns = {
  ...getTableColumns(approvalRules),
  kind: ruleKind,
  account: ruleAccount,
};

/** Stamp the kind on a rule just written (same transaction as the insert). Null leaves it unset. */
export async function saveRuleKind(
  executor: Executor,
  ruleId: string,
  kind: ActionKind | null,
): Promise<void> {
  if (kind === null) return;
  await executor.execute(
    sql`update ${approvalRules} set ${sql.identifier("kind")} = ${kind} where ${approvalRules.id} = ${ruleId}`,
  );
}

/**
 * Stamp what the card a rule was saved from said about it, on the rule just written (same
 * transaction as the insert): its kind and the account it is for. One statement; a null leaves its
 * column unset, and both null writes nothing.
 */
export async function saveRuleExtras(
  executor: Executor,
  ruleId: string,
  extras: { kind: ActionKind | null; account: string | null },
): Promise<void> {
  const sets = [
    ...(extras.kind !== null
      ? [sql`${sql.identifier("kind")} = ${extras.kind}`]
      : []),
    ...(extras.account !== null
      ? [sql`${sql.identifier("account")} = ${extras.account}`]
      : []),
  ];
  if (sets.length === 0) return;
  await executor.execute(
    sql`update ${approvalRules} set ${sql.join(sets, sql`, `)} where ${approvalRules.id} = ${ruleId}`,
  );
}

/* ---- approval_team_settings ---- */

export type TeamActionKinds = Partial<Record<ActionKind, ActionKindPolicy>>;

/** `approval_team_settings.action_kinds`: the kinds the admin closed. A kind not named is open. */
export const teamActionKinds: SQL<TeamActionKinds> = columnOf<TeamActionKinds>(
  approvalTeamSettings,
  "action_kinds",
);

/**
 * `approval_team_settings.reviewer_guidance`: what the admin told auto-review, in their own words,
 * or null. Read only by the gate and the admin's screen, never by members.
 */
export const teamReviewerGuidance: SQL<string | null> = columnOf<string | null>(
  approvalTeamSettings,
  "reviewer_guidance",
);

/** Every `approval_team_settings` column, the schema's and the ones above. */
export const teamSettingsColumns = {
  ...getTableColumns(approvalTeamSettings),
  actionKinds: teamActionKinds,
  reviewerGuidance: teamReviewerGuidance,
};

const teamRow = sql`${approvalTeamSettings.id} = 'team' and ${approvalTeamSettings.tenantId} = ${TEAM_TENANT}`;

/**
 * Write the closed kinds on the team row, which the caller has just upserted in the same
 * transaction. The object goes to the driver once, as the `jsonb` column type does (db/schema/json.ts):
 * a string here would be stored as a JSON string.
 */
export async function saveTeamActionKinds(
  executor: Executor,
  actionKinds: TeamActionKinds,
): Promise<void> {
  await executor.execute(
    sql`update ${approvalTeamSettings} set ${sql.identifier("action_kinds")} = ${sql.param(actionKinds)}::jsonb where ${teamRow}`,
  );
}

/** Write the reviewer guidance on the team row, which the caller has just upserted. */
export async function saveTeamReviewerGuidance(
  executor: Executor,
  guidance: string | null,
): Promise<void> {
  await executor.execute(
    sql`update ${approvalTeamSettings} set ${sql.identifier("reviewer_guidance")} = ${guidance} where ${teamRow}`,
  );
}

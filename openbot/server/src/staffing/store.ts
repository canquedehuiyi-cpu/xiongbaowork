import {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { staffingProposals } from "../db/schema/staffing";
import type {
  Proposal,
  ProposalDraft,
  ProposalKind,
  ResultItem,
} from "./types";

/**
 * 提议的存储。每个状态迁移都是一条带条件的 `UPDATE … RETURNING`，由数据库裁决谁先到：两个并发的确认里
 * 只有一个能把 pending 改成 applying，另一个拿到 0 行。先读再写在这里不安全。
 *
 * 帧：全部方法在调用方的租户帧里读写（提议落在本人的租户里，行安全挡住别人的帧），本模块不开帧。
 */

export const PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_PER_OWNER_LIMIT = 20;

/**
 * 「执行中」最后一次被写之后过了这么久还没落定，就当执行它的那次请求已经不在了（进程重启、连接断开）。
 * 执行每做完一步都会写一次结果，所以正在做的提议不会被误判；十分钟远长于一次执行要花的时间。
 */
export const STALE_APPLYING_MS = 10 * 60 * 1000;

export class ProposalLimitError extends Error {
  constructor() {
    super(`待确认的提议最多 ${PENDING_PER_OWNER_LIMIT} 份，请先处理已有的。`);
    this.name = "ProposalLimitError";
  }
}

export class ProposalNotFoundError extends Error {
  constructor() {
    super("找不到这份提议。");
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalExpiredError extends Error {
  constructor() {
    super("这份提议已过期，请让员工重新起草。");
    this.name = "ProposalExpiredError";
  }
}

export class ProposalStateError extends Error {
  constructor(message = "这份提议当前的状态不允许这个操作。") {
    super(message);
    this.name = "ProposalStateError";
  }
}

type Row = typeof staffingProposals.$inferSelect;

/**
 * 提议的 id 是 uuid。别的写法（地址栏里随手改的、模型编的）在查库之前就当作找不到：交给数据库，它的类型
 * 错误会变成 500，而对问的人来说这就是一份不存在的提议。
 */
const PROPOSAL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isProposalId = (id: string): boolean => PROPOSAL_ID.test(id);

function toProposal(row: Row): Proposal {
  return {
    id: row.id,
    ownerId: row.ownerId,
    proposedByAgentId: row.proposedByAgentId,
    threadId: row.threadId,
    kind: row.kind,
    draft: row.draft as unknown as ProposalDraft,
    baseVersion: row.baseVersion,
    status: row.status,
    result: (row.result as unknown as ResultItem[] | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

export function createStaffingProposalStore(db: Database) {
  const byId = async (id: string) =>
    (
      await db
        .select()
        .from(staffingProposals)
        .where(eq(staffingProposals.id, id))
    )[0];

  /** 已过期的 pending 落成 expired，之后谁来读都是 expired。 */
  const markExpired = async (id: string) =>
    (
      await db
        .update(staffingProposals)
        .set({ status: "expired", updatedAt: sql`now()` })
        .where(
          and(
            eq(staffingProposals.id, id),
            eq(staffingProposals.status, "pending"),
            lte(staffingProposals.expiresAt, sql`now()`),
          ),
        )
        .returning()
    )[0];

  /**
   * 停得太久的「执行中」落定：有结果（做了一部分，含建好的员工）的落成部分完成，失败的项可以重试；什么都没
   * 记下的放回待确认。一条带条件的更新，和还在做的那次请求的落定互不覆盖：谁先写，另一个就拿到 0 行。
   */
  const settleStale = async (id: string) =>
    (
      await db
        .update(staffingProposals)
        .set({
          status: sql`CASE WHEN jsonb_typeof(${staffingProposals.result}) = 'array' AND jsonb_array_length(${staffingProposals.result}) > 0 THEN 'partially_applied' ELSE 'pending' END`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(staffingProposals.id, id),
            eq(staffingProposals.status, "applying"),
            lte(
              staffingProposals.updatedAt,
              sql`now() - make_interval(secs => ${STALE_APPLYING_MS / 1000})`,
            ),
          ),
        )
        .returning()
    )[0];

  /**
   * 条件更新没命中时说明原因。别人的提议与不存在的提议一个样（NotFound），
   * 不让人借错误类型探出别人有没有提议。
   */
  async function refusal(
    id: string,
    ownerId: string,
    expiredAsError: boolean,
  ): Promise<Error> {
    const row = await byId(id);
    if (!row || row.ownerId !== ownerId) return new ProposalNotFoundError();
    const lapsed =
      row.status === "expired" ||
      (row.status === "pending" && row.expiresAt.getTime() <= Date.now());
    if (lapsed) {
      if (row.status === "pending") await markExpired(id);
      if (expiredAsError) return new ProposalExpiredError();
    }
    return new ProposalStateError();
  }

  async function transition(
    id: string,
    ownerId: string,
    from: Row["status"],
    to: Row["status"],
    options: { expiredAsError?: boolean; requireLive?: boolean } = {},
  ): Promise<Proposal> {
    if (!isProposalId(id)) throw new ProposalNotFoundError();
    const [row] = await db
      .update(staffingProposals)
      .set({ status: to, updatedAt: sql`now()` })
      .where(
        and(
          eq(staffingProposals.id, id),
          eq(staffingProposals.ownerId, ownerId),
          eq(staffingProposals.status, from),
          options.requireLive
            ? gt(staffingProposals.expiresAt, sql`now()`)
            : undefined,
        ),
      )
      .returning();
    if (!row) throw await refusal(id, ownerId, options.expiredAsError ?? false);
    return toProposal(row);
  }

  return {
    async create(input: {
      ownerId: string;
      proposedByAgentId: string;
      threadId: string | null;
      kind: ProposalKind;
      draft: ProposalDraft;
      baseVersion: string | null;
    }): Promise<Proposal> {
      const [open] = await db
        .select({ n: count() })
        .from(staffingProposals)
        .where(
          and(
            eq(staffingProposals.ownerId, input.ownerId),
            eq(staffingProposals.status, "pending"),
            gt(staffingProposals.expiresAt, sql`now()`),
          ),
        );
      if ((open?.n ?? 0) >= PENDING_PER_OWNER_LIMIT) {
        throw new ProposalLimitError();
      }
      const [row] = await db
        .insert(staffingProposals)
        .values({
          ownerId: input.ownerId,
          proposedByAgentId: input.proposedByAgentId,
          threadId: input.threadId,
          kind: input.kind,
          draft: input.draft as unknown as Record<string, unknown>,
          baseVersion: input.baseVersion,
          expiresAt: new Date(Date.now() + PROPOSAL_LIFETIME_MS),
        })
        .returning();
      if (!row) throw new Error("staffing proposal insert returned no row");
      return toProposal(row);
    },

    /** 这次调用是否把一份到期的 pending 落成了 expired（只有第一个看到的人得到 true，用来只记一次轨迹）。 */
    async expireIfLapsed(id: string): Promise<boolean> {
      if (!isProposalId(id)) return false;
      return Boolean(await markExpired(id));
    },

    /**
     * 读一份提议。到期的 pending 在这里落成 expired；停得太久的 applying 在这里落定（见 {@link settleStale}），
     * 所以卡片、`proposal_status` 与执行器读到的都不会是一个永远不会结束的「执行中」。在调用方的帧里。
     */
    async get(id: string): Promise<Proposal | null> {
      if (!isProposalId(id)) return null;
      const row = await byId(id);
      if (!row) return null;
      if (
        row.status === "applying" &&
        Date.now() - row.updatedAt.getTime() >= STALE_APPLYING_MS
      ) {
        const settled = await settleStale(id);
        if (settled) return toProposal(settled);
        const latest = await byId(id);
        return latest ? toProposal(latest) : null;
      }
      if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
        const expired = await markExpired(id);
        if (expired) return toProposal(expired);
        const latest = await byId(id);
        return latest ? toProposal(latest) : null;
      }
      return toProposal(row);
    },

    async updateDraft(
      id: string,
      ownerId: string,
      draft: ProposalDraft,
    ): Promise<Proposal> {
      if (!isProposalId(id)) throw new ProposalNotFoundError();
      const [row] = await db
        .update(staffingProposals)
        .set({
          draft: draft as unknown as Record<string, unknown>,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(staffingProposals.id, id),
            eq(staffingProposals.ownerId, ownerId),
            eq(staffingProposals.status, "pending"),
            gt(staffingProposals.expiresAt, sql`now()`),
          ),
        )
        .returning();
      if (!row) throw await refusal(id, ownerId, false);
      return toProposal(row);
    },

    claim: (id: string, ownerId: string) =>
      transition(id, ownerId, "pending", "applying", {
        expiredAsError: true,
        requireLive: true,
      }),

    /** 应用时发现内容已变或名额已满、什么都没改，就把提议放回待确认。 */
    release: (id: string, ownerId: string) =>
      transition(id, ownerId, "applying", "pending"),

    /** 重试上次没做完的部分。 */
    reopenFailed: (id: string, ownerId: string) =>
      transition(id, ownerId, "partially_applied", "applying"),

    /**
     * 作废：待确认的（还没过期），或者部分完成的——每一步都失败、重试也做不成的提议要有个了结，否则它一直
     * 挂着「失败可重试」。部分完成的已经做成的项不回滚，作废只是不再重试。
     */
    async discard(id: string, ownerId: string): Promise<Proposal> {
      if (!isProposalId(id)) throw new ProposalNotFoundError();
      const [row] = await db
        .update(staffingProposals)
        .set({ status: "discarded", updatedAt: sql`now()` })
        .where(
          and(
            eq(staffingProposals.id, id),
            eq(staffingProposals.ownerId, ownerId),
            inArray(staffingProposals.status, ["pending", "partially_applied"]),
            or(
              eq(staffingProposals.status, "partially_applied"),
              gt(staffingProposals.expiresAt, sql`now()`),
            ),
          ),
        )
        .returning();
      if (!row) throw await refusal(id, ownerId, false);
      return toProposal(row);
    },

    /**
     * 执行途中记下到此为止的结果（只在仍是「执行中」时）：建好的员工一建好就在行里，之后出了什么意外，
     * 重试也不会再建一个；每写一次也刷新 `updated_at`，表示还有人在做（见 {@link STALE_APPLYING_MS}）。
     */
    async recordProgress(id: string, result: ResultItem[]): Promise<boolean> {
      if (!isProposalId(id)) return false;
      const [row] = await db
        .update(staffingProposals)
        .set({
          result: result as unknown as Record<string, unknown>,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(staffingProposals.id, id),
            eq(staffingProposals.status, "applying"),
          ),
        )
        .returning({ id: staffingProposals.id });
      return row !== undefined;
    },

    async finish(
      id: string,
      status: "applied" | "partially_applied",
      result: ResultItem[],
    ): Promise<Proposal> {
      if (!isProposalId(id)) throw new ProposalNotFoundError();
      const [row] = await db
        .update(staffingProposals)
        .set({
          status,
          result: result as unknown as Record<string, unknown>,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(staffingProposals.id, id),
            eq(staffingProposals.status, "applying"),
          ),
        )
        .returning();
      if (row) return toProposal(row);
      throw (await byId(id))
        ? new ProposalStateError()
        : new ProposalNotFoundError();
    },

    /** 这个人在这段对话里起草过多少份（不论状态），用来给单次运行之外再设一道总量上限。 */
    async countCreatedSince(
      ownerId: string,
      threadId: string | null,
      since: Date,
    ): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(staffingProposals)
        .where(
          and(
            eq(staffingProposals.ownerId, ownerId),
            threadId === null
              ? isNull(staffingProposals.threadId)
              : eq(staffingProposals.threadId, threadId),
            gte(staffingProposals.createdAt, since),
          ),
        );
      return row?.n ?? 0;
    },
  };
}

export type StaffingProposalStore = ReturnType<
  typeof createStaffingProposalStore
>;

/**
 * 看板自主认领（期 3·3.3）：员工在看板上自己领派给自己岗位、还没人领的卡，领了就开工，走现有的接活、交付、验收。
 *
 * 分两层：
 *  - `createBoardCards`：卡的账（`board_cards`）和 `claimNextCard(employeeId)`，用 `for update skip locked` 原子地领；
 *  - `createCardAutonomy`：领到之后把它变成一张跟着走的看板卡（`tasks`，`tracked`），并让员工开工。
 *
 * 为什么放在心跳上，又在卡创建时踢一下：心跳本来就是员工「醒来看一眼有没有事」的机制，认领挂在醒来上，员工不用
 * 为此另开一个定时器；而一张新卡放进来，开了心跳的同岗位员工不该等到下一次醒来才知道，所以创建时也踢一下。
 * 两处都只对开了心跳的员工生效（开心跳就是同意它自己找活干）。
 *
 * 在本人的租户帧里做，别人的卡看不到；不开新的跨租户的门。
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema/coworker";
import { boardCards } from "../db/schema/board-cards";
import { agents } from "../db/schema/core";
import { tasks } from "../db/schema/tasks";
import { currentTenant } from "../tenant/context";

export type BoardCard = typeof boardCards.$inferSelect;

/** 每位员工同时最多在做几张自己领的卡，没设置时用的数。 */
export const DEFAULT_MAX_PARALLEL_CARDS = 2;

/** `XIONGBAO_MAX_PARALLEL_CARDS`：正整数才算，别的都用默认。 */
export function maxParallelCards(
  environment: Record<string, string | undefined> = process.env,
): number {
  const raw = environment.XIONGBAO_MAX_PARALLEL_CARDS?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= 50
    ? value
    : DEFAULT_MAX_PARALLEL_CARDS;
}

/** `XIONGBAO_CARD_AUTOCLAIM=off`：整个关掉自己认领，卡照常能放能看。 */
export function cardAutoclaimOn(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.XIONGBAO_CARD_AUTOCLAIM?.trim().toLowerCase() !== "off";
}

export type NewBoardCard = {
  title: string;
  detail?: string;
  role: string;
  priority?: number;
  urgent?: boolean;
  createdBy: string;
};

export type BoardCardsStore = ReturnType<typeof createBoardCards>;

/** 卡的账和原子认领。调用者要在本人的租户帧里。 */
export function createBoardCards(
  database: Database,
  options: { maxParallel?: () => number } = {},
) {
  const maxParallel = options.maxParallel ?? (() => maxParallelCards());
  return {
    async create(input: NewBoardCard): Promise<BoardCard> {
      const owner = currentTenant();
      const [row] = await database
        .insert(boardCards)
        .values({
          ownerUserId: owner,
          title: input.title,
          detail: input.detail ?? "",
          role: input.role,
          priority: input.priority ?? 0,
          urgent: input.urgent ?? false,
          createdBy: input.createdBy,
        })
        .returning();
      if (!row) throw new Error("The card could not be saved.");
      return row;
    },

    /** 本人的卡，新的在前，带上领它的员工开出来的看板卡现在的状态。 */
    async list(limit = 200) {
      return database
        .select({
          id: boardCards.id,
          title: boardCards.title,
          detail: boardCards.detail,
          role: boardCards.role,
          priority: boardCards.priority,
          urgent: boardCards.urgent,
          status: boardCards.status,
          claimedBy: boardCards.claimedBy,
          claimedAt: boardCards.claimedAt,
          taskId: boardCards.taskId,
          taskStatus: tasks.status,
          createdAt: boardCards.createdAt,
        })
        .from(boardCards)
        .leftJoin(tasks, eq(tasks.id, boardCards.taskId))
        .orderBy(desc(boardCards.createdAt))
        .limit(limit);
    },

    /** 撤掉一张还没人领的卡；已被领走的不动（要停它走看板卡的取消）。 */
    async cancelOpen(id: string): Promise<boolean> {
      const rows = await database
        .delete(boardCards)
        .where(and(eq(boardCards.id, id), eq(boardCards.status, "open")))
        .returning({ id: boardCards.id });
      return rows.length > 0;
    },

    /**
     * 这位员工领下一张：派给自己岗位（员工头衔）、还没人领的卡里，优先级最高、同级最早放进来的那张；
     * 在做的卡已经到并行上限就不领。一步做完：
     *  - 按员工加一把事务锁，同一位员工同时来领，数「在做几张」不会都看到旧数；
     *  - 挑卡用 `for update skip locked`，别的员工同时在领，各领各的，绝不领到同一张。
     * 没有可领的、到上限、员工没有岗位，答 null。`onlyUrgent` 只在安静时段里用：只领紧急的。
     */
    async claimNextCard(
      employeeId: string,
      claim: { onlyUrgent?: boolean } = {},
    ): Promise<BoardCard | null> {
      const owner = currentTenant();
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`board-claim\u001f${owner}\u001f${employeeId}`}, 0))`,
        );
        const [profile] = await transaction
          .select({ title: agentProfiles.title })
          .from(agentProfiles)
          .where(eq(agentProfiles.agentId, employeeId))
          .limit(1);
        if (!profile?.title) return null;
        // 在做的：领了还没开出看板卡的，和看板卡还在做、在等人处理的。交出去等验收的不占名额。
        const [busy] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(boardCards)
          .leftJoin(tasks, eq(tasks.id, boardCards.taskId))
          .where(
            and(
              eq(boardCards.claimedBy, employeeId),
              eq(boardCards.status, "claimed"),
              or(
                isNull(boardCards.taskId),
                inArray(tasks.status, ["running", "needs_action"]),
              ),
            ),
          );
        if ((busy?.count ?? 0) >= maxParallel()) return null;
        const [next] = await transaction
          .select()
          .from(boardCards)
          .where(
            and(
              eq(boardCards.ownerUserId, owner),
              eq(boardCards.status, "open"),
              eq(boardCards.role, profile.title),
              ...(claim.onlyUrgent ? [eq(boardCards.urgent, true)] : []),
            ),
          )
          .orderBy(desc(boardCards.priority), asc(boardCards.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!next) return null;
        const [claimed] = await transaction
          .update(boardCards)
          .set({
            status: "claimed",
            claimedBy: employeeId,
            claimedAt: sql`now()`,
          })
          .where(eq(boardCards.id, next.id))
          .returning();
        return claimed ?? null;
      });
    },

    /** 领到之后开出的看板卡记在这张卡上。 */
    async markStarted(id: string, taskId: string): Promise<void> {
      await database
        .update(boardCards)
        .set({ taskId })
        .where(eq(boardCards.id, id));
    },

    /** 领了却没能开出看板卡（比如超了本月额度）：放回去，让别人、或下一次再领。 */
    async release(id: string): Promise<void> {
      await database
        .update(boardCards)
        .set({ status: "open", claimedBy: null, claimedAt: null, taskId: null })
        .where(and(eq(boardCards.id, id), isNull(boardCards.taskId)));
    },

    /** 这个岗位上，本人名下开了心跳、可以自己领活的员工。 */
    async heartbeatEmployees(role: string): Promise<string[]> {
      const rows = await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
        .where(
          and(
            eq(agentProfiles.title, role),
            sql`${agents.configuration} #>> '{heartbeat,enabled}' = 'true'`,
          ),
        );
      return rows.map((row) => row.id);
    },
  };
}

/** 领到的卡给员工的话：要做什么，做完怎么交。 */
export function cardAsk(card: Pick<BoardCard, "title" | "detail">): string {
  return [
    "【看板派活】看板上有一张派给你这个岗位的卡，你领下来了：",
    `标题：${card.title}`,
    ...(card.detail ? [`说明：${card.detail}`] : []),
    "照常先用 accept_task 回执（写清楚你怎么做、什么算做完），做完用 deliver_task 交成果，等本人验收。",
  ].join("\n");
}

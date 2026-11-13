import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  channelMemberships,
  groupBotThreads,
  intelligenceChannelMappings,
  users,
} from "../db/schema";
import { QuotaExceeded } from "../quota/limits";
import { parseDraft } from "./draft";
import {
  ProposalRefusedError,
  ProposalStaleError,
  type StaffingExecutor,
} from "./executor";
import {
  ProposalExpiredError,
  ProposalNotFoundError,
  ProposalStateError,
  type StaffingProposalStore,
} from "./store";
import type { Proposal } from "./types";

/**
 * 提议的确认、修改、作废、重试接口。
 *
 * 只挂 `requireUser`：员工运行带的机器凭证不是登录会话，进不来（401），所以员工自己确认不了自己的提议。
 * 帧：每个请求都在本人的租户帧里读写，`store.get` 不看主人，所以这里自己核对 `ownerId`——主人得到全文，
 * 同一帧里能看到该会话的人只得到摘要，其余一律 404（别的租户的行被行安全挡住，读出来就是 null）。
 */

const NOT_FOUND = { error: "找不到这份提议。" };

type Actor = AppVariables["actor"];

export type ProposalRouteOptions = {
  /** 写轨迹。不给就不写（单元测试里用）。 */
  auditStore?: AuditStore;
  /** 摘要里显示的主人名字；读不到就留空。 */
  ownerName?: (ownerId: string) => Promise<string | null>;
};

/**
 * 这个人能不能看到这个会话：会话所在的频道里有他的成员行。
 *
 * 没有现成的「（人，会话）能否看到」检查，所以用现有的频道成员表自己判断：会话 id 经员工群聊线程或
 * 个人对话映射找到频道，再看本人是不是该频道成员。全部在请求自己的帧里读，不新开出帧门。
 */
export function createThreadVisibility(database: Database) {
  return async (actor: Actor, threadId: string): Promise<boolean> => {
    const channelIds = new Set<string>();
    for (const row of await database
      .select({ channelId: groupBotThreads.channelId })
      .from(groupBotThreads)
      .where(eq(groupBotThreads.threadId, threadId)))
      channelIds.add(row.channelId);
    for (const row of await database
      .select({ channelId: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.threadId, threadId)))
      channelIds.add(row.channelId);
    for (const channelId of channelIds) {
      const [member] = await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .limit(1);
      if (member) return true;
    }
    return false;
  };
}

/** 摘要里的主人名字：用户表里的名字，读不到就空。 */
export function createOwnerNameReader(database: Database) {
  return async (ownerId: string): Promise<string | null> => {
    const [row] = await database
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    return row?.name ?? null;
  };
}

export function createProposalRoutes(
  store: StaffingProposalStore,
  executor: StaffingExecutor,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canSeeThread: (actor: Actor, threadId: string) => Promise<boolean>,
  options: ProposalRouteOptions = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  const audit = async (
    actor: Actor,
    eventType:
      | "staffing.proposal_edited"
      | "staffing.proposal_discarded"
      | "staffing.proposal_expired",
    proposal: Proposal,
  ) => {
    if (!options.auditStore) return;
    try {
      await recordAuditEvent(options.auditStore, {
        eventType,
        actorUserId: actor.id,
        targetType: "staffing_proposal",
        targetId: proposal.id,
        payload: { proposalId: proposal.id, kind: proposal.kind },
      });
    } catch (error) {
      // 改动已经做了；轨迹一时写不进不是说它没做的理由。
      console.error(
        JSON.stringify({
          type: "staffing-audit-write-failed",
          eventType,
          error: String(error),
        }),
      );
    }
  };

  /** 读提议；到期的 pending 在这里落成 expired，并且只有第一个撞上的请求记一次轨迹。 */
  const load = async (actor: Actor, id: string) => {
    const lapsed = await store.expireIfLapsed(id);
    const proposal = await store.get(id);
    if (lapsed && proposal)
      await audit(actor, "staffing.proposal_expired", proposal);
    return proposal;
  };

  const failure = (
    context: {
      json: (
        body: unknown,
        status: 400 | 402 | 403 | 404 | 409 | 410,
      ) => Response;
    },
    error: unknown,
  ): Response => {
    if (error instanceof ProposalNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ProposalExpiredError)
      return context.json({ error: error.message }, 410);
    if (error instanceof ProposalStaleError)
      return context.json({ error: error.message }, 409);
    if (error instanceof ProposalStateError)
      return context.json({ error: error.message }, 409);
    if (error instanceof QuotaExceeded) return context.json(error.body, 402);
    if (error instanceof ProposalRefusedError)
      return context.json(
        { error: error.message },
        error.capability ? 403 : 400,
      );
    throw error;
  };

  /**
   * 动手的接口共用：只有主人能动。同一帧里的别人：看得到这个会话的是 403，看不到的和读不到的一样是 404
   * （与 GET 同一条界线，不让人借 403 探出别人会话里有没有提议）。
   */
  const owned = async (actor: Actor, id: string) => {
    const proposal = await load(actor, id);
    if (!proposal) return { response: NOT_FOUND, status: 404 as const };
    if (proposal.ownerId !== actor.id) {
      if (!proposal.threadId || !(await canSeeThread(actor, proposal.threadId)))
        return { response: NOT_FOUND, status: 404 as const };
      return {
        response: { error: "只有提议的主人可以这样做。" },
        status: 403 as const,
      };
    }
    return { proposal };
  };

  routes.get("/:id", async (context) => {
    const actor = context.var.actor;
    const proposal = await load(actor, context.req.param("id"));
    if (!proposal) return context.json(NOT_FOUND, 404);
    if (proposal.ownerId === actor.id)
      return context.json({ proposal, canAct: true });
    if (!proposal.threadId || !(await canSeeThread(actor, proposal.threadId)))
      return context.json(NOT_FOUND, 404);
    return context.json({
      summary: {
        kind: proposal.kind,
        title: summaryTitle(proposal),
        ownerName: (await options.ownerName?.(proposal.ownerId)) ?? "",
        status: proposal.status,
      },
      canAct: false,
    });
  });

  routes.patch("/:id", async (context) => {
    const actor = context.var.actor;
    const found = await owned(actor, context.req.param("id"));
    if (!found.proposal) return context.json(found.response, found.status);
    const body = (await context.req.json().catch(() => null)) as {
      draft?: unknown;
    } | null;
    const parsed = parseDraft(found.proposal.kind, body?.draft);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      const proposal = await store.updateDraft(
        found.proposal.id,
        actor.id,
        parsed.draft,
      );
      await audit(actor, "staffing.proposal_edited", proposal);
      return context.json({ proposal });
    } catch (error) {
      return failure(context, error);
    }
  });

  routes.post("/:id/apply", async (context) => {
    const actor = context.var.actor;
    const found = await owned(actor, context.req.param("id"));
    if (!found.proposal) return context.json(found.response, found.status);
    try {
      return context.json({
        proposal: await executor.apply(actor, found.proposal.id),
      });
    } catch (error) {
      return failure(context, error);
    }
  });

  routes.post("/:id/retry", async (context) => {
    const actor = context.var.actor;
    const found = await owned(actor, context.req.param("id"));
    if (!found.proposal) return context.json(found.response, found.status);
    try {
      return context.json({
        proposal: await executor.retry(actor, found.proposal.id),
      });
    } catch (error) {
      return failure(context, error);
    }
  });

  routes.post("/:id/discard", async (context) => {
    const actor = context.var.actor;
    const found = await owned(actor, context.req.param("id"));
    if (!found.proposal) return context.json(found.response, found.status);
    try {
      const proposal = await store.discard(found.proposal.id, actor.id);
      await audit(actor, "staffing.proposal_discarded", proposal);
      return context.json({ proposal });
    } catch (error) {
      return failure(context, error);
    }
  });

  return routes;
}

/** 摘要里的一句话：草稿里有名字就用名字，没有就按种类说。 */
function summaryTitle(proposal: Proposal): string {
  const draft = proposal.draft as { name?: unknown };
  if (typeof draft.name === "string" && draft.name.trim()) return draft.name;
  return {
    employee: "招聘员工",
    employee_change: "调整员工",
    group: "组建群组",
    group_change: "调整群组",
  }[proposal.kind];
}

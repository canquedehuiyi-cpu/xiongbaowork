import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  asSharedUseApproval,
  covers,
  exposureOf,
  type SharedUseApproval,
} from "./shared-use";
import {
  type SharedAudience,
  SharedUseFrameError,
  SharedUseNotSharedError,
  SharedUseRequestDecidedError,
  type SharedUseRequestRow,
  type SharedUseStore,
} from "./shared-use-store";

type RouteContext = Context<{ Variables: AppVariables }>;

/**
 * 管理员给员工一个应用的动作时，要随授予一起记下的共享使用批准（上游 `sharedGrantApproval`）：谁可以经这位
 * 员工用 Shared 应用唯一那个团队账号。没有批准，闸门会拒绝这次授予刚放开的每一次调用。
 *
 * - 应用不是 Shared（`accountMode` 由调用方从应答行读来，不信授予恰好经过的那一行），或没有共享使用：没什么
 *   要记，答 `approval: null`。
 * - 送来了批准：读得懂就记它，读不懂答 `unreadable`，由调用方整次拒绝。
 * - 没送：管理员之前定的批准是他的决定，这次授予不替他放宽或改写，答 null；没有批准、或只有主人的授予设下
 *   的受众时，批准员工此刻的开放范围（`exposureOf`），受众随之成为管理员的。
 *
 * 在员工主人的帧里调用（路由经 `asBotOwner` 进来），批准行就在那里读。
 */
export async function sharedGrantApproval(
  shared: Pick<SharedUseStore, "appIdOf" | "approvalSource" | "botFacts">,
  input: {
    serverId: string;
    agentId: string;
    accountMode: string | null | undefined;
    sent: unknown;
  },
): Promise<
  { appId: string; approval: SharedUseApproval | null } | "unreadable"
> {
  const appId = await shared.appIdOf(input.serverId);
  if (input.accountMode !== "shared") return { appId, approval: null };
  if (input.sent !== undefined) {
    const approval = asSharedUseApproval(input.sent);
    return approval ? { appId, approval } : "unreadable";
  }
  if ((await shared.approvalSource(input.agentId, appId)) === "admin")
    return { appId, approval: null };
  return { appId, approval: exposureOf(await shared.botFacts(input.agentId)) };
}

/**
 * 一位员工使用一个 Shared 应用的团队账号，在哪里申请、在哪里回答（上游 `shared-use-routes.ts`，挂在
 * `/api/plugins/shared-use` 下）。
 *
 * 提议永远是服务端的：员工的主人申请，申请的内容是这个部署读到的员工开放范围，所以申请写不得比员工实际
 * 更宽，管理员批准的就是下一次调用会被检查的。
 *
 * 帧（见 `./shared-use-store.ts`）：
 * - 管理员（持有能力，`decisionRefusal`）的批准、驳回、替别人的员工申请、看别人的员工：经已有的
 *   `asBotOwner`（`adminActAsOwner`）在员工主人的帧里做，轨迹也落在主人名下。
 * - 管理员收件箱：插件路由已有的那道 `asAdminPlatform`，与应用访问申请的收件箱是同一次读（`pendingForAdmin`），
 *   不另开门。
 * - 员工的主人：在自己的帧里。
 * 没有主人的员工没有地方记批准，答 409。
 */
export function mountSharedUseRoutes(options: {
  routes: Hono<{ Variables: AppVariables }>;
  shared: { store: SharedUseStore; audience: SharedAudience };
  /** 带管理员能力的入口（`signedInWithCapability`）；成员原样通过，由处理函数决定。 */
  capable: MiddlewareHandler<{ Variables: AppVariables }>;
  /** 能处理申请的人：持有能力的管理员；否则是拒绝的那句话。 */
  decisionRefusal: (context: { var: AppVariables }) => string | null;
  asBotOwner: <T>(
    context: { var: AppVariables },
    agentId: string,
    work: () => Promise<T>,
  ) => Promise<T>;
  /** 所有人的待处理共享使用申请，经插件路由已有的那道 platform 门；调用前已确认持有能力。 */
  pendingForAdmin: (context: {
    var: AppVariables;
  }) => Promise<SharedUseRequestRow[]>;
}) {
  const { routes, capable, decisionRefusal, asBotOwner } = options;
  const { store, audience } = options.shared;
  const ALREADY_DECIDED = "这条申请已经处理过了。";
  const NO_OWNER = "这位员工没有主人，团队账号只能给有主人的员工用。";

  /**
   * 员工的主人在自己的帧里做；持有能力的管理员经 `asBotOwner` 在主人的帧里做；其余为 null（403）。
   * 没有主人的员工答 `"no_owner"`。
   */
  async function asOwnerOrAdmin<T>(
    context: RouteContext,
    botId: string,
    work: () => Promise<T>,
  ): Promise<{ done: T } | "forbidden" | "no_owner"> {
    const actor = context.var.actor;
    const owner = await audience.ownerOf(botId);
    if (owner && owner === actor.id) return { done: await work() };
    if (decisionRefusal(context) !== null) return "forbidden";
    if (!owner) return "no_owner";
    return { done: await asBotOwner(context, botId, work) };
  }

  /** 收件箱：所有人的待处理申请。只给持有能力的管理员。 */
  routes.get("/shared-use", capable, async (context) => {
    const refusal = decisionRefusal(context);
    if (refusal) return context.json({ error: refusal }, 403);
    return context.json({ requests: await options.pendingForAdmin(context) });
  });

  for (const decision of ["approve", "decline"] as const) {
    routes.post(`/shared-use/:id/${decision}`, capable, async (context) => {
      const refusal = decisionRefusal(context);
      if (refusal) return context.json({ error: refusal }, 403);
      const id = context.req.param("id");
      const pending = (await options.pendingForAdmin(context)).find(
        (request) => request.id === id,
      );
      // 不存在的和已经处理过的读起来一样：都不再待处理。
      if (!pending) return context.json({ error: ALREADY_DECIDED }, 409);
      try {
        const request = await asBotOwner(context, pending.botId, async () => {
          const decided = await store.decide({
            id,
            by: context.var.actor.id,
            decision,
          });
          await audience.record({
            eventType:
              decision === "approve"
                ? "shared_use.approved"
                : "shared_use.declined",
            targetId: decided.serverId,
            actorUserId: context.var.actor.id,
            payload: {
              bot: decided.botId,
              server: decided.serverId,
              request: decided.id,
              audience: decided.proposed.audience,
              outsideInput: decided.proposed.outsideInput,
            },
          });
          return decided;
        });
        return context.json({ request });
      } catch (error) {
        if (error instanceof SharedUseRequestDecidedError)
          return context.json({ error: ALREADY_DECIDED }, 409);
        if (
          error instanceof SharedUseFrameError ||
          error instanceof SharedUseNotSharedError
        )
          return context.json({ error: error.message }, 409);
        throw error;
      }
    });
  }

  /**
   * 管理员撤销一位员工在一个应用上的批准（管理员的或主人的都算），在员工主人的帧里，轨迹也落在那里。之后
   * 这位员工对团队账号的调用被拒绝，直到再有批准。只给持有能力的管理员。
   */
  routes.delete(
    "/shared-use/bot/:botId/:serverId",
    capable,
    async (context) => {
      const refusal = decisionRefusal(context);
      if (refusal) return context.json({ error: refusal }, 403);
      const botId = context.req.param("botId");
      const serverId = context.req.param("serverId");
      if (!(await audience.ownerOf(botId)))
        return context.json({ error: NO_OWNER }, 409);
      const revoked = await asBotOwner(context, botId, async () => {
        const appId = await store.appIdOf(serverId);
        const done = await store.revokeApproval({ botId, serverId: appId });
        if (done)
          await audience.record({
            eventType: "shared_use.revoked",
            targetId: appId,
            actorUserId: context.var.actor.id,
            payload: { bot: botId, server: appId },
          });
        return done;
      });
      return context.json({ revoked });
    },
  );

  /**
   * 员工的主人（或持有能力的管理员）为员工持有的一个 Shared 应用申请批准。理由只收 `trigger`（加了外部
   * 触发）与 `publish`（发布得更宽）；提议由服务端按员工现在的开放范围定。
   */
  routes.post("/shared-use", capable, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
      serverId?: unknown;
      reason?: unknown;
    } | null;
    const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
    const serverId =
      typeof body?.serverId === "string" ? body.serverId.trim() : "";
    const reason =
      body?.reason === "trigger"
        ? "trigger"
        : body?.reason === "publish"
          ? "publish"
          : null;
    if (!botId || !serverId || !reason)
      return context.json(
        { error: "请说明员工、应用和原因（trigger 或 publish）。" },
        400,
      );
    const outcome = await asOwnerOrAdmin(context, botId, async () => {
      const appId = await store.appIdOf(serverId);
      const held = await store.sharedAppsHeldBy(botId);
      if (!held.some((app) => app.serverId === appId)) return null;
      const filed = await store.fileRequest({
        botId,
        serverId: appId,
        reason,
        requestedBy: context.var.actor.id,
        proposed: exposureOf(await store.botFacts(botId)),
      });
      if (filed.created)
        await audience.record({
          eventType: "shared_use.requested",
          targetId: appId,
          actorUserId: context.var.actor.id,
          payload: { bot: botId, server: appId, reason, request: filed.id },
        });
      return filed;
    });
    if (outcome === "forbidden")
      return context.json({ error: "只有员工的主人可以申请。" }, 403);
    if (outcome === "no_owner") return context.json({ error: NO_OWNER }, 409);
    if (outcome.done === null)
      return context.json({ error: "这位员工没有用这个共享应用。" }, 400);
    return context.json(outcome.done);
  });

  /** 员工持有的每个 Shared 应用：现在的批准、它现在需要的、是否盖得住，以及待处理的申请。 */
  routes.get("/shared-use/bot/:botId", capable, async (context) => {
    const botId = context.req.param("botId");
    const outcome = await asOwnerOrAdmin(context, botId, async () => {
      const needed = exposureOf(await store.botFacts(botId));
      const apps = await Promise.all(
        (await store.sharedAppsHeldBy(botId)).map(async (app) => {
          const approval = await store.approvalFor(botId, app.serverId);
          return {
            ...app,
            approval,
            needed,
            covered: covers(approval, needed),
          };
        }),
      );
      return { apps, pending: await store.pendingFor(botId) };
    });
    if (outcome === "forbidden")
      return context.json({ error: "只有员工的主人可以看。" }, 403);
    if (outcome === "no_owner") return context.json({ error: NO_OWNER }, 409);
    return context.json(outcome.done);
  });
}

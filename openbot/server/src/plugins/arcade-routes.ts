import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { reasonWithoutStatement } from "../db/query-failure";
import { toolkitOfFor } from "./access";
import { normalizeArcadeError } from "./arcade-adapter";
import type { PendingAuthorization } from "./arcade-attempts";
import { isServerWriteRefusal } from "./store";
import {
  type ArcadeBroker,
  type AuthorizationFlow,
  BrokerAccountHeldError,
  brokerSentence,
} from "./broker";
import { connectedAccountsUrlFor } from "./oauth";
import type { AccountRef } from "./shared-accounts";
import type { PluginStore } from "./store";
import { withVendorDeadline } from "./vendor-deadline";

/**
 * Arcade 的连接路由（X5，上游 `route-groups/connections.ts` 的授权尝试与回程验证，按 fork 改写）。
 *
 * Arcade 的连接分三步，每一步都绑定发起人：
 * 1. `POST /servers/:id/connect`（fork 的连接路由在 Arcade 时转到 {@link startArcadeAuthorization}）：
 *    先在发起人名下认领一次尝试，再向厂商要授权链接，把厂商的 mint id 写到这次尝试上。没有绑定上
 *    mint id 的尝试永远完成不了。
 * 2. 人在厂商页面同意后，Arcade 把浏览器送到这个部署的用户验证地址 `GET /arcade/verify?flow_id=…`。
 *    这里用回来的浏览器的会话找到「这个人」的尝试，请厂商确认这个 flow 属于这次尝试的账号
 *    （`confirmUser`，不是他的就答 mismatch），再核对确认回来的授权 id 等于尝试上绑定的 mint id、
 *    授权已完成、完成的用户就是这次尝试的账号。任何一步不对都不记录。别人的链接、别人的 flow、
 *    过期或已取消的尝试都到不了「记下连接」。
 * 3. 记录在一个事务里只成功一次（`completeAuthorizationAttempt`）。
 *
 * 链接和厂商的回答从不进响应 body、日志或审计：授权链接是持有即可用的凭证，状态回答里有访问令牌。
 * 失败回到「已连接账号」页，`?authorized=<原因>`，原因只是一个词。
 *
 * 与上游的差异（保底线、缩范围，报告里逐条写明）：
 * - 「已取消」与「不再允许」（应用切成了共享、团队身份换了、没有管理员能力了）在请厂商确认
 *   （`confirmUser`）之前判：不确认，同意在 Arcade 那边就不生效，不留遗留授权。上游是先确认再判。
 * - 只剩一种遗留授权：回程进行中尝试被取消（竞争），厂商已经确认、记录时认领不到。
 *   团队账号：在厂商那边撤销。团队身份每个应用、每次切换随机铸出，撤销不会连带别的应用；只有厂商答
 *   「撤了」才算撤回，答 false 或抛错都如实留痕（审计 `mcp.cancelled_grant_left_live`）。
 *   个人账号：只留痕并告诉本人。授权是本人自己的、记在本人 id 下，不算越权；撤销会连带本人同一认证
 *   提供商下的其他应用（fork 还没有上游按认证提供商列出兄弟应用的那一层），所以不撤。
 * - 单个动作的授权（`POST /servers/:id/authorize`）与授权清单（`GET /servers/:id/grants`）不在 X5：
 *   「连接」一次要整个应用需要的权限。
 * - 一个人的第二个 Arcade 账号（`?another=1`）不在 X5。
 */

/** 回到「已连接账号」页时带的原因，只是一个词。与上游的名单一致。 */
export const AUTHORIZATION_REFUSALS = [
  "no-broker",
  "not-supported",
  "missing-handle",
  "no-attempt",
  "vendor-unavailable",
  "not-your-authorization",
  "not-finished",
  "authorization-failed",
  "context-changed",
  "name-changed",
  "not-permitted",
  "cancelled",
  "cancelled-left-live",
  "not-recorded",
] as const;

export type AuthorizationRefusal = (typeof AUTHORIZATION_REFUSALS)[number];

/** 一次厂商状态调用的期限：回程上有一个浏览器在等。 */
export const STATUS_CALL_TIMEOUT_MS = 2_000;
const STATUS_POLLS = 5;
const STATUS_PAUSE_MS = 1000;

/** 授权状态，`pending` 时短暂地多问几次；每一次都有期限。 */
export async function settledStatus(
  flow: AuthorizationFlow,
  id: string,
  pauseMs = STATUS_PAUSE_MS,
): Promise<Awaited<ReturnType<AuthorizationFlow["status"]>>> {
  const poll = () =>
    withVendorDeadline(
      (signal) => flow.status(id, { signal }),
      STATUS_CALL_TIMEOUT_MS,
    );
  let answer = await poll();
  for (
    let polls = 1;
    polls < STATUS_POLLS && answer.status === "pending";
    polls += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    answer = await poll();
  }
  return answer;
}

/** 没有会话的浏览器去登录，登录后前端把它送回验证地址（`app/src/lib/auth/resume.ts`）。 */
export function signInUrlFor(
  appUrl: string | undefined,
  flowId: string,
): string {
  const base = `${appUrl?.replace(/\/+$/, "") ?? ""}/sign`;
  return flowId ? `${base}?flow_id=${encodeURIComponent(flowId)}` : base;
}

/** 厂商与本部署写给运维的句子不给普通成员看（#1223 不点名提供商）。 */
const NAMES_A_BROKER = /\b(composio|arcade)\b/i;

function personSentence(error: unknown, generic: string): string {
  const authored = brokerSentence(error);
  return authored && !NAMES_A_BROKER.test(authored) ? authored : generic;
}

export type ArcadeRouteDeps = {
  store: PluginStore;
  arcade: ArcadeBroker;
  appUrl: string | undefined;
};

function accountOf(attempt: PendingAuthorization): AccountRef | null {
  if (attempt.holder === "person") {
    return attempt.userId
      ? {
          holder: "person",
          userId: attempt.userId,
          vendorUserId: attempt.vendorUserId,
        }
      : null;
  }
  return { holder: "deployment", vendorUserId: attempt.vendorUserId };
}

/**
 * 开始一次 Arcade 授权：认领尝试 → 向厂商要链接 → 把 mint id 绑到这次尝试上。
 *
 * 厂商明确拒绝（本部署写的句子，或带状态码的厂商失败）时丢弃尝试，让人马上能重来；厂商没答清楚时
 * 留下尝试（它没有 mint id，永远完成不了），15 分钟后让位，谁也没被送去同意页面。
 */
export async function startArcadeAuthorization(
  context: Context<{ Variables: AppVariables }>,
  deps: ArcadeRouteDeps,
  input: {
    serverId: string;
    account: AccountRef;
    toolkit: string;
    title: string;
    returnUrl: string;
    held?: () => Promise<Response>;
  },
): Promise<Response> {
  const { store, arcade } = deps;
  const actorId = context.var.actor.id;
  const claim = await store.claimAuthorizationAttempt({
    actorId,
    serverId: input.serverId,
    action: null,
    account: input.account,
  });
  if (!claim.claimed) {
    return context.json(
      {
        error:
          "你已经有一次连接正在进行。请先完成它，或者等它过期（15 分钟）再开始新的。",
      },
      409,
    );
  }

  let minted: { redirectUrl: string; authorizationId: string | null };
  try {
    minted = await withVendorDeadline(() =>
      arcade.authorize({
        account: input.account,
        toolkit: input.toolkit,
        returnUrl: input.returnUrl,
      }),
    );
  } catch (error) {
    if (error instanceof BrokerAccountHeldError && input.held) {
      await store
        .discardAuthorizationAttempt({
          actorId,
          createdAt: claim.attempt.createdAt,
        })
        .catch(() => false);
      return input.held();
    }
    const authored = brokerSentence(error) !== null;
    const failure = normalizeArcadeError(error);
    const definite =
      authored || (failure !== null && failure.status !== undefined);
    if (definite) {
      const freed = await store
        .discardAuthorizationAttempt({
          actorId,
          createdAt: claim.attempt.createdAt,
        })
        .catch((cleanup: unknown) => {
          console.error(
            JSON.stringify({
              type: "arcade-refused-attempt-not-cleared",
              server: input.serverId,
              error: reasonWithoutStatement(cleanup),
            }),
          );
          return false;
        });
      const sentence = personSentence(
        error,
        `没能开始连接 ${input.title}。请稍后再试；如果一直这样，请联系管理员。`,
      );
      return context.json(
        {
          error: freed
            ? sentence
            : `${sentence}这次尝试会在 15 分钟内过期，之后可以重新开始。`,
        },
        authored ? 503 : 502,
      );
    }
    console.error(
      JSON.stringify({
        type: "arcade-mint-outcome-unknown",
        server: input.serverId,
        attemptStartedAt: claim.attempt.createdAt,
        note: "The vendor did not answer an authorization clearly, so whether it started a flow is unknown. The attempt was left standing with no authorization id: it cannot complete, and nobody was sent to a consent screen.",
        // 评审 M5：认不出的错误只记类名，它的 message 可能带着授权链接。
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return context.json(
      {
        error:
          "应用没有给出明确的回答，所以没有打开授权页面，也没有连接任何东西。这次尝试会在 15 分钟内过期，之后可以重新开始。",
      },
      502,
    );
  }

  let bound: boolean;
  try {
    bound = await store.recordAuthorizationMint({
      actorId,
      createdAt: claim.attempt.createdAt,
      authId: minted.authorizationId,
    });
  } catch (error) {
    const freed = await store
      .discardAuthorizationAttempt({
        actorId,
        createdAt: claim.attempt.createdAt,
      })
      .catch(() => false);
    console.error(
      JSON.stringify({
        type: "arcade-mint-not-recorded",
        server: input.serverId,
        authorizationId: minted.authorizationId,
        attemptCleared: freed,
        note: "An authorization was minted at the vendor and could not be written to its attempt. The person was not sent to the consent screen.",
        error: reasonWithoutStatement(error),
      }),
    );
    return context.json(
      {
        error: freed
          ? "应用开始了这次授权，但 OpenBot 没能记下它，所以没有连接任何东西。可以放心再按一次「连接」。"
          : "应用开始了这次授权，但 OpenBot 没能记下它，所以没有连接任何东西。这次尝试会在 15 分钟内过期，之后可以重新开始。",
      },
      500,
    );
  }
  if (!bound || minted.authorizationId === null) {
    return context.json(
      { error: "这次授权在开始之前就被取消了，没有连接任何东西。请重新连接。" },
      409,
    );
  }
  return context.json({ authorizationUrl: minted.redirectUrl });
}

/**
 * 回来的人此刻是否仍然可以把这个账号记下来：应用还在、还是 Arcade 应用、账号模式与身份没变，
 * 团队账号只有管理员能连接。不再成立时答原因。
 */
async function stillPermitted(
  context: Context<{ Variables: AppVariables }>,
  store: PluginStore,
  attempt: PendingAuthorization,
  account: AccountRef,
): Promise<
  | { toolkit: string; refused?: undefined }
  | { toolkit: string | null; refused: "context-changed" }
> {
  const row = await store.serverAddress(attempt.serverId);
  const toolkit = row ? toolkitOfFor("arcade", row.url) : null;
  if (!row || !toolkit) return { toolkit, refused: "context-changed" };
  const app = await store.appAccount(toolkit);
  if (!app) return { toolkit, refused: "context-changed" };
  if (account.holder === "person") {
    if (app.mode === "shared") return { toolkit, refused: "context-changed" };
    if (account.userId !== context.var.actor.id)
      return { toolkit, refused: "context-changed" };
    return { toolkit };
  }
  if (
    app.mode !== "shared" ||
    app.shared?.vendorUserId !== account.vendorUserId
  )
    return { toolkit, refused: "context-changed" };
  /*
   * 评审 M2：会话里的角色是登录时定的，真正的门是管理员能力（X1 的 `requireTeamAccountWriter`）。
   * 降权的管理员在这里被拒，而不是等到写应用行时被行安全过滤。
   */
  try {
    store.requireTeamAccountWriter();
  } catch (error) {
    if (!isServerWriteRefusal(error)) throw error;
    return { toolkit, refused: "context-changed" };
  }
  return { toolkit };
}

/**
 * 评审 I1：一个记不下来的授权在厂商那边已经生效时怎么办。
 *
 * 团队账号：在厂商那边撤销。团队身份是每个应用、每次切换随机铸出的（`mintDeploymentVendorUserId`），
 * 它下面只有这一个应用，撤销不会连带别的应用；不撤，它就会在之后被别人的「确认」收养。撤销失败才落回
 * 留痕。个人：授权是本人自己的，记在本人 id 下；撤销会连带本人同一认证提供商下的其他应用，所以只留痕。
 */
async function leftoverGrant(
  deps: ArcadeRouteDeps,
  input: {
    actorId: string;
    attempt: PendingAuthorization;
    account: AccountRef;
    toolkit: string | null;
    why: string;
  },
): Promise<"withdrawn" | "left-live"> {
  const { store, arcade } = deps;
  if (input.account.holder === "deployment" && input.toolkit) {
    const toolkit = input.toolkit;
    const withdrawn = await withVendorDeadline(() =>
      arcade.revoke({ account: input.account, toolkit }),
    ).then(
      // 只有厂商答「撤了」才算撤回；答 false（没找到可撤的连接）与抛错一样是没有完成（复核 1）。
      (ended) => {
        if (ended === true) return true;
        console.error(
          JSON.stringify({
            type: "arcade-team-grant-not-withdrawn",
            server: input.attempt.serverId,
            app: toolkit,
            error: "the vendor found no connection to withdraw",
          }),
        );
        return false;
      },
      (error: unknown) => {
        console.error(
          JSON.stringify({
            type: "arcade-team-grant-not-withdrawn",
            server: input.attempt.serverId,
            app: toolkit,
            error: error instanceof Error ? error.name : typeof error,
          }),
        );
        return false;
      },
    );
    if (withdrawn) return "withdrawn";
  }
  await store
    .recordCancelledGrantLeftLive({
      actorId: input.actorId,
      attempt: input.attempt,
      toolkit: input.toolkit ?? input.attempt.serverId,
      why: input.why,
      siblings: [],
    })
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          type: "arcade-cancelled-grant-left-live-not-filed",
          server: input.attempt.serverId,
          error: reasonWithoutStatement(error),
        }),
      ),
    );
  return "left-live";
}

/**
 * Arcade 的路由：回程验证与取消。挂在 fork 的插件路由上（`/api/plugins`）。
 *
 * `signedIn` 是带管理员能力的登录守卫（与 fork 连接路由的 `capable` 相同）：团队账号的完成要写应用行，
 * 那需要管理员能力的帧；普通成员的帧就是他自己的。
 */
export function mountArcadeRoutes(
  routes: Hono<{ Variables: AppVariables }>,
  signedIn: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: () => ArcadeRouteDeps | null,
): void {
  routes.get("/arcade/verify", async (context) => {
    const appUrl = deps()?.appUrl;
    const refusedWith = (reason: AuthorizationRefusal) => {
      const [screen] = connectedAccountsUrlFor(appUrl, { failed: true }).split(
        "?",
      );
      return context.redirect(`${screen}?authorized=${reason}`, 303);
    };
    const flowId = (context.req.query("flow_id") ?? "").trim();

    let answered: Response | undefined;
    const refusal = await signedIn(context, async () => {
      answered = await verify(context, flowId, refusedWith);
    });
    if (answered) return answered;
    if (refusal instanceof Response && refusal.status === 401) {
      return context.redirect(signInUrlFor(appUrl, flowId), 303);
    }
    return context.json(
      {
        error:
          "OpenBot 认不出你了，所以什么也没有记录。请联系管理员恢复你的访问，再从应用页面重新连接。",
      },
      403,
    );
  });

  async function verify(
    context: Context<{ Variables: AppVariables }>,
    flowId: string,
    refusedWith: (reason: AuthorizationRefusal) => Response,
  ): Promise<Response> {
    const current = deps();
    if (!current) return refusedWith("no-broker");
    const { store, arcade, appUrl } = current;
    const flow = arcade.authorizations;
    if (!flowId) return refusedWith("missing-handle");

    let recorded = false;
    try {
      const actorId = context.var.actor.id;
      /*
       * 活着的那一次；没有就看刚被取消的那一次（评审 I1）。
       *
       * 「已取消」与「不再允许」都在请厂商确认（`confirmUser`）之前判（复核建议）：在自定义验证地址模式下，
       * 正是这一步让同意在 Arcade 那边生效。所以这两种情况根本不确认，遗留授权不会出现，也就不用撤销；
       * 团队账号与个人一样。
       */
      const live = await store.authorizationAttemptFor(actorId);
      const attempt = live ?? (await store.withdrawnAttemptFor(actorId));
      if (!attempt || attempt.authId === null) return refusedWith("no-attempt");
      const account = accountOf(attempt);
      if (!account) return refusedWith("no-attempt");
      const authId = attempt.authId;
      if (live === null) return refusedWith("cancelled");

      const permitted = await stillPermitted(context, store, attempt, account);
      if (permitted.refused) {
        console.error(
          JSON.stringify({
            type: "arcade-completion-not-permitted",
            server: attempt.serverId,
            authorizationId: authId,
            holder: account.holder,
            note: "A person returned from a consent screen who may no longer record this app's account. The return was not confirmed at the vendor, so the consent does not take effect; the attempt was closed as withdrawn.",
          }),
        );
        await store.markAuthorizationWithdrawn({ actorId, authId });
        return refusedWith("not-permitted");
      }

      let confirmed: Awaited<ReturnType<AuthorizationFlow["confirmReturn"]>>;
      try {
        confirmed = await withVendorDeadline(
          (signal) =>
            flow.confirmReturn(
              { handle: flowId, vendorUserId: account.vendorUserId },
              { signal },
            ),
          STATUS_CALL_TIMEOUT_MS,
        );
      } catch {
        // 不带原因：这条腿上的回答可能带着授权链接。
        console.error(
          JSON.stringify({
            type: "arcade-return-confirmation-unknown",
            server: attempt.serverId,
            authorizationId: authId,
            attemptStartedAt: attempt.createdAt,
          }),
        );
        return refusedWith("vendor-unavailable");
      }
      if ("mismatch" in confirmed || confirmed.authorizationId !== authId) {
        return refusedWith("not-your-authorization");
      }

      let settled: Awaited<ReturnType<AuthorizationFlow["status"]>>;
      try {
        settled = await settledStatus(flow, authId);
      } catch {
        // 不带原因：状态回答里有访问令牌。尝试留着，回到链接还能结清。
        console.error(
          JSON.stringify({
            type: "arcade-completion-status-unknown",
            server: attempt.serverId,
            authorizationId: authId,
            attemptStartedAt: attempt.createdAt,
          }),
        );
        return refusedWith("vendor-unavailable");
      }
      if (settled.status === "failed") {
        await store.failAuthorizationAttempt({ actorId, authId });
        return refusedWith("authorization-failed");
      }
      if (settled.status !== "completed") return refusedWith("not-finished");
      if (settled.userId !== account.vendorUserId) {
        await store.failAuthorizationAttempt({ actorId, authId });
        return refusedWith("not-your-authorization");
      }

      const authProvider = await withVendorDeadline(() =>
        arcade.authProviderOf(permitted.toolkit),
      ).catch(() => null);

      let claimed: boolean;
      try {
        ({ claimed } = await store.completeAuthorizationAttempt({
          actorId,
          authId,
          serverId: attempt.serverId,
          toolkit: permitted.toolkit,
          account,
          action: attempt.action,
          scopes: settled.scopes,
          authProvider: authProvider ?? "",
        }));
        recorded = claimed;
      } catch (error) {
        recorded = await store
          .authorizationAttemptCompleted({ actorId, authId })
          .catch(() => false);
        console.error(
          JSON.stringify({
            type: recorded
              ? "arcade-completion-unacknowledged"
              : "arcade-completion-not-recorded",
            server: attempt.serverId,
            authorizationId: authId,
            error: reasonWithoutStatement(error),
          }),
        );
        if (!recorded) return refusedWith("not-recorded");
        claimed = true;
      }

      if (!claimed) {
        const completedElsewhere = await store
          .authorizationAttemptCompleted({ actorId, authId })
          .catch(() => null);
        if (completedElsewhere === null) return refusedWith("not-recorded");
        if (!completedElsewhere) {
          // 尝试在同意期间被取消了，授权却完成了：团队账号撤销，个人留痕（评审 I1）。
          const outcome = await leftoverGrant(current, {
            actorId,
            attempt,
            account,
            toolkit: permitted.toolkit,
            why: "the attempt was cancelled before the consent completed",
          });
          return refusedWith(
            outcome === "withdrawn" ? "cancelled" : "cancelled-left-live",
          );
        }
        recorded = true;
      }

      return context.redirect(
        connectedAccountsUrlFor(appUrl, { serverId: attempt.serverId }),
        303,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "arcade-verify-failed",
          recorded,
          error: reasonWithoutStatement(error),
        }),
      );
      return refusedWith("not-recorded");
    }
  }

  /**
   * 取消这个人在这个应用上进行中的授权。已经完成的不能取消（409，告诉他去断开）。
   */
  routes.delete("/servers/:id/authorize", signedIn, async (context) => {
    const current = deps();
    if (!current) return context.json({ cancelled: false });
    const { store } = current;
    const serverId = context.req.param("id");
    const actorId = context.var.actor.id;
    const attempt = await store.authorizationAttemptFor(actorId);
    if (!attempt || attempt.serverId !== serverId) {
      return context.json({ cancelled: false });
    }
    // 已经拿到链接的那一次结束为「已撤回」而不是删掉：之后厂商那边若仍完成了同意，回程还能认出它（评审 I1）。
    const cancelled =
      attempt.authId === null
        ? await store.discardAuthorizationAttempt({
            actorId,
            createdAt: attempt.createdAt,
          })
        : await store.markAuthorizationWithdrawn({
            actorId,
            authId: attempt.authId,
          });
    if (cancelled) {
      await store.recordAuthorizationCancelled({ actorId, attempt });
    } else if (
      (await store.settledAuthorizationOutcome({
        actorId,
        createdAt: attempt.createdAt,
      })) === "completed"
    ) {
      return context.json(
        {
          error:
            "这次授权在取消之前已经完成，账号已经连接。如果不是你想要的，请断开它。",
        },
        409,
      );
    }
    return context.json({ cancelled });
  });
}

/**
 * 这个人持有连接的别的 Arcade 应用（按行的地址读应用名，不含问的这一个）。断开的级联
 * （{@link clearEndedArcadeSiblings}）和它的预告（{@link arcadeConnectionSiblings}）都从这里拿候选，
 * 所以两边看的是同一批应用。只读这个人自己的连接行，别人的从不进来。
 */
async function otherArcadeAppsOf(
  store: PluginStore,
  userId: string,
  toolkit: string,
): Promise<string[]> {
  const others = new Set<string>();
  for (const connection of await store.brokeredConnectionsFor(userId)) {
    const row = await store.serverAddress(connection.serverId);
    const other = row ? toolkitOfFor("arcade", row.url) : null;
    if (other && other !== toolkit) others.add(other);
  }
  return [...others];
}

/**
 * 两个应用是不是在同一个认证提供商下，也就是共用一个连接。级联和预告用同一个判断：预告说会一起结束的，
 * 正是级联去核对的那些。不分大小写，和适配器认连接时一样（`arcade-adapter` 把提供商名转成小写再比）：
 * 厂商撤销时按这个规则结束的连接，这里也要按这个规则认，否则会留下一行厂商已经结束了的连接。
 */
const sameAuthProvider = (left: string | null, right: string): boolean =>
  left !== null && left.toLowerCase() === right.toLowerCase();

/**
 * 断开这个应用还会连带结束哪些应用，只回答、不动任何东西（上游的 `siblingApps`）：这个人持有连接、且和
 * 它在同一个认证提供商下的别的应用，排好序，不含它自己。
 *
 * 问不出认证提供商的应用不猜：把一个不会被碰的应用说成会结束，是教人忽略真正要紧的那条提醒。但少说也
 * 不是没有代价（按了断开，丢了一个没人提醒过的应用），所以问不出的有几个照实给个数，不给名字。问的这个
 * 应用自己问不出时，谁都判断不了，别的应用全算问不出。厂商超时和厂商答不出是同一个结果，级联那边也是
 * 这样对待的。
 *
 * 每个应用只问厂商一次，同时问：这是有人在等的页面。
 */
export async function arcadeConnectionSiblings(input: {
  store: PluginStore;
  arcade: ArcadeBroker;
  userId: string;
  toolkit: string;
}): Promise<{ siblings: string[]; unanswered: number }> {
  const { store, arcade, userId, toolkit } = input;
  const others = await otherArcadeAppsOf(store, userId, toolkit);
  if (others.length === 0) return { siblings: [], unanswered: 0 };
  const providerOf = (app: string) =>
    withVendorDeadline(() => arcade.authProviderOf(app)).catch(() => null);
  const [provider, ...answers] = await Promise.all(
    [toolkit, ...others].map(providerOf),
  );
  if (!provider) return { siblings: [], unanswered: others.length };
  const siblings = others.filter((_app, index) =>
    sameAuthProvider(answers[index] ?? null, provider),
  );
  return {
    siblings: siblings.sort(),
    unanswered: answers.filter((answer) => !answer).length,
  };
}

/**
 * 断开一个 Arcade 应用之后，结束这个人在同一认证提供商下、厂商那边也已经结束了的兄弟应用的本地行
 * （上游 #770 的断开级联）。Arcade 按认证提供商存连接：撤销 Gmail 的 Google 授权也结束了
 * GoogleCalendar。只结束「提供商相同、厂商也说已经没有连接」的那些；问不到的留着，不猜。
 */
export async function clearEndedArcadeSiblings(input: {
  store: PluginStore;
  arcade: ArcadeBroker;
  userId: string;
  toolkit: string;
}): Promise<string[]> {
  const { store, arcade, userId, toolkit } = input;
  const provider = await withVendorDeadline(() =>
    arcade.authProviderOf(toolkit),
  ).catch(() => null);
  if (!provider) return [];
  const ended: string[] = [];
  for (const sibling of await otherArcadeAppsOf(store, userId, toolkit)) {
    try {
      const same = sameAuthProvider(
        await withVendorDeadline(() => arcade.authProviderOf(sibling)),
        provider,
      );
      if (!same) continue;
      const live = await withVendorDeadline(() =>
        arcade.isConnected({
          account: { holder: "person", userId, vendorUserId: userId },
          toolkit: sibling,
        }),
      );
      if (live) continue;
      await store.disconnectBrokered({
        toolkit: sibling,
        userId,
        by: userId,
        reason: "self",
      });
      ended.push(sibling);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "arcade-sibling-not-cleared",
          app: sibling,
          note: "An Arcade app sharing the disconnected app's auth provider could not be checked or cleared; its row stands.",
          error: reasonWithoutStatement(error),
        }),
      );
    }
  }
  return ended;
}

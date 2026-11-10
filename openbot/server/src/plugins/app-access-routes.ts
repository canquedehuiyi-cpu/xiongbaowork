import type { Context, Hono, MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { appsPageZh } from "../edition";
import type {
  AppAccess,
  AppAccessRequestKind,
  Unavailable,
} from "./app-access";
import type { AppDirectory } from "./app-access-store";
import { MAX_PENDING_APP_ACCESS_REQUESTS } from "./app-access-tool";
import type { CatalogueEntry } from "./catalogue";
import type { AppAccessRequestRecord, PluginStore } from "./store";

type RouteContext = Context<{ Variables: AppVariables }>;

/**
 * 一个申请能带的应用名或员工 id 的最长长度，和工具给模型的上限一样。两者在被拒绝时都会写进轨迹，应用名
 * 还会成为管理员在收件箱里读到的标题，所以不是调用方想填什么就填什么的字段。
 */
export const MAX_NAME = 200;

/**
 * 打开一个目录条目还需要什么只有管理员能填的东西；只要添加它那一行就够时为 null。批准不能替管理员编出
 * 这些，所以照实说缺哪一个，申请保持待处理。
 */
export function adminInputFor(entry: CatalogueEntry): string | null {
  if (entry.host === null) return `你们的 ${entry.title} 实例地址`;
  if (
    entry.auth.kind === "user-oauth" &&
    entry.auth.clientRegistration !== "dynamic"
  )
    return "在 vendor 处登记的 OAuth 客户端";
  if (
    entry.auth.kind !== "user-oauth" &&
    entry.auth.kind !== "none" &&
    entry.auth.kind !== "builtin"
  )
    return "访问它用的密钥";
  return null;
}

/** 应用在、但还是用不了时，批准被拒绝的那句话。 */
export function unavailableSentence(
  reason: Unavailable,
  title: string,
  again = "再批准这条申请",
): string {
  switch (reason) {
    case "absent":
      return `「${title}」不能在这里打开。`;
    case "composio_unconfigured":
      return `设置 COMPOSIO_API_KEY 之前「${title}」无法连接。设置之后，${again}。`;
    case "scheme_unreadable":
      return `「${title}」已经打开，但读不出它怎么连接（或还没有人决定它用个人账号还是共享账号）。请在${appsPageZh()}它的页面上处理，然后${again}。`;
    case "oauth_client_missing":
      return `「${title}」还没有 OAuth 客户端。请在${appsPageZh()}它的页面上登记，然后${again}。`;
    case "token_missing":
      return `「${title}」还没有密钥。请在${appsPageZh()}它的页面上填写，然后${again}。`;
  }
}

/** 一个状态没有什么可以请管理员做时，答给申请人的话。 */
function nothingToRequest(access: AppAccess): string {
  const name = access.displayName;
  switch (access.state) {
    case "ready":
      return `「${name}」已经可以使用了，不需要向管理员申请。`;
    case "owner_grantable":
      return `这是你的员工，你可以自己把「${name}」给它。`;
    case "shared_not_connected":
      return `「${name}」用的是一个共享的团队账号，管理员还没有连接它。连接之后再试。`;
    case "shared_not_approved":
      return `「${name}」用的是一个共享的团队账号，管理员还没有批准这位员工使用它（共享使用批准将在后续版本提供）。`;
    default:
      return `「${name}」用的是你自己的账号，不需要管理员。请自己连接它。`;
  }
}

/**
 * 应用访问审批的上游路由（上游 `route-groups/app-access.ts`），与 fork 的申请收件箱是同一套：同一张表、
 * 同一条去重、同一个批准。这里只放 fork 原来没有的四条：
 *
 * - `GET /for/:agentId/apps`：员工持有的每个应用对这个人是什么。
 * - `GET /for/:agentId/apps/:app`：按键或名字问一个应用（持有与否），对话卡片据此画。
 * - `POST /access-requests`：在浏览器里申请。类型由服务端按状态定，浏览器只说员工和应用。
 * - `POST /for/:agentId/apps/:app/approve`：管理员在卡片上一按：替自己提这条申请并批准，与收件箱的批准
 *   走同一个 `carryOut`，不是第二条授予路径。
 *
 * 收件箱的列出、撤回、批准、驳回仍在 `routes.ts`（fork 原有的路由，形状按上游补齐）。
 *
 * 谁能做什么（安全敏感，逐条有测试）：
 * - 只能问、只能为自己能用的员工申请（`canUseBot`，否则 404，不说员工存不存在）。
 * - 只有目录、行或 broker 目录能作证的应用能申请打开；随手写的 `composio-` 键答没有这个应用。
 * - 类型是服务端的：本人自己能解决的状态（连接、重连、本人自己添加的应用）不建申请。
 * - 一按批准只给管理员（持有能力，`decisionRefusal`）；批准给的是只读、非破坏性的动作，写操作仍逐个授予。
 * - Shared 应用在 X3 并入共享使用批准之前对谁都读作 `shared_not_approved`，没有可申请的（X1 的共享闸门
 *   没有批准就拒绝，管理员与员工主人也不例外）。
 */
export function mountAppAccessRoutes(options: {
  routes: Hono<{ Variables: AppVariables }>;
  store: PluginStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** 带管理员能力的入口（`signedInWithCapability`）。 */
  capable: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  /** 管理员（带能力）时在员工主人的帧里做这件事，其余在本帧里做；routes.ts 的 `asBotOwner`。 */
  asBotOwner: <T>(
    context: { var: AppVariables },
    agentId: string,
    work: () => Promise<T>,
  ) => Promise<T>;
  composioConfigured: boolean;
  directory: AppDirectory | undefined;
  /** 能处理申请的人：持有能力的管理员；否则是拒绝的那句话。 */
  decisionRefusal: (context: { var: AppVariables }) => string | null;
  /** 收件箱的批准，做申请要的那件事并关单；一按批准共用它。 */
  carryOut: (
    context: RouteContext,
    request: AppAccessRequestRecord,
    chosen: string[] | undefined,
    direct?: boolean,
  ) => Promise<Response>;
}) {
  const {
    routes,
    store,
    requireUser,
    capable,
    canUseBot,
    composioConfigured,
    directory,
  } = options;

  const refused = async (
    context: RouteContext,
    input: {
      app: string;
      reason: string;
      error: string;
      status: 400 | 403 | 404 | 409 | 429;
      bot?: string | null;
      kind?: string;
    },
  ) => {
    await store.recordAppAccessEvent({
      eventType: "app_access.refused",
      targetId: input.app,
      actorUserId: context.var.actor.id,
      payload: {
        app: input.app,
        reason: input.reason,
        ...(input.bot !== undefined ? { bot: input.bot } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      },
    });
    return context.json({ error: input.error }, input.status);
  };

  /** 员工主人帧里的授予：管理员看别人的员工时，持有什么要在主人的帧里读。 */
  const ownersHeld = (context: RouteContext, agentId: string) => () =>
    options.asBotOwner(context, agentId, () => store.listForAgent(agentId));

  const inspect = (context: RouteContext, agentId: string, app: string) =>
    store.inspectApp({
      app,
      agentId,
      userId: context.var.actor.id,
      composioConfigured,
      directory,
      ownersHeld: ownersHeld(context, agentId),
    });

  /** 员工持有的每个应用对这个人是什么。只对这个人能用的员工答，否则 404。 */
  routes.get("/for/:agentId/apps", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId)))
      return context.json({ error: "没有这位员工。" }, 404);
    return context.json({
      apps: await store.appAccessForBot({
        userId: context.var.actor.id,
        agentId,
        composioConfigured,
        directory,
        ownersHeld: ownersHeld(context, agentId),
      }),
    });
  });

  /** 一个应用，按键或名字，员工持有与否，好让对话卡片说它停用了或没被授予，并给出能解决它的申请。 */
  routes.get("/for/:agentId/apps/:app", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId)))
      return context.json({ error: "没有这位员工。" }, 404);
    const app = context.req.param("app");
    const inspected =
      app.length > MAX_NAME ? null : await inspect(context, agentId, app);
    if (!inspected)
      return context.json({ error: `这个部署没有叫「${app}」的应用。` }, 404);
    return context.json({ app: inspected.access });
  });

  /**
   * 一条申请会是关于哪个应用，或者拒绝：员工和应用都写了，员工是这个人能用的，应用有东西作证，状态是只有
   * 管理员能解决的。申请与一按批准都先过它，所以两者都不会为对方会拒绝的东西按下去。
   */
  const requestable = async (
    context: RouteContext,
    rawAgentId: unknown,
    rawApp: unknown,
  ): Promise<
    | Response
    | {
        agentId: string;
        access: AppAccess;
        requestKind: Exclude<AppAccessRequestKind, "connect_shared">;
        serverId: string | null;
      }
  > => {
    const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
    const app = typeof rawApp === "string" ? rawApp.trim() : "";
    if (!agentId || !app)
      return context.json({ error: "请写明员工和应用。" }, 400);
    if (agentId.length > MAX_NAME || app.length > MAX_NAME)
      return context.json(
        { error: `员工和应用的名字最多 ${MAX_NAME} 个字符。` },
        400,
      );
    if (!(await canUseBot(context.var.actor, agentId)))
      return refused(context, {
        app,
        bot: agentId,
        reason: "no_such_bot",
        error: "没有这位员工。",
        status: 404,
      });
    const found = await inspect(context, agentId, app);
    const inspected =
      found && (found.vouched || found.access.granted) ? found : null;
    if (!inspected)
      return refused(context, {
        app,
        bot: agentId,
        reason: "no_such_app",
        error: `这个部署没有叫「${app}」的应用。`,
        status: 404,
      });
    const { access } = inspected;
    // 自己添加的应用不归管理员管：申请只会让管理员看到一个在他的帧里不存在的应用，永远批不了。
    if (inspected.own)
      return refused(context, {
        app: access.key,
        bot: agentId,
        reason: "own_app",
        error: `「${access.displayName}」是你自己添加的应用，不需要向管理员申请。请在插件页自己把它装到这位员工上。`,
        status: 409,
      });
    const kind = access.requestKind;
    if (kind !== "enable" && kind !== "grant")
      return refused(context, {
        app: access.key,
        bot: agentId,
        reason: `nothing_to_request:${access.state}`,
        error: nothingToRequest(access),
        status: 409,
      });
    return {
      agentId,
      access,
      requestKind: kind,
      serverId: inspected.answeringId,
    };
  };

  const fileFor = (
    context: RouteContext,
    asked: Exclude<Awaited<ReturnType<typeof requestable>>, Response>,
    note: string | null,
  ) =>
    store.fileAppAccessRequest({
      serverId: asked.serverId,
      ...(asked.serverId === null
        ? { appKey: asked.access.key, appTitle: asked.access.displayName }
        : {}),
      botId: asked.agentId,
      requesterUserId: context.var.actor.id,
      kind: asked.requestKind,
      note,
      maxPending: MAX_PENDING_APP_ACCESS_REQUESTS,
    });

  /**
   * 在浏览器里向管理员申请。请求体写员工和应用（可选一句理由 `note`）；类型是服务端的。
   *
   * 再按一次就是第一次那条：同一个人、员工、应用、类型只有一条待处理的，答已有那条并 `created: false`，
   * 不写第二行轨迹。已有那条先于上限回答，所以到了上限的人再按自己已提的申请，看到的是它而不是拒绝。
   */
  routes.post("/access-requests", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
      app?: unknown;
      note?: unknown;
    } | null;
    const note =
      typeof body?.note === "string" && body.note.trim()
        ? body.note.trim()
        : null;
    if (note !== null && note.length > 500)
      return context.json({ error: "申请理由最多 500 个字。" }, 400);
    const asked = await requestable(context, body?.agentId, body?.app);
    if (asked instanceof Response) return asked;
    const filed = await fileFor(context, asked, note);
    if (filed.outcome === "limited")
      return refused(context, {
        app: asked.access.key,
        bot: asked.agentId,
        reason: "too_many_pending",
        kind: asked.requestKind,
        error: `你已经有 ${MAX_PENDING_APP_ACCESS_REQUESTS} 条申请在等管理员处理。先撤回一条，或等它们处理完，再申请。`,
        status: 429,
      });
    const created = filed.outcome === "created";
    return context.json(
      { request: filed.request, created },
      created ? 201 : 200,
    );
  });

  /**
   * 管理员在卡片上一按：替自己提这个应用在这位员工上需要的申请，并当场批准。轨迹和两次按下一样——
   * `app_access.requested`，然后带 `direct` 的 `app_access.approved`。
   *
   * 同样的检查、同样的改动：能申请什么是 `requestable` 的答案，批准做什么是收件箱的 `carryOut`。没有
   * `refs`：一按给的是收件箱不带 refs 时给的，应用的只读、非破坏性动作。
   *
   * 没能做成就什么也不留：这次新提的申请撤回（写一行带 `direct` 的 `app_access.cancelled`）；本来就在等的
   * 那条原样留着。
   */
  routes.post("/for/:agentId/apps/:app/approve", capable, async (context) => {
    const refusal = options.decisionRefusal(context);
    if (refusal) return context.json({ error: refusal }, 403);
    const asked = await requestable(
      context,
      context.req.param("agentId"),
      context.req.param("app"),
    );
    if (asked instanceof Response) return asked;
    const by = context.var.actor.id;
    const filed = await fileFor(context, asked, null);
    if (filed.outcome === "limited")
      return refused(context, {
        app: asked.access.key,
        bot: asked.agentId,
        reason: "too_many_pending",
        kind: asked.requestKind,
        error: `你已经有 ${MAX_PENDING_APP_ACCESS_REQUESTS} 条申请在等处理。先处理掉一些再试。`,
        status: 429,
      });
    const response = await options.carryOut(
      context,
      filed.request,
      undefined,
      true,
    );
    if (response.status !== 200 && filed.outcome === "created") {
      const withdrawn = await store.cancelAppAccessRequest({
        id: filed.request.id,
        requesterUserId: by,
      });
      if (withdrawn)
        await store.recordAppAccessEvent({
          eventType: "app_access.cancelled",
          targetId: withdrawn.appKey,
          actorUserId: by,
          payload: {
            request: withdrawn.id,
            app: withdrawn.appKey,
            bot: withdrawn.botId,
            kind: withdrawn.kind,
            direct: true,
          },
        });
    }
    return response;
  });
}

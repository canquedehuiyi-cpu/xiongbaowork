/**
 * 插件接口上「会话里还写着管理员、角色已被收回」的那道门，挂在装配处（app.ts）。
 *
 * 会话自己带着角色时，守卫直接用它，不再读 `user_roles`；管理员能力不一样，每次请求由
 * `adminCapability` 重新读过 `user_roles` 之后才给。两者不一致的时候（角色已被收回，会话还说是管理员），
 * 只看会话角色的路径会让这个人继续做管理员的事。会话不带角色时守卫每次请求都读 `user_roles`，不会有这种
 * 不一致，这道门对那样的请求只是多核对一次。
 *
 * 下面这些路径在路由里只看会话角色，数据库也拦不住，或者拦住之前已经去问了厂商：
 *
 * - 单个授予和收回：授予写在请求者自己的帧里，行安全不拦他给自己的员工授予。
 * - 上架和下架：上架表由 store 以 platform 写。
 * - 添加应用、换令牌、登记 OAuth 客户端、启用 broker 应用：store 在写之前会拒绝，但那时路由已经读过
 *   broker 的目录；在这里拒绝，就什么都还没有做。
 * - 浏览 broker 目录：用部署的密钥去问厂商。
 *
 * 判断和路由里的 `decisionRefusal` 是同一个：会话是管理员，而且这次请求持有管理员能力。会话是管理员
 * 却没有能力的请求答 403；成员不归这道门管，原样放过去，由路由照旧回答（成员有自己的自助安装）。没有
 * 角色仓库的装配里没有人拿得到能力，这道门就拒绝每一个会话说自己是管理员的请求，是关着的方向。
 *
 * 其余的管理员路径在路由入口自己核对（`plugins/routes.ts` 的 `staleAdminRefusal`），不在这张表里。
 */
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { capabilityFor } from "../tenant/context";

/** 会话里写着管理员、这次请求却没有拿到管理员能力时答的话。和路由里的那一句相同。 */
export const STALE_ADMIN_REFUSAL = "你的管理员身份没能确认，没有改变任何东西。";

type Rule = { methods: readonly string[]; path: RegExp };

const ADMIN_PATHS: readonly Rule[] = [
  { methods: ["POST", "DELETE"], path: /^\/api\/plugins\/grants$/ },
  { methods: ["POST", "DELETE"], path: /^\/api\/plugins\/listings$/ },
  { methods: ["POST"], path: /^\/api\/plugins\/servers$/ },
  { methods: ["POST"], path: /^\/api\/plugins\/servers\/custom$/ },
  {
    methods: ["POST"],
    path: /^\/api\/plugins\/servers\/[^/]+\/(token|oauth-client)$/,
  },
  { methods: ["GET", "POST"], path: /^\/api\/plugins\/composio\/apps$/ },
];

/**
 * `requireAdminUser` 是装配处那一个：先认出是谁，再让 `adminCapability` 重新读角色。不在表里的请求不查
 * 会话，直接放过去。
 */
export function createStaleAdminGate(
  requireAdminUser: MiddlewareHandler<{ Variables: AppVariables }>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    /*
     * 两种写法的路径都看。Hono 按解码后的路径（`c.req.path`）找路由，`/api/plugins/%67rants` 到的也是
     * 授予那条路由，只拿原始 URL 去比就漏过去了。HEAD 走的是 GET 的处理函数。
     */
    const paths = [
      ...new Set([context.req.path, new URL(context.req.url).pathname]),
    ];
    const method = context.req.method === "HEAD" ? "GET" : context.req.method;
    const gated = ADMIN_PATHS.some(
      (rule) =>
        rule.methods.includes(method) &&
        paths.some((path) => rule.path.test(path)),
    );
    if (!gated) return next();

    let refused: Response | undefined;
    const answered = await requireAdminUser(context, async () => {
      const actor = context.var.actor;
      if (actor.role === "admin" && capabilityFor(actor.id) !== "admin")
        refused = context.json({ error: STALE_ADMIN_REFUSAL }, 403);
    });
    // 守卫自己答了：没登录，或者没有角色。
    if (answered instanceof Response) return answered;
    if (refused) return refused;
    // 路由在自己的守卫后面，会再打开这个人的帧。
    return next();
  };
}

/**
 * 以登录人身份访问的自定义 MCP 服务器（上游 #931，Microsoft OBO）：插件存储用到的规则和中文说明。
 *
 * 单独一个模块，让 `store.ts` 只做接线：哪个 scope 生效、什么时候拒绝，以及本人看到的每一句话，都在这里
 * 写一次。token 本身由 `auth/entra.ts` 换取和缓存，这里不碰 token，也不碰登录。
 *
 * fork 比上游多的一条底线：token 的受众和发送地址必须对得上（评审 I-2）。上游允许管理员给任意地址标任意
 * scope，于是 OpenBot 管理员只要填一个 Microsoft Graph 或 OpenBot 自己 API 的 scope，就能把每个人的委托
 * token 收到自己的服务器上。这里要求：
 * - scope 的资源必须登记在部署设置 `MICROSOFT_OAUTH_OBO_RESOURCES` 里，并写明这个资源的 token 只发往哪个
 *   主机（`<资源>=<主机>`）。登记由能改部署配置的人做，不由应用里的管理员做；不设置就不能标记任何服务器。
 * - 服务器地址的主机名必须和登记的主机一字不差。
 * - OpenBot 自己的 API（client id、`api://<client id>` 及其子路径、`MICROSOFT_OAUTH_API_SCOPE` 的资源）和
 *   Microsoft 第一方资源（Graph 等）永远拒绝，登记了也不行：启动时就拒绝这样的登记。
 * - 每次调用前再核对一遍（登记可能已经改了），对不上就不发。
 *
 * 存储说明（评审 M-5）：OBO 换来的 access token 只在 `auth/entra.ts` 的进程内存里，不落库。用来换取的
 * Microsoft refresh token 由 Better Auth 存在它的 `account` 表里，用 Better Auth 自己的加密
 * （`encryptOAuthTokens`，密钥随 `BETTER_AUTH_SECRET`），轮换后的新值也按同样方式写回；它**不在** fork 凭据库
 * 的 v2 信封里，也不随 fork 的密钥轮换。没有改成 fork 凭据库，是因为这一行是 Better Auth 的登录记录本身，
 * 它自己的登录、账号关联和取 token 流程都直接读写这一列；把它挪走等于替换 Better Auth 的存储层。
 */
import type { EntraRefusal, EntraTokens } from "../auth/entra-refusal";
import { EntraTokenRefusedError } from "../auth/entra-refusal";

/** 一个 scope 最长多少字符。Entra 的 scope 是 `api://<id>/.default` 这类短串，再长就是填错了。 */
const ENTRA_SCOPE_MAX = 256;

/** 部署登记的一个下游资源：这个资源的 token 只发往 `host`。 */
export type OboResource = { resource: string; host: string };

/** 判断 scope 能不能用、发往哪里所需的部署事实。 */
export type EntraBinding = {
  /** `MICROSOFT_OAUTH_OBO_RESOURCES` 登记的资源；空就是谁都不能标记。 */
  resources: readonly OboResource[];
  /** OpenBot 自己 API 的资源标识（小写），见 {@link openBotResources}。 */
  own: readonly string[];
};

/**
 * 插件存储拿到的 Entra：换 token 的门，加上核对 scope 的部署事实。
 *
 * 后两项可选，只是为了类型上兼容只给 `tokenFor` 的调用方；缺了按空处理，也就是任何 scope 都不放行
 * （失败闭合）。
 */
export type EntraOnBehalf = EntraTokens & Partial<EntraBinding>;

/** 资源标识统一成小写、去掉末尾斜杠后再比较。 */
function normalized(resource: string): string {
  return resource.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * scope 指向的资源：`<资源>/<权限>` 去掉最后一段。`api://hr-api/.default` 是 `api://hr-api`。
 *
 * 没有 `/` 的写法（`User.Read`、`Mail.Read`）在 Entra 里默认指 Microsoft Graph，这里返回 null，由调用方拒绝。
 */
export function scopeResource(scope: string): string | null {
  const trimmed = scope.trim();
  const scheme = trimmed.indexOf("://");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= (scheme === -1 ? 0 : scheme + 2)) return null;
  if (slash === trimmed.length - 1) return null;
  const resource = normalized(trimmed.slice(0, slash));
  return resource || null;
}

/** OpenBot 自己 API 的资源标识：client id、`api://<client id>`、以及 API scope 的资源。 */
export function openBotResources(clientId: string, apiScope: string): string[] {
  const id = normalized(clientId);
  return [
    ...new Set(
      [id, `api://${id}`, scopeResource(apiScope) ?? ""].filter(Boolean),
    ),
  ];
}

/** Microsoft 第一方应用的 app id：Graph、Azure AD Graph、SharePoint、Exchange、Dynamics、Power BI 等。 */
const MICROSOFT_FIRST_PARTY_ID =
  /^0000000[0-9a-f]-0000-0(000|ff1)-c(000|e00)-000000000000$/;
/** 不符合上面规律的其他第一方资源：Azure 资源管理、Key Vault、Azure 存储。 */
const MICROSOFT_FIRST_PARTY_IDS = new Set([
  "797f4846-ba00-4fd7-ba43-dac1f8f63013",
  "cfa8b339-82a2-471a-a3c9-0fc0be7a4093",
  "e406a681-f3d4-42a8-90b6-c2b029497af1",
]);
/** 第一方资源的 URI 主机：它们本身或任何子域都算。 */
const MICROSOFT_FIRST_PARTY_HOSTS = [
  "microsoft.com",
  "microsoftonline.com",
  "microsoftonline.us",
  "microsoftonline.cn",
  "windows.net",
  "office.com",
  "office.net",
  "office365.com",
  "office365.us",
  "outlook.com",
  "live.com",
  "sharepoint.com",
  "sharepoint.us",
  "sharepoint.cn",
  "azure.com",
  "azure.net",
  "azure.us",
  "azure.cn",
  "chinacloudapi.cn",
  "dynamics.com",
  "powerbi.com",
  "microsoft.us",
];

/** 这个资源是不是不允许的那两类之一：OpenBot 自己，或 Microsoft 第一方。 */
export function forbiddenResource(
  resource: string,
  own: readonly string[],
): "own" | "microsoft" | null {
  const value = normalized(resource);
  for (const mine of own) {
    const ours = normalized(mine);
    if (ours && (value === ours || value.startsWith(`${ours}/`))) return "own";
  }
  const id = value.replace(/^api:\/\//, "").split("/")[0] ?? "";
  if (MICROSOFT_FIRST_PARTY_ID.test(id) || MICROSOFT_FIRST_PARTY_IDS.has(id))
    return "microsoft";
  if (/^https?:\/\//.test(value)) {
    let host = "";
    try {
      host = new URL(value).hostname;
    } catch {
      return "microsoft";
    }
    if (
      MICROSOFT_FIRST_PARTY_HOSTS.some(
        (root) => host === root || host.endsWith(`.${root}`),
      )
    )
      return "microsoft";
  }
  return null;
}

/** 主机名：小写字母、数字、点和连字符，不带端口。 */
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * 解析 `MICROSOFT_OAUTH_OBO_RESOURCES` 的各项 `<资源>=<主机>`。写错的、指向 OpenBot 自己的、指向
 * Microsoft 第一方资源的，都在启动时拒绝：这类登记留着只会在某天被人用上。
 */
export function parseOboResources(
  entries: readonly string[],
  own: readonly string[],
): OboResource[] {
  return entries.map((entry) => {
    const at = entry.lastIndexOf("=");
    const resource = at > 0 ? normalized(entry.slice(0, at)) : "";
    const host =
      at > 0
        ? entry
            .slice(at + 1)
            .trim()
            .toLowerCase()
        : "";
    if (!resource || !HOSTNAME.test(host)) {
      throw new Error(
        `MICROSOFT_OAUTH_OBO_RESOURCES 的「${entry}」写法不对。每项写成 <资源>=<主机>，例如 api://hr-api=hr.example.com，多项用逗号隔开。`,
      );
    }
    const forbidden = forbiddenResource(resource, own);
    if (forbidden) {
      throw new Error(
        forbidden === "own"
          ? `MICROSOFT_OAUTH_OBO_RESOURCES 登记了 OpenBot 自己的 API（${resource}）。换出来的 token 能冒充本人调用 OpenBot，不能登记。`
          : `MICROSOFT_OAUTH_OBO_RESOURCES 登记了 Microsoft 的第一方资源（${resource}）。这类 token 权限太大，不能发给自定义服务器。`,
      );
    }
    return { resource, host };
  });
}

/**
 * 这个 scope 能不能发往这个地址：不能的话返回给管理员看的原因，能的话返回 null。
 *
 * 标记时问一次，每次调用前再问一次。
 */
export function scopeBindingRefusal(
  scope: string,
  url: string,
  binding: EntraBinding,
): string | null {
  const resource = scopeResource(scope);
  if (!resource) {
    return `「${scope}」没有写明资源。请写成 <资源>/<权限>，例如 api://hr-api/.default；只写权限名时 Entra 默认指 Microsoft Graph，不能用。`;
  }
  const forbidden = forbiddenResource(resource, binding.own);
  if (forbidden === "own") {
    return "不能用 OpenBot 自己的 API 作为 Entra scope：换出来的 token 能冒充本人调用 OpenBot。";
  }
  if (forbidden === "microsoft") {
    return "不能用 Microsoft 的第一方资源（例如 Microsoft Graph）作为 Entra scope：这类 token 权限太大，不能发给自定义服务器。";
  }
  const registered = binding.resources.find(
    (entry) => entry.resource === resource,
  );
  if (!registered) {
    return `${resource} 没有登记在部署设置 MICROSOFT_OAUTH_OBO_RESOURCES 里。请运维把它和它的服务器主机一起登记（<资源>=<主机>）。`;
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host !== registered.host) {
    return `${resource} 登记的服务器主机是 ${registered.host}，和这个服务器的地址（${host || url}）不一致。token 只发往登记的主机。`;
  }
  return null;
}

/**
 * Entra 不肯为这个人发 token 时，本人看到的那句话：说清楚是谁、要做什么。
 *
 * 上游原句是英文，这里按 fork 的约定改成中文，意思逐条对应。`refused` 是其余情况，运维日志
 * （`entra-token-refused`）里有错误码，这里不把 Microsoft 的原文转给本人。
 */
export function entraRefusalSentence(
  reason: EntraRefusal,
  title: string,
): string {
  switch (reason) {
    case "not-admitted":
      return `你已经不能使用 OpenBot，所以没有使用「${title}」。`;
    case "no-sign-in":
      return `「${title}」要用你的 Microsoft 账号，但 OpenBot 还没有你的 Microsoft 登录。请先在浏览器里用 Microsoft 登录 OpenBot 一次，再重新提问。`;
    case "sign-in-expired":
      return `你的 Microsoft 登录已过期，所以没有使用「${title}」。请重新用 Microsoft 登录后再提问。`;
    case "no-consent":
      return `管理员还没有在 Microsoft Entra 里授权 OpenBot 访问「${title}」。请联系管理员授权。`;
    case "no-api-consent":
      return `OpenBot 在 Microsoft Entra 里还没有获得对它自己 API 的授权，所以无法以你的身份访问「${title}」。请联系管理员授权。`;
    case "no-api":
      return `OpenBot 在 Microsoft Entra 里还没有设置好，无法以你的身份访问「${title}」。请管理员在那里公开 OpenBot 的 API。`;
    case "refused":
      return `Microsoft 不允许 OpenBot 以你的身份访问「${title}」。请稍后再试；如果一直这样，请联系管理员。`;
  }
}

/**
 * 一次调用用的 token：Entra 代表提问人、为这个服务器的 scope 发的那一个。
 *
 * 拿不到就抛 `refuse(句子)` 造出的拒绝，绝不退回部署保存的凭据：退回去就是用别人的权限替这个人回答。
 * 每种拿不到的情况都给本人一句能照着做的话。发出前先核对 scope 和地址仍然对得上（登记可能改过），再由
 * `tokens.tokenFor` 在发出任何 token（缓存的或新换的）之前重新问一遍登录规则，被管理员移除的人在这里
 * 立刻失效。
 */
export async function entraTokenFor(
  tokens: EntraOnBehalf | undefined,
  row: { title: string; url: string; entraScope?: string | null },
  actorId: string,
  refuse: (sentence: string) => Error,
): Promise<string> {
  if (!actorId) {
    throw refuse(
      `「${row.title}」以提问人的身份访问，而这次运行没有归属到任何人。`,
    );
  }
  if (!tokens || !row.entraScope) {
    throw refuse(
      `「${row.title}」需要 Microsoft 登录，但这里还没有配置。请联系管理员配置。`,
    );
  }
  if (
    scopeBindingRefusal(row.entraScope, row.url, {
      resources: tokens.resources ?? [],
      own: tokens.own ?? [],
    })
  ) {
    throw refuse(
      `「${row.title}」的 Entra scope 已经不在部署登记的范围里，所以没有发出。请联系管理员。`,
    );
  }
  try {
    return await tokens.tokenFor(actorId, row.entraScope);
  } catch (error) {
    if (error instanceof EntraTokenRefusedError) {
      throw refuse(entraRefusalSentence(error.reason, row.title));
    }
    throw error;
  }
}

/** 按 URL 添加服务器时，`entraScope` 落成什么，或者为什么拒绝。 */
export type EntraScopeDecision =
  | {
      /**
       * 调用方写明的：字符串就是新的 scope，`null` 是取消标记，`undefined` 是没提（保留原样）。
       * 写库时只有写明了才改这一列。
       */
      named: string | null | undefined;
      /** 这次写入之后生效的 scope；没有就是按部署凭据访问。 */
      scope: string | undefined;
    }
  | { refusal: string };

/**
 * 这次写入之后服务器怎么访问：调用方写明的 scope，写明 `null` 就是不再标记，没提就沿用已有的。
 *
 * 沿用是要紧的那种情况：不认识这个字段的调用方（应用里「按 URL 添加」的请求就不发它）重新添加一个
 * 已标记的服务器，若清掉标记，之后每次调用都会悄悄改走部署的凭据。
 *
 * fork 比上游多两条：
 * - 已标记的服务器不能换地址，换地址时也不能同时标记。fork 对部署凭据已有同样的规矩（凭据只在交给它的
 *   地址上用），而这里每次调用带的是本人在那个系统里的 token。这是先读后判；写库时 `store.ts` 再用条件
 *   更新原子地核对一次（评审 M-1），并发的另一个请求改了地址或标记就拒绝。
 * - scope 必须登记、地址必须对得上（{@link scopeBindingRefusal}）。
 *
 * `binding` 为 undefined 表示部署没配 Microsoft 登录。
 */
export function decideEntraScope(
  input: {
    id: string;
    url: string;
    credentialId?: string;
    entraScope?: string | null;
  },
  existing: { url: string; entraScope: string | null } | undefined,
  binding: EntraBinding | undefined,
): EntraScopeDecision {
  const named =
    input.entraScope === undefined
      ? undefined
      : input.entraScope?.trim() || null;
  const scope =
    (named === undefined ? existing?.entraScope : named) || undefined;

  if (existing && existing.url !== input.url) {
    if (existing.entraScope)
      return {
        refusal: `${input.id} 以登录人的身份访问，已经在另一个地址。要换地址，请先移除再重新添加。`,
      };
    if (scope)
      return {
        refusal: `${input.id} 已经在另一个地址。换地址时不能同时设为以登录人的身份访问，请先移除再重新添加。`,
      };
  }
  if (!scope) return { named, scope };

  if (!binding)
    return {
      refusal:
        "还没有配置 Microsoft 登录，所以不能把服务器设为以登录人的身份访问。请先设置 MICROSOFT_OAUTH_CLIENT_ID 和 MICROSOFT_OAUTH_CLIENT_SECRET。",
    };
  // 每次调用带的是本人的 token，部署的令牌放在这里永远不会被发出去，所以直接拒绝，不默默收下。
  if (input.credentialId?.trim())
    return {
      refusal:
        named === undefined
          ? `${input.id} 以登录人的身份访问，不收令牌。要改用令牌访问，请同时把 entraScope 设为 null。`
          : "以登录人的身份访问的服务器使用本人的 Microsoft 登录，不收令牌。",
    };
  if (/\s/.test(scope) || scope.length > ENTRA_SCOPE_MAX)
    return {
      refusal: "请只填一个 Entra scope，例如 api://hr-api/.default。",
    };
  const unbound = scopeBindingRefusal(scope, input.url, binding);
  if (unbound) return { refusal: unbound };
  return { named, scope };
}

/**
 * 写库时的原子核对（评审 M-1）：冲突更新只在这条件成立时才落下。
 *
 * 地址没变，或者库里这一行此刻既没有标记、也没有部署凭据，而这次写入也不带标记和凭据。和
 * {@link decideEntraScope} 及 `store.ts` 里凭据换地址的规则是同一件事，只是在行锁之下再问一次，
 * 两个并发请求谁也绕不过去。
 */
export const MOVED_WHILE_ADDING =
  "这个服务器刚被别人改过地址或访问方式。请刷新后再试；要换地址，请先移除再重新添加。";

/**
 * 以登录人身份访问的自定义 MCP 服务器（上游 #931，Microsoft OBO）：插件存储用到的规则和中文说明。
 *
 * 单独一个模块，让 `store.ts` 只做接线：哪个 scope 生效、什么时候拒绝，以及本人看到的每一句话，都在这里
 * 写一次。token 本身由 `auth/entra.ts` 换取和缓存，这里不碰 token，也不碰登录。
 */
import type { EntraRefusal, EntraTokens } from "../auth/entra-refusal";
import { EntraTokenRefusedError } from "../auth/entra-refusal";

/** 一个 scope 最长多少字符。Entra 的 scope 是 `api://<id>/.default` 这类短串，再长就是填错了。 */
const ENTRA_SCOPE_MAX = 256;

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
 * 每种拿不到的情况都给本人一句能照着做的话。`tokens.tokenFor` 在发出任何 token（缓存的或新换的）之前
 * 都会重新问一遍登录规则，被管理员移除的人在这里立刻失效。
 */
export async function entraTokenFor(
  tokens: EntraTokens | undefined,
  row: { title: string; entraScope?: string | null },
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
 * fork 比上游多一条：已标记的服务器不能换地址（或换地址的同时标记）。fork 对部署凭据已有同样的规矩
 * （凭据只在交给它的地址上用），而这里每次调用带的是本人在那个系统里的 token，换到别的地址就是把每个
 * 人的 token 送过去。要换地址，先移除再重新添加。
 */
export function decideEntraScope(
  input: {
    id: string;
    url: string;
    credentialId?: string;
    entraScope?: string | null;
  },
  existing: { url: string; entraScope: string | null } | undefined,
  entraConfigured: boolean,
): EntraScopeDecision {
  const named =
    input.entraScope === undefined
      ? undefined
      : input.entraScope?.trim() || null;
  const scope =
    (named === undefined ? existing?.entraScope : named) || undefined;

  if (existing && existing.url !== input.url && (existing.entraScope || scope))
    return {
      refusal: `${input.id} 以登录人的身份访问，已经在另一个地址。要换地址，请先移除再重新添加。`,
    };
  if (!scope) return { named, scope };

  if (!entraConfigured)
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
  return { named, scope };
}

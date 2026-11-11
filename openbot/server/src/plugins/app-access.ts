import { schemeKind } from "./broker";
import type { CatalogueEntry } from "./catalogue";
import { accountFor, brokeredProvenance } from "./shared-accounts";

/**
 * 一个人能不能通过一位员工用一个应用；不能的话，下一步是什么、归谁（上游 `app-access.ts`，按 fork 改写）。
 *
 * 为什么是一个答案：每个事实本来各有出处——应用行在 `mcp_servers`，broker 有没有配置是环境里的一个 key，
 * 员工持有什么是 `plugin_grants`，个人连接在 `composio_connections` / `mcp_user_credentials`，Shared 应用
 * 的团队账号记在应用行的 `shared_*` 列（X1，迁移 0180）。这里从同样的表、按每道闸门同样的规则算一次，
 * 作为一个词发给浏览器，浏览器照着画，不自己再推一遍。
 *
 * 这里不问 vendor。「已连接」是这个部署最后一次记下的：连接或重新检查写的 `verified` / `probe` 列。
 *
 * 与上游的差异（都写在报告里）：
 * - 谁的账号用 X1 的 `accountFor`（`shared-accounts.ts`）判定，不另写一份。账号模式没人决定（NULL）的
 *   broker 行，调用会被拒绝，所以这里读作停用（`scheme_unreadable`）而不是猜成个人账号。
 * - broker 应用是 Composio 或 Arcade 的（X5），`AppProvider` 说的是这个应用自己的提供商。
 * - `connect_shared` 不建申请：fork 的申请表只收 enable 与 grant（0153 的 CHECK，fork 测试钉住）。
 * - 主人自己给员工应用（`owner_grantable`、`ownerGrants`）属于 X3；X2 里 `mayGiveOwn` 恒为 false，
 *   `ownerGrants` 列也还不存在，所以只给出按账号的默认值。
 */

/**
 * 一个人在一位员工上看一个应用，可能被告知的八种状态。
 *
 * `ready` 现在可用。`not_connected` / `reconnect` 等这个人自己连接或重连。`shared_not_connected` 团队账号
 * 还没连接（或密钥被拒），只有管理员能连。`shared_not_approved` 团队账号已连接，但这个人不在允许驾驶它的
 * 人里（X3 之前只有员工主人和管理员）。`disabled` 部署这一侧没开好。`not_granted` 开好了，这位员工没被
 * 授予。`owner_grantable` 员工的主人可以自己给（X3 接线）。
 */
export const APP_ACCESS_STATES = [
  "ready",
  "not_connected",
  "reconnect",
  "shared_not_connected",
  "shared_not_approved",
  "disabled",
  "not_granted",
  "owner_grantable",
] as const;

export type AppAccessState = (typeof APP_ACCESS_STATES)[number];

/** 请管理员做的事。fork 的申请表只收前两种；`connect_shared` 保留在类型里，好让前端的类型对得上。 */
export type AppAccessRequestKind = "enable" | "grant" | "connect_shared";

/**
 * 每个状态要建哪种申请，下一步归本人的为 null。是一张表而不是分支，新加的状态编译器会再问一次。
 *
 * fork 差异：`shared_not_connected` 为 null（见文件头）。
 */
export const REQUEST_KIND_FOR: Record<
  AppAccessState,
  AppAccessRequestKind | null
> = {
  ready: null,
  not_connected: null,
  reconnect: null,
  shared_not_connected: null,
  shared_not_approved: null,
  disabled: "enable",
  not_granted: "grant",
  owner_grantable: null,
};

/** 谁可以把应用给员工：员工的主人（`any`），或只有管理员（`admin`）。X3 加上 `mcp_servers.owner_grants`。 */
export type OwnerGrants = "any" | "admin";

/** 调用进谁的账号。 */
export type AppAccount = "personal" | "shared" | "deployment";

/** 账号怎么连接：部署自己的 OAuth、broker 的同意页、broker 的密钥表单，或没有可连的。 */
export type AppConnect = "oauth" | "consent" | "key" | null;

/** 应用从哪来。fork 只有 Composio 一个 broker。 */
export type AppProvider = "composio" | "arcade" | "catalogue" | "custom";

/** 部署这一侧缺什么，任何人都还用不了；见 {@link unavailableReason}。 */
export type Unavailable =
  | "absent"
  | "composio_unconfigured"
  | "scheme_unreadable"
  | "oauth_client_missing"
  | "token_missing";

/** 员工页和对话卡片画的一个应用。字段与上游一致，前端直接接。 */
export type AppAccess = {
  /** 应用的键：授予 ref 的前缀（目录键，或没有目录键时是行自己的 id）。申请就按它记。 */
  key: string;
  displayName: string;
  logo: string | null;
  provider: AppProvider;
  account: AppAccount;
  connect: AppConnect;
  authScheme: string | null;
  accountMode: "personal" | "shared" | null;
  state: AppAccessState;
  unavailable: Unavailable | null;
  /** 个人账号应用的调用进谁的账号：自己的，或别人的 Team Bot 上主人的。不是个人账号时为 null。 */
  accountHolder: "you" | "owner" | null;
  /** 在别人的 Team Bot 上用自己的账号、又没有长期同意时，第一次调用会先问。状态仍是 `ready`。 */
  asksFirst: boolean;
  granted: boolean;
  ownerGrants: OwnerGrants;
  givenByOwner: boolean;
  needsConnect: boolean;
  /** 这个人用的那个账号（自己的，或 Shared 应用的团队账号）何时连接；没有时为 null。 */
  connectedAt: string | null;
  requestKind: AppAccessRequestKind | null;
  /** 这个人对这个状态那一种申请的待处理记录。 */
  request: { id: string; kind: AppAccessRequestKind; createdAt: string } | null;
};

/** 判定状态用到的事实，全部由 store 从表里读出来；这里没有判断。 */
export type AppAccessFacts = {
  provider: AppProvider;
  /** 应用行在不在。 */
  present: boolean;
  /** 部署有没有 Composio 的 key。 */
  composioConfigured: boolean;
  /** broker 应用记下的认证方式。 */
  authScheme: string | null;
  /** broker 目录说一个还没有行的应用怎么连接；有行时不读。 */
  listedConnect?: AppConnect;
  /** broker 应用的账号模式，原样（NULL 就是 NULL，见 X1 `accountFor`）。 */
  accountMode: "personal" | "shared" | null;
  catalogueAuth: CatalogueEntry["auth"] | null;
  /** 应用行上有没有凭据：OAuth 客户端，或部署的密钥。 */
  hasCredential: boolean;
  granted: boolean;
  ownerGrants: OwnerGrants | null;
  /** 这个人能不能把自己的应用给这位员工（X3）。X2 恒为 false。 */
  mayGiveOwn: boolean;
  personal: { usable: boolean } | null;
  shared: { usable: boolean } | null;
  /** 共享闸门会不会放这个人的调用经这位员工进团队账号；没人问时为 null。 */
  sharedAdmitted: boolean | null;
};

type AccountFacts = Pick<
  AppAccessFacts,
  "provider" | "authScheme" | "accountMode" | "catalogueAuth"
>;

/** broker 应用按 X1 的 `accountFor` 读；`ambiguous` 交给 {@link unavailableReason}。 */
function brokeredAnswer(facts: AccountFacts) {
  return accountFor(
    {
      title: "",
      provenance: facts.provider,
      authScheme: facts.authScheme,
      accountMode: facts.accountMode,
    },
    "",
  );
}

/** 调用进谁的账号，和调用时 `accountFor` 的答案是同一个。 */
export function accountOf(facts: AccountFacts): AppAccount {
  if (brokeredProvenance(facts.provider)) {
    const answer = brokeredAnswer(facts);
    if (answer.kind === "none") return "deployment";
    if (answer.kind === "deployment") return "shared";
    return "personal";
  }
  if (facts.provider === "catalogue")
    return facts.catalogueAuth?.kind === "user-oauth"
      ? "personal"
      : "deployment";
  return "deployment";
}

/**
 * 谁可以把这个应用给员工：管理员选的，或按账号的默认值——只在应用跑在提问者自己账号上时（以及内置的
 * 例行任务）默认归主人决定。
 */
export function ownerGrantsOf(
  facts: AccountFacts & { ownerGrants: OwnerGrants | null },
): OwnerGrants {
  if (facts.ownerGrants) return facts.ownerGrants;
  if (facts.catalogueAuth?.kind === "builtin") return "any";
  return accountOf(facts) === "personal" ? "any" : "admin";
}

export function connectOf(facts: AppAccessFacts): AppConnect {
  if (brokeredProvenance(facts.provider)) {
    if (!facts.present) return facts.listedConnect ?? null;
    const kind = schemeKind(facts.authScheme);
    return kind === "consent" || kind === "key" ? kind : null;
  }
  return facts.catalogueAuth?.kind === "user-oauth" ? "oauth" : null;
}

/** 部署密钥类的目录认证：一份由管理员存一次的密钥，只是放在请求的不同位置。 */
const DEPLOYMENT_KEY_KINDS: ReadonlySet<string> = new Set([
  "deployment-bearer",
  "deployment-query",
  "deployment-header",
  "deployment-address",
]);

/**
 * 部署这一侧缺什么，任何授予或连接被问到之前；什么都不缺时为 null。批准 `enable` 申请时也读它，缺的那一步
 * 照实说，而不是记一个什么都没改的批准。
 */
export function unavailableReason(facts: AppAccessFacts): Unavailable | null {
  if (!facts.present) return "absent";
  if (brokeredProvenance(facts.provider)) {
    if (!facts.composioConfigured) return "composio_unconfigured";
    if (schemeKind(facts.authScheme) === "unreadable")
      return "scheme_unreadable";
    // fork：账号模式没人决定的行，调用一律被拒（X1 `accountFor` 的 ambiguous），这里不说成可用。
    if (brokeredAnswer(facts).kind === "ambiguous") return "scheme_unreadable";
    return null;
  }
  const auth = facts.catalogueAuth;
  if (auth?.kind === "user-oauth") {
    if (auth.clientRegistration !== "dynamic" && !facts.hasCredential)
      return "oauth_client_missing";
    return null;
  }
  if (auth && DEPLOYMENT_KEY_KINDS.has(auth.kind) && !facts.hasCredential)
    return "token_missing";
  return null;
}

/**
 * 规则，按一个人遇到障碍的顺序：先部署，再员工，再账号；团队账号还要看这个人能不能驾驶它。
 */
export function appAccessState(facts: AppAccessFacts): AppAccessState {
  if (unavailableReason(facts) !== null) return "disabled";
  if (!facts.granted)
    return facts.mayGiveOwn && ownerGrantsOf(facts) === "any"
      ? "owner_grantable"
      : "not_granted";
  const account = accountOf(facts);
  if (account === "deployment") return "ready";
  if (account === "shared") {
    if (!facts.shared?.usable) return "shared_not_connected";
    return facts.sharedAdmitted === false ? "shared_not_approved" : "ready";
  }
  if (!facts.personal) return "not_connected";
  return facts.personal.usable ? "ready" : "reconnect";
}

/** 一个状态没有什么可以请管理员做时，答给申请人的话（浏览器入口与 `request_app_access` 共用）。 */
export function nothingToRequest(access: AppAccess): string {
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

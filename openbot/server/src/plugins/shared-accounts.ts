import { randomBytes } from "node:crypto";
import { appsPageZh, currentEdition } from "../edition";
import { brokeredProvenance as isBrokeredProvenance } from "./access";
import { type Decides, type SchemeKind, schemeKind } from "./broker";

/**
 * 一次 broker 调用进的是谁的账号，只在这里判定（上游 `shared-accounts.ts`，按 fork 改写）。
 *
 * 调用前的闸门、传输、审计行、连接页都问这里，所以「这个人是对照哪个账号检查的」和「调用实际进了哪个
 * 账号」不会是两个碰巧一致的答案。
 *
 * 与上游的差异：
 * - 「是不是 broker 应用」与 `access.ts` 的 `brokeredProvenance` 同一个回答（Composio 或 Arcade，X5）。
 * - fork 没有单用户部署的 `brokered_identities`（上游 0074），所以一个人的 vendor id 永远就是他自己的
 *   用户 id；`personAccount` 仍保留 `filedUnder` 参数，以便以后并入时不改调用方。
 * - 部署团队账号的连接状态记在应用自己的 `mcp_servers` 行上（`shared_*` 列，迁移 0180），而不是上游
 *   `brokered_connections` 的 `holder = deployment` 行；见 `db/schema/plugins.ts`。
 */

export const ACCOUNT_MODES = ["personal", "shared"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export const HOLDERS = ["person", "deployment"] as const;
export type Holder = (typeof HOLDERS)[number];

/** broker 被要求代表谁行事。broker 只发送 `vendorUserId`，从不自己选 holder。 */
export type AccountRef =
  | { holder: "person"; userId: string; vendorUserId: string }
  | { holder: "deployment"; vendorUserId: string };

/** 会到达 broker 的 provenance：Composio 或 Arcade。与 `access.ts` 是同一个判断。 */
export function brokeredProvenance(provenance: string): boolean {
  return isBrokeredProvenance(provenance);
}

/**
 * 一个人的账号。`userId` 与 `vendorUserId` 是两个概念（这里是谁的账号 / vendor 把它记在哪个名字下），
 * 对一个人来说它们故意是同一个值：Composio 的 `user_id` 是调用方自己选的字符串，fork 里每一条现存连接都是
 * 用本人的用户 id 建的。不要在这里推导出别的 vendor id，否则每一条现有连接都会读成「没有连接」。
 *
 * `filedUnder` 是唯一的例外，而且只读不推：上游单用户部署的那个人在 vendor 处的名字记在
 * `brokered_identities` 里。fork 没有这张表，调用方传 `null`。
 */
export function personAccount(
  userId: string,
  filedUnder: string | null,
): AccountRef {
  return { holder: "person", userId, vendorUserId: filedUnder ?? userId };
}

export function asAccountMode(value: unknown): AccountMode | null {
  return value === "personal" || value === "shared" ? value : null;
}

export type AccountAnswer =
  | { kind: "none" }
  | { kind: "person"; userId: string }
  | { kind: "deployment" }
  | { kind: "ambiguous"; message: string };

/**
 * 这一行的调用进谁的账号。
 *
 * `credentialActorId` 是调用开的那个账号的主人：通常是提问的人；Team Bot 用它主人的账号时是主人。
 * 所有闸门仍然是提问者的。
 */
export function accountFor(
  row: {
    title: string;
    provenance: string;
    authScheme: string | null;
    accountMode: string | null;
  },
  credentialActorId: string,
): AccountAnswer {
  if (!brokeredProvenance(row.provenance)) return { kind: "none" };

  const kind = schemeKind(row.authScheme);
  type _AccountForDecides = Decides<
    SchemeKind,
    {
      key: "has an account, chosen by the mode";
      consent: "has an account, chosen by the mode";
      none: "has no account in either mode, so the mode is not read";
      unreadable: "is treated as having an account, which is the closed direction";
    }
  >;
  if (kind === "none") return { kind: "none" };

  const mode = asAccountMode(row.accountMode);
  type _ModeDecides = Decides<
    AccountMode,
    {
      personal: "the credential actor's own account — the asker, or a Team Bot's owner";
      shared: "the deployment's one account, whoever asked";
    }
  >;
  if (mode === "personal") return { kind: "person", userId: credentialActorId };
  if (mode === "shared") return { kind: "deployment" };
  /*
   * 不猜。迁移 0180 给每一行的默认值是 `personal`（fork 之前每个应用都是个人账号），所以只有被显式写成
   * 别的值或 NULL 的行会走到这里。猜成 Shared 会把团队账号交给每一个人，猜成 Personal 会把一个本该共享
   * 的应用拆成个人账号——两种都不是谁做过的决定。
   */
  return {
    kind: "ambiguous",
    message: `${row.title} 没有调用：还没有人决定它用每个人自己的账号还是一个共享账号。${currentEdition() === "personal" ? "你" : "管理员"}可以在${appsPageZh()}里它的页面上选择。`,
  };
}

export const DEPLOYMENT_VENDOR_PREFIX = "openbot-deployment:";

/**
 * 部署自己的账号在 vendor 处登记的身份。
 *
 * 随机部分排除了与某个人撞名：前缀本身什么也保证不了（组织认证模式下用户 id 由外部原样给出）。每次切到
 * Shared 时铸一次并存下，从不重算。
 */
export function mintDeploymentVendorUserId(
  deploymentId: string,
  random: () => string = () => randomBytes(16).toString("base64url"),
): string {
  const named = deploymentId.trim();
  if (!named) {
    throw new Error(
      "A deployment with no id cannot hold a shared account; set DEPLOYMENT_ID.",
    );
  }
  return `${DEPLOYMENT_VENDOR_PREFIX}${named}:${random()}`;
}

/**
 * 一个人自己的 broker id 与他「再连一个账号」时登记的 id 之间的分隔符（上游为 Arcade 准备；Composio
 * 把一个人的所有账号都记在同一个 user id 下，用不到）。
 */
export const ANOTHER_ACCOUNT_MARK = "~";

/**
 * 一个人在同一个应用上「再连一个账号」时用的 id（上游 `anotherArcadeAccount`）。
 *
 * Arcade 按「用户 id + 认证提供商」只存一个账号，所以第二个 Gmail 记在这个人自己的另一个 id 下：
 * `<他在厂商那边的名字>~<随机后缀>`。后缀在按下的那一刻由服务端铸出，从不取自请求；它只是让两个账号在
 * 厂商那边分开，不是秘密——那个 id 能不能用，仍由「这次同意的回程是不是发起人自己的会话」决定。
 */
export function anotherArcadeAccount(
  account: Extract<AccountRef, { holder: "person" }>,
): Extract<AccountRef, { holder: "person" }> {
  return {
    ...account,
    vendorUserId: `${account.vendorUserId}${ANOTHER_ACCOUNT_MARK}${randomBytes(4).toString("hex")}`,
  };
}

/** `vendorUserId` 是不是这个人自己的 broker id，或者他另一个账号的 id。 */
export function filedUnderPerson(
  vendorUserId: string,
  personVendorUserId: string,
): boolean {
  return (
    vendorUserId === personVendorUserId ||
    (vendorUserId.startsWith(`${personVendorUserId}${ANOTHER_ACCOUNT_MARK}`) &&
      vendorUserId.length > personVendorUserId.length + 1 &&
      !vendorUserId
        .slice(personVendorUserId.length + 1)
        .includes(ANOTHER_ACCOUNT_MARK))
  );
}

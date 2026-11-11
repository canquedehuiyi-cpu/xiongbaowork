// server/tests/support/arcade-double.ts
//
// 一个按 vendor 用户 id 分开授权的 Arcade 替身，给经 fork 插件路由跑的 Arcade 测试共用。
//
// 它替的是 `ArcadeBroker`（adapter 之上的那一层）：谁被铸了授权、哪个 flow 属于谁、谁在哪个认证提供商下
// 有连接、哪些被撤销，都记在 `state` 里，测试据此断言「厂商被问了什么、以谁的名字问的」。
import {
  type ArcadeBroker,
  BrokerAccountHeldError,
  type GrantState,
} from "../../src/plugins/broker";

export type ArcadeDoubleState = {
  minted: { userId: string; toolkit: string; action: string | null }[];
  confirms: { handle: string; vendorUserId: string }[];
  /** flow 句柄 → 它属于的 vendor 用户与授权 id。 */
  flows: Map<string, { vendorUserId: string; authId: string }>;
  status: Map<string, { status: string; userId: string | null }>;
  /** `<vendor 用户>/<认证提供商>`：厂商那边活着的连接。 */
  connected: Set<string>;
  revoked: string[];
  /** `<vendor 用户>/<toolkit>`：厂商已经持有这个应用要的全部权限，再要授权答「已持有」。 */
  held: Set<string>;
  /** toolkit → 厂商说每个动作现在的授权状态。 */
  grants: Map<string, GrantState[]>;
  /** 每一次问授权清单时用的 vendor 用户。 */
  grantReads: { toolkit: string; vendorUserId: string }[];
  /** 每一次问连接时用的 vendor 用户。 */
  connectionReads: { toolkit: string; vendorUserId: string }[];
  confirmThrows?: unknown;
  authorizeThrows?: unknown;
};

export function arcadeDouble(options: {
  /** 授权 id 的前缀，让并行的测试文件互不相撞。 */
  suite: string;
  /** 一个 toolkit 用哪个认证提供商；不给时都是 `google`。 */
  providerOf?: (toolkit: string) => string | null;
  authorizationUrl?: string;
}): { arcade: ArcadeBroker; state: ArcadeDoubleState } {
  const state: ArcadeDoubleState = {
    minted: [],
    confirms: [],
    flows: new Map(),
    status: new Map(),
    connected: new Set(),
    revoked: [],
    held: new Set(),
    grants: new Map(),
    grantReads: [],
    connectionReads: [],
  };
  let next = 0;
  const providerOf = options.providerOf ?? (() => "google");
  const url = options.authorizationUrl ?? "https://vendor.example/consent";
  const arcade: ArcadeBroker = {
    grantIsLocal: true,
    authorizations: {
      status: async (id) => ({
        ...(state.status.get(id) ?? { status: "pending", userId: null }),
        scopes: ["gmail.readonly"],
      }),
      confirmReturn: async (q) => {
        state.confirms.push(q);
        if (state.confirmThrows) throw state.confirmThrows;
        const flow = state.flows.get(q.handle);
        if (!flow || flow.vendorUserId !== q.vendorUserId)
          return { mismatch: true };
        return { authorizationId: flow.authId };
      },
    },
    grantsFor: async ({ toolkit, account }) => {
      state.grantReads.push({ toolkit, vendorUserId: account.vendorUserId });
      return state.grants.get(toolkit) ?? [];
    },
    authProviderOf: async (toolkit) => providerOf(toolkit),
    listApps: async () => [],
    ensureAuthConfig: async () => "not-needed",
    deleteAuthConfig: async () => {},
    authorize: async ({ account, toolkit, action }) => {
      if (state.authorizeThrows) throw state.authorizeThrows;
      if (!action && state.held.has(`${account.vendorUserId}/${toolkit}`)) {
        throw new BrokerAccountHeldError(
          `你的账号已经允许 ${toolkit} 需要的全部权限，所以没有打开授权页面。`,
        );
      }
      next += 1;
      state.minted.push({
        userId: account.vendorUserId,
        toolkit,
        action: action ?? null,
      });
      return {
        redirectUrl: `${url}&n=${next}`,
        authorizationId: `ar_${options.suite}_${next}`,
      };
    },
    accountsOf: async () => [],
    isConnected: async ({ account, toolkit }) => {
      state.connectionReads.push({
        toolkit,
        vendorUserId: account.vendorUserId,
      });
      return state.connected.has(
        `${account.vendorUserId}/${providerOf(toolkit)}`,
      );
    },
    revoke: async ({ account, toolkit }) => {
      const key = `${account.vendorUserId}/${providerOf(toolkit)}`;
      state.revoked.push(key);
      return state.connected.delete(key);
    },
    connectionFields: async () => [],
    connectWithFields: async () => ({ accountId: "never" }),
    revokeAccount: async () => {},
    accountName: async () => null,
  };
  return { arcade, state };
}

/** 厂商那边：这个 vendor 用户在 flow 句柄上完成了同意。 */
export function consented(
  state: ArcadeDoubleState,
  handle: string,
  vendorUserId: string,
  authId: string,
): void {
  state.flows.set(handle, { vendorUserId, authId });
  state.status.set(authId, { status: "completed", userId: vendorUserId });
}

/** 回程重定向带的原因词；成功的回程没有这个参数。 */
export const reasonOf = (response: Response): string | null =>
  new URL(response.headers.get("location") ?? "", "https://x").searchParams.get(
    "authorized",
  );

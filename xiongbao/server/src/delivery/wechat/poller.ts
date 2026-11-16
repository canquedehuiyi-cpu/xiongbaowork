/*
 * 微信 ClawBot 长轮询（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 5）。
 *
 * 每次 `tick` 只负责认领一批账号（租约，`for update skip locked`，多副本也只有一个拿到同一个账号），
 * 认领到的各自起一次轮询，`tick` 不等它们结束；一个账号一次 `getUpdates` 后还租约，`lease_until` 记成
 * 还租约的时刻，刚拉过的排到队尾，账号多于一批时每个都轮得到。副本级在途上限 `MAX_IN_FLIGHT`，到了就少认领。
 * 测试用 `drain()` 等在途轮询结束。
 *
 * 帧：认领在 store 的 platform 帧里；之后每个账号的一切（取令牌、记入站、`inbound`、存游标、还租约、
 * 暂停、断开）都在 `runAsTenant(account.tenantId, …)` 里，这里不新开 platform 帧。
 *
 * 机密：`bot_token` 只在这里解封、只交给 `ilink.getUpdates`，不进日志和错误；日志只写错误类名。
 * `context_token` 随消息交给 `inbound`，不记录。
 *
 * 去重：消息 ID（`message_id`，19 位整数，ilink.ts 保精度）是去重键。持久去重由 `inbound` 负责：
 * `deliveryStore.recordInbox({ source: "wechat", realm: ilink_bot_id, externalId: message.id })`
 * 撞唯一索引时返回 null。这里再按账号留最近处理过的 ID，挡住「游标没存成功、服务器重发」时同一进程内的重复。
 *
 * 失败：`inbound` 抛错时本批停在这条，不存游标，下一轮服务器会从旧游标重发，已处理的靠去重跳过。
 * 同一条消息连续失败 3 次就跳过（只记消息 ID 和错误类名），推进游标，不让账号卡死。
 * 网络错误、`poll_failed`：这个账号 30 秒内不再认领。
 */
import {
  type CredentialSecretReader,
  CredentialUnusableError,
  decryptCredentialForUse,
} from "../../credentials";
import type { Database } from "../../db/client";
import type { WechatAccount } from "../../db/schema/wechat";
import { runAsTenant } from "../../tenant/context";
import { DeliveryProviderError } from "../types";
import {
  type IlinkClient,
  type IlinkMessage,
  IlinkPausedError,
  IlinkUnauthorizedError,
} from "./ilink";
import type { WechatStore } from "./store";

export type WechatInbound = (
  account: WechatAccount,
  message: IlinkMessage,
) => Promise<void>;

export type WechatPollerDeps = {
  database: Database;
  wechat: WechatStore;
  ilink: Pick<IlinkClient, "getUpdates">;
  credentials: CredentialSecretReader;
  keyEncryptionKey: string;
  /** Task 6 提供：把一条入站交给智能体。 */
  inbound: WechatInbound;
  /** 这个轮询器（副本）的名字，写进租约。 */
  owner: string;
  now?: () => Date;
};

/** 长轮询默认 35 秒；租约 = 这个账号的长轮询时长 + 30 秒。 */
const DEFAULT_POLL_MS = 35_000;
const LEASE_MARGIN_MS = 30_000;
export const WECHAT_CLAIM_LIMIT = 20;
/** 本副本同时在轮询的账号上限。 */
export const WECHAT_MAX_IN_FLIGHT = 200;
/** iLink 返回 -14 后暂停多久。 */
export const WECHAT_PAUSE_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 30_000;
const SEEN_PER_ACCOUNT = 500;
const POISON_AFTER = 3;
/** 账号超过这么久没被碰过，就清掉它的内存状态（解绑的账号不会再被认领）。 */
const STATE_IDLE_MS = 2 * 60 * 60 * 1000;

function logFailure(type: string, error: unknown, extra: object = {}) {
  console.error(
    JSON.stringify({
      type,
      ...extra,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );
}

type AccountState = {
  seen: Set<string>;
  timeoutMs: number | undefined;
  failures: Map<string, number>;
  touched: number;
};

export function createWechatPoller(deps: WechatPollerDeps) {
  const now = deps.now ?? (() => new Date());
  const states = new Map<string, AccountState>();
  const inFlight = new Set<Promise<void>>();

  const stateOf = (accountId: string): AccountState => {
    let state = states.get(accountId);
    if (!state) {
      state = {
        seen: new Set(),
        timeoutMs: undefined,
        failures: new Map(),
        touched: 0,
      };
      states.set(accountId, state);
    }
    state.touched = Date.now();
    return state;
  };

  const remember = (state: AccountState, id: string) => {
    state.seen.add(id);
    if (state.seen.size > SEEN_PER_ACCOUNT) {
      const oldest = state.seen.values().next().value;
      if (oldest !== undefined) state.seen.delete(oldest);
    }
  };

  /** 解封令牌；凭据没了、被作废了，就等于令牌失效。 */
  async function botToken(account: WechatAccount): Promise<string | null> {
    if (!account.credentialId) return null;
    try {
      return await decryptCredentialForUse(
        deps.keyEncryptionKey,
        deps.credentials,
        account.credentialId,
      );
    } catch (error) {
      if (error instanceof CredentialUnusableError) return null;
      throw error;
    }
  }

  async function disconnect(account: WechatAccount) {
    await deps.wechat.disconnect(account.id);
    states.delete(account.id);
  }

  async function pollOne(account: WechatAccount): Promise<void> {
    const state = stateOf(account.id);
    const token = await botToken(account);
    if (!token) {
      await disconnect(account);
      return;
    }
    const leaseMs = (state.timeoutMs ?? DEFAULT_POLL_MS) + LEASE_MARGIN_MS;
    if (!(await deps.wechat.renewLease(account.id, deps.owner, leaseMs)))
      return;
    const reply = await deps.ilink.getUpdates(
      { baseUrl: account.baseUrl, botToken: token },
      account.cursor ?? "",
      state.timeoutMs,
    );
    state.timeoutMs = reply.timeoutMs;
    for (const message of reply.messages) {
      if (state.seen.has(message.id)) continue;
      // 处理一条可能很久：租约不再是自己的就停手，不存游标，让拿到租约的那个重来。
      if (!(await deps.wechat.renewLease(account.id, deps.owner, leaseMs)))
        return;
      await deps.wechat.markInbound(account.id, {
        at: now(),
        contextToken: message.contextToken,
      });
      try {
        await deps.inbound(account, message);
      } catch (error) {
        const failures = (state.failures.get(message.id) ?? 0) + 1;
        if (failures < POISON_AFTER) {
          state.failures.set(message.id, failures);
          throw error;
        }
        // 连续失败到上限：跳过这条，别让整个账号卡死。
        state.failures.delete(message.id);
        logFailure("wechat-inbound-skipped", error, { messageId: message.id });
      }
      state.failures.delete(message.id);
      remember(state, message.id);
    }
    if (reply.cursor) await deps.wechat.setCursor(account.id, reply.cursor);
  }

  async function pollInTenant(account: WechatAccount): Promise<void> {
    await runAsTenant(account.tenantId, async () => {
      let backoffMs = 0;
      try {
        await pollOne(account);
      } catch (error) {
        if (error instanceof IlinkPausedError) {
          await deps.wechat.pause(
            account.id,
            new Date(now().getTime() + WECHAT_PAUSE_MS),
          );
        } else if (error instanceof IlinkUnauthorizedError) {
          await disconnect(account);
        } else {
          if (
            error instanceof DeliveryProviderError &&
            (error.code === "network_error" || error.code === "poll_failed")
          )
            backoffMs = ERROR_BACKOFF_MS;
          logFailure("wechat-poll-error", error);
        }
      } finally {
        try {
          await deps.wechat.releaseLease(account.id, deps.owner, backoffMs);
        } catch (error) {
          logFailure("wechat-lease-release-error", error);
        }
      }
    });
  }

  return {
    /** 认领一批账号，各自起一次轮询，不等它们结束；在途数到上限就少认领。 */
    async tick(): Promise<void> {
      const cutoff = Date.now() - STATE_IDLE_MS;
      for (const [id, state] of states)
        if (state.touched < cutoff) states.delete(id);
      const room = Math.min(
        WECHAT_CLAIM_LIMIT,
        WECHAT_MAX_IN_FLIGHT - inFlight.size,
      );
      if (room <= 0) return;
      const accounts = await deps.wechat.claimForPolling(
        deps.owner,
        DEFAULT_POLL_MS + LEASE_MARGIN_MS,
        room,
      );
      for (const account of accounts) {
        const run: Promise<void> = pollInTenant(account)
          .catch((error) => logFailure("wechat-poll-error", error))
          .finally(() => inFlight.delete(run));
        inFlight.add(run);
      }
    },

    /** 等在途的轮询都结束（测试用；关停时也可以用）。 */
    async drain(): Promise<void> {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },

    /** 账号被解绑时丢掉它的内存状态。 */
    forget(accountId: string): void {
      states.delete(accountId);
    },
  };
}

export type WechatPoller = ReturnType<typeof createWechatPoller>;

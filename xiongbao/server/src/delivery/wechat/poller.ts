/*
 * 微信 ClawBot 长轮询（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 5）。
 *
 * 每次 `tick` 只负责认领一批账号（租约，`for update skip locked`，多副本也只有一个拿到同一个账号），
 * 认领到的各自起一次轮询，`tick` 不等它们结束；一个账号一次 `getUpdates` 后还租约，`lease_until` 记成
 * 还租约的时刻，刚拉过的排到队尾，账号多于一批时每个都轮得到。副本级在途上限 `MAX_IN_FLIGHT`，到了就少认领。
 * 测试用 `drain()` 等在途轮询结束。
 *
 * 同一个账号不会被本副本重复处理：进程内记着正在处理的账号，认领时排除；每次认领用专属 owner
 * （`owner#随机`），续租、存游标、还租约都带它，续租失败就停手、不写游标；`inbound` 执行期间按租约的三分之一心跳续租。
 *
 * 帧：认领在 store 的 platform 帧里；之后每个账号的一切（取令牌、记入站、`inbound`、存游标、还租约、
 * 暂停、断开）都在 `runAsTenant(account.tenantId, …)` 里，这里不新开 platform 帧。
 *
 * 机密：`bot_token` 只在这里解封、只交给 `ilink.getUpdates`，不进日志和错误；日志只写错误类名。
 * `context_token` 随消息交给 `inbound`，不记录。
 *
 * 去重：消息 ID（`message_id`，19 位整数，ilink.ts 保精度）是去重键。持久去重由 `inbound` 负责
 * （inbound.ts：先在账号行上记这条的 ID，开一轮时 `delivery_inbox` 再按同一个 ID 去重一次）。
 * 这里再按账号留最近处理过的 ID，挡住「游标没存成功、服务器重发」时同一进程内的重复。
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
  /** 轮询器关停时中止（`stop`）；交给员工那一轮，让它尽快收尾。 */
  signal?: AbortSignal,
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
  /** 测试用：固定租约时长（毫秒）；默认按账号的长轮询时长加 30 秒。 */
  leaseMs?: number;
  /** 测试用：本副本同时在轮询的账号上限，默认 `WECHAT_MAX_IN_FLIGHT`。 */
  maxInFlight?: number;
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
  /** 正在处理的账号 ID（含 `inbound` 跑得比租约还久的）。 */
  const active = new Set<string>();
  const maxInFlight = deps.maxInFlight ?? WECHAT_MAX_IN_FLIGHT;
  /** 整个轮询器的中止信号：`stop` 时中止在途的长轮询和 `inbound`，之后不再认领。 */
  const stopping = new AbortController();

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

  async function pollOne(
    account: WechatAccount,
    claimOwner: string,
  ): Promise<void> {
    const state = stateOf(account.id);
    const token = await botToken(account);
    if (!token) {
      await disconnect(account);
      return;
    }
    const leaseMs =
      deps.leaseMs ?? (state.timeoutMs ?? DEFAULT_POLL_MS) + LEASE_MARGIN_MS;
    if (!(await deps.wechat.renewLease(account.id, claimOwner, leaseMs)))
      return;
    const reply = await deps.ilink.getUpdates(
      { baseUrl: account.baseUrl, botToken: token },
      account.cursor ?? "",
      state.timeoutMs,
      stopping.signal,
    );
    state.timeoutMs = reply.timeoutMs;
    for (const message of reply.messages) {
      // 关停了：剩下的不处理、不存游标，下次启动从旧游标重来。
      if (stopping.signal.aborted) return;
      if (state.seen.has(message.id)) continue;
      // 处理一条可能很久：租约不再是自己的就停手，不存游标，让拿到租约的那个重来。
      if (!(await deps.wechat.renewLease(account.id, claimOwner, leaseMs)))
        return;
      await deps.wechat.markInbound(account.id, {
        at: now(),
        contextToken: message.contextToken,
      });
      // 心跳：`inbound` 可能比租约还久；续不上说明租约被别人拿走了，跑完也不写游标。
      let lost = false;
      const heartbeat = setInterval(
        () => {
          deps.wechat
            .renewLease(account.id, claimOwner, leaseMs)
            .then((ok) => {
              if (!ok) lost = true;
            })
            .catch(() => {
              lost = true;
            });
        },
        Math.max(10, Math.floor(leaseMs / 3)),
      );
      try {
        await deps.inbound(account, message, stopping.signal);
      } catch (error) {
        if (lost) return;
        const failures = (state.failures.get(message.id) ?? 0) + 1;
        if (failures < POISON_AFTER) {
          state.failures.set(message.id, failures);
          throw error;
        }
        // 连续失败到上限：跳过这条，别让整个账号卡死。
        state.failures.delete(message.id);
        logFailure("wechat-inbound-skipped", error, { messageId: message.id });
      } finally {
        clearInterval(heartbeat);
      }
      if (lost) return;
      state.failures.delete(message.id);
      remember(state, message.id);
      // 这条在关停中途跑完（员工那一轮可能被中止了）：算处理过，但不存游标，剩下的留给下次。
      if (stopping.signal.aborted) return;
    }
    // 只在租约还在本次认领手里时写：拉取期间被别人认领了，就让拿到的那个去写。
    if (reply.cursor)
      await deps.wechat.setCursor(account.id, reply.cursor, claimOwner);
  }

  async function pollInTenant(
    account: WechatAccount,
    claimOwner: string,
  ): Promise<void> {
    await runAsTenant(account.tenantId, async () => {
      let backoffMs = 0;
      try {
        await pollOne(account, claimOwner);
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
          await deps.wechat.releaseLease(account.id, claimOwner, backoffMs);
        } catch (error) {
          logFailure("wechat-lease-release-error", error);
        }
      }
    });
  }

  return {
    /** 认领一批账号，各自起一次轮询，不等它们结束；在途数到上限就少认领。 */
    async tick(): Promise<void> {
      if (stopping.signal.aborted) return;
      const cutoff = Date.now() - STATE_IDLE_MS;
      for (const [id, state] of states)
        if (state.touched < cutoff) states.delete(id);
      const room = Math.min(WECHAT_CLAIM_LIMIT, maxInFlight - inFlight.size);
      if (room <= 0) return;
      const claimOwner = `${deps.owner}#${crypto.randomUUID()}`;
      const accounts = await deps.wechat.claimForPolling(
        claimOwner,
        deps.leaseMs ?? DEFAULT_POLL_MS + LEASE_MARGIN_MS,
        room,
        [...active],
      );
      // 认领时已排除本副本还在处理的账号，所以这里每个都是新的。
      for (const account of accounts) {
        active.add(account.id);
        const run: Promise<void> = pollInTenant(account, claimOwner)
          .catch((error) => logFailure("wechat-poll-error", error))
          .finally(() => {
            active.delete(account.id);
            inFlight.delete(run);
          });
        inFlight.add(run);
      }
    },

    /** 关停第一步：中止在途的长轮询和 `inbound`，之后 `tick` 不再认领。再 `drain` 等它们收尾。 */
    stop(): void {
      stopping.abort();
    },

    /** 等在途的轮询都结束（测试用；关停时在 `stop` 之后调）。 */
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

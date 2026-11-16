/*
 * 微信 ClawBot 长轮询（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 5）。
 *
 * 每次 `tick` 认领一批账号（租约，`for update skip locked`，多副本也只有一个拿到同一个账号），每个账号
 * 一次 `getUpdates` 后立刻还租约，下一轮再认领。`getUpdates` 本身是 35 秒的长轮询，所以一次 `tick` 最长
 * 要这么久；定时器用 `repeatAfterEach`，上一次结束才排下一次。
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
 */
import {
  type CredentialSecretReader,
  CredentialUnusableError,
  decryptCredentialForUse,
} from "../../credentials";
import type { Database } from "../../db/client";
import type { WechatAccount } from "../../db/schema/wechat";
import { runAsTenant } from "../../tenant/context";
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

/** 长轮询最长 45 秒（35 秒加 10 秒余量），租约留足，处理消息期间还会续租。 */
const LEASE_MS = 90_000;
const CLAIM_LIMIT = 20;
/** iLink 返回 -14 后暂停多久。 */
export const WECHAT_PAUSE_MS = 60 * 60 * 1000;
const SEEN_PER_ACCOUNT = 500;

function logFailure(type: string, error: unknown) {
  console.error(
    JSON.stringify({
      type,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );
}

export function createWechatPoller(deps: WechatPollerDeps) {
  const now = deps.now ?? (() => new Date());
  const seen = new Map<string, Set<string>>();
  const pollTimeout = new Map<string, number>();

  const remember = (accountId: string, id: string) => {
    const ids = seen.get(accountId) ?? new Set<string>();
    seen.set(accountId, ids);
    ids.add(id);
    if (ids.size > SEEN_PER_ACCOUNT) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
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

  async function pollOne(account: WechatAccount): Promise<void> {
    const token = await botToken(account);
    if (!token) {
      await deps.wechat.disconnect(account.id);
      return;
    }
    const reply = await deps.ilink.getUpdates(
      { baseUrl: account.baseUrl, botToken: token },
      account.cursor ?? "",
      pollTimeout.get(account.id),
    );
    pollTimeout.set(account.id, reply.timeoutMs);
    for (const message of reply.messages) {
      if (seen.get(account.id)?.has(message.id)) continue;
      // 处理一条可能很久：租约不再是自己的就停手，不存游标，让拿到租约的那个重来。
      if (!(await deps.wechat.renewLease(account.id, deps.owner, LEASE_MS)))
        return;
      await deps.wechat.markInbound(account.id, {
        at: now(),
        contextToken: message.contextToken,
      });
      await deps.inbound(account, message);
      remember(account.id, message.id);
    }
    if (reply.cursor) await deps.wechat.setCursor(account.id, reply.cursor);
  }

  async function pollInTenant(account: WechatAccount): Promise<void> {
    await runAsTenant(account.tenantId, async () => {
      try {
        await pollOne(account);
      } catch (error) {
        if (error instanceof IlinkPausedError) {
          await deps.wechat.pause(
            account.id,
            new Date(now().getTime() + WECHAT_PAUSE_MS),
          );
        } else if (error instanceof IlinkUnauthorizedError) {
          await deps.wechat.disconnect(account.id);
        } else {
          logFailure("wechat-poll-error", error);
        }
      } finally {
        try {
          await deps.wechat.releaseLease(account.id, deps.owner);
        } catch (error) {
          logFailure("wechat-lease-release-error", error);
        }
      }
    });
  }

  return {
    /** 认领一批账号，各拉一次；一个账号出错不影响别的。 */
    async tick(): Promise<void> {
      const accounts = await deps.wechat.claimForPolling(
        deps.owner,
        LEASE_MS,
        CLAIM_LIMIT,
      );
      await Promise.all(
        accounts.map((account) =>
          pollInTenant(account).catch((error) =>
            logFailure("wechat-poll-error", error),
          ),
        ),
      );
    },
  };
}

export type WechatPoller = ReturnType<typeof createWechatPoller>;

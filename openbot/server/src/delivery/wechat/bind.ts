/*
 * 微信 ClawBot 的扫码绑定与解绑（计划 docs/plans/2026-11-16-im-channels-wechat.md Task 4）。
 *
 * 帧：都在本人帧里跑（路由经登录中间件，请求在这个人自己的帧里），账号行和凭据都记在本人租户下；
 * 「这个微信是不是已经绑了别人」由 store 自己开 platform 帧去查。
 *
 * 机密：`bot_token` 只进 `sealCredential`（v2 信封，AAD 绑凭据行的租户、id、种类）；账号行的
 * `context_token`、凭据 id、iLink 的 id 都不出接口：总览只挑 `status`、`boundAt`、`paused`、`windowOpen`。
 */
import {
  CredentialRefusedError,
  type CredentialStore,
  sealCredential,
} from "../../credentials";
import type { Database } from "../../db/client";
import type { WechatBindAttemptStatus } from "../../db/schema/wechat";
import { DeliveryNotFoundError, DeliveryProviderError } from "../types";
import {
  type IlinkClient,
  type IlinkQrcodeStatus,
  isTrustedIlinkBase,
} from "./ilink";
import { WECHAT_BIND_ATTEMPT_MINUTES, type WechatStore } from "./store";

/** 最后一次入站超过这么久，就不往微信发主动内容。 */
export const WECHAT_PROACTIVE_WINDOW_MS = 10 * 60 * 60 * 1000;

export type WechatBindDeps = {
  database: Database;
  ilink: Pick<IlinkClient, "getBotQrcode" | "getQrcodeStatus">;
  store: WechatStore;
  credentials: Pick<
    CredentialStore,
    "create" | "rotate" | "revoke" | "findLiveByKey"
  >;
  encryptionKey: string;
};

export type WechatBindStatus =
  | "wait"
  | "scaned"
  | "bound"
  | "expired"
  | "taken"
  | "failed";

export type WechatBindAnswer = { status: WechatBindStatus; message?: string };

/** 总览里关于微信的全部内容：没有任何令牌和 id。 */
export type WechatSummary = {
  status: "bound" | "paused";
  boundAt: Date;
  paused: boolean;
  windowOpen: boolean;
};

const MESSAGES: Partial<Record<WechatBindStatus, string>> = {
  expired: "二维码已过期，请换一张",
  taken: "这个微信已绑在别的账号上",
  failed: "没绑上，请换一张二维码再试",
};

const FINISHED = new Set<WechatBindAttemptStatus>([
  "bound",
  "taken",
  "failed",
  "expired",
]);

/** iLink 的状态和本地结局，对外只说六种。 */
function publicStatus(status: WechatBindAttemptStatus): WechatBindStatus {
  switch (status) {
    case "wait":
    case "bound":
    case "taken":
    case "failed":
    case "expired":
    case "scaned":
      return status;
    // 扫了、还要在手机上再走一步：对这个人来说仍是「已扫码，等确认」。
    case "scaned_but_redirect":
    case "need_verifycode":
      return "scaned";
    case "confirmed":
      return "wait";
    case "verify_code_blocked":
    case "binded_redirect":
      return "failed";
  }
}

const answer = (status: WechatBindStatus): WechatBindAnswer => {
  const message = MESSAGES[status];
  return message ? { status, message } : { status };
};

/**
 * Postgres 唯一冲突（SQLSTATE 23505）时违反的约束名，否则 null。Bun 的驱动把 SQLSTATE 放在 `errno`，
 * drizzle 把驱动错误包成 `cause`（同 `identity/store.ts`）。
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; constraint?: unknown };
  const candidates = [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ];
  for (const candidate of candidates) {
    if (candidate?.errno === "23505")
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
  }
  return null;
}

const CREDENTIAL_KEY = (userId: string) => ({
  kind: "chat" as const,
  provider: "wechat",
  keyId: userId,
});

export function createWechatBind(deps: WechatBindDeps) {
  const { store } = deps;

  async function finish(
    userId: string,
    attemptId: string,
    status: WechatBindAttemptStatus & WechatBindStatus,
  ): Promise<WechatBindAnswer> {
    await store.setAttemptStatus(userId, attemptId, status);
    return answer(status);
  }

  /** 凭据和账号行一个事务：撞上唯一索引时，新凭据和对旧凭据的作废一起回滚。 */
  async function save(
    userId: string,
    session: {
      baseUrl: string;
      botToken: string;
      botId: string;
      userId: string;
    },
  ): Promise<void> {
    const { botToken } = session;
    await deps.database.transaction(async (transaction) => {
      const value = {
        ...CREDENTIAL_KEY(userId),
        metadata: { ownerUserId: userId },
        seal: (binding: Parameters<typeof sealCredential>[1]) =>
          sealCredential(deps.encryptionKey, binding, botToken),
      };
      const previous = await deps.credentials.findLiveByKey(
        CREDENTIAL_KEY(userId),
        transaction,
      );
      const credential = previous
        ? await deps.credentials.rotate(
            { ...value, previousCredentialId: previous.id },
            transaction,
          )
        : await deps.credentials.create(value, transaction);
      await store.saveAccount(
        {
          userId,
          ilinkBotId: session.botId,
          ilinkUserId: session.userId,
          baseUrl: session.baseUrl,
          credentialId: credential.id,
        },
        transaction,
      );
    });
  }

  return {
    async start(userId: string) {
      const qr = await deps.ilink.getBotQrcode();
      const attempt = await store.createAttempt(userId, {
        qrcode: qr.qrcode,
        imageContent: qr.imageContent || null,
      });
      return {
        attemptId: attempt.id,
        imageContent: qr.imageContent,
        expiresInMinutes: WECHAT_BIND_ATTEMPT_MINUTES,
      };
    },

    /** 问一次微信这张二维码走到哪了；确认了就存凭据、写账号。 */
    async check(userId: string, attemptId: string): Promise<WechatBindAnswer> {
      const attempt = await store.attempt(userId, attemptId);
      if (!attempt) throw new DeliveryNotFoundError("找不到这次绑定。");
      if (FINISHED.has(attempt.status))
        return answer(publicStatus(attempt.status));
      if (attempt.expired) return finish(userId, attempt.id, "expired");

      let reply: Awaited<ReturnType<IlinkClient["getQrcodeStatus"]>>;
      try {
        reply = await deps.ilink.getQrcodeStatus(attempt.qrcode);
      } catch (error) {
        if (!(error instanceof DeliveryProviderError)) throw error;
        // 网络、超时、对方 5xx：这次没问到，照上次的说，前端会再问。
        if (error.uncertain) return answer(publicStatus(attempt.status));
        return finish(userId, attempt.id, "failed");
      }

      const status: IlinkQrcodeStatus = reply.status;
      if (status !== "confirmed") {
        const shown = publicStatus(status);
        if (shown === "expired" || shown === "failed")
          return finish(userId, attempt.id, shown);
        await store.setAttemptStatus(userId, attempt.id, status);
        return answer(shown);
      }

      const session = reply.session;
      // 令牌只给微信自己的 https 主机；地址不对就不存。
      if (!session || !isTrustedIlinkBase(session.baseUrl))
        return finish(userId, attempt.id, "failed");
      const holder = await store.accountByIlinkUser(session.userId);
      if (holder && holder.userId !== userId)
        return finish(userId, attempt.id, "taken");
      try {
        await save(userId, session);
      } catch (error) {
        // 查重之后、写入之前别人抢先绑了：部分唯一索引兜底。
        if (
          uniqueViolationConstraint(error) === "wechat_accounts_ilink_user_idx"
        )
          return finish(userId, attempt.id, "taken");
        throw error;
      }
      return finish(userId, attempt.id, "bound");
    },

    /** 解绑：账号标成 `unbound`（store 同时清掉 `context_token`、游标、租约），凭据作废。 */
    async unbind(userId: string): Promise<void> {
      await deps.database.transaction(async (transaction) => {
        const row = await store.unbind(userId, transaction);
        if (!row?.credentialId) return;
        try {
          await deps.credentials.revoke(row.credentialId, transaction);
        } catch (error) {
          // 已经作废了，正是要的结果。
          if (!(error instanceof CredentialRefusedError)) throw error;
        }
      });
    },

    /** 设置页看的那一点：只挑这四个字段，绝不展开账号行。 */
    async summary(
      userId: string,
      now: Date = new Date(),
    ): Promise<WechatSummary | null> {
      const row = await store.account(userId);
      if (!row || row.status === "unbound") return null;
      const paused =
        row.status === "paused" &&
        (!row.pausedUntil || row.pausedUntil.getTime() > now.getTime());
      return {
        status: paused ? "paused" : "bound",
        boundAt: row.boundAt ?? row.createdAt,
        paused,
        windowOpen: Boolean(
          row.lastInboundAt &&
            now.getTime() - row.lastInboundAt.getTime() <
              WECHAT_PROACTIVE_WINDOW_MS,
        ),
      };
    },
  };
}

export type WechatBind = ReturnType<typeof createWechatBind>;

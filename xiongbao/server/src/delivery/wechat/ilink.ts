import { DELIVERY_REQUEST_TIMEOUT_MS } from "../../timeouts";
import { DeliveryProviderError, type ProviderFetch } from "../types";

/** 微信 iLink（ClawBot）协议客户端。固定主机，不经 guardedFetch；token 不进错误信息。 */

export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 实测前的默认值；真实取值由绑定实测确认后改这里。 */
export const ILINK_DEFAULT_CLIENT_VERSION = "2.4.10";
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const PROVIDER = "wechat";

export type IlinkSession = { baseUrl: string; botToken: string };
export type IlinkMessage = {
  id: string;
  fromUserId: string;
  text: string | null;
  contextToken: string | null;
  groupId: string | null;
};
export type IlinkQrcodeStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

export class IlinkPausedError extends DeliveryProviderError {
  override name = "IlinkPausedError";
  constructor() {
    super(PROVIDER, "paused");
  }
}
export class IlinkWindowClosedError extends DeliveryProviderError {
  override name = "IlinkWindowClosedError";
  constructor() {
    super(PROVIDER, "window_closed");
  }
}
export class IlinkUnauthorizedError extends DeliveryProviderError {
  override name = "IlinkUnauthorizedError";
  constructor() {
    super(PROVIDER, "unauthorized");
  }
}

export type IlinkClient = {
  getBotQrcode(): Promise<{ qrcode: string; imageContent: string }>;
  getQrcodeStatus(qrcode: string): Promise<{
    status: IlinkQrcodeStatus;
    session?: IlinkSession & { botId: string; userId: string };
  }>;
  getUpdates(
    session: IlinkSession,
    cursor: string,
    timeoutMs?: number,
  ): Promise<{
    messages: IlinkMessage[];
    cursor: string | null;
    timeoutMs: number;
  }>;
  sendText(
    session: IlinkSession,
    input: { toUserId: string; contextToken: string; text: string },
  ): Promise<void>;
};

/** 0x00MMNNPP 编成十进制字符串。 */
export function encodeClientVersion(v: string): string {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`invalid client version: ${v}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return String(((maj & 0xff) << 16) | ((min & 0xff) << 8) | (pat & 0xff));
}

function uin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] as number;
  return Buffer.from(String(n)).toString("base64");
}

type Json = Record<string, unknown>;
/** Internal: the client-side deadline passed; a long poll treats it as an empty round. */
class RequestTimeout extends Error {}

/**
 * The base URL comes from the bind response; only WeChat's own https hosts may get the bearer token.
 * Binding checks it before saving; authed calls check it again before sending.
 */
export function isTrustedIlinkBase(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (host === "weixin.qq.com" || host.endsWith(".weixin.qq.com"))
  );
}
function assertTrustedBase(baseUrl: string): void {
  if (!isTrustedIlinkBase(baseUrl))
    throw new DeliveryProviderError(PROVIDER, "bad_base_url");
}
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;

/**
 * `message_id` 是 19 位整数，超过 2^53，`JSON.parse` 会丢掉末几位。解析前把键后面的纯整数原样改成字符串。
 * 只匹配未转义的键名：消息正文里写着 `"message_id": 1` 时引号是转义的（`\"`），不会被误改。
 */
function keepMessageIds(text: string): string {
  return text.replace(/("message_id"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g, '$1"$2"');
}

export function createIlinkClient(options: {
  fetch?: ProviderFetch;
  clientVersion: string;
}): IlinkClient {
  const wire = options.fetch ?? fetch;
  const version = encodeClientVersion(options.clientVersion);
  const appHeaders = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": version,
  };

  async function call(
    method: "GET" | "POST",
    url: string,
    init: {
      headers: Record<string, string>;
      body?: unknown;
      timeoutMs: number;
      longPoll?: boolean;
    },
  ): Promise<Json> {
    let response: Response;
    try {
      response = await wire(url, {
        method,
        signal: AbortSignal.timeout(init.timeoutMs),
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (
        init.longPoll &&
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new RequestTimeout();
      }
      throw new DeliveryProviderError(PROVIDER, "network_error", true);
    }
    if (response.status === 401 || response.status === 403)
      throw new IlinkUnauthorizedError();
    if (!response.ok) {
      throw new DeliveryProviderError(
        PROVIDER,
        `http_${response.status}`,
        response.status >= 500,
      );
    }
    try {
      const text = await response.text();
      return text ? (JSON.parse(keepMessageIds(text)) as Json) : {};
    } catch {
      throw new DeliveryProviderError(PROVIDER, "bad_response", true);
    }
  }

  function codes(body: Json): number {
    const ret = typeof body.ret === "number" ? body.ret : 0;
    const err = typeof body.errcode === "number" ? body.errcode : 0;
    return ret !== 0 ? ret : err;
  }

  async function authed(
    session: IlinkSession,
    path: string,
    body: Json,
    timeoutMs: number,
    longPoll = false,
  ): Promise<Json> {
    assertTrustedBase(session.baseUrl);
    return call(
      "POST",
      `${session.baseUrl.replace(/\/$/, "")}/ilink/bot/${path}`,
      {
        timeoutMs,
        longPoll,
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${session.botToken}`,
          "X-WECHAT-UIN": uin(),
          ...appHeaders,
        },
        body: {
          ...body,
          base_info: {
            channel_version: options.clientVersion,
            bot_agent: "xiongbao",
          },
        },
      },
    );
  }

  function textOf(message: Json): string | null {
    const items = Array.isArray(message.item_list)
      ? (message.item_list as Json[])
      : [];
    const parts: string[] = [];
    for (const item of items) {
      const text =
        (item?.text_item as Json | undefined)?.text ??
        (item?.voice_item as Json | undefined)?.text;
      if (typeof text === "string") parts.push(text);
    }
    return parts.length ? parts.join("") : null;
  }

  return {
    async getBotQrcode() {
      const body = await call(
        "POST",
        `${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
        {
          timeoutMs: DELIVERY_REQUEST_TIMEOUT_MS,
          headers: { "Content-Type": "application/json", ...appHeaders },
          body: { local_token_list: [] },
        },
      );
      const qrcode = str(body.qrcode);
      if (!qrcode) throw new DeliveryProviderError(PROVIDER, "bad_response");
      return { qrcode, imageContent: str(body.qrcode_img_content) ?? "" };
    },

    async getQrcodeStatus(qrcode) {
      const body = await call(
        "GET",
        `${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?${new URLSearchParams({ qrcode })}`,
        { timeoutMs: 40_000, headers: { ...appHeaders } },
      );
      const status = (str(body.status) ?? "wait") as IlinkQrcodeStatus;
      if (status !== "confirmed") return { status };
      const botToken = str(body.bot_token);
      const botId = str(body.ilink_bot_id);
      const userId = str(body.ilink_user_id);
      if (!botToken || !botId || !userId)
        throw new DeliveryProviderError(PROVIDER, "bad_response");
      return {
        status,
        session: {
          baseUrl: str(body.baseurl) ?? ILINK_DEFAULT_BASE_URL,
          botToken,
          botId,
          userId,
        },
      };
    },

    async getUpdates(session, cursor, previousTimeoutMs) {
      const pollMs = previousTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
      let body: Json;
      try {
        body = await authed(
          session,
          "getupdates",
          { get_updates_buf: cursor },
          pollMs + 10_000,
          true,
        );
      } catch (error) {
        if (error instanceof RequestTimeout)
          return { messages: [], cursor: null, timeoutMs: pollMs };
        throw error;
      }
      const code = codes(body);
      if (code === -14) throw new IlinkPausedError();
      if (code !== 0) throw new DeliveryProviderError(PROVIDER, "poll_failed");
      const timeoutMs =
        typeof body.longpolling_timeout_ms === "number" &&
        body.longpolling_timeout_ms > 0
          ? body.longpolling_timeout_ms
          : DEFAULT_POLL_TIMEOUT_MS;
      const raw = Array.isArray(body.msgs) ? (body.msgs as Json[]) : [];
      const messages: IlinkMessage[] = [];
      for (const m of raw) {
        if (m.message_type === 2) continue; // 自己发的
        const id = str(m.message_id) ?? str(m.seq) ?? str(m.client_id);
        const fromUserId = str(m.from_user_id);
        if (!id || !fromUserId) continue;
        messages.push({
          id,
          fromUserId,
          text: textOf(m),
          contextToken: str(m.context_token),
          groupId: str(m.group_id),
        });
      }
      return { messages, cursor: str(body.get_updates_buf), timeoutMs };
    },

    async sendText(session, input) {
      const body = await authed(
        session,
        "sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: input.toUserId,
            client_id: `xb-${crypto.randomUUID()}`,
            message_type: 2,
            message_state: 2,
            context_token: input.contextToken,
            item_list: [{ type: 1, text_item: { text: input.text } }],
          },
        },
        DELIVERY_REQUEST_TIMEOUT_MS,
      );
      const code = codes(body);
      if (code === -14) throw new IlinkPausedError();
      if (code !== 0) throw new IlinkWindowClosedError();
    },
  };
}

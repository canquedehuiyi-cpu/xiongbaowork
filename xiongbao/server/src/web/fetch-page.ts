/**
 * 替员工读一个公开网页：地址由模型给，所以每一跳都过 SSRF 出站校验。
 *
 * 员工跑在部署里面，`http://localhost:5432`、云元数据 `169.254.169.254`、每个 RFC1918 邻居都够得着，而对方的
 * 笔记本一个也够不着。模型被一页文字说动去「看看 10.0.0.5 上有什么」，没有这道门就真的会去。所以：
 *
 *  1. 静态：只要 http 和 https；不许带用户名密码；字面地址、`localhost`、`*.localhost`、云元数据名一律拒。
 *     判定用仓库现成的 `addressRisk` / `isNeverAllowedHostname`（`net/outbound-guard.ts`、`computer/target.ts`），
 *     与模型接口地址、浏览器导航同一份名单。
 *  2. DNS：`assertResolvesPublic`，任何一个解析结果在内网就整个拒（同一个函数，同一条「经出站代理时」的规则）。
 *  3. 重定向自己跟（`redirect: "manual"`），每一跳回到第 1 步重新判，最多 {@link MAX_REDIRECTS} 跳。
 *  4. 一个总期限（默认 20 秒）管住解析、连接和读正文；正文读到 {@link MAX_BODY_BYTES} 就停。
 *
 * 不跟 `guardedFetch` 走，是因为那扇门是给「带着密钥」的请求的：它要求 https、拒绝一切重定向，提示也都是
 * 「模型接口」。读公开网页要允许 http、要跟重定向，但内网和元数据一样不许碰。已知局限与那边相同（DNS 重绑定，
 * 见 outbound-guard.ts 的 KNOWN LIMIT）。
 */
import { isNeverAllowedHostname } from "../computer/target";
import {
  addressRisk,
  assertResolvesPublic,
  type OutboundLookup,
  OutboundRefusedError,
  untilAborted,
} from "../net/outbound-guard";

/** 一次读网页的总期限。 */
export const FETCH_TIMEOUT_MS = 20_000;
/** 最多读多少字节的正文：再大的网页也只取前面这些。 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** 最多跟几次重定向。 */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 员工读网页、爬网站时报的身份，固定不变，不带任何用户信息。网站可以在 robots.txt 里按
 * {@link CRAWLER_TOKEN} 单独给它规则。
 */
export const CRAWLER_TOKEN = "XiongbaoBot";
export const CRAWLER_USER_AGENT = `Mozilla/5.0 (compatible; ${CRAWLER_TOKEN}/1.0; digital employee web reader)`;

export type WebFetchPolicy = {
  /** 测试注入。默认系统解析器。 */
  lookup?: OutboundLookup;
  /** 测试注入。默认全局 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 测试注入：这个地址会不会经出站代理（见 outbound-guard.ts 的 `proxiedByEnvironment`）。 */
  viaProxy?: (url: URL) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
};

/** 不读这个地址，`message` 是给模型看的中文原因。什么都没发出去，或者发出去的那一跳被拦下了。 */
export class WebFetchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchRefusedError";
  }
}

/** 读到的网页：最后一跳的地址、状态、类型和（可能截断的）正文字节。 */
export type FetchedPage = {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  /** 正文超过了字节上限，只读了前面一段。 */
  truncated: boolean;
  /** 服务器报的正文长度（Content-Length），没报为空。 */
  declaredLength?: number;
};

/**
 * 这个地址能不能读，不碰网络就能判的那部分。
 *
 * `new URL()` 已经把 `2130706433`、`0x7f.1`、`127.1` 这些写法都改成了 `127.0.0.1`，IPv6 的各种写法由
 * `addressRisk` 看穿。
 */
export function checkFetchUrl(
  raw: string,
): { allowed: true; url: URL } | { allowed: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { allowed: false, reason: "这不是有效的网址。" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return {
      allowed: false,
      reason: `只能读 http 或 https 网页，这个地址是 ${url.protocol.replace(":", "")}。`,
    };
  if (url.username || url.password)
    return { allowed: false, reason: "网址里不能带用户名或密码。" };
  const hostname = url.hostname.toLowerCase();
  const risk = addressRisk(hostname);
  if (isNeverAllowedHostname(hostname) || risk === "metadata")
    return {
      allowed: false,
      reason: "这个地址是本部署的云凭据服务，不会去读。",
    };
  const bare = hostname.replace(/\.+$/, "");
  if (
    risk === "internal" ||
    bare === "localhost" ||
    bare.endsWith(".localhost")
  )
    return {
      allowed: false,
      reason: "这个地址在本部署的内部网络里，不会去读。只能读公开网页。",
    };
  return { allowed: true, url };
}

/**
 * 读一个公开网页，跟着重定向走，每一跳都校验。被拒抛 {@link WebFetchRefusedError}；超时抛 `TimeoutError`；
 * 连不上抛 fetch 自己的错。
 */
export async function fetchPublicPage(
  raw: string,
  policy: WebFetchPolicy = {},
  callerSignal?: AbortSignal,
): Promise<FetchedPage> {
  const timeoutMs = policy.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = policy.maxBytes ?? MAX_BODY_BYTES;
  const fetchImpl = policy.fetchImpl ?? fetch;
  const signal = AbortSignal.any(
    [AbortSignal.timeout(timeoutMs), callerSignal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );

  let current = raw;
  for (let hop = 0; ; hop++) {
    const verdict = checkFetchUrl(current);
    if (!verdict.allowed)
      throw new WebFetchRefusedError(
        hop === 0
          ? verdict.reason
          : `网页重定向到了不能读的地址：${verdict.reason}`,
      );
    const url = verdict.url;
    try {
      await untilAborted(
        assertResolvesPublic(url.href, {
          ...(policy.lookup ? { lookup: policy.lookup } : {}),
          ...(policy.viaProxy ? { viaProxy: policy.viaProxy } : {}),
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof OutboundRefusedError) {
        const reason =
          error.kind === "unresolved"
            ? `找不到 ${url.hostname} 这个网站（域名解析失败）。`
            : `这个网址指向本部署的内部网络，不会去读。只能读公开网页。`;
        throw new WebFetchRefusedError(
          hop === 0 ? reason : `网页重定向到了不能读的地址：${reason}`,
        );
      }
      throw error;
    }

    const response = await fetchImpl(url.href, {
      redirect: "manual",
      signal,
      headers: {
        accept:
          "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "user-agent": CRAWLER_USER_AGENT,
      },
    });
    const location = response.headers.get("location");
    if (REDIRECT_STATUSES.has(response.status) && location) {
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS)
        throw new WebFetchRefusedError(
          `网页重定向超过 ${MAX_REDIRECTS} 次，没有继续跟。`,
        );
      try {
        current = new URL(location, url).href;
      } catch {
        throw new WebFetchRefusedError("网页重定向到了一个无效的网址。");
      }
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length"));
    const declaredLength =
      Number.isFinite(declared) && declared >= 0 ? declared : undefined;
    // A binary file is described, never downloaded: its headers say all the model is told.
    if (isBinaryType(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        url: url.href,
        status: response.status,
        contentType,
        body: new Uint8Array(),
        truncated: false,
        ...(declaredLength !== undefined ? { declaredLength } : {}),
      };
    }
    const { body, truncated } = await readLimited(response, maxBytes);
    return {
      url: url.href,
      status: response.status,
      contentType,
      body,
      truncated,
      ...(declaredLength !== undefined ? { declaredLength } : {}),
    };
  }
}

/** 正文读到 `maxBytes` 为止，多的不读，连接随即放掉。 */
async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!response.body) return { body: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

/** 页面是哪一类：HTML 要转成文字，文本直接给，二进制只说明。 */
export function pageKind(
  contentType: string,
  body: Uint8Array,
): "html" | "text" | "binary" {
  const type = mediaType(contentType);
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (isTextType(type)) return "text";
  if (type !== "" && type !== "application/octet-stream") return "binary";
  // No type, or a generic one: look at the bytes.
  const head = body.subarray(0, 1024);
  if (head.includes(0)) return "binary";
  const start = new TextDecoder()
    .decode(head)
    .trimStart()
    .slice(0, 100)
    .toLowerCase();
  if (start.startsWith("<!doctype html") || start.startsWith("<html"))
    return "html";
  return type === "" ? "text" : "binary";
}

function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isTextType(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/ecmascript",
      "application/yaml",
      "application/x-yaml",
      "application/x-ndjson",
      "application/csv",
      "application/x-sh",
      "application/sql",
      "application/graphql",
    ].includes(type)
  );
}

/** 头里就能看出是二进制：图片、音视频、PDF、压缩包这一类。没有类型或类型泛泛的，读了再看。 */
function isBinaryType(contentType: string): boolean {
  const type = mediaType(contentType);
  if (type === "" || type === "application/octet-stream") return false;
  return !(
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    isTextType(type)
  );
}

/**
 * 正文按它的字符集解码：先看 Content-Type 的 charset，HTML 再看前 2KB 里的 `<meta charset>`，都没有就是
 * UTF-8。国内不少网页还是 GBK。
 */
export function decodeBody(
  body: Uint8Array,
  contentType: string,
  html: boolean,
): string {
  const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  let charset = declared;
  if (!charset && html) {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 2048));
    charset =
      /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? undefined;
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

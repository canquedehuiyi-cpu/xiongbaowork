import { lookup as dnsLookup } from "node:dns/promises";
import {
  canonicalHostname,
  expandIpv6,
  isNeverAllowedHostname,
} from "../computer/target";

/**
 * The one door a tenant-chosen URL goes through before this server sends a credential to it.
 *
 * Audit defect #6. A model's base URL is typed by a tenant and then POSTed to, from inside the
 * deployment, with that tenant's Bearer key. Without a check that is the textbook SSRF shape: the
 * metadata service, the database port on localhost and every RFC1918 neighbour are reachable from
 * here and from nowhere the tenant sits, and a default `fetch` follows a redirect to any of them with
 * the key still attached.
 *
 * What this does, in order:
 *
 *  1. Static: http or https only, https unless the deployment opted into private hosts (refused in
 *     production by config); no userinfo; no literal address or `localhost` name
 *     that is inside the deployment. `new URL()` has already rewritten `2130706433`, `0x7f.1`,
 *     `0177.0.0.1` and `127.1` to `127.0.0.1`, so every literal form arrives here in one spelling.
 *  2. DNS: every A/AAAA answer is classified, and ONE internal answer refuses the whole name. A name
 *     that does not resolve is `unresolved`, not a policy refusal: a resolver hiccup is "unreachable",
 *     not "forbidden". When the process sends through an egress proxy (HTTP(S)_PROXY, which Bun's
 *     `fetch` honours) and this pod has no resolver of its own for the name, the request is handed to
 *     the proxy unresolved — see KNOWN LIMIT — EGRESS PROXY below.
 *  3. Send with `redirect: "manual"` and refuse any 3xx outright. A redirect is never followed, so a
 *     credential can never be carried across one.
 *  4. A deadline, when the caller gives one, merged with the caller's own signal.
 *
 * The metadata addresses are refused at every step whatever the configuration says, the same rule
 * `computer/target.ts` keeps for browsing: no development task needs them.
 *
 * KNOWN LIMIT — DNS REBINDING. Bun's `fetch` cannot be told which IP to connect to while keeping the
 * URL's hostname for SNI and the Host header, so the address checked in step 2 and the address the
 * socket opens are two separate resolutions. A resolver that answers public first and internal a
 * moment later can still win that race. What narrows it: every answer is checked rather than the
 * first, the window is one request long, redirects are refused, and https is required in production
 * (an internal service would also have to present a certificate for the tenant's name). Closing it
 * outright needs a pinned dialer or an egress proxy that applies the same deny-list at connect time —
 * a deployment control, recorded as a follow-up rather than pretended away here.
 *
 * KNOWN LIMIT — EGRESS PROXY. A locked-down deployment may have no external DNS inside the pod and
 * send all egress through HTTP(S)_PROXY. There the local lookup fails for every public provider, so
 * refusing on that failure would break every legitimate custom endpoint. When a proxy is configured
 * and the local lookup FAILS, step 2 is skipped and the proxy resolves the name; the deny-list then
 * has to be enforced at the proxy, which is the deployment's responsibility. When the local lookup
 * SUCCEEDS, its answers are still checked, proxy or not. Literal addresses, `localhost`, metadata
 * names and the scheme are checked in step 1 whatever the proxy says.
 */

export type OutboundLookup = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

export type OutboundPolicy = {
  /** Development only; `config.ts` refuses it in production. Never admits metadata. */
  allowPrivateHosts?: boolean;
  /**
   * Exact `host:port` (or bare `host` for the scheme's default port), in URL spelling, an operator
   * named. Admits an internal address for that one host and port only; https is still required.
   * Never admits metadata. Not wired for tenant model endpoints (see `index.ts`).
   */
  allowedHosts?: ReadonlySet<string>;
  /** Injected by tests. Defaults to the system resolver, all answers, in the order it gave them. */
  lookup?: OutboundLookup;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
  /**
   * Whether `fetch` will send this URL through an egress proxy. Injected by tests; defaults to
   * reading HTTPS_PROXY / HTTP_PROXY (either case) from the environment.
   */
  viaProxy?: (url: URL) => boolean;
};

/** Refused, with a reason a person can read. Never carries the URL's query or any header. */
export class OutboundRefusedError extends Error {
  /**
   * `destination`: refused by policy, nothing was sent. `unresolved`: the name could not be looked
   * up (not a policy decision; nothing was sent). `redirect`: the request was sent to an allowed
   * host, which answered with a redirect that was not followed.
   */
  readonly kind: "destination" | "unresolved" | "redirect";
  constructor(
    reason: string,
    kind: "destination" | "unresolved" | "redirect" = "destination",
  ) {
    super(reason);
    this.name = "OutboundRefusedError";
    this.kind = kind;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const systemLookup: OutboundLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Whether Bun's `fetch` would send this URL through a proxy, by the environment it reads. */
function environmentProxy(url: URL): boolean {
  const env = process.env;
  const https = env.HTTPS_PROXY ?? env.https_proxy;
  const http = env.HTTP_PROXY ?? env.http_proxy;
  return Boolean(url.protocol === "https:" ? https || http : http);
}

/**
 * What kind of address this is: the metadata service, somewhere inside the deployment, or neither.
 *
 * Takes a bare address as DNS or a URL hands it over, IPv6 with or without brackets. IPv6 forms that
 * carry an IPv4 address (mapped, compatible, NAT64) are judged as the IPv4 they carry, and so is 6to4,
 * which routes to its embedded address through any relay.
 */
export function addressRisk(raw: string): "metadata" | "internal" | null {
  const bare = dottedTailToHex(raw.replace(/^\[|\]$/g, "").toLowerCase());
  const canonical = bare.includes(":")
    ? canonicalHostname(`[${bare}]`)
    : canonicalHostname(bare);
  if (isNeverAllowedHostname(canonical)) return "metadata";
  if (canonical.includes(":")) return ipv6Risk(canonical);
  return ipv4Risk(canonical);
}

/**
 * `::ffff:169.254.169.254` as `::ffff:a9fe:a9fe`.
 *
 * `new URL()` rewrites the dotted tail, but a resolver's answer or a bare string arrives as written,
 * and the IPv6 expander reads groups as hex — so the dotted form would be misread as some other
 * address entirely. An unparseable tail is left alone and judged as unparseable.
 */
function dottedTailToHex(address: string): string {
  if (!address.includes(":")) return address;
  const cut = address.lastIndexOf(":");
  const octets = ipv4Octets(address.slice(cut + 1));
  if (!octets) return address;
  const [a, b, c, d] = octets as [number, number, number, number];
  return `${address.slice(0, cut + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((value) => value <= 255) ? octets : null;
}

function ipv4Risk(address: string): "internal" | null {
  const octets = ipv4Octets(address);
  if (!octets) return null;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return "internal"; // 0.0.0.0/8, "this host"
  if (a === 10) return "internal"; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return "internal"; // 100.64/10 carrier-grade NAT
  if (a === 127) return "internal"; // loopback
  if (a === 169 && b === 254) return "internal"; // link-local
  if (a === 172 && b >= 16 && b <= 31) return "internal"; // RFC1918
  if (a === 192 && b === 0 && c === 0) return "internal"; // IETF protocol assignments
  if (a === 192 && b === 168) return "internal"; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return "internal"; // benchmarking
  if (a >= 224) return "internal"; // multicast, reserved, broadcast
  return null;
}

function ipv6Risk(address: string): "metadata" | "internal" | null {
  const groups = expandIpv6(address);
  if (!groups) return "internal"; // unparseable as an address it claims to be: refuse
  if (groups.every((group) => group === 0)) return "internal"; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return "internal"; // ::1
  }
  const [first, second = 0, third = 0] = groups as [number, ...number[]];
  // fe80::/10 link-local and the retired fec0::/10 site-local
  if (first >= 0xfe80 && first <= 0xfeff) return "internal";
  if (first >= 0xfc00 && first <= 0xfdff) return "internal"; // fc00::/7 unique-local
  if (first >= 0xff00) return "internal"; // ff00::/8 multicast
  if (first === 0x2002) {
    // 6to4: the IPv4 address is in the second and third groups.
    const embedded = [second >> 8, second & 255, third >> 8, third & 255].join(
      ".",
    );
    if (isNeverAllowedHostname(embedded)) return "metadata";
    return ipv4Risk(embedded);
  }
  return null;
}

function isLiteralAddress(hostname: string): boolean {
  return hostname.startsWith("[") || ipv4Octets(hostname) !== null;
}

/**
 * Exact match only: `host:port` for an explicit port, bare `host` only for the default port. A bare
 * entry never widens to every port on that host.
 */
function namedHost(url: URL, allowedHosts?: ReadonlySet<string>): boolean {
  if (!allowedHosts || allowedHosts.size === 0) return false;
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.has(url.port ? `${hostname}:${url.port}` : hostname);
}

/** Whether the operator named this host at all, with or without a port. */
function hostIsNamed(url: URL, allowedHosts?: ReadonlySet<string>): boolean {
  if (!allowedHosts || allowedHosts.size === 0) return false;
  const hostname = url.hostname.toLowerCase();
  for (const entry of allowedHosts) {
    const named = entry.toLowerCase();
    if (named === hostname || named.startsWith(`${hostname}:`)) return true;
  }
  return false;
}

export type OutboundVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/**
 * Whether this URL may be sent a credential, decided without the network.
 *
 * Used on its own when a URL is stored, so an address that must never be dialled never reaches the
 * database, and again as the first step of every send.
 */
export function checkOutboundUrl(
  raw: string,
  policy: OutboundPolicy = {},
): OutboundVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { allowed: false, reason: "这不是有效的网址。" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      allowed: false,
      reason: "模型接口地址必须以 http 或 https 开头。",
    };
  }
  if (url.username || url.password) {
    return {
      allowed: false,
      reason: "模型接口地址中不能包含用户名或密码。",
    };
  }
  const hostname = url.hostname.toLowerCase();
  if (
    isNeverAllowedHostname(hostname) ||
    (isLiteralAddress(hostname) && addressRisk(hostname) === "metadata")
  ) {
    return {
      allowed: false,
      reason: "该地址是本部署的云凭据服务，不会向它发送任何内容。",
    };
  }
  const opened =
    policy.allowPrivateHosts === true || namedHost(url, policy.allowedHosts);
  // Only the development opt-in relaxes https; naming a host opens its address, not plain text.
  if (url.protocol !== "https:" && policy.allowPrivateHosts !== true) {
    return {
      allowed: false,
      reason: "模型接口必须使用 https，否则密钥会以明文传输。",
    };
  }
  // A named host is scoped to the port it was named with (a bare name: the scheme's default port),
  // so naming `agents.internal` never opens `agents.internal:6379`.
  if (!opened && hostIsNamed(url, policy.allowedHosts)) {
    return {
      allowed: false,
      reason: "该主机只允许使用登记时指定的端口。",
    };
  }
  const bare = canonicalHostname(hostname);
  const internal =
    (isLiteralAddress(hostname) && addressRisk(hostname) !== null) ||
    bare === "localhost" ||
    bare.endsWith(".localhost");
  if (internal && !opened) {
    return {
      allowed: false,
      reason: "该地址位于本部署的内部网络，不会向它发送任何内容。",
    };
  }
  return { allowed: true, url: url.toString() };
}

/**
 * Resolve the URL's host and refuse it if ANY answer is inside the deployment.
 *
 * One bad answer is enough because the connection may use any of them. A literal address was already
 * judged by {@link checkOutboundUrl} and is not looked up.
 */
export async function assertResolvesPublic(
  raw: string,
  policy: OutboundPolicy = {},
): Promise<void> {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  if (isLiteralAddress(hostname)) return;
  const opened =
    policy.allowPrivateHosts === true || namedHost(url, policy.allowedHosts);
  let answers: { address: string }[];
  try {
    answers = await (policy.lookup ?? systemLookup)(
      canonicalHostname(hostname),
    );
  } catch {
    answers = [];
  }
  if (answers.length === 0) {
    // No local answer. Behind an egress proxy the proxy resolves it (KNOWN LIMIT — EGRESS PROXY);
    // otherwise the request could not go anywhere anyway: unreachable, not forbidden.
    if ((policy.viaProxy ?? environmentProxy)(url)) return;
    throw new OutboundRefusedError(`无法解析 ${hostname}。`, "unresolved");
  }
  for (const { address } of answers) {
    const risk = addressRisk(address);
    if (risk === "metadata") {
      throw new OutboundRefusedError(
        `${hostname} 解析到本部署的云凭据服务，不会向它发送任何内容。`,
      );
    }
    if (risk === "internal" && !opened) {
      throw new OutboundRefusedError(
        `${hostname} 解析到本部署的内部网络，不会向它发送任何内容。`,
      );
    }
  }
}

/**
 * `fetch`, for a URL a tenant chose: checked, resolved, never redirected, optionally on a deadline.
 *
 * Throws {@link OutboundRefusedError} instead of sending, and for any redirect answer — the body of a
 * refused redirect is discarded and its Location is never requested.
 */
export async function guardedFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  policy: OutboundPolicy & { timeoutMs?: number } = {},
): Promise<Response> {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const verdict = checkOutboundUrl(raw, policy);
  if (!verdict.allowed) throw new OutboundRefusedError(verdict.reason);

  // One deadline for the whole request, name resolution included: a resolver that never answers
  // must not hold a probe past its timeout, and the caller's own abort must stop it too.
  const signals = [
    init?.signal,
    policy.timeoutMs ? AbortSignal.timeout(policy.timeoutMs) : undefined,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);
  await untilAborted(assertResolvesPublic(verdict.url, policy), signal);

  const response = await (policy.fetchImpl ?? fetch)(input, {
    ...init,
    redirect: "manual",
    ...(signal ? { signal } : {}),
  });
  if (
    REDIRECT_STATUSES.has(response.status) ||
    response.type === "opaqueredirect"
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new OutboundRefusedError(
      `模型接口返回了重定向（HTTP ${response.status}）。系统不跟随重定向，密钥未被转发。`,
      "redirect",
    );
  }
  return response;
}

/**
 * `work`, or the signal's reason if it aborts first. The lookup itself cannot be cancelled, so a
 * stalled one is abandoned rather than awaited; its eventual answer is ignored.
 */
export function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** {@link guardedFetch} with its policy bound, in the shape an SDK's `fetch` option takes. */
export function createGuardedFetch(
  policy: OutboundPolicy & { timeoutMs?: number } = {},
): typeof fetch {
  const bound = (input: string | URL | Request, init?: RequestInit) =>
    guardedFetch(input, init, policy);
  // `typeof fetch` carries Bun's `preconnect`; this is only ever called as a fetch.
  return bound as unknown as typeof fetch;
}

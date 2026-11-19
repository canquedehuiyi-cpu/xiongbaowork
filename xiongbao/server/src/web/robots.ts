/**
 * 爬网站的两条规矩：遵守 robots.txt，同一个网站每秒最多一个请求。
 *
 * robots.txt 按 RFC 9309 读：先找点名 {@link CRAWLER_TOKEN} 的那组规则，没有就用 `*` 那组；Allow 和
 * Disallow 取最长匹配，一样长时 Allow 赢；`*` 是任意字符，结尾的 `$` 表示到此为止。robots.txt 不存在（4xx）
 * 就是都可以爬；服务器出错（5xx）或连不上就当整站不许爬，这也是 RFC 的要求。
 *
 * robots.txt 本身也经 `fetchPublicPage` 去取，同一道 SSRF 校验。
 */
import {
  CRAWLER_TOKEN,
  decodeBody,
  fetchPublicPage,
  type WebFetchPolicy,
} from "./fetch-page";

export type RobotsRules = {
  /** 这个地址（路径加查询）许不许爬。 */
  allows(pathAndQuery: string): boolean;
  /** 网站要求的两次请求间隔（Crawl-delay），没写为空。 */
  crawlDelayMs?: number;
};

const ALLOW_ALL: RobotsRules = { allows: () => true };
const DISALLOW_ALL: RobotsRules = { allows: () => false };

/** robots.txt 最多读多少：RFC 9309 要求至少读 500 KiB。 */
const MAX_ROBOTS_BYTES = 512 * 1024;

type Rule = { allow: boolean; pattern: string; regex: RegExp };

function ruleRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** 只解析，不碰网络。 */
export function parseRobots(
  text: string,
  token: string = CRAWLER_TOKEN,
): RobotsRules {
  type Group = { agents: string[]; rules: Rule[]; delay?: number };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow allows everything, which is the same as no rule.
      if (value === "") continue;
      let pattern = value;
      try {
        pattern = decodeURI(value);
      } catch {}
      current.rules.push({
        allow: field === "allow",
        pattern,
        regex: ruleRegex(pattern),
      });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.delay = seconds;
    }
  }
  const name = token.toLowerCase();
  const named = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && name.includes(agent)),
  );
  const chosen =
    named.length > 0
      ? named
      : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  const delay = chosen.find((group) => group.delay !== undefined)?.delay;
  return {
    allows(pathAndQuery) {
      let path = pathAndQuery || "/";
      try {
        path = decodeURI(path);
      } catch {}
      if (path === "/robots.txt") return true;
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        )
          best = rule;
      }
      return best ? best.allow : true;
    },
    ...(delay !== undefined ? { crawlDelayMs: delay * 1000 } : {}),
  };
}

/** 读一个网站的 robots.txt，按来源缓存在这一次爬取里。 */
export function createRobotsReader(
  policy: WebFetchPolicy,
  before?: (url: URL) => Promise<void>,
): (url: URL, signal?: AbortSignal) => Promise<RobotsRules> {
  const cache = new Map<string, Promise<RobotsRules>>();
  return (url, signal) => {
    const origin = url.origin;
    let rules = cache.get(origin);
    if (!rules) {
      rules = (async () => {
        const robotsUrl = new URL("/robots.txt", origin);
        try {
          await before?.(robotsUrl);
          const page = await fetchPublicPage(
            robotsUrl.href,
            { ...policy, maxBytes: MAX_ROBOTS_BYTES },
            signal,
          );
          if (page.status >= 500) return DISALLOW_ALL;
          if (page.status >= 400) return ALLOW_ALL;
          if (page.status >= 300) return DISALLOW_ALL;
          return parseRobots(decodeBody(page.body, page.contentType, false));
        } catch {
          return DISALLOW_ALL;
        }
      })();
      cache.set(origin, rules);
    }
    return rules;
  };
}

/**
 * 同一个网站两次请求之间至少隔多久（默认 1 秒）。按主机名排队：先到先得，后来的等到自己的时间片。
 * 进程里共用一个（{@link sharedHostPacer}），几位员工同时爬同一个网站也合起来算。
 */
export type HostPacer = {
  wait(host: string, minimumMs?: number, signal?: AbortSignal): Promise<void>;
};

export function createHostPacer(
  options: {
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): HostPacer {
  const interval = options.intervalMs ?? 1000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const next = new Map<string, number>();
  return {
    async wait(host, minimumMs = 0, signal) {
      const key = host.toLowerCase();
      const at = Math.max(now(), next.get(key) ?? 0);
      next.set(key, at + Math.max(interval, minimumMs));
      // Forget hosts whose turn passed long ago, so the map does not grow without end.
      if (next.size > 1000)
        for (const [name, time] of next)
          if (time < now() - 60_000) next.delete(name);
      const delay = at - now();
      if (delay > 0) await sleep(delay, signal);
    },
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const sharedHostPacer: HostPacer = createHostPacer();

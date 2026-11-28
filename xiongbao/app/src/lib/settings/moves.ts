import { redirect } from "@tanstack/react-router";

/**
 * 旧地址换成新地址的那一张表（设计 §7）。
 *
 * 路由的重定向、服务器发来的旧地址（`movedHref`）、应用内链接的静态扫描都读它，所以一个旧地址只在这里
 * 写一次。后续每个 PR 往 `SETTINGS_MOVES` 末尾（同前缀的具体地址排在参数地址前面）加自己那批行，并给
 * `tests/settings-moves.test.tsx` 加对应的用例。
 */
export type SettingsMove = {
  /** §7 的行号，如 "U51" */
  id: string;
  /** 旧地址模式：`$name` 匹配一段；结尾 `/$` 匹配余下全部（可为空） */
  from: string;
  /** 新地址模式，引用 from 里同名参数；`$` 引用余下部分 */
  to: string;
  hash?: string;
  /** "all" 原样带全部查询参数；数组只带这些；省略不带 */
  search?: "all" | readonly string[];
  /** 只在满足时转（U41：带 focus） */
  only?: (search: Record<string, unknown>) => boolean;
  /** §3.2 外部依赖的地址 */
  kept?: true;
};

/**
 * 先写的先匹配：具体地址必须排在同前缀的参数地址前面（U14/U15 在 U10 前，
 * `/settings/plugins/composio` 在 `/settings/plugins/$` 前）。
 */
export const SETTINGS_MOVES: readonly SettingsMove[] = [
  // 服务端配额报错里的 `upgradeUrl`，前端 lib/client.ts 也按它走。
  { id: "U01", from: "/plans", to: "/settings/plans", kept: true },
  // 部署清单（server/src/setup/checklist.ts）与动作推演（server/src/what-if-check.ts）发来的电脑页。
  {
    id: "U51",
    from: "/admin/computers",
    to: "/settings/devices",
    hash: "team-computers",
    kept: true,
  },
  // 部署清单发来的个人版电脑页。
  {
    id: "U52",
    from: "/settings/computer",
    to: "/settings/devices",
    hash: "this-computer",
    kept: true,
  },
];

type Params = { named: Record<string, string>; rest: string | null };

function segmentsOf(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/** 解码一次；坏的转义原样留着，不让一个错地址把路由炸掉。 */
function decodeOnce(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchFrom(from: string, pathname: string): Params | null {
  const pattern = segmentsOf(from);
  const actual = segmentsOf(pathname);
  const hasRest = pattern[pattern.length - 1] === "$";
  const fixed = hasRest ? pattern.slice(0, -1) : pattern;
  if (hasRest ? actual.length < fixed.length : actual.length !== fixed.length) {
    return null;
  }
  const named: Record<string, string> = {};
  for (const [index, part] of fixed.entries()) {
    const segment = actual[index] as string;
    if (part.startsWith("$")) named[part.slice(1)] = decodeOnce(segment);
    else if (part !== segment) return null;
  }
  const rest = hasRest ? actual.slice(fixed.length) : null;
  return {
    named,
    // 余下部分按段解码再按段编码，段内的 `%2F` 不会变成路径分隔。
    rest: rest
      ? rest.map((part) => encodeURIComponent(decodeOnce(part))).join("/")
      : null,
  };
}

function fillTo(to: string, params: Params): string {
  const parts = segmentsOf(to).map((part) => {
    if (part === "$") return params.rest ?? "";
    if (part.startsWith("$")) {
      return encodeURIComponent(params.named[part.slice(1)] ?? "");
    }
    return part;
  });
  return `/${parts.filter((part) => part !== "").join("/")}`;
}

function queryOf(
  search: Record<string, unknown>,
  keep: SettingsMove["search"],
): string {
  if (!keep) return "";
  const query = new URLSearchParams();
  const keys = keep === "all" ? Object.keys(search) : keep;
  for (const key of keys) {
    const value = search[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      query.append(
        key,
        typeof item === "object" ? JSON.stringify(item) : String(item),
      );
    }
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** `resolveMove` 的纯核心：拿一张表来匹配，规则测试用小表。 */
export function resolveMoveIn(
  moves: readonly SettingsMove[],
  pathname: string,
  search: Record<string, unknown>,
): string | null {
  for (const move of moves) {
    const params = matchFrom(move.from, pathname);
    if (!params) continue;
    if (move.only && !move.only(search)) continue;
    const hash = move.hash ? `#${move.hash}` : "";
    return `${fillTo(move.to, params)}${queryOf(search, move.search)}${hash}`;
  }
  return null;
}

/** 命中返回完整 href（路径 + ?查询 + #锚点），未命中 null。参数值解码一次再编码一次。 */
export function resolveMove(
  pathname: string,
  search: Record<string, unknown>,
): string | null {
  return resolveMoveIn(SETTINGS_MOVES, pathname, search);
}

/** 服务器发来的旧地址换成新地址；没有对应就原样返回。 */
export function movedHref(href: string): string {
  const hashAt = href.indexOf("#");
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const search: Record<string, unknown> = {};
  if (queryAt !== -1) {
    for (const [key, value] of new URLSearchParams(
      beforeHash.slice(queryAt + 1),
    )) {
      const seen = search[key];
      search[key] =
        seen === undefined
          ? value
          : [...(Array.isArray(seen) ? seen : [seen]), value];
    }
  }
  const moved = resolveMove(pathname, search);
  if (moved === null) return href;
  return moved.includes("#") ? moved : `${moved}${hash}`;
}

/** 路由 beforeLoad 用：命中时 throw redirect。 */
export function redirectIfMoved(opts: {
  location: { pathname: string; search: Record<string, unknown> };
}): void {
  const href = resolveMove(opts.location.pathname, opts.location.search);
  if (href !== null) throw redirect({ href, replace: true });
}

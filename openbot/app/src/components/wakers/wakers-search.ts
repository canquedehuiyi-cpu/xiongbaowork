import type { LinkProps } from "@tanstack/react-router";

/**
 * The address of the 员工管理 wall (`/wakers`): which tab, and how the employee wall is narrowed
 * and ordered (parity plan F2). Every axis is optional and absent means "the default", so the
 * sidebar's plain `/wakers` link and an old bookmark keep landing on the unfiltered employees tab,
 * while a narrowed wall survives a reload, a shared link and the detail page's back link.
 */

/**
 * Three states read from facts that already exist (CONTEXT.md: 在线/休息/暂停), plus the screen
 * admitting it could not read one of those facts. See `statusFor` in the route.
 */
export type WakerStatus = "working" | "resting" | "paused" | "unknown";

/**
 * Where a coworker's work runs, as far as this person's device list can tell: on one of their
 * machines (a running task bound to it, or their own coworker while they have paired machines), or
 * on no machine of theirs that the screen can name.
 */
export type WakerEnv = "device" | "unbound";

/** Only orders the screen can compute from what it already reads. Absent: the roster's own order. */
export type WakerSort = "name" | "recent" | "tasks";

export type WakersSearch = {
  tab?: "groups";
  q?: string;
  status?: WakerStatus;
  role?: string;
  env?: WakerEnv;
  sort?: WakerSort;
};

const STATUSES: readonly WakerStatus[] = [
  "working",
  "resting",
  "paused",
  "unknown",
];
const ENVS: readonly WakerEnv[] = ["device", "unbound"];
const SORTS: readonly WakerSort[] = ["name", "recent", "tasks"];

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

/** Free text, which the router may have parsed into a number ("2025" in the search box). */
const text = (value: unknown): string | undefined => {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Only the keys that carry a choice, so the default address stays `/wakers` with nothing after it. */
export function parseWakersSearch(raw: Record<string, unknown>): WakersSearch {
  const next: WakersSearch = {
    tab: raw.tab === "groups" ? "groups" : undefined,
    q: text(raw.q),
    status: oneOf(raw.status, STATUSES),
    role: text(raw.role),
    env: oneOf(raw.env, ENVS),
    sort: oneOf(raw.sort, SORTS),
  };
  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as WakersSearch;
}

/** Whether anything narrows the employee wall, so an empty wall reads "none match", not "none exist". */
export const isNarrowed = (search: WakersSearch, query: string): boolean =>
  query.trim() !== "" || !!search.status || !!search.role || !!search.env;

/*
 * The wall's last address in this tab of the browser, for the detail page's back link.
 *
 * The browser's own Back already returns to the narrowed wall, because the wall's state is in the
 * URL. The detail page's 返回 is a link, though, and a bare `/wakers` would drop the filters a person
 * had just set. Router history state would carry this per entry, but typing it means augmenting
 * `@tanstack/history`, which is not a dependency here (see `transcript-messages.ts`); a module value
 * is enough, and a reload of the detail page simply falls back to the unfiltered wall.
 */
let lastWakersSearch: WakersSearch = {};

export function rememberWakersSearch(search: WakersSearch): void {
  lastWakersSearch = search;
}

export function wakersReturnSearch(): WakersSearch {
  return lastWakersSearch;
}

/**
 * The detail page's back link: `/wakers` with the wall's last address. Typed as the loose
 * `LinkProps` PageShell takes, whose `search` is every route's at once; the value is exactly what
 * `/wakers`'s own `validateSearch` produced.
 */
export function wakersBackLink(): LinkProps {
  return { search: lastWakersSearch, to: "/wakers" } as LinkProps;
}

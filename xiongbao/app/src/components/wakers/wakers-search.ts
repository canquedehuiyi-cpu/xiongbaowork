import type { LinkProps } from "@tanstack/react-router";
import { rememberForSession } from "@/lib/session-memory";
import type { AcpHarness } from "../../../../shared/acp";

/**
 * The address of the 员工 page (`/bots`; 熊宝的员工管理 `/wakers` 重定向到这里，M5b): which tab, and how
 * the roster is narrowed, ordered and drawn (parity plan F2). Every axis is optional and absent means
 * "the default", so the sidebar's plain `/bots` link and an old `/wakers` bookmark keep landing on the
 * unfiltered employees tab, while a narrowed roster survives a reload, a shared link and the detail
 * page's back link.
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

/** 员工怎么画：卡片（默认，熊宝的员工墙）或列表（上游的员工名单行）。 */
export type WakerView = "list";

/**
 * 「招一位新同事」从哪里招（外部员工 Task 10）：人才市场（默认，不写进地址）、固定员工（Claude Code 和 Codex，
 * 一键启用，8.3）、从我的电脑招、云端（下一步）。
 */
export type HireSource = "market" | "fixed" | "computer" | "cloud";

export type WakersSearch = {
  /** 顶部「人才市场 / 从我的电脑招 / 云端（下一步）」；没有就是人才市场。 */
  source?: Exclude<HireSource, "market">;
  /** 从我的电脑招：选的是哪台电脑（`deviceId`）。 */
  device?: string;
  /** 从我的电脑招：在招聘设置里招哪一家；配 `device` 一起用。 */
  hire?: AcpHarness;
  tab?: "groups";
  q?: string;
  status?: WakerStatus;
  role?: string;
  env?: WakerEnv;
  sort?: WakerSort;
  view?: WakerView;
  /**
   * The two dialogs over the roster: `new` opens the create wizard, `agent` opens that employee's
   * edit dialog (each card's 编辑). Search parameters rather than local state so Back closes them.
   * The old `/agents?new=true` / `/wakers?new=true` links redirect onto `new`; their `agent` now
   * opens that employee's own page instead (`lib/agents/legacy-routes.ts`).
   */
  new?: true;
  agent?: string;
};

const STATUSES: readonly WakerStatus[] = [
  "working",
  "resting",
  "paused",
  "unknown",
];
const ENVS: readonly WakerEnv[] = ["device", "unbound"];
const SORTS: readonly WakerSort[] = ["name", "recent", "tasks"];
const SOURCES: readonly Exclude<HireSource, "market">[] = [
  "fixed",
  "computer",
  "cloud",
];
const HARNESSES: readonly AcpHarness[] = [
  "codex",
  "claude-code",
  "hermes",
  "custom",
];

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

/** Only the keys that carry a choice, so the default address stays `/bots` with nothing after it. */
export function parseWakersSearch(raw: Record<string, unknown>): WakersSearch {
  const source = oneOf(raw.source, SOURCES);
  const next: WakersSearch = {
    source,
    // 电脑和招聘设置只属于「从我的电脑招」。
    device: source === "computer" ? text(raw.device) : undefined,
    hire: source === "computer" ? oneOf(raw.hire, HARNESSES) : undefined,
    tab: raw.tab === "groups" ? "groups" : undefined,
    q: text(raw.q),
    status: oneOf(raw.status, STATUSES),
    role: text(raw.role),
    env: oneOf(raw.env, ENVS),
    sort: oneOf(raw.sort, SORTS),
    view: raw.view === "list" ? "list" : undefined,
    // The router parses `?new=true` into a boolean; a hand-typed string is honoured too.
    new: raw.new === true || raw.new === "true" ? true : undefined,
    agent: text(raw.agent),
  };
  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as WakersSearch;
}

/** The wall's own address without the dialog keys: where closing a dialog returns to. */
export function wallSearch(search: WakersSearch): WakersSearch {
  const { new: _new, agent: _agent, ...wall } = search;
  return wall;
}

/**
 * The archived `/agents` address mapped onto the roster: `new` and `agent` keep their meaning, and
 * nothing else on it ever existed. Anything unparseable is dropped, as the roster itself would.
 */
export function wakersSearchFromAgents(
  raw: Record<string, unknown>,
): WakersSearch {
  return parseWakersSearch({ new: raw.new, agent: raw.agent });
}

/** Whether anything narrows the employee wall, so an empty wall reads "none match", not "none exist". */
export const isNarrowed = (search: WakersSearch, query: string): boolean =>
  query.trim() !== "" || !!search.status || !!search.role || !!search.env;

/*
 * The roster's last address in this tab of the browser, for the detail page's back link.
 *
 * The browser's own Back already returns to the narrowed roster, because its state is in the
 * URL. The detail page's 返回 is a link, though, and a bare `/bots` would drop the filters a person
 * had just set. Router history state would carry this per entry, but typing it means augmenting
 * `@tanstack/history`, which is not a dependency here (see `transcript-messages.ts`); a module value
 * is enough, and a reload of the detail page simply falls back to the unfiltered wall.
 */
let lastWakersSearch: WakersSearch = {};
rememberForSession(() => {
  lastWakersSearch = {};
});

export function rememberWakersSearch(search: WakersSearch): void {
  /*
   * A dialog open at the time is not part of the wall the back link should return to, and neither is
   * a hire form (外部员工 Task 10): after hiring, deleting or hiding an employee, going back must not
   * land on 「把 X 招进来」 again, one click from hiring it twice.
   */
  const { hire: _hire, ...wall } = wallSearch(search);
  lastWakersSearch = wall;
}

export function wakersReturnSearch(): WakersSearch {
  return lastWakersSearch;
}

/**
 * The detail page's back link: `/bots` with the roster's last address. Typed as the loose
 * `LinkProps` PageShell takes, whose `search` is every route's at once; the value is exactly what
 * `/bots`'s own `validateSearch` produced.
 */
export function wakersBackLink(): LinkProps {
  return { search: lastWakersSearch, to: "/bots" } as LinkProps;
}

/**
 * 视觉对照截图与测量脚本。
 *
 *   bun tests/parity/capture.ts [--base http://127.0.0.1:3910] [--out <dir>]
 *     [--scenario data|empty|all] [--theme dark|light|all] [--only <route substring>]
 *     [--viewport 1440x900] [--concurrency 3]
 *
 * Every `/api/**` request is answered from `fixtures.ts`; nothing reaches a backend. For each
 * route × viewport × theme × scenario it writes `<out>/<scenario>/<theme>/<WxH>/<slug>.png` plus a
 * `.json` of measurements, and finally `<out>/summary.md`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { resolveFixture, SCENARIOS, type Scenario } from "./fixtures";

/* ------------------------------------------------------------------------------------------------ */
/* What to capture                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

type RouteSpec = {
  /** The address to open, relative to `--base`. */
  path: string;
  /** File name; defaults to the path turned into a slug. */
  slug?: string;
  /** One of the five routes whose capture must be clean (no page errors, no unmatched requests). */
  main?: boolean;
  /** Something to do once the page has settled, e.g. switch a tab that lives in component state. */
  prepare?: (page: Page) => Promise<void>;
};

export const ROUTES: RouteSpec[] = [
  { path: "/tasks", main: true },
  { path: "/tasks?view=lanes", slug: "tasks-lanes" },
  { path: "/reachability", main: true },
  { path: "/autonomous", main: true },
  { path: "/wakers", main: true },
  // The reference's `/management?tab=groups`; ours deep-links the same way.
  { path: "/wakers?tab=groups", slug: "wakers-groups" },
  { path: "/resources", main: true },
  // `/skills` and `/knowledge` were archived into these tabs and only redirect now.
  { path: "/resources?tab=skills", slug: "resources-skills" },
  { path: "/resources?tab=knowledge", slug: "resources-knowledge" },
  { path: "/resources?tab=wakerflows", slug: "resources-wakerflows" },
  { path: "/autonomous?view=agents", slug: "autonomous-agents" },
  { path: "/wakerflows" },
  { path: "/bot" },
  { path: "/settings" },
  { path: "/wakers/agent-analyst" },
  { path: "/wakerflows/flow-weekly" },
  { path: "/channel/new" },
  // The conversation workspace column beside a new conversation addressed to one employee.
  { path: "/channel/new?agent=agent-analyst", slug: "channel-new-analyst" },
  /*
   * The rest of the app, for the site-wide pass of the black/white/red redesign
   * (docs/design/ios-studio/IMPLEMENTATION.zh-CN.md §全站范围). Captured for review; the fixtures may
   * not answer every read these pages make, and an unmatched read shows as that page's error state.
   */
  { path: "/", slug: "home" },
  { path: "/onboarding" },
  { path: "/group/new" },
  { path: "/assemble/agent-analyst" },
  { path: "/role-templates" },
  { path: "/team-bots" },
  { path: "/pipelines" },
  { path: "/approvals" },
  { path: "/responsibilities" },
  { path: "/plans" },
  { path: "/platform" },
  { path: "/wakerflows/new" },
  { path: "/settings/passwords" },
  { path: "/settings/connected-accounts" },
  { path: "/settings/components-gallery" },
  { path: "/admin", slug: "admin" },
  { path: "/admin/people" },
  { path: "/admin/plugins" },
  { path: "/admin/skills" },
  { path: "/admin/audit" },
  { path: "/admin/credentials" },
  { path: "/admin/computers" },
  { path: "/admin/enterprise" },
  { path: "/admin/identity-providers" },
  { path: "/admin/boundaries" },
  { path: "/admin/components" },
];

export const VIEWPORTS = [
  { width: 1696, height: 783 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

type Theme = "dark" | "light";

/** The page clock is pinned here so relative times ("3 小时前") read the same in every capture. */
const FROZEN_NOW = new Date("2026-11-07T10:00:00+08:00");

const DEFAULT_OUT =
  "/tmp/claude-0/-home-user-xiongbaowork/87ff88c2-019b-516c-a0cd-6b2b65a63f7a/scratchpad/parity-shots";

/**
 * No motion, no caret, and no CopilotKit dev inspector: in a Vite dev build CopilotKit mounts its
 * `<cpk-web-inspector>` launcher over the top-right corner, which a production build never shows.
 */
const FREEZE_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" +
  "cpk-web-inspector{display:none!important}";

/* ------------------------------------------------------------------------------------------------ */
/* Arguments                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

type Options = {
  base: string;
  out: string;
  scenarios: Scenario[];
  themes: Theme[];
  only: string | undefined;
  viewports: { width: number; height: number }[];
  concurrency: number;
};

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenario = value("--scenario") ?? "all";
  const theme = value("--theme") ?? "dark";
  const viewport = value("--viewport");
  if (scenario !== "all" && !SCENARIOS.includes(scenario as Scenario)) {
    throw new Error(`--scenario must be data, empty or all (got ${scenario})`);
  }
  if (!["dark", "light", "all"].includes(theme)) {
    throw new Error(`--theme must be dark, light or all (got ${theme})`);
  }
  return {
    base: (value("--base") ?? "http://127.0.0.1:3910").replace(/\/$/, ""),
    out: value("--out") ?? DEFAULT_OUT,
    scenarios: scenario === "all" ? [...SCENARIOS] : [scenario as Scenario],
    themes: theme === "all" ? ["dark", "light"] : [theme as Theme],
    only: value("--only"),
    viewports: viewport
      ? [
          {
            width: Number(viewport.split("x")[0]),
            height: Number(viewport.split("x")[1]),
          },
        ]
      : VIEWPORTS.map((entry) => ({ ...entry })),
    concurrency: Math.max(1, Number(value("--concurrency") ?? 3)),
  };
}

export const slugOf = (route: RouteSpec) =>
  route.slug ??
  (route.path
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "") ||
    "home");

/* ------------------------------------------------------------------------------------------------ */
/* Measurements                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

type Box = {
  selector: string;
  index: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: string;
  color: string;
  backgroundColor: string;
};

type Measurements = {
  route: string;
  slug: string;
  scenario: Scenario;
  theme: Theme;
  viewport: string;
  finalUrl: string;
  pageErrors: string[];
  consoleErrors: string[];
  /** Console errors about the live socket to the (absent) API server; expected without a backend. */
  websocketErrors: string[];
  unmatchedRequests: string[];
  /** Requests to other hosts, answered locally with `{}` and never sent. */
  externalRequests: string[];
  horizontalOverflow: boolean;
  scrollWidth: number;
  innerWidth: number;
  anchors: Box[];
};

/** Runs in the page. Kept free of closures over Node values so Playwright can serialise it. */
function measureInPage(): {
  anchors: Box[];
  horizontalOverflow: boolean;
  scrollWidth: number;
  innerWidth: number;
} {
  const groups: [selector: string, limit: number][] = [
    ['[data-sidebar="sidebar"]', 1],
    ["main", 1],
    ["h1", 1],
    ['[data-sidebar="menu-button"]', 12],
    ["main button", 12],
    ["main input", 50],
  ];
  const anchors: Box[] = [];
  for (const [selector, limit] of groups) {
    let elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    // The visible copy of the sidebar: on narrow screens the desktop one is display:none.
    if (selector === '[data-sidebar="sidebar"]') {
      elements = elements.filter((element) => element.offsetParent !== null);
      if (elements.length === 0) {
        elements = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="sidebar"]'),
        );
      }
    }
    elements.slice(0, limit).forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      anchors.push({
        selector,
        index,
        text: (
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder") ??
          element.innerText ??
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        fontSize: style.fontSize,
        color: style.color,
        backgroundColor: style.backgroundColor,
      });
    });
  }
  return {
    anchors,
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* One capture                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

const isSocketNoise = (text: string) =>
  /WebSocket|ws:\/\/|wss:\/\//i.test(text);

async function newContext(
  browser: Browser,
  options: Options,
  scenario: Scenario,
  theme: Theme,
  viewport: { width: number; height: number },
  unmatched: Set<string>,
  external: Set<string>,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {}
    },
    ["openbot-theme", theme] as const,
  );
  await context.addInitScript((css: string) => {
    const inject = () => {
      const style = document.createElement("style");
      style.setAttribute("data-parity", "freeze");
      style.textContent = css;
      (document.head ?? document.documentElement).appendChild(style);
    };
    if (document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject);
  }, FREEZE_CSS);
  const origin = new URL(options.base).origin;
  /*
   * Nothing leaves the machine: a request to another host (CopilotKit's announcement feed, say) gets
   * an empty JSON object and is recorded, so a capture never depends on, or leaks to, the internet.
   */
  await context.route(
    (url) => url.origin !== origin && /^https?:$/.test(url.protocol),
    async (route) => {
      external.add(`${route.request().method()} ${route.request().url()}`);
      await route.fulfill({ status: 200, json: {} });
    },
  );
  await context.route(
    (url) => url.origin === origin && url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathWithSearch = `${url.pathname}${url.search}`;
      let body: unknown;
      try {
        body = request.postDataJSON();
      } catch {
        body = undefined;
      }
      const fixture = resolveFixture(
        request.method(),
        pathWithSearch,
        scenario,
        body,
      );
      if (!fixture) {
        unmatched.add(`${request.method()} ${pathWithSearch}`);
        await route.fulfill({
          status: 404,
          json: { error: "parity fixture missing" },
        });
        return;
      }
      if (fixture.contentType !== undefined) {
        await route.fulfill({
          status: fixture.status,
          contentType: fixture.contentType,
          body: String(fixture.body ?? ""),
        });
        return;
      }
      await route.fulfill({ status: fixture.status, json: fixture.body });
    },
  );
  return context;
}

async function captureOne(
  browser: Browser,
  options: Options,
  route: RouteSpec,
  scenario: Scenario,
  theme: Theme,
  viewport: { width: number; height: number },
): Promise<Measurements> {
  const unmatched = new Set<string>();
  const external = new Set<string>();
  const context = await newContext(
    browser,
    options,
    scenario,
    theme,
    viewport,
    unmatched,
    external,
  );
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const websocketErrors: string[] = [];
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    const text =
      location && message.text().startsWith("Failed to load resource")
        ? `${message.text()} (${location})`
        : message.text();
    (isSocketNoise(text) ? websocketErrors : consoleErrors).push(text);
  });
  await page.clock.setFixedTime(FROZEN_NOW);

  const slug = slugOf(route);
  const size = `${viewport.width}x${viewport.height}`;
  const dir = join(options.out, scenario, theme, size);
  await mkdir(dir, { recursive: true });

  try {
    await page.goto(`${options.base}${route.path}`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});
    if (route.prepare) {
      await route.prepare(page);
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => {});
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(500);
  } catch (error) {
    pageErrors.push(
      `[capture] ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await page.screenshot({
    path: join(dir, `${slug}.png`),
    animations: "disabled",
    caret: "hide",
  });
  const measured = await page.evaluate(measureInPage).catch(() => ({
    anchors: [],
    horizontalOverflow: false,
    scrollWidth: 0,
    innerWidth: viewport.width,
  }));
  const result: Measurements = {
    route: route.path,
    slug,
    scenario,
    theme,
    viewport: size,
    finalUrl: page.url(),
    pageErrors,
    consoleErrors,
    websocketErrors,
    unmatchedRequests: [...unmatched].sort(),
    externalRequests: [...external].sort(),
    ...measured,
  };
  await writeFile(
    join(dir, `${slug}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await context.close();
  return result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Summary                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const MAIN_SLUGS = new Set(
  ROUTES.filter((route) => route.main).map((route) => slugOf(route)),
);

function summarise(results: Measurements[], options: Options): string {
  const lines: string[] = [
    "# Parity capture summary",
    "",
    `- base: ${options.base}`,
    `- frozen clock: ${FROZEN_NOW.toISOString()}`,
    `- shots: ${results.length}`,
    "",
  ];
  const mainProblems = results.filter(
    (result) =>
      MAIN_SLUGS.has(result.slug) &&
      (result.pageErrors.length > 0 || result.unmatchedRequests.length > 0),
  );
  lines.push(
    mainProblems.length === 0
      ? "**Main routes clean:** no page errors and no unmatched API requests on /tasks /reachability /autonomous /wakers /resources."
      : `**Main routes with problems:** ${mainProblems.map((result) => `${result.scenario}/${result.theme}/${result.viewport}/${result.slug}`).join(", ")}`,
    "",
  );
  const allUnmatched = [
    ...new Set(results.flatMap((result) => result.unmatchedRequests)),
  ].sort();
  lines.push(
    "## Unmatched API requests (all shots)",
    "",
    ...(allUnmatched.length > 0
      ? allUnmatched.map((entry) => `- \`${entry}\``)
      : ["- (none)"]),
    "",
  );
  const groups = new Map<string, Measurements[]>();
  for (const result of results) {
    const key = `${result.scenario} / ${result.theme}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  for (const [key, rows] of groups) {
    lines.push(
      `## ${key}`,
      "",
      "| route | viewport | page errors | console errors | ws errors | unmatched | overflow |",
      "| --- | --- | ---: | ---: | ---: | --- | --- |",
    );
    for (const row of rows) {
      lines.push(
        `| ${row.slug} | ${row.viewport} | ${row.pageErrors.length} | ${row.consoleErrors.length} | ${row.websocketErrors.length} | ${row.unmatchedRequests.map((entry) => `\`${entry}\``).join("<br>") || "-"} | ${row.horizontalOverflow ? `**yes** (${row.scrollWidth}px)` : "no"} |`,
      );
    }
    lines.push("");
  }
  const errored = results.filter(
    (result) => result.pageErrors.length > 0 || result.consoleErrors.length > 0,
  );
  if (errored.length > 0) {
    lines.push("## Error details", "");
    for (const row of errored) {
      lines.push(
        `### ${row.scenario}/${row.theme}/${row.viewport}/${row.slug}`,
        "",
        ...row.pageErrors.map((entry) => `- pageerror: ${entry.slice(0, 300)}`),
        ...[...new Set(row.consoleErrors)].map(
          (entry) => `- console: ${entry.slice(0, 300)}`,
        ),
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------------------------------ */
/* Main                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const routes = options.only
    ? ROUTES.filter(
        (route) =>
          route.path.includes(options.only ?? "") ||
          slugOf(route).includes(options.only ?? ""),
      )
    : ROUTES;
  if (routes.length === 0) throw new Error(`no route matches ${options.only}`);

  const jobs: (() => Promise<Measurements>)[] = [];
  for (const scenario of options.scenarios) {
    for (const theme of options.themes) {
      for (const viewport of options.viewports) {
        for (const route of routes) {
          jobs.push(() =>
            captureOne(browser, options, route, scenario, theme, viewport),
          );
        }
      }
    }
  }

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
  });
  const results: Measurements[] = [];
  let next = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const result = await job();
      results.push(result);
      const flags = [
        result.pageErrors.length
          ? `pageerrors=${result.pageErrors.length}`
          : "",
        result.unmatchedRequests.length
          ? `unmatched=${result.unmatchedRequests.join(",")}`
          : "",
        result.horizontalOverflow ? "overflow" : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `[${results.length}/${jobs.length}] ${result.scenario}/${result.theme}/${result.viewport}/${result.slug} ${flags}`,
      );
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, jobs.length) },
        worker,
      ),
    );
  } finally {
    await browser.close();
  }

  const order = (result: Measurements) =>
    [
      options.scenarios.indexOf(result.scenario),
      options.themes.indexOf(result.theme),
      options.viewports.findIndex(
        (entry) => `${entry.width}x${entry.height}` === result.viewport,
      ),
      routes.findIndex((route) => slugOf(route) === result.slug),
    ].reduce((sum, index) => sum * 100 + index, 0);
  results.sort((left, right) => order(left) - order(right));
  await mkdir(options.out, { recursive: true });
  await writeFile(join(options.out, "summary.md"), summarise(results, options));
  console.log(
    `done: ${results.length} shots in ${Math.round((Date.now() - started) / 1000)}s -> ${options.out}`,
  );
}

if (import.meta.main) {
  await main();
}

/**
 * DoD-6：77 故事表说「已验收」，今天还站得住吗？
 *
 * 这张表自己的规则是「一个故事只有在 `main` 上有对应测试通过，才算已验收」。这句话有两个前提会
 * 悄悄失效，而失效时表上一点痕迹都没有：
 *
 * 1. **证据文件被改名或删掉**——`STORIES.md` 里还写着它，CI 也不会因为一条文档引用而红。
 * 2. **证据文件不再被任何作业跑到**——`server-test` / `app-test` 只跑各自的分片清单，文件从清单里
 *    掉了照样全绿，因为它压根没被读过。
 *
 * 2026-11-16 那次整表刷新是手工逐条核的；下一次改动不会有人再核一遍。所以这里把「核」写成四条
 * 机读判据，让它可以重跑、也可以在 `main` 上被质疑时当场复算：
 *
 * - **行数**：故事表必须 77 行。少一行是有人删了故事，不是排版。
 * - **钉住的提交**：每行验收状态里的 `main <sha>` 必须与表头「整表刷新」那句是同一个 sha，且这个
 *   sha 在本仓库里真的存在。这就是「表说核过，就真的是同一次核」。
 * - **证据在磁盘上**：每个反引号路径都得存在（按 `xiongbao/` 解析，`docs/` 打头的按仓库根解析）。
 * - **证据会被跑到**：每个路径都要能落到一个真跑它的作业上；`server/tests/*` 与 `app/tests/*` 还要
 *   在各自的分片清单里。不认识的前缀直接报错——宁可让守卫吵，也不要让一条新证据在没人跑的地方
 *   静默「已验收」。
 *
 * 数出来的行数与引用数一起打印（`--json` 给机读版）。数字本身不是判据，但「上一版说 257 条、
 * 这一版按同一规则数出 251 条」这种事，只有每次都把口径写下来才不会重复发生。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** `xiongbao/`：证据里的路径都相对它。 */
const CODE_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根：`docs/` 打头的路径相对它。 */
const REPO_ROOT = resolve(CODE_ROOT, "..");

export const STORIES_DOC = "docs/acceptance/STORIES.md";
/** 77 = 规格 §3 的 58 条 + 后续纳入的 19 条。少一条就说明有人动了故事集合。 */
export const STORY_COUNT = 77;

/** 故事编号：A1、WF9、ROLE1、AUT4…… */
const ROW_ID = /^[A-Z]{1,4}\d{1,3}$/;
/** 验收状态：`accepted (main abc1234)` / `partly accepted (main abc1234)`。 */
const STATUS_PIN = /^(?:partly )?accepted \(main ([0-9a-f]{7,40})\)$/;
/** 表头那一句：「**2026-11-16 整表刷新（`main` `af18d06e`）**」。 */
const HEADER_PIN = /整表刷新（`main` `([0-9a-f]{7,40})`）/;
const BACKTICK = /`([^`\n]+)`/g;

export interface StoryRow {
  readonly id: string;
  readonly status: string;
  /** 验收状态里钉住的提交；状态不是 accepted 形态时为 null。 */
  readonly pin: string | null;
  /** 证据列里的路径，按出现顺序、按行去重。 */
  readonly evidence: readonly string[];
}

export interface Stories {
  /** 表头「整表刷新」钉住的提交。 */
  readonly headerPin: string | null;
  readonly rows: readonly StoryRow[];
}

export type ProblemKind =
  /** 行数不是 77。 */
  | "count"
  /** 某行钉的提交与表头不一致，或状态不是可识别的形态。 */
  | "pin"
  /** 证据路径在磁盘上不存在。 */
  | "missing"
  /** 证据路径没有落到任何 CI 作业上（前缀不认识，或清单里没有）。 */
  | "uncovered";

export interface Problem {
  readonly kind: ProblemKind;
  readonly story: string | null;
  readonly detail: string;
}

/**
 * 证据里能出现的东西：路径。判据是「有斜杠、不以斜杠开头、没有空格」——`cargo test --locked`
 * 这类同一段反引号里的命令因此不会混进来，`/api/routines` 这种接口路径也不会。
 */
function looksLikePath(token: string): boolean {
  return token.includes("/") && !token.startsWith("/") && !/\s/.test(token);
}

/** 把故事表读成行。非故事表（取值、计数、门表）的第一个单元格不是编号，直接跳过。 */
export function parseStories(markdown: string): Stories {
  const rows: StoryRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    // 故事表 9 列；前 7 列之外还有 验收状态 与 备注。
    if (cells.length < 9) continue;
    const id = cells[0] ?? "";
    if (!ROW_ID.test(id)) continue;
    const evidence: string[] = [];
    for (const segment of (cells[6] ?? "").split("<br>")) {
      for (const match of segment.matchAll(BACKTICK)) {
        const token = (match[1] ?? "").trim();
        if (looksLikePath(token) && !evidence.includes(token))
          evidence.push(token);
      }
    }
    const status = cells[7] ?? "";
    rows.push({
      id,
      status,
      pin: STATUS_PIN.exec(status)?.[1] ?? null,
      evidence,
    });
  }
  return { headerPin: HEADER_PIN.exec(markdown)?.[1] ?? null, rows };
}

/** 判据要用到的仓库事实。分开传进来，测试才能在不碰磁盘的情况下构造反例。 */
export interface Facts {
  /** `workspaces-test` 矩阵里的包名，直接从 `ci.yml` 读，免得两处各写一份。 */
  readonly workspaces: ReadonlySet<string>;
  /** `scripts/ci/server-tests.list.txt`，已还原成 `server/...` 形式。 */
  readonly serverManifest: ReadonlySet<string>;
  /** `scripts/ci/app-tests.list.txt`，已还原成 `app/...` 形式。 */
  readonly appManifest: ReadonlySet<string>;
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 从仓库里读事实：两份分片清单 + `ci.yml` 的 workspaces 矩阵。 */
export function loadFacts(codeRoot: string = CODE_ROOT): Facts {
  const server = lines(join(codeRoot, "scripts/ci/server-tests.list.txt")).map(
    (p) => `server/${p}`,
  );
  const app = lines(join(codeRoot, "scripts/ci/app-tests.list.txt")).map(
    (p) => `app/${p}`,
  );
  const ci = readFileSync(
    join(codeRoot, "../.github/workflows/ci.yml"),
    "utf8",
  );
  const workspaces = new Set(
    [...ci.matchAll(/^\s*-\s*pkg:\s*([a-z0-9-]+)\s*$/gm)].map(
      (m) => m[1] ?? "",
    ),
  );
  return {
    workspaces,
    serverManifest: new Set(server),
    appManifest: new Set(app),
  };
}

/**
 * 这条证据由哪个作业跑？返回作业名；返回 null 表示「没有人跑它」——这是本守卫最想抓的那种情况。
 *
 * 每条规则都对应 `ci.yml` 里一个真实存在的 `run:`，改那边就要改这里：
 *
 * - `server/tests/*` → `server-test`，且必须在 `server-tests.list.txt`（作业只跑清单）。
 * - `app/tests/*` → `app-test`，同上。
 * - `<包>/tests/*` → `workspace tests (<包>)`，包名取自矩阵。
 * - `tests/*`（仓库根的 `xiongbao/tests`）→ `repository tests (xiongbao/tests)` 的 `bun test ./tests/`。
 * - `scripts/**\/*.test.ts` → `repository tests` 的 `bun test ./scripts/`。
 * - `scripts/ci/*.test.mjs` → `static`（显式点名那几个），也被上面那条扫到。
 * - `scripts/e2e/wakerflow-lifecycle.ts` → `e2e-wakerflow`。
 * - `scripts/ci/windows-runner-probe.ts` → `win1-windows`（WIN1 的探针，不是测试）。
 * - `desktop-device/tests/*` → `device shell tests` 的 `bun test`。
 * - `desktop-device/src-tauri/**` → `device shell tests` 的 `cargo test --locked`。
 * - `desktop-device/scripts/verify-*` → 发布校验脚本本身，由 `device-bundle-*` / `device-release.yml` 执行。
 */
export function jobFor(ref: string, facts: Facts): string | null {
  if (ref.startsWith("server/tests/")) {
    return facts.serverManifest.has(ref) ? "server-test" : null;
  }
  if (ref.startsWith("app/tests/")) {
    return facts.appManifest.has(ref) ? "app-test" : null;
  }
  // 设备端先判：它也有 `tests/` 与 `src-tauri/`，而且它的包名不是 workspace 成员。
  if (ref.startsWith("desktop-device/tests/")) return "device shell tests";
  if (
    ref === "desktop-device/src-tauri" ||
    ref.startsWith("desktop-device/src-tauri/")
  ) {
    return "device shell tests (cargo test --locked)";
  }
  if (ref.startsWith("desktop-device/scripts/verify-"))
    return "device bundle / release checks";
  const pkg = /^([a-z0-9-]+)\/tests\//.exec(ref)?.[1];
  if (pkg !== undefined) {
    return facts.workspaces.has(pkg) ? `workspace tests (${pkg})` : null;
  }
  if (ref.startsWith("tests/")) return "repository tests (xiongbao/tests)";
  // 探针不是测试：它由 `win1-windows`（WIN1 device CLI probe）跑。
  if (ref === "scripts/ci/windows-runner-probe.ts") return "win1-windows";
  if (ref.startsWith("scripts/ci/") && /\.test\.m?js$/.test(ref))
    return "static";
  if (ref.startsWith("scripts/") && /\.test\.[cm]?[jt]sx?$/.test(ref)) {
    return "repository tests (xiongbao/tests)";
  }
  if (ref === "scripts/e2e/wakerflow-lifecycle.ts") return "e2e-wakerflow";
  return null;
}

export interface CheckOptions {
  readonly markdown: string;
  readonly facts: Facts;
  /** 判断证据路径是否存在。默认按磁盘；测试用来造反例。 */
  readonly exists?: (ref: string) => boolean;
}

export interface Report {
  readonly stories: Stories;
  readonly problems: readonly Problem[];
  readonly refs: number;
  readonly files: number;
}

/** 四条判据。返回的问题按故事编号顺序，方便对着表改。 */
export function checkStories(options: CheckOptions): Report {
  const stories = parseStories(options.markdown);
  const exists =
    options.exists ?? ((ref: string) => existsSync(join(CODE_ROOT, ref)));
  const problems: Problem[] = [];

  if (stories.rows.length !== STORY_COUNT) {
    problems.push({
      kind: "count",
      story: null,
      detail: `故事表是 ${stories.rows.length} 行，应为 ${STORY_COUNT} 行：故事集合变了，验收表得跟着重核`,
    });
  }
  if (stories.headerPin === null) {
    problems.push({
      kind: "pin",
      story: null,
      detail:
        "表头没有「整表刷新（`main` `<sha>`）」这一句：不知道这版表核的是哪次提交",
    });
  }

  const all = new Set<string>();
  for (const row of stories.rows) {
    if (row.pin === null) {
      problems.push({
        kind: "pin",
        story: row.id,
        detail: `验收状态「${row.status}」不是 accepted / partly accepted (main <sha>) 的形态`,
      });
    } else if (stories.headerPin !== null && row.pin !== stories.headerPin) {
      problems.push({
        kind: "pin",
        story: row.id,
        detail: `钉住 ${row.pin}，表头钉住 ${stories.headerPin}：两处说的不是同一次核`,
      });
    }
    if (row.evidence.length === 0) {
      problems.push({
        kind: "missing",
        story: row.id,
        detail: "证据列里没有一条路径",
      });
    }
    for (const ref of row.evidence) {
      all.add(ref);
      if (!exists(ref)) {
        problems.push({
          kind: "missing",
          story: row.id,
          detail: `${ref} 不存在`,
        });
        continue;
      }
      if (jobFor(ref, options.facts) === null) {
        problems.push({
          kind: "uncovered",
          story: row.id,
          detail: `${ref} 没有落到任何 CI 作业上（不在分片清单里，或前缀不认识）`,
        });
      }
    }
  }

  return { stories, problems, refs: countRefs(stories), files: all.size };
}

function countRefs(stories: Stories): number {
  return stories.rows.reduce((n, row) => n + row.evidence.length, 0);
}

function main(argv: readonly string[]): void {
  const markdown = readFileSync(join(REPO_ROOT, STORIES_DOC), "utf8");
  const report = checkStories({ markdown, facts: loadFacts() });
  const json = argv.includes("--json");

  if (json) {
    console.log(
      JSON.stringify(
        {
          rows: report.stories.rows.length,
          headerPin: report.stories.headerPin,
          refs: report.refs,
          files: report.files,
          problems: report.problems,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `故事表 ${report.stories.rows.length} 行 / 证据引用 ${report.refs} 条 / 不同文件 ${report.files} 个 / 钉住 ${report.stories.headerPin ?? "（缺）"}`,
    );
    for (const p of report.problems) {
      console.log(`  ${p.story ?? "表"}：${p.detail}`);
    }
  }

  if (report.problems.length > 0) {
    // 先打印注解再退出：Bun 会把 `error:` 前缀和栈塞进同一行，注解会被截断。
    for (const p of report.problems) {
      console.log(
        `::error file=${STORIES_DOC},line=1,title=${p.story ?? "故事表"} 的证据站不住::${p.detail}`,
      );
    }
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));

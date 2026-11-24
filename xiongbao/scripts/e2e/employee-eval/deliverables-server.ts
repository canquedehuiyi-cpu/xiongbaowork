/**
 * 交付题的服务器侧判分：员工交出来的东西，人从服务器上拿得到、打得开吗。
 *
 * 本地判分（`check-deliverables.ts`）只看员工目录里的文件；这里请求的是人真正会走的路：
 *  - 下载：`files/download` 要 200、是 `attachment`、字节数等于电脑上的那份；
 *  - 预览：`files/preview` 要 200 且带 `nosniff`；pptx / docx / xlsx 靠电脑把文件转成 PDF，答 `{ unavailable: true }`
 *    说明预览不可用，算失败（人在聊天里点开看到的是「不能预览」）；
 *  - 网页、本机程序：`POST /api/computers/:botId/open` 拿到链接，换内容源的 cookie，首页要 200，再用 Chromium
 *    真的操作一遍（网页点按钮看文字变；程序新增一条待办、再读得到、删掉后读不到）。
 *
 * 全部走 HTTP，不碰数据库；起服务器、起电脑、拿到哪个运行的产物由调用方（`run-xiongbao.ts`）负责。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DelivItem } from "./check-deliverables";
import { type Check, check, type DELIVERABLES_SUITE } from "./lib";

type Task = (typeof DELIVERABLES_SUITE)[number];

/** 调用方才知道、请求里没有的几样：电脑上的字节数、程序的端口和落地路径。 */
export type ServerCheckExtras = {
  /** 工作区相对路径 → 电脑上这个文件的字节数；读不到返回 undefined。 */
  localBytes?: (file: string) => number | undefined;
  /** 交付里写的程序端口（deliv-app 用）。 */
  appPort?: number;
  /** 程序的落地路径，默认 `/`。 */
  appPath?: string;
  /** 打开程序用的运行（列出该端口交付的那一轮）；缺省同文件的运行。 */
  appRunId?: string;
};

const OFFICE_TASKS: readonly Task[] = [
  "deliv-pptx",
  "deliv-docx",
  "deliv-xlsx",
];

/** 一次请求一个 URL；网络错误返回 null，让判分项写「请求失败」而不是整个脚本崩掉。 */
async function fetchOrNull(
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch {
    return null;
  }
}

function scopedUrl(
  base: string,
  botId: string,
  route: "download" | "preview",
  file: string,
  scope: { channelId: string; runId: string },
): string {
  const query = new URLSearchParams({
    path: file,
    channel: scope.channelId,
    run: scope.runId,
  });
  return `${base}/api/computers/${encodeURIComponent(botId)}/files/${route}?${query}`;
}

async function downloadCheck(
  headers: Record<string, string>,
  url: string,
  file: string,
  extras: ServerCheckExtras,
): Promise<Check> {
  const name = `下载 ${file}`;
  const response = await fetchOrNull(url, { headers });
  if (!response) return check(name, false, "请求失败");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const disposition = response.headers.get("content-disposition") ?? "";
  const expected = extras.localBytes?.(file);
  const lengthHeader = response.headers.get("content-length");
  const declared = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  const flaws = [
    ...(response.status === 200 ? [] : [`状态 ${response.status}`]),
    ...(/^attachment\b/i.test(disposition)
      ? []
      : [`Content-Disposition 不是 attachment（${disposition || "无"}）`]),
    // 电脑上的字节数拿得到就对它；拿不到时至少要头里写的长度和实际收到的一致。
    ...(expected !== undefined
      ? bytes.length === expected
        ? []
        : [`下载 ${bytes.length} 字节，电脑上是 ${expected} 字节`]
      : lengthHeader === null || !Number.isFinite(declared)
        ? [] // 没有电脑上的字节数、响应也没带长度：没有可对的，跳过并在 detail 里写明
        : declared === bytes.length
          ? []
          : [`Content-Length ${declared} 与收到的 ${bytes.length} 字节不一致`]),
  ];
  return check(
    name,
    flaws.length === 0,
    flaws.length
      ? flaws.join("；")
      : `200，attachment，${bytes.length} 字节${expected !== undefined ? "" : lengthHeader === null ? "（没有电脑上的字节数，响应也没带 Content-Length，跳过字节数核对）" : "（没有电脑上的字节数，只核对了长度头）"}`,
  );
}

async function previewCheck(
  headers: Record<string, string>,
  url: string,
  file: string,
  task: Task,
): Promise<Check> {
  const name = `预览 ${file}`;
  const response = await fetchOrNull(url, { headers });
  if (!response) return check(name, false, "请求失败");
  const type = response.headers.get("content-type") ?? "";
  const nosniff =
    (response.headers.get("x-content-type-options") ?? "").toLowerCase() ===
    "nosniff";
  // 办公文件转不出 PDF 时服务器答 200 和 `{ unavailable: true }`：状态码对，但人看到的是「不能预览」。
  if (type.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as {
      unavailable?: unknown;
    } | null;
    if (body?.unavailable === true)
      return check(
        name,
        false,
        OFFICE_TASKS.includes(task)
          ? "预览不可用（unavailable：电脑没能把它转成 PDF）"
          : "预览不可用（unavailable）",
      );
  }
  await response.arrayBuffer().catch(() => undefined);
  const flaws = [
    ...(response.status === 200 ? [] : [`状态 ${response.status}`]),
    ...(nosniff ? [] : ["没有 X-Content-Type-Options: nosniff"]),
  ];
  return check(
    name,
    flaws.length === 0,
    flaws.length ? flaws.join("；") : `200，nosniff，${type}`,
  );
}

type Opened = { url: string } | { error: string };

async function openContent(
  base: string,
  headers: Record<string, string>,
  botId: string,
  body: Record<string, unknown>,
): Promise<Opened> {
  const response = await fetchOrNull(
    `${base}/api/computers/${encodeURIComponent(botId)}/open`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response) return { error: "请求失败" };
  const answer = (await response.json().catch(() => null)) as {
    url?: unknown;
    available?: unknown;
    reason?: unknown;
    error?: unknown;
  } | null;
  if (response.status === 200 && typeof answer?.url === "string")
    return { url: answer.url };
  return {
    error:
      answer?.available === false
        ? `内容源没有配置：${String(answer.reason ?? "")}`
        : `状态 ${response.status}${answer?.error ? `：${String(answer.error)}` : ""}`,
  };
}

/** 链接换 cookie：`/__open/<令牌>` 答 302 并种下 xb_content，带着 cookie 跟到首页，看最后是不是 200。 */
async function landingStatus(
  url: string,
): Promise<{ status: number; detail: string }> {
  let current = url;
  let cookie = "";
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetchOrNull(current, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
    if (!response) return { status: 0, detail: "请求失败" };
    const set = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .filter(Boolean);
    if (set.length) cookie = set.join("; ");
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    await response.arrayBuffer().catch(() => undefined);
    return {
      status: response.status,
      detail: `${new URL(current).pathname}${cookie ? "，已拿到 cookie" : "，没有 cookie"}`,
    };
  }
  return { status: 0, detail: "重定向太多" };
}

async function landingChecks(label: string, opened: Opened): Promise<Check[]> {
  if ("error" in opened)
    return [check(`${label}：打开链接`, false, opened.error)];
  const landed = await landingStatus(opened.url);
  return [
    check(`${label}：打开链接`, true, "拿到内容源链接"),
    check(
      `${label}：首页 200`,
      landed.status === 200,
      `状态 ${landed.status}，${landed.detail}`,
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// 浏览器交互
// ---------------------------------------------------------------------------------------------

type Browser = import("playwright-core").Browser;

/** 评测机上预装的 Chromium 没装在 playwright 默认的位置：环境变量优先，再找几处常见位置。 */
export function chromePath(): string | undefined {
  const fromEnv = process.env.E2E_CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;
  const roots = ["/opt/pw-browsers"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort().reverse()) {
      if (!entry.startsWith("chromium-")) continue;
      const exe = join(root, entry, "chrome-linux64", "chrome");
      if (existsSync(exe)) return exe;
    }
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) =>
    existsSync(path),
  );
}

/** 起一个无头 Chromium；起不来返回原因，调用方把它写进判分项或跳过用例。 */
export async function launchChromium(): Promise<
  { browser: Browser } | { reason: string }
> {
  try {
    const { chromium } = await import("playwright-core");
    const options = {
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    };
    const executablePath = chromePath();
    // 设了 PLAYWRIGHT_BROWSERS_PATH（工作流装在 /opt/ms-playwright）时先让 playwright 按自己的版本找，不传路径；
    // 找不到再用 chromePath 找到的那个（版本对不上时不至于起不来）。
    const browser = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
      ? await chromium.launch(options).catch((error) => {
          if (!executablePath) throw error;
          return chromium.launch({ ...options, executablePath });
        })
      : await chromium.launch({
          ...options,
          ...(executablePath ? { executablePath } : {}),
        });
    return { browser };
  } catch (error) {
    return {
      reason: `起不来 Chromium：${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
    };
  }
}

/** 这台机器上有没有能用的 Chromium（测试据此跳过浏览器用例并说明原因）。 */
export async function chromiumAvailable(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const launched = await launchChromium();
  if ("reason" in launched) return { ok: false, reason: launched.reason };
  await launched.browser.close();
  return { ok: true };
}

async function inBrowser(
  work: (browser: Browser) => Promise<Check[]>,
  names: string[],
): Promise<Check[]> {
  const launched = await launchChromium();
  if ("reason" in launched)
    return names.map((name) => check(name, false, launched.reason));
  try {
    return await work(launched.browser);
  } catch (error) {
    const reason = (
      error instanceof Error ? error.message : String(error)
    ).split("\n")[0];
    return names.map((name) => check(name, false, `浏览器操作出错：${reason}`));
  } finally {
    await launched.browser.close().catch(() => undefined);
  }
}

const WEB_CLICK = "网页：点按钮后页面文字变化";

/** 网页：打开页面，点第一个按钮，页面可见文字要变。 */
async function webInteraction(opened: Opened): Promise<Check[]> {
  if ("error" in opened)
    return [check(WEB_CLICK, false, "没拿到链接，没法在浏览器里打开")];
  const { url } = opened;
  return inBrowser(
    async (browser) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        // 题面要求的按钮是「推荐一杯」；员工换了文字时退回页面上第一个按钮。
        const named = page.getByRole("button", { name: "推荐一杯" });
        const buttons =
          (await named.count()) > 0 ? named : page.locator("button");
        if ((await buttons.count()) === 0)
          return [check(WEB_CLICK, false, "页面上没有 <button>")];
        const before = await page.evaluate(() => document.body.innerText);
        await buttons.first().click({ timeout: 10_000 });
        const changed = await page
          .waitForFunction((text) => document.body.innerText !== text, before, {
            timeout: 5_000,
          })
          .then(() => true)
          .catch(() => false);
        return [
          check(
            WEB_CLICK,
            changed,
            changed ? "点击后页面文字变了" : "点击后页面文字没有变化",
          ),
        ];
      } finally {
        await context.close();
      }
    },
    [WEB_CLICK],
  );
}

const APP_ADD = "程序：新增一条待办后列表读得到";
const APP_DELETE = "程序：删除后列表读不到";

/** 待办程序的接口（题面 `deliv-app/TASK.md` 约定）：`/api/todos`，GET 列表、POST 新增、DELETE `/api/todos/<id>`。 */
export const APP_TODOS_PATH = "/api/todos";

type Todo = { id?: unknown; text?: unknown };

const todosIn = (body: unknown): Todo[] => {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { todos?: unknown } | null)?.todos)
      ? (body as { todos: unknown[] }).todos
      : [];
  return list.filter((item): item is Todo => typeof item === "object");
};

async function appInteraction(opened: Opened): Promise<Check[]> {
  if ("error" in opened)
    return [
      check(APP_ADD, false, "没拿到链接，没法在浏览器里打开"),
      check(APP_DELETE, false, "没拿到链接，没法在浏览器里打开"),
    ];
  const { url } = opened;
  return inBrowser(
    async (browser) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        // 先在浏览器里打开首页：内容源的 cookie 由它种下，随后的接口请求共用这个上下文的 cookie。
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        const origin = new URL(page.url()).origin;
        const api = context.request;
        const text = `评测待办-${Math.random().toString(36).slice(2, 8)}`;
        const read = async () => {
          const response = await api.get(`${origin}${APP_TODOS_PATH}`);
          return {
            status: response.status(),
            todos: todosIn(await response.json().catch(() => null)),
          };
        };
        const added = await api.post(`${origin}${APP_TODOS_PATH}`, {
          data: { text },
        });
        const addedBody = (await added.json().catch(() => null)) as Todo | null;
        const afterAdd = await read();
        const mine = afterAdd.todos.find((todo) => todo.text === text);
        const addOk =
          added.ok() && afterAdd.status === 200 && mine !== undefined;
        const checks = [
          check(
            APP_ADD,
            addOk,
            addOk
              ? `POST ${added.status()}，GET 读到「${text}」`
              : `POST ${added.status()}，GET ${afterAdd.status}，列表里${mine ? "有" : "没有"}「${text}」`,
          ),
        ];
        const id = mine?.id ?? addedBody?.id;
        if (!addOk || id === undefined || id === null) {
          checks.push(
            check(APP_DELETE, false, "新增没成功或拿不到这条待办的 id，没法删"),
          );
          return checks;
        }
        const removed = await api.delete(
          `${origin}${APP_TODOS_PATH}/${encodeURIComponent(String(id))}`,
        );
        const afterDelete = await read();
        const gone = !afterDelete.todos.some((todo) => todo.text === text);
        const deleteOk = removed.ok() && afterDelete.status === 200 && gone;
        checks.push(
          check(
            APP_DELETE,
            deleteOk,
            deleteOk
              ? `DELETE ${removed.status()}，GET 读不到了`
              : `DELETE ${removed.status()}，GET ${afterDelete.status}，列表里${gone ? "没有" : "还有"}这条`,
          ),
        );
        return checks;
      } finally {
        await context.close();
      }
    },
    [APP_ADD, APP_DELETE],
  );
}

// ---------------------------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------------------------

type RunEvent = Record<string, unknown> & { type?: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const portsOf = (list: unknown): number[] =>
  Array.isArray(list)
    ? list.flatMap((item) =>
        isObject(item) && Number.isInteger(item.port)
          ? [item.port as number]
          : [],
      )
    : [];

/** 一个 `delivery.delivered` 事件里列出的程序端口（`deliverable.apps` 或 `apps`）。 */
function deliveredPorts(event: RunEvent): number[] {
  if (event.type !== "CUSTOM" || event.name !== "delivery.delivered") return [];
  const value = event.value;
  if (!isObject(value)) return [];
  return [
    ...portsOf(isObject(value.deliverable) ? value.deliverable.apps : []),
    ...portsOf(value.apps),
  ];
}

/**
 * 员工这几轮交付了什么（判分用得到的字段）：服务器的 `delivery.delivered` 事件里列的程序，加上 `deliver_task`
 * 调用的 `items`（没有任务卡时服务器不发事件，调用参数里仍写着端口）。
 */
export function deliveriesOf(
  events: readonly RunEvent[],
  calls: readonly { name: string; args: string }[],
): DelivItem[] {
  const found: DelivItem[] = events.flatMap((event) =>
    deliveredPorts(event).map((port) => ({ kind: "app", port })),
  );
  for (const call of calls) {
    if (!call.name.endsWith("deliver_task")) continue;
    let args: unknown;
    try {
      args = JSON.parse(call.args);
    } catch {
      continue;
    }
    const items = isObject(args) && Array.isArray(args.items) ? args.items : [];
    for (const item of items) {
      if (!isObject(item) || typeof item.kind !== "string") continue;
      found.push({
        kind: item.kind,
        ...(typeof item.port === "number" ? { port: item.port } : {}),
      });
    }
  }
  return found;
}

/**
 * 下载路由认的是「列出这个文件的那条事件所在的运行」：多轮（追过「继续」）时文件只出现在写下它的那一轮。
 * 取最后一个在 `computer.turn_artifacts` 里列出任一产物的运行；都没有就取最后一轮。
 */
export function runListing(
  runs: readonly { runId: string; events: readonly RunEvent[] }[],
  input: { files: readonly string[] },
): string | undefined {
  const lists = (events: readonly RunEvent[]) =>
    events.some((event) => {
      if (event.type !== "CUSTOM" || event.name !== "computer.turn_artifacts")
        return false;
      const files = isObject(event.value) ? event.value.files : undefined;
      return (
        Array.isArray(files) &&
        files.some(
          (file) =>
            isObject(file) &&
            typeof file.path === "string" &&
            input.files.some(
              (wanted) =>
                file.path === wanted ||
                (file.path as string).endsWith(`/${wanted}`) ||
                wanted.endsWith(`/${file.path as string}`),
            ),
        )
      );
    });
  const listed = runs.filter((run) => lists(run.events)).at(-1);
  return (listed ?? runs.at(-1))?.runId;
}

/** 服务器侧检查失败、而且运行里一条 `computer.turn_artifacts` 都没有时，失败详情里加的这一句。 */
export const NO_TURN_ARTIFACTS_NOTE = "服务器没记到这一轮的产物（没放行）";
/** 没放行、且这题运行里有 RUN_ERROR：模型慢被停、段数到顶等收尾，和「轮正常结束却没放行」分开。 */
export const ENDED_IN_ERROR_NOTE = "这一轮以出错/被停收尾";

/**
 * 区分「服务器没放行」和「电脑上没文件」：失败的检查，在这一题所有运行都没有 `computer.turn_artifacts`
 * 事件时，详情末尾注明服务器没记到产物；这题的运行里还有 `RUN_ERROR`（被停、段数到顶、模型报错）时再注明
 * 这一轮以出错/被停收尾，带上错误原文前几个字，把「模型慢被停」和「轮正常结束却没放行」分开。
 * 只改失败项的文字，不改任何一项的通过与否。
 */
export function noteMissingRelease(
  checks: readonly Check[],
  runs: readonly { events: readonly RunEvent[] }[],
): Check[] {
  const recorded = runs.some((run) =>
    run.events.some(
      (event) =>
        event.type === "CUSTOM" && event.name === "computer.turn_artifacts",
    ),
  );
  if (recorded) return [...checks];
  const errors = runs.flatMap((run) =>
    run.events.flatMap((event) =>
      event.type === "RUN_ERROR"
        ? [typeof event.message === "string" ? event.message : ""]
        : [],
    ),
  );
  const first = errors.find((message) => message !== "")?.slice(0, 80);
  const note =
    errors.length === 0
      ? NO_TURN_ARTIFACTS_NOTE
      : `${NO_TURN_ARTIFACTS_NOTE}；${ENDED_IN_ERROR_NOTE}${first ? `：${first}` : ""}`;
  return checks.map((item) =>
    item.ok
      ? item
      : {
          ...item,
          detail: item.detail ? `${item.detail}；${note}` : note,
        },
  );
}

/**
 * 程序的内容源范围认的是列出该端口的交付事件所在的运行，和文件所在的运行可以不是同一轮（`index.html` 写在第一轮，
 * 交付在后面）。取最后一个列出该端口的运行；没有交付事件（没有任务卡时服务器不发）就取最后一轮。
 */
export function runDelivering(
  runs: readonly { runId: string; events: readonly RunEvent[] }[],
  port: number,
): string | undefined {
  const delivered = runs
    .filter((run) => run.events.some((e) => deliveredPorts(e).includes(port)))
    .at(-1);
  return (delivered ?? runs.at(-1))?.runId;
}

const dirOf = (file: string) => file.split("/").slice(0, -1).join("/");

/**
 * 一道交付题的服务器侧判分。`files` 是产物在员工工作区里的相对路径；`base` 是服务器地址，`cookie` 是本人的会话
 * cookie；`channelId` + `runId` 是下载路由认的范围（列出这些文件的那个运行）。
 */
export async function serverChecks(
  i: {
    base: string;
    cookie: string;
    botId: string;
    channelId: string;
    runId: string;
    task: Task;
    files: string[];
  },
  extras: ServerCheckExtras = {},
): Promise<Check[]> {
  const headers = { cookie: i.cookie, origin: i.base };
  const scope = { channelId: i.channelId, runId: i.runId };
  const checks: Check[] = [];
  for (const file of i.files) {
    checks.push(
      await downloadCheck(
        headers,
        scopedUrl(i.base, i.botId, "download", file, scope),
        file,
        extras,
      ),
      await previewCheck(
        headers,
        scopedUrl(i.base, i.botId, "preview", file, scope),
        file,
        i.task,
      ),
    );
  }
  const first = i.files[0];
  if (i.task === "deliv-web" && first) {
    const opened = await openContent(i.base, headers, i.botId, {
      kind: "dir",
      path: dirOf(first),
      channel: i.channelId,
      run: i.runId,
    });
    checks.push(
      ...(await landingChecks("网页", opened)),
      ...(await webInteraction(opened)),
    );
  }
  if (i.task === "deliv-app") {
    if (extras.appPort === undefined) {
      checks.push(
        check("程序：打开链接", false, "交付里没有端口，没法请求内容源"),
      );
    } else {
      const opened = await openContent(i.base, headers, i.botId, {
        kind: "app",
        port: extras.appPort,
        path: extras.appPath ?? "/",
        channel: i.channelId,
        run: extras.appRunId ?? i.runId,
      });
      checks.push(
        ...(await landingChecks("程序", opened)),
        ...(await appInteraction(opened)),
      );
    }
  }
  return checks;
}

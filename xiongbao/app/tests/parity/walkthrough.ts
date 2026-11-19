/**
 * The redesign's interaction walk-through (docs/design/ios-studio/IMPLEMENTATION.zh-CN.md §验证与交付 4),
 * run against the Vite dev server with every `/api` read answered from the parity fixtures.
 *
 *   bun tests/parity/walkthrough.ts [--base http://127.0.0.1:3910] [--out <dir>]
 *
 * Each step drives the real page — sidebar navigation, filters and clearing them, list/lanes, tabs,
 * dialogs and sheets, a write that the page has to send — and records what changed: the URL, what is
 * on screen, and the writes (method, path, body) the page issued. Writes are answered by the fixtures
 * where one exists and with a 404 otherwise; either way the request itself is the evidence that the
 * control is wired. This is a simulated walk-through on sample data, not a run against a server.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";
import { newContext } from "./capture";

type Step = {
  name: string;
  ok: boolean;
  detail: string;
  writes: string[];
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const base = (flag("--base") ?? "http://127.0.0.1:3910").replace(/\/$/, "");
const out =
  flag("--out") ??
  "/tmp/claude-0/-home-user-xiongbaowork/87ff88c2-019b-516c-a0cd-6b2b65a63f7a/scratchpad/walkthrough";

const steps: Step[] = [];

async function open(browser: Browser, path: string) {
  const context = await newContext(
    browser,
    { base } as never,
    "data",
    "dark",
    { width: 1440, height: 900 },
    new Set(),
    new Set(),
  );
  const page = await context.newPage();
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    // The component catalogue sync happens on every page and is not a control's write.
    if (
      url.pathname.startsWith("/api/") &&
      request.method() !== "GET" &&
      url.pathname !== "/api/components/catalogue"
    ) {
      writes.push(
        `${request.method()} ${url.pathname}${url.search} ${(request.postData() ?? "").slice(0, 160)}`.trim(),
      );
    }
  });
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  return { page, writes, close: () => context.close() };
}

async function step(
  browser: Browser,
  name: string,
  path: string,
  run: (page: Page) => Promise<string>,
) {
  const session = await open(browser, path);
  try {
    const detail = await run(session.page);
    await session.page.screenshot({
      path: join(out, `${String(steps.length + 1).padStart(2, "0")}.png`),
    });
    steps.push({ name, ok: true, detail, writes: [...session.writes] });
  } catch (error) {
    steps.push({
      name,
      ok: false,
      detail:
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "")
          : String(error),
      writes: [...session.writes],
    });
  } finally {
    await session.close();
  }
}

/** The values of a native select's options, in order. */
function optionValues(select: Locator): Promise<string[]> {
  return select
    .locator("option")
    .evaluateAll((options: Element[]) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
}

const pathOf = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

async function main() {
  await mkdir(out, { recursive: true });
  // The same browser the capture harness drives (playwright-core ships none of its own).
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
  });

  await step(browser, "侧栏导航到五个核心页面", "/tasks", async (page) => {
    const nav = page.getByRole("navigation", { name: "主导航" });
    const seen: string[] = [];
    for (const [label, heading] of [
      ["@Waker", null],
      ["自主工作", "自主工作"],
      ["员工管理", "员工管理"],
      ["能力与资源", "能力与资源"],
      ["任务看板", "任务看板"],
    ] as const) {
      await nav.getByRole("link", { name: label }).click();
      await page.waitForLoadState("networkidle");
      if (heading) {
        await page.getByRole("heading", { level: 1, name: heading }).waitFor();
      }
      const current = await nav
        .locator('[aria-current="page"]')
        .first()
        .textContent();
      seen.push(`${label}→${pathOf(page)}（选中：${current?.trim()}）`);
    }
    return seen.join("；");
  });

  await step(
    browser,
    "任务看板：指标点选筛选与取消",
    "/tasks",
    async (page) => {
      const metric = page.getByRole("button", { name: /需要操作/ }).first();
      await metric.click();
      const after = pathOf(page);
      const pressed = await metric.getAttribute("aria-pressed");
      await metric.click();
      return `点选后 ${after}（aria-pressed=${pressed}），再点 ${pathOf(page)}`;
    },
  );

  await step(browser, "任务看板：列表与泳道切换", "/tasks", async (page) => {
    await page.getByRole("tab", { name: /泳道/ }).click();
    await page.waitForLoadState("networkidle");
    const lanes = pathOf(page);
    await page.getByRole("tab", { name: /列表/ }).click();
    return `泳道 ${lanes}，回到列表 ${pathOf(page)}`;
  });

  await step(browser, "任务看板：筛选与清空", "/tasks", async (page) => {
    const status = page.getByRole("combobox", { name: "任务状态" });
    const values = await optionValues(status);
    const pick =
      values.find((value: string) => value && value !== "all") ?? values[1];
    await status.selectOption(pick ?? "");
    const filtered = pathOf(page);
    await status.selectOption(values[0] ?? "");
    return `选 ${pick} 后 ${filtered}，清空后 ${pathOf(page)}`;
  });

  await step(
    browser,
    "任务看板：需要操作与查收结果页签",
    "/tasks",
    async (page) => {
      await page.getByRole("tab", { name: /查收结果/ }).click();
      const review = pathOf(page);
      await page.getByRole("tab", { name: /需要操作/ }).click();
      return `查收结果 ${review}，需要操作 ${pathOf(page)}`;
    },
  );

  await step(
    browser,
    "任务看板：批准一条待批准任务（写入）",
    "/tasks",
    async (page) => {
      await page.getByRole("button", { name: "批准" }).first().click();
      await page.waitForTimeout(800);
      return "已点击「批准」";
    },
  );

  await step(browser, "任务看板：查看任务详情", "/tasks", async (page) => {
    const link = page.getByRole("link", { name: /查看详情/ }).first();
    const href = await link.getAttribute("href");
    await link.click();
    await page.waitForLoadState("networkidle");
    return `「查看详情」指向 ${href}，到达 ${pathOf(page)}`;
  });

  await step(
    browser,
    "员工管理：员工与群组页签、角色模板入口",
    "/wakers",
    async (page) => {
      const main = page.locator("main");
      await main.getByRole("tab", { name: /群组/ }).click();
      const groups = pathOf(page);
      await main.getByRole("tab", { name: /员工/ }).click();
      const employees = pathOf(page);
      await main.getByText("角色模板", { exact: true }).click();
      await page.waitForLoadState("networkidle");
      return `群组 ${groups}，员工 ${employees}，角色模板到达 ${pathOf(page)}`;
    },
  );

  await step(browser, "员工管理：新建员工入口", "/wakers", async (page) => {
    await page
      .getByRole("link", { name: /新建员工/ })
      .first()
      .click();
    await page.waitForLoadState("networkidle");
    const dialog = await page.getByRole("dialog").count();
    return `到达 ${pathOf(page)}，打开的对话框 ${dialog} 个`;
  });

  await step(browser, "员工管理：员工详情", "/wakers", async (page) => {
    await page
      .locator("main [data-testid=waker-card]")
      .filter({ hasText: "数据分析员" })
      .getByRole("link")
      .first()
      .click();
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { level: 1, name: "数据分析员" }).waitFor();
    const crumb = await page
      .getByRole("navigation", { name: "当前位置" })
      .textContent();
    return `到达 ${pathOf(page)}，面包屑「${crumb}」`;
  });

  await step(
    browser,
    "@Waker：接入 IM 聊天弹层开关与焦点回归",
    "/reachability",
    async (page) => {
      const trigger = page
        .getByRole("button", { name: /接入 IM 聊天/ })
        .first();
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const title = await dialog.getByRole("heading").first().textContent();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      const focused = await page.evaluate(
        () => document.activeElement?.textContent?.trim() ?? "",
      );
      return `打开「${title}」，Esc 关闭，焦点回到「${focused}」`;
    },
  );

  await step(
    browser,
    "@Waker：列表与卡片切换",
    "/reachability",
    async (page) => {
      await page.getByRole("tab", { name: /卡片/ }).click();
      const cards = pathOf(page);
      await page.getByRole("tab", { name: /列表/ }).click();
      return `卡片 ${cards}，列表 ${pathOf(page)}`;
    },
  );

  await step(
    browser,
    "自主工作：新建自动任务表单",
    "/autonomous",
    async (page) => {
      await page
        .getByRole("button", { name: /新建自动任务/ })
        .first()
        .click();
      await page.waitForTimeout(400);
      const fields = await page
        .locator("form input, form select, form textarea")
        .count();
      return `创建面板已打开，表单控件 ${fields} 个`;
    },
  );

  await step(
    browser,
    "自主工作：启停开关（写入）",
    "/autonomous",
    async (page) => {
      const toggle = page.getByRole("switch").first();
      const before = await toggle.getAttribute("aria-checked");
      await toggle.click();
      await page.waitForTimeout(800);
      return `开关原为 ${before}，已点击`;
    },
  );

  await step(
    browser,
    "自主工作：触发类型筛选与按员工查看",
    "/autonomous",
    async (page) => {
      const kind = page.getByRole("combobox", { name: "触发类型" });
      const values = await optionValues(kind);
      await kind.selectOption(values[1] ?? "");
      const filtered = pathOf(page);
      await kind.selectOption(values[0] ?? "");
      await page.getByRole("link", { name: /按员工查看/ }).click();
      await page.waitForLoadState("networkidle");
      return `筛选 ${filtered}，清空后再进按员工 ${pathOf(page)}`;
    },
  );

  await step(
    browser,
    "能力与资源：入口切换与插件详情",
    "/resources",
    async (page) => {
      await page.getByRole("tab", { name: /技能/ }).first().click();
      const skills = pathOf(page);
      await page.getByRole("tab", { name: /插件/ }).first().click();
      await page.getByRole("button", { name: /详情/ }).first().click();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      const text = (await sheet.textContent())?.slice(0, 60);
      await page.keyboard.press("Escape");
      return `技能 ${skills}；插件详情「${text}…」，Esc 关闭`;
    },
  );

  await step(
    browser,
    "能力与资源：插件分类与我的插件",
    "/resources",
    async (page) => {
      await page
        .getByRole("button", { name: /个人账号/ })
        .first()
        .click();
      const category = pathOf(page);
      await page.getByRole("tab", { name: /我的插件/ }).click();
      return `分类 ${category}，我的插件 ${pathOf(page)}`;
    },
  );

  await step(browser, "设置：深浅主题切换", "/settings", async (page) => {
    const before = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    await page.getByRole("switch").first().click();
    const after = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    return `dark 类：${before} → ${after}`;
  });

  await step(
    browser,
    "键盘：Tab 焦点可见与分段控件方向键",
    "/wakers",
    async (page) => {
      const tab = page.locator("main").getByRole("tab", { name: /员工/ });
      await tab.focus();
      await page.keyboard.press("ArrowRight");
      const focusedName = await page.evaluate(
        () => document.activeElement?.textContent?.trim() ?? "",
      );
      const outline = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return "";
        const style = getComputedStyle(element);
        // Tailwind composes the ring last in box-shadow; report whether a visible ring is drawn.
        const ring = style.boxShadow
          .split(/,(?![^(]*\))/)
          .map((part) => part.trim())
          .find(
            (part) => !part.startsWith("rgba(0, 0, 0, 0)") && part !== "none",
          );
        return ring
          ? `焦点环 ${ring}`
          : `无焦点环（outline ${style.outlineStyle}）`;
      });
      return `方向键后焦点在「${focusedName}」，${pathOf(page)}；焦点样式 ${outline}`;
    },
  );

  await browser.close();

  const report = steps
    .map(
      (entry, index) =>
        `${String(index + 1).padStart(2, "0")} ${entry.ok ? "✓" : "✗"} ${entry.name}\n   ${entry.detail}${
          entry.writes.length ? `\n   写请求：${entry.writes.join(" | ")}` : ""
        }`,
    )
    .join("\n");
  await writeFile(join(out, "report.txt"), `${report}\n`);
  await writeFile(join(out, "report.json"), JSON.stringify(steps, null, 2));
  console.log(report);
  if (steps.some((entry) => !entry.ok)) process.exitCode = 1;
}

await main();

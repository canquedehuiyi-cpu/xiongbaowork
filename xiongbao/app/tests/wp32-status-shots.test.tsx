import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * 状态行实时耗时的截图取证（WP-3.2 S1a，规格 §8.3）＋终态行的截图取证（WP-3.2 S1b，设计稿 §2.8）：
 * 真 Chromium 里画真组件，暗色＋2 倍像素，每个画面各存一张图，供负责人按既定授权核对界面后才合并。
 * S1a 五张（model／tool／answer／typing／observed）原样不动；S1b 追加五张
 * （turn-closed--idle-dark／--cancelled-dark／--awaiting-approval-dark／--stopped-error-dark
 * 互斥对照／--empty-thread-dark 零噪音对照），各自独立断言，不改 S1a 那条测试的一个字。
 *
 * 打包与样式管线与 transcript-rail-clearance.test.tsx 完全一致：Bun.build 打包旁边的 fixture，
 * Tailwind 按页面上真实出现的类编译应用自己的 styles.css。深色不是手挂 class：页面加载前把
 * `xiongbao-theme` 置成 dark，fixture 里的 ThemeProvider 走产品逻辑上深色。
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_SHOTS=<dir> bun test app/tests/wp32-status-shots.test.tsx
 *
 * 平时（分片跑、没有 OPENBOT_APP_BROWSER）整组跳过，不占分片时间；CI 的 app-status-shots job
 * 带着两个环境变量跑它并把图上传成 artifact。
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots =
  process.env.OPENBOT_APP_SHOTS ?? join(import.meta.dir, ".wp32-shots");

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ELAPSED = /已跑 2 分 15 秒|已进行 2 分 15 秒/;

/** 每个画面：地址片段、等哪句话出现、断言哪句阶段话在。 */
const SCENES = [
  { hash: "model", wait: "思考中", stage: "思考中" },
  { hash: "tool", wait: "正在执行工具", stage: "正在执行工具" },
  { hash: "answer", wait: "正在输出回答", stage: "正在输出回答" },
  { hash: "typing", wait: "雄宝 正在输入", stage: "雄宝 正在输入" },
  { hash: "observed", wait: "思考中", stage: "思考中" },
] as const;

/**
 * S1b 终态行的五个画面（设计稿 §2.8）：三个正性版本各断言自己的话与 data-variant；
 * stopped-error 是互斥对照（Stopped 在、终态行不在）；empty-thread 是零噪音对照（什么都不在）。
 * wait 为 null 的画面没有一句话可等，open() 等挂载。
 */
const CLOSED_SCENES: {
  hash: string;
  wait: string | null;
  variant?: string;
  says?: string[];
  amber?: boolean;
  stopped?: boolean;
}[] = [
  {
    hash: "turn-closed--idle-dark",
    wait: "本轮已结束",
    variant: "idle",
    says: ["本轮已结束", "等待你的下一句"],
  },
  {
    hash: "turn-closed--cancelled-dark",
    wait: "本轮已由你停止",
    variant: "cancelled",
    says: ["本轮已由你停止", "想继续就说一句。"],
  },
  {
    hash: "turn-closed--awaiting-approval-dark",
    wait: "有一个命令等你批准",
    variant: "awaiting_approval",
    says: ["有一个命令等你批准", "批准后我接着做。"],
    amber: true,
  },
  {
    hash: "turn-closed--stopped-error-dark",
    wait: "员工停下了，没有说原因。",
    stopped: true,
  },
  { hash: "turn-closed--empty-thread-dark", wait: null },
];

/** 打包 fixture。`@/lib/marks` 是 Vite 的 `import.meta.glob`，浏览器里没有，置空。 */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "wp32-status-shots.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "no-marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "no-marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
            contents: "export const markFor = () => null;",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** `@import "<package>[/<file>]"` 按包的 `style` 出口落地，与 Vite 读法一致。 */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package for ${id}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** 应用自己的样式表，Tailwind 按这些类编译，与应用构建一致。 */
async function stylesheet(classes: string[]): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
}

let browser: Browser;
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // CI job 装的是完整 Chromium，不带 headless shell。托管 Ubuntu runner 的沙箱与 /dev/shm
  // 限制按仓库既有 CI 浏览器门同款处理（scripts/e2e/wakerflow-lifecycle.ts 的启动参数）。
  browser = await chromium.launch({
    channel: "chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

afterAll(async () => {
  await browser?.close();
});

/** 一个画面开成一页：暗色＋2 倍像素，样式按画出来的类编译一次。wait 为 null＝零噪音画面，等挂载。 */
async function open(hash: string, wait: string | null): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  // 深色走产品逻辑：ThemeProvider 挂载时读这个键。
  await page.addInitScript(() => {
    window.localStorage.setItem("xiongbao-theme", "dark");
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>',
      });
    if (path === "/transcript.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === "/api/approvals")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          enabled: false,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        }),
      });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: '{"error":"not served"}',
    });
  });
  await page.goto(`${ORIGIN}/#${hash}`);
  if (wait === null) {
    // 零噪音画面没有一句话可等：等 React 挂上根节点，再靠下面的落定时间拍。
    await page.waitForFunction(
      () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
    );
  } else {
    await page.getByText(wait).first().waitFor({ timeout: 8000 });
  }
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
  // 入场动画落定再拍。
  await page.waitForTimeout(700);
  return page;
}

describe.skipIf(!asked)("the working line's live elapsed time, in pictures", () => {
  test("each scene says its stage and its seconds, and is saved dark at 2x", async () => {
    mkdirSync(shots, { recursive: true });
    for (const scene of SCENES) {
      const page = await open(scene.hash, scene.wait);
      try {
        // 结构断言：阶段话在、秒数在，图不是白拍的。
        expect(await page.getByText(scene.stage).count()).toBeGreaterThan(0);
        expect(await page.getByText(ELAPSED).count()).toBeGreaterThan(0);
        const dark = await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        );
        expect(dark).toBe(true);
        // observed 画面说「已进行」，其余说「已跑」：限定词各就各位。
        const qualifier =
          scene.hash === "observed" ? "已进行 2 分 15 秒" : "已跑 2 分 15 秒";
        expect(await page.getByText(qualifier).count()).toBe(1);
        await page.screenshot({ path: join(shots, `${scene.hash}.png`) });
      } finally {
        await page.close();
      }
    }
  }, 120_000);
});

describe.skipIf(!asked)("the closed turn's line, in pictures", () => {
  test("each closed-turn scene says its variant or nothing, and is saved dark at 2x", async () => {
    mkdirSync(shots, { recursive: true });
    for (const scene of CLOSED_SCENES) {
      const page = await open(scene.hash, scene.wait);
      try {
        const dark = await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        );
        expect(dark).toBe(true);
        const closed = page.getByTestId("transcript-turn-closed");
        const stoppedLine = page.getByTestId("transcript-stopped");
        if (scene.variant) {
          // 正性版本：这一行在、版本对、话在；失败句/思考中/秒数一个都不在。
          expect(await closed.count()).toBe(1);
          expect(await closed.getAttribute("data-variant")).toBe(scene.variant);
          for (const words of scene.says ?? [])
            expect(await page.getByText(words).count()).toBeGreaterThan(0);
          expect(await stoppedLine.count()).toBe(0);
          expect(await page.getByText("思考中").count()).toBe(0);
          expect(await page.getByText(ELAPSED).count()).toBe(0);
          if (scene.amber)
            expect(
              await page
                .locator('[data-variant="awaiting_approval"] .text-amber-600')
                .count(),
            ).toBe(1);
        } else if (scene.stopped) {
          // 互斥对照：失败句在，终态行永不与它同屏（就算版本被置了位）。
          expect(await stoppedLine.count()).toBe(1);
          expect(await closed.count()).toBe(0);
        } else {
          // 零噪音对照：空 thread 一个字不说，一行会话也没有。
          expect(await closed.count()).toBe(0);
          expect(await stoppedLine.count()).toBe(0);
          expect(await page.getByText("思考中").count()).toBe(0);
          expect(await page.locator("[data-message-id]").count()).toBe(0);
        }
        await page.screenshot({ path: join(shots, `${scene.hash}.png`) });
      } finally {
        await page.close();
      }
    }
  }, 120_000);
});
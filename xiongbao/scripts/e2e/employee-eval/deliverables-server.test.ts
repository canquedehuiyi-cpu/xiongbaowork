import { afterAll, describe, expect, test } from "bun:test";
import {
  chromiumAvailable,
  deliveriesOf,
  runDelivering,
  runListing,
  serverChecks,
} from "./deliverables-server";

/*
 * 桩服务器：一个冒充应用服务器（下载、预览、打开内容源），一个冒充内容源（换 cookie、给首页、跑待办接口）。
 * 不跑真模型、不连真服务器；浏览器交互用 Chromium 打开本地的桩页面。
 */

const BOT = "bot-1";
const COOKIE = "session=abc";
const browser = await chromiumAvailable();
if (!browser.ok) console.log(`跳过浏览器交互用例：${browser.reason}`);
// 起浏览器、等点击后的变化超时（5 秒）要比默认的 5 秒测试上限久。
const browserTest = (name: string, run: () => Promise<void>) =>
  (browser.ok ? test : test.skip)(name, run, 30_000);

const stopList: (() => void)[] = [];
afterAll(() => {
  for (const stop of stopList) stop();
});

type Behavior = {
  /** 下载：状态、Content-Disposition、正文。 */
  download?: { status?: number; disposition?: string; body?: string };
  /** 预览：状态、正文类型。unavailable 为真时答 `{ unavailable: true }`。 */
  preview?: { unavailable?: boolean; nosniff?: boolean; status?: number };
  /** 内容源页面和接口的行为。 */
  page?: string;
  listAfterAdd?: boolean;
  deleteWorks?: boolean;
};

function startStubs(behavior: Behavior) {
  const todos: { id: number; text: string }[] = [];
  let nextId = 1;
  const content = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/__open/"))
        return new Response(null, {
          status: 302,
          headers: { location: "/", "set-cookie": "xb_content=ok; Path=/" },
        });
      if (!(request.headers.get("cookie") ?? "").includes("xb_content=ok"))
        return new Response("no", { status: 404 });
      if (url.pathname === "/api/todos") {
        if (request.method === "POST") {
          const body = (await request.json()) as { text: string };
          const item = { id: nextId++, text: body.text };
          if (behavior.listAfterAdd !== false) todos.push(item);
          return Response.json(item, { status: 201 });
        }
        return Response.json(todos);
      }
      const removing = /^\/api\/todos\/(\d+)$/.exec(url.pathname);
      if (removing && request.method === "DELETE") {
        if (behavior.deleteWorks !== false) {
          const at = todos.findIndex((todo) => String(todo.id) === removing[1]);
          if (at >= 0) todos.splice(at, 1);
        }
        return new Response(null, { status: 204 });
      }
      return new Response(
        behavior.page ??
          "<!doctype html><body><p id=\"t\">你好</p><button onclick=\"document.getElementById('t').textContent='推荐：拿铁'\">推荐</button></body>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const app = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("cookie") !== COOKIE)
        return new Response("login", { status: 401 });
      if (url.pathname.endsWith("/files/download")) {
        const spec = behavior.download ?? {};
        const body = spec.body ?? "0123456789";
        return new Response(body, {
          status: spec.status ?? 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(Buffer.byteLength(body)),
            "content-disposition":
              spec.disposition ?? 'attachment; filename="x"',
          },
        });
      }
      if (url.pathname.endsWith("/files/preview")) {
        const spec = behavior.preview ?? {};
        if (spec.unavailable) return Response.json({ unavailable: true });
        return new Response("pdf", {
          status: spec.status ?? 200,
          headers: {
            "content-type": "application/pdf",
            ...(spec.nosniff === false
              ? {}
              : { "x-content-type-options": "nosniff" }),
          },
        });
      }
      if (url.pathname.endsWith("/open"))
        return Response.json({
          url: `http://127.0.0.1:${content.port}/__open/tok`,
          mode: "port",
          replaces: false,
        });
      return new Response("?", { status: 404 });
    },
  });
  stopList.push(() => {
    app.stop(true);
    content.stop(true);
  });
  return `http://127.0.0.1:${app.port}`;
}

const input = (base: string, task: string, files: string[]) => ({
  base,
  cookie: COOKIE,
  botId: BOT,
  channelId: "ch-1",
  runId: "run-1",
  task: task as "deliv-pptx",
  files,
});
const failedNames = (checks: { name: string; ok: boolean }[]) =>
  checks.filter((item) => !item.ok).map((item) => item.name);

describe("下载和预览", () => {
  test("下载答对、预览有 nosniff 时全过", async () => {
    const base = startStubs({});
    const checks = await serverChecks(
      input(base, "deliv-pptx", ["a/deck.pptx"]),
      {
        localBytes: () => 10,
      },
    );
    expect(failedNames(checks)).toEqual([]);
    expect(checks.map((item) => item.name)).toEqual([
      "下载 a/deck.pptx",
      "预览 a/deck.pptx",
    ]);
  });

  test("a download with the wrong disposition fails; an unavailable office preview fails the pptx task", async () => {
    const wrongDisposition = startStubs({
      download: { disposition: 'inline; filename="x"' },
    });
    const first = await serverChecks(
      input(wrongDisposition, "deliv-docx", ["report.docx"]),
      { localBytes: () => 10 },
    );
    expect(failedNames(first)).toEqual(["下载 report.docx"]);
    expect(first[0]?.detail).toContain("attachment");

    const unavailable = startStubs({ preview: { unavailable: true } });
    const second = await serverChecks(
      input(unavailable, "deliv-pptx", ["deck.pptx"]),
      { localBytes: () => 10 },
    );
    expect(failedNames(second)).toEqual(["预览 deck.pptx"]);
    expect(second[1]?.detail).toContain("unavailable");
  });

  test("下载的字节数和电脑上的不一样就失败；没有电脑上的字节数时只核对长度头", async () => {
    const base = startStubs({});
    const wrong = await serverChecks(input(base, "deliv-xlsx", ["b.xlsx"]), {
      localBytes: () => 11,
    });
    expect(failedNames(wrong)).toEqual(["下载 b.xlsx"]);
    expect(wrong[0]?.detail).toContain("10 字节，电脑上是 11 字节");
    const unknown = await serverChecks(input(base, "deliv-xlsx", ["b.xlsx"]));
    expect(failedNames(unknown)).toEqual([]);
  });

  test("预览缺 nosniff 或下载非 200 都失败", async () => {
    const base = startStubs({
      download: { status: 404 },
      preview: { nosniff: false },
    });
    const checks = await serverChecks(input(base, "deliv-pptx", ["d.pptx"]));
    expect(failedNames(checks)).toEqual(["下载 d.pptx", "预览 d.pptx"]);
  });

  test("没带会话 cookie 时请求被拒，判分项失败而不是抛错", async () => {
    const base = startStubs({});
    const checks = await serverChecks({
      ...input(base, "deliv-image", ["cover.png"]),
      cookie: "session=other",
    });
    expect(failedNames(checks)).toEqual(["下载 cover.png", "预览 cover.png"]);
  });
});

describe("网页和程序", () => {
  browserTest("网页：首页 200，点按钮后文字变化就过", async () => {
    const base = startStubs({});
    const checks = await serverChecks(
      input(base, "deliv-web", ["eval/web/site/index.html"]),
      { localBytes: () => 10 },
    );
    expect(failedNames(checks)).toEqual([]);
    expect(checks.map((item) => item.name)).toContain(
      "网页：点按钮后页面文字变化",
    );
  });

  browserTest("网页：点按钮文字不变就失败", async () => {
    const base = startStubs({
      page: "<!doctype html><body><p>静态</p><button>推荐</button></body>",
    });
    const checks = await serverChecks(
      input(base, "deliv-web", ["site/index.html"]),
      { localBytes: () => 10 },
    );
    expect(failedNames(checks)).toEqual(["网页：点按钮后页面文字变化"]);
  });

  browserTest("程序：新增、读到、删除、读不到都对就过", async () => {
    const base = startStubs({});
    const checks = await serverChecks(
      input(base, "deliv-app", ["app/index.html"]),
      { localBytes: () => 10, appPort: 4321 },
    );
    expect(failedNames(checks)).toEqual([]);
    expect(checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "程序：新增一条待办后列表读得到",
        "程序：删除后列表读不到",
      ]),
    );
  });

  browserTest("程序：新增后列表看不到就失败", async () => {
    const base = startStubs({ listAfterAdd: false });
    const checks = await serverChecks(
      input(base, "deliv-app", ["app/index.html"]),
      { localBytes: () => 10, appPort: 4321 },
    );
    expect(failedNames(checks)).toEqual([
      "程序：新增一条待办后列表读得到",
      "程序：删除后列表读不到",
    ]);
  });

  browserTest("程序：删除后还读得到就失败", async () => {
    const base = startStubs({ deleteWorks: false });
    const checks = await serverChecks(
      input(base, "deliv-app", ["app/index.html"]),
      { localBytes: () => 10, appPort: 4321 },
    );
    expect(failedNames(checks)).toEqual(["程序：删除后列表读不到"]);
  });

  test("程序：交付里没写端口就不请求内容源，直接失败", async () => {
    const base = startStubs({});
    const checks = await serverChecks(
      input(base, "deliv-app", ["app/index.html"]),
      { localBytes: () => 10 },
    );
    expect(failedNames(checks)).toEqual(["程序：打开链接"]);
  });
});

describe("交付清单和下载认的运行", () => {
  const delivered = (apps: unknown) => ({
    type: "CUSTOM",
    name: "delivery.delivered",
    value: { agentId: "bot-1", deliverable: { apps } },
  });
  const listed = (path: string) => ({
    type: "CUSTOM",
    name: "computer.turn_artifacts",
    value: { botId: "bot-1", files: [{ path, bytes: 3 }] },
  });

  test("交付清单读服务器的交付事件，也读 deliver_task 调用里的 items", () => {
    expect(
      deliveriesOf([delivered([{ port: 4321, path: "/", title: "待办" }])], []),
    ).toEqual([{ kind: "app", port: 4321 }]);
    expect(
      deliveriesOf(
        [],
        [
          {
            name: "delivery/deliver_task",
            args: JSON.stringify({
              items: [
                { kind: "app", port: 5000 },
                { kind: "note", ref: "x" },
              ],
            }),
          },
          { name: "deliver_task", args: "{坏的" },
        ],
      ),
    ).toEqual([{ kind: "app", port: 5000 }, { kind: "note" }]);
  });

  test("多轮时取列出产物的那一轮，程序题取列出该端口的那一轮", () => {
    const runs = [
      { runId: "r1", events: [listed("eval/x/deck.pptx")] },
      { runId: "r2", events: [] },
    ];
    expect(runListing(runs, { files: ["eval/x/deck.pptx"] })).toBe("r1");
    expect(runListing(runs, { files: ["nothing.md"] })).toBe("r2");
    // 程序题：文件的运行按产物列表认，端口的运行单独取。
    const appRuns = [
      { runId: "a", events: [listed("eval/x/app/index.html")] },
      {
        runId: "b",
        events: [delivered([{ port: 4321, path: "/", title: "t" }])],
      },
    ];
    expect(runListing(appRuns, { files: ["eval/x/app/index.html"] })).toBe("a");
    expect(runDelivering(appRuns, 4321)).toBe("b");
  });

  test("没有交付事件、多轮、index.html 在第 1 轮时：文件取第 1 轮，程序取最后一轮", () => {
    const runs = [
      { runId: "r1", events: [listed("eval/x/app/index.html")] },
      { runId: "r2", events: [] },
      { runId: "r3", events: [] },
    ];
    expect(runListing(runs, { files: ["eval/x/app/index.html"] })).toBe("r1");
    expect(runDelivering(runs, 4321)).toBe("r3");
  });

  test("响应没带 Content-Length 且没有电脑上的字节数时跳过字节数核对，不误报", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname.endsWith("/download")
          ? new Response(
              new ReadableStream({
                // 分块发送：Bun 对一次写完的流会补上 Content-Length，这里要一个没有长度的响应。
                async start(controller) {
                  controller.enqueue(new TextEncoder().encode("ab"));
                  await Bun.sleep(20);
                  controller.enqueue(new TextEncoder().encode("c"));
                  controller.close();
                },
              }),
              {
                headers: { "content-disposition": "attachment; filename=x" },
              },
            )
          : new Response("pdf", {
              headers: { "x-content-type-options": "nosniff" },
            }),
    });
    stopList.push(() => server.stop(true));
    const checks = await serverChecks({
      ...input(`http://127.0.0.1:${server.port}`, "deliv-docx", ["r.docx"]),
      cookie: "",
    });
    expect(failedNames(checks)).toEqual([]);
    expect(checks[0]?.detail).toContain("跳过字节数核对");
  });
});

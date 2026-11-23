/*
 * 侧边栏预览 html：文件名是 index.html 的先问内容源（`POST /api/computers/:botId/open`），可用就把 iframe
 * 指向它给的地址；没配内容源、不是 index.html、在工作区根、被拒绝时回到受限沙箱预览。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ArtifactPreview } from "@/components/channels/artifact-preview";
import { type PreviewTarget, previewHref } from "@/lib/computers/preview";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const ui = () => within(document.body);

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    settings: {
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ window }) =>
            new window.Response("", {
              headers: { "content-type": "text/html" },
            }),
        },
      },
    },
  });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const target = (path: string, run = "r1"): PreviewTarget => ({
  botId: "b1",
  path,
  scope: { channel: "c1", run },
});

type Call = { url: URL; body: Record<string, unknown> };

/** 把 /open 的回答交给 handler；其余地址一律不该被请求。 */
function serveOpen(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      expect(url.pathname).toBe("/api/computers/b1/open");
      expect(init?.method).toBe("POST");
      const call = { url, body: JSON.parse(String(init?.body)) };
      calls.push(call);
      return handler(call);
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const available = (url: string, extra: Record<string, unknown> = {}) =>
  json({
    available: true,
    url,
    mode: "port",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    replaces: false,
    ...extra,
  });

const NOTE = "没有配置内容源，网页在受限沙箱里显示，部分功能可能不可用。";

describe("open through the content origin", () => {
  test("available: iframe points at the content url; open body carries dir and scope", async () => {
    const calls = serveOpen(() => available("http://c.example:9000/__open/t1"));
    render(<ArtifactPreview target={target("site/index.html")} />);
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
        "http://c.example:9000/__open/t1",
      ),
    );
    expect(calls[0]?.body).toEqual({
      kind: "dir",
      path: "site",
      channel: "c1",
      run: "r1",
    });
    // 「同源」指内容源，响应头的沙箱取交集，页面实际仍在不透明源里。
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
    );
    expect(ui().queryByText(NOTE)).toBeNull();
    expect(ui().queryByText("已替换你之前打开的程序")).toBeNull();
  });

  test("a delivery card scope sends task", async () => {
    const calls = serveOpen(() => available("http://c.example/__open/t"));
    render(
      <ArtifactPreview
        target={{ botId: "b1", path: "a/index.html", scope: { task: "k1" } }}
      />,
    );
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.body).toEqual({ kind: "dir", path: "a", task: "k1" });
  });

  test("unavailable: fallback note, and the app-origin iframe never gets allow-same-origin", async () => {
    serveOpen(() => json({ available: false, reason: "no content origin" }));
    render(<ArtifactPreview target={target("site/index.html")} />);
    await ui().findByText(NOTE);
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      previewHref(target("site/index.html")),
    );
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  test("replaces shows the notice", async () => {
    serveOpen(() => available("http://c.example/__open/t", { replaces: true }));
    render(<ArtifactPreview target={target("site/index.html")} />);
    await ui().findByText("已替换你之前打开的程序");
  });

  test("expiry shows 已过期，重新打开, which opens again without replacing the content on its own", async () => {
    let n = 0;
    const calls = serveOpen(() => {
      n++;
      return available(`http://c.example/__open/t${n}`, {
        expiresAt: new Date(
          Date.now() + (n === 1 ? 30 : 3_600_000),
        ).toISOString(),
      });
    });
    render(<ArtifactPreview target={target("site/index.html")} />);
    const button = await ui().findByRole("button", {
      name: "已过期，重新打开",
    });
    // 到点后不自动换内容。
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://c.example/__open/t1",
    );
    expect(calls.length).toBe(1);
    fireEvent.click(button);
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
        "http://c.example/__open/t2",
      ),
    );
    expect(ui().queryByRole("button", { name: "已过期，重新打开" })).toBeNull();
  });

  test("a non-index html uses the sandbox preview with no note and no open request", async () => {
    const calls = serveOpen(() => available("http://c.example/x"));
    render(<ArtifactPreview target={target("site/about.html")} />);
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      previewHref(target("site/about.html")),
    );
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    await act(async () => {});
    expect(calls.length).toBe(0);
    expect(ui().queryByText(NOTE)).toBeNull();
  });

  test("an index.html at the workspace root shows the root hint and the sandbox preview", async () => {
    const calls = serveOpen(() => available("http://c.example/x"));
    render(<ArtifactPreview target={target("index.html")} />);
    await ui().findByText("这个网页在工作区根目录，只能在受限预览里查看");
    expect(ui().queryByText(NOTE)).toBeNull();
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-scripts",
    );
    expect(calls.length).toBe(0);
  });

  test("open in a new tab asks again for a fresh url", async () => {
    let n = 0;
    const calls = serveOpen(() => available(`http://c.example/__open/t${++n}`));
    const opened: unknown[][] = [];
    const real = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      render(<ArtifactPreview target={target("site/index.html")} />);
      await waitFor(() =>
        expect(document.querySelector("iframe")).not.toBeNull(),
      );
      fireEvent.click(
        await ui().findByRole("button", { name: "在新标签页打开" }),
      );
      await waitFor(() => expect(opened.length).toBe(1));
      expect(calls.length).toBe(2);
      expect(opened[0]).toEqual([
        "http://c.example/__open/t2",
        "_blank",
        "noopener,noreferrer",
      ]);
      // 面板里的 iframe 没被新地址替换。
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
        "http://c.example/__open/t1",
      );
    } finally {
      window.open = real;
    }
  });

  test("switching files: a late answer for the old file never overwrites the new one", async () => {
    const releases: Array<() => void> = [];
    serveOpen(
      (call) =>
        new Promise<Response>((resolve) => {
          const path = call.body.path;
          releases.push(() => resolve(available(`http://c.example/${path}`)));
        }),
    );
    const view = render(<ArtifactPreview target={target("one/index.html")} />);
    await waitFor(() => expect(releases.length).toBe(1));
    view.rerender(<ArtifactPreview target={target("two/index.html")} />);
    await waitFor(() => expect(releases.length).toBe(2));
    releases[1]?.();
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
        "http://c.example/two",
      ),
    );
    releases[0]?.();
    await act(async () => {});
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://c.example/two",
    );
  });

  test("while loading the new file after a switch, the old file's iframe is gone", async () => {
    let n = 0;
    serveOpen((call) =>
      n++ === 0
        ? available("http://c.example/one")
        : new Promise<Response>(() => {
            void call;
          }),
    );
    const view = render(<ArtifactPreview target={target("one/index.html")} />);
    await waitFor(() =>
      expect(document.querySelector("iframe")).not.toBeNull(),
    );
    view.rerender(<ArtifactPreview target={target("two/index.html")} />);
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("404 falls back to the sandbox preview with a one-line reason", async () => {
    serveOpen(() => json({ error: "not found" }, 404));
    render(<ArtifactPreview target={target("site/index.html")} />);
    await ui().findByText("打不开这个网页，已改用受限预览");
    expect(ui().queryByText(NOTE)).toBeNull();
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      previewHref(target("site/index.html")),
    );
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  });
});

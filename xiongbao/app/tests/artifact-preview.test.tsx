/*
 * 侧边栏的文件预览面板：按文件类型选一种画法，内容一律不在本页的源里执行。
 * html 用 sandbox="allow-scripts" 的 iframe；pdf 和 office 的 iframe 不带 sandbox 属性（元素上的
 * sandbox 会拦掉浏览器的 PDF 查看器，隔离靠服务器响应头里的 CSP sandbox）；文本类只画成文字或表格。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { ArtifactPreview } from "@/components/channels/artifact-preview";
import { artifactHref } from "@/lib/computers/artifact";
import {
  decodePreview,
  encodePreview,
  type FilePreviewTarget,
  parseCsv,
  previewHref,
} from "@/lib/computers/preview";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const ui = () => within(document.body);

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    // 面板的 iframe 只看属性：让 happy-dom 取 iframe 页面时拿到一页空的，不真去连网。
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

const target = (path: string): FilePreviewTarget => ({
  botId: "b1",
  path,
  scope: { channel: "c1", run: "r1" },
});

function serve(handler: (url: URL) => Response) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      handler(new URL(String(input), "http://localhost/")),
    { preconnect: originalFetch.preconnect },
  );
}

describe("preview param", () => {
  test("round-trips; a bad value is undefined", () => {
    const t = target("a b/#.pdf");
    expect(decodePreview(encodePreview(t))).toEqual(t);
    expect(decodePreview("%%")).toBeUndefined();
    expect(decodePreview(undefined)).toBeUndefined();
    const raw = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(
      decodePreview(raw({ botId: 1, path: "p", scope: { task: "t" } })),
    ).toBeUndefined();
    expect(
      decodePreview(
        raw({ botId: "b", path: "p".repeat(5000), scope: { task: "t" } }),
      ),
    ).toBeUndefined();
    expect(decodePreview("bm90IGpzb24")).toBeUndefined(); // "not json"
    // 没有 scope 的文件是单聊老清单里的（和它的下载一样按自己的电脑取），读得回来；给了坏 scope 的不行。
    expect(decodePreview(raw({ botId: "b", path: "p" }))).toEqual({
      botId: "b",
      path: "p",
    });
    expect(
      decodePreview(raw({ botId: "b", path: "p", scope: {} })),
    ).toBeUndefined();
    expect(
      decodePreview(raw({ path: "p", scope: { task: "t" } })),
    ).toBeUndefined();
    expect(
      decodePreview(raw({ botId: "b", path: "p", scope: { task: "t" } })),
    ).toEqual({ botId: "b", path: "p", scope: { task: "t" } });
  });

  test("special-character path encodes the same as the download link", () => {
    const t = target("a b/#?%.pdf");
    const down = artifactHref(t) as string;
    expect(previewHref(t)).toBe(
      down.replace("/files/download?", "/files/preview?"),
    );
  });
});

describe("parseCsv", () => {
  test("handles quotes, commas and newlines inside quotes", () => {
    expect(parseCsv('a,"b,c","d ""q"""\n1,2,3\n"x\ny",,')).toEqual([
      ["a", "b,c", 'd "q"'],
      ["1", "2", "3"],
      ["x\ny", "", ""],
    ]);
  });
});

describe("ArtifactPreview", () => {
  test("image, video and audio use native tags", () => {
    const { container, rerender } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.png")} />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      previewHref(target("a.png")),
    );
    rerender(<ArtifactPreview onClose={() => {}} target={target("a.mp4")} />);
    expect(container.querySelector("video")).not.toBeNull();
    rerender(<ArtifactPreview onClose={() => {}} target={target("a.mp3")} />);
    expect(container.querySelector("audio")).not.toBeNull();
  });

  test("html iframe sandbox is exactly allow-scripts", () => {
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.html")} />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toBe(previewHref(target("a.html")));
  });

  test("pdf iframe has no sandbox attribute", () => {
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a b/#?%.pdf")} />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.hasAttribute("sandbox")).toBe(false);
    expect(frame?.getAttribute("src")).toBe(
      `${previewHref(target("a b/#?%.pdf"))}#navpanes=0`,
    );
  });

  test("pdf iframe src ends with #navpanes=0; html and the open link do not", () => {
    const pdf = render(
      <ArtifactPreview onClose={() => {}} target={target("a.pdf")} />,
    );
    expect(
      pdf.container
        .querySelector("iframe")
        ?.getAttribute("src")
        ?.endsWith("#navpanes=0"),
    ).toBe(true);
    expect(
      ui()
        .getByRole("link", { name: /新标签页/ })
        .getAttribute("href"),
    ).toBe(previewHref(target("a.pdf")) as string);
    cleanup();
    const html = render(
      <ArtifactPreview onClose={() => {}} target={target("a.html")} />,
    );
    expect(
      html.container.querySelector("iframe")?.getAttribute("src"),
    ).not.toContain("#");
  });

  test("without onClose there is no close button", () => {
    render(<ArtifactPreview target={target("a.pdf")} />);
    expect(ui().queryByRole("button", { name: /关闭/ })).toBeNull();
  });

  test("office: converted PDF goes in an iframe without sandbox", async () => {
    serve(
      () =>
        new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        }),
    );
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.docx")} />,
    );
    await waitFor(() =>
      expect(container.querySelector("iframe")).not.toBeNull(),
    );
    expect(container.querySelector("iframe")?.hasAttribute("sandbox")).toBe(
      false,
    );
  });

  test("office unavailable draws the cannot-preview note and download", async () => {
    serve(() => Response.json({ unavailable: true }));
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.docx")} />,
    );
    await waitFor(() =>
      expect(ui().getByText(/预览不了这个类型/)).toBeTruthy(),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(ui().getAllByRole("link", { name: /下载/ }).length).toBeGreaterThan(
      0,
    );
  });

  test("none and svg are download only", () => {
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.svg")} />,
    );
    expect(ui().getByText(/预览不了这个类型/)).toBeTruthy();
    expect(container.querySelector("iframe, img, object, embed")).toBeNull();
    expect(ui().queryByRole("link", { name: /新标签页/ })).toBeNull();
  });

  test("415 from the text route draws the cannot-preview note", async () => {
    serve(() => Response.json({ error: "no" }, { status: 415 }));
    render(<ArtifactPreview onClose={() => {}} target={target("a.txt")} />);
    await waitFor(() =>
      expect(ui().getByText(/预览不了这个类型/)).toBeTruthy(),
    );
  });

  test("other errors draw the load-failed note with download", async () => {
    serve(() => Response.json({ error: "boom" }, { status: 500 }));
    render(<ArtifactPreview onClose={() => {}} target={target("a.txt")} />);
    await waitFor(() => expect(ui().getByText("预览加载失败")).toBeTruthy());
  });

  test("text shows markup as words, never as elements", async () => {
    serve(() =>
      Response.json({
        kind: "markdown",
        text: "<b>x</b>\nline2",
        truncated: false,
        bytes: 14,
      }),
    );
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.md")} />,
    );
    await waitFor(() => expect(ui().getByText(/<b>x<\/b>/)).toBeTruthy());
    expect(container.querySelector("b")).toBeNull();
  });

  test("truncated text says only the first 1MB is shown", async () => {
    serve(() =>
      Response.json({
        kind: "text",
        text: "hi",
        truncated: true,
        bytes: 9_000_000,
      }),
    );
    render(<ArtifactPreview onClose={() => {}} target={target("a.txt")} />);
    await waitFor(() => expect(ui().getByText(/只显示了前 1MB/)).toBeTruthy());
  });

  test("csv draws a table and caps the rows", async () => {
    const rows = ["h1,h2", '"a,b",2'];
    for (let i = 0; i < 600; i++) rows.push(`r${i},x`);
    serve(() =>
      Response.json({
        kind: "csv",
        text: rows.join("\n"),
        truncated: false,
        bytes: 1,
      }),
    );
    const { container } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.csv")} />,
    );
    await waitFor(() =>
      expect(container.querySelector("table")).not.toBeNull(),
    );
    expect(ui().getByText("a,b")).toBeTruthy();
    expect(container.querySelectorAll("tbody tr").length).toBe(500);
    expect(ui().getByText(/只显示了前 500 行/)).toBeTruthy();
  });

  test("top bar: name, download, open in new tab, close", () => {
    let closed = 0;
    render(
      <ArtifactPreview onClose={() => closed++} target={target("d/a.pdf")} />,
    );
    expect(ui().getByText("a.pdf")).toBeTruthy();
    const open = ui().getByRole("link", { name: /新标签页/ });
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.getAttribute("href")).toBe(
      "/api/computers/b1/files/preview?path=d%2Fa.pdf&channel=c1&run=r1",
    );
    expect(
      ui().getAllByRole("link", { name: /下载/ })[0]?.getAttribute("href"),
    ).toBe(artifactHref(target("d/a.pdf")) as string);
    (ui().getByRole("button", { name: /关闭/ }) as HTMLButtonElement).click();
    expect(closed).toBe(1);
  });
});

describe("switching files", () => {
  const deferred = () => {
    let resolve: (r: Response) => void = () => {};
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const answer = (text: string) =>
    Response.json({ kind: "text", text, truncated: false, bytes: 1 });

  test("a late answer for the first file never overwrites the second", async () => {
    const slow = deferred();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) =>
        String(input).includes("one.txt") ? slow.promise : answer("SECOND"),
      { preconnect: originalFetch.preconnect },
    );
    const { rerender } = render(
      <ArtifactPreview onClose={() => {}} target={target("one.txt")} />,
    );
    rerender(<ArtifactPreview onClose={() => {}} target={target("two.txt")} />);
    await waitFor(() => expect(ui().getByText("SECOND")).toBeTruthy());
    slow.resolve(answer("FIRST"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ui().queryByText("FIRST")).toBeNull();
    expect(ui().getByText("SECOND")).toBeTruthy();
  });

  test("the first frame after a switch never shows the old text", async () => {
    serve((url) => answer(url.searchParams.get("path") ?? ""));
    const { rerender } = render(
      <ArtifactPreview onClose={() => {}} target={target("one.txt")} />,
    );
    await waitFor(() =>
      expect(ui().getByText("one.txt", { selector: "pre" })).toBeTruthy(),
    );
    rerender(<ArtifactPreview onClose={() => {}} target={target("two.txt")} />);
    expect(ui().queryByText("one.txt", { selector: "pre" })).toBeNull();
  });

  test("office draws no iframe for a new file until its check is done", async () => {
    const slow = deferred();
    serve((url) =>
      url.searchParams.get("path") === "a.docx"
        ? new Response("%PDF", {
            headers: { "content-type": "application/pdf" },
          })
        : (undefined as never),
    );
    const { container, rerender } = render(
      <ArtifactPreview onClose={() => {}} target={target("a.docx")} />,
    );
    await waitFor(() =>
      expect(container.querySelector("iframe")).not.toBeNull(),
    );
    globalThis.fetch = Object.assign(async () => slow.promise, {
      preconnect: originalFetch.preconnect,
    });
    rerender(<ArtifactPreview onClose={() => {}} target={target("b.docx")} />);
    expect(container.querySelector("iframe")).toBeNull();
    slow.resolve(Response.json({ unavailable: true }));
    await waitFor(() =>
      expect(ui().getByText(/预览不了这个类型/)).toBeTruthy(),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("office failures", () => {
  test("non-2xx and JSON without unavailable draw load-failed with download", async () => {
    serve(() => Response.json({ error: "boom" }, { status: 500 }));
    const first = render(
      <ArtifactPreview onClose={() => {}} target={target("a.docx")} />,
    );
    await waitFor(() => expect(ui().getByText("预览加载失败")).toBeTruthy());
    expect(ui().getAllByRole("link", { name: /下载/ }).length).toBeGreaterThan(
      1,
    );
    first.unmount();
    serve(() => Response.json({ hello: 1 }));
    render(<ArtifactPreview onClose={() => {}} target={target("a.docx")} />);
    await waitFor(() => expect(ui().getByText("预览加载失败")).toBeTruthy());
  });
});

test("the panel never uses dangerouslySetInnerHTML or a message listener", () => {
  const source = readFileSync(
    new URL("../src/components/channels/artifact-preview.tsx", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain("dangerouslySetInnerHTML");
  expect(source).not.toContain("addEventListener");
});

test("truncated csv warns that the last row may be cut", async () => {
  serve(() =>
    Response.json({
      kind: "csv",
      text: "a,b\n1,2",
      truncated: true,
      bytes: 9_000_000,
    }),
  );
  render(<ArtifactPreview onClose={() => {}} target={target("a.csv")} />);
  await waitFor(() =>
    expect(ui().getByText(/最后一行可能不完整/)).toBeTruthy(),
  );
});

/*
 * 预览是右侧详情面板的第三种内容：地址里的 `preview` 参数开关它，本轮产物清单、群清单和交付卡上的
 * 「预览」按钮写这个参数。这里搭一个只有预览这一种内容的页面（真路由、真 `usePreviewTarget`）来验。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { ArtifactPreview } from "@/components/channels/artifact-preview";
import {
  EventArtifacts,
  GroupTurnArtifacts,
  turnArtifactNotes,
} from "@/components/channels/turn-artifacts";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  decodePreview,
  encodePreview,
  PREVIEW_PANEL_WIDTH,
  type PreviewTarget,
  PreviewTargetContext,
  useRoutePreviewTarget,
} from "@/lib/computers/preview";
import { queryClient } from "@/query-client";
import { DeliveryChatCard } from "@/skins/xiongbao/delivery-chat";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const ui = () => within(document.body);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const TARGET: PreviewTarget = {
  botId: "b1",
  path: "out/报告.pdf",
  scope: { channel: "c1", run: "r1" },
};

type Search = {
  preview?: string;
  watch?: boolean;
  settings?: boolean;
  keep?: string;
};

function Page({
  content,
  unscopedFiles,
}: {
  content: React.ReactNode;
  unscopedFiles: boolean;
}) {
  const preview = useRoutePreviewTarget({ unscopedFiles });
  return (
    <PreviewTargetContext.Provider value={preview}>
      <DetailPanel
        detail={
          preview.target ? <ArtifactPreview target={preview.target} /> : null
        }
        detailWidth={PREVIEW_PANEL_WIDTH}
        onClose={preview.close}
        open={preview.target !== undefined}
        title="预览"
      >
        {content}
      </DetailPanel>
    </PreviewTargetContext.Provider>
  );
}

async function openPage(
  search: Search,
  content: React.ReactNode,
  serve: typeof fetch = (async () =>
    Response.json({}, { status: 404 })) as unknown as typeof fetch,
  /** 单聊路由才认不带范围的文件；默认按群聊这类页面。 */
  unscopedFiles = false,
) {
  globalThis.fetch = serve;
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/chat",
    validateSearch: (raw: Record<string, unknown>): Search => ({
      ...(typeof raw.preview === "string" ? { preview: raw.preview } : {}),
      ...(raw.watch === true ? { watch: true } : {}),
      ...(raw.settings === true ? { settings: true } : {}),
      ...(typeof raw.keep === "string" ? { keep: raw.keep } : {}),
    }),
    component: () => <Page content={content} unscopedFiles={unscopedFiles} />,
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    query.set(key, JSON.stringify(value));
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/chat?${query}`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await act(async () => {});
  return router;
}

const searchOf = (router: { state: { location: { search: unknown } } }) =>
  router.state.location.search as Search;
const panel = () => document.querySelector("[data-artifact-preview]");

const file = (path: string, bytes = 10) => ({
  path,
  bytes,
  modifiedMs: 1,
  change: "new" as const,
});
const group = (path: string, runId = "r7") => ({
  botId: "b1",
  files: [{ ...file(path), runId }],
  omitted: 0,
  scanTruncated: false,
});

test("?preview opens the pane; a malformed param leaves it closed", async () => {
  const router = await openPage(
    { preview: encodePreview(TARGET) },
    <p>chat</p>,
  );
  expect(panel()).not.toBeNull();
  expect(ui().getByText("报告.pdf")).toBeTruthy();
  expect(searchOf(router).preview).toBe(encodePreview(TARGET));
  cleanup();

  for (const bad of ["not base64 !", "e30", encodePreview(TARGET).slice(3)]) {
    await openPage({ preview: bad }, <p>chat</p>);
    expect(panel()).toBeNull();
    cleanup();
  }
});

test("opening a preview closes the live screen and settings; the other params stay", async () => {
  const router = await openPage(
    { watch: true, settings: true, keep: "x" },
    <EventArtifacts channelId="c1" groups={[group("out/报告.pdf") as never]} />,
  );
  expect(panel()).toBeNull();
  await act(async () => {
    ui().getByRole("button", { name: "预览 out/报告.pdf" }).click();
  });
  await waitFor(() => expect(panel()).not.toBeNull());
  const search = searchOf(router);
  expect(search.watch).toBeUndefined();
  expect(search.settings).toBeUndefined();
  expect(search.keep).toBe("x");
  expect(decodePreview(search.preview)).toEqual({
    botId: "b1",
    path: "out/报告.pdf",
    scope: { channel: "c1", run: "r7" },
  });
});

test("the pane has exactly one close button", async () => {
  await openPage({ preview: encodePreview(TARGET) }, <p>chat</p>);
  expect(panel()).not.toBeNull();
  expect(ui().getAllByRole("button", { name: /^关闭/ })).toHaveLength(1);
  expect(ui().queryByRole("button", { name: "关闭预览" })).toBeNull();
});

test("closing removes only the preview param", async () => {
  const router = await openPage(
    { preview: encodePreview(TARGET), keep: "x" },
    <p>chat</p>,
  );
  expect(panel()).not.toBeNull();
  await act(async () => {
    ui().getByRole("button", { name: /^关闭/ }).click();
  });
  await waitFor(() => expect(searchOf(router).preview).toBeUndefined());
  expect(searchOf(router).keep).toBe("x");
  expect("preview" in searchOf(router)).toBe(false);
  await waitFor(() => expect(panel()).toBeNull());
});

test("a group list row's 预览 carries that row's own run", async () => {
  const router = await openPage(
    {},
    <GroupTurnArtifacts
      channelId="g1"
      messages={[
        { agentId: null },
        {
          agentId: "b1",
          turnArtifacts: [
            {
              runId: "r1",
              value: {
                botId: "b1",
                files: [file("a.pdf")],
                scanned: 1,
                scanTruncated: false,
                omitted: 0,
              },
            },
            {
              runId: "r2",
              value: {
                botId: "b1",
                files: [file("b.pdf")],
                scanned: 1,
                scanTruncated: false,
                omitted: 0,
              },
            },
          ],
        },
      ]}
      nameOf={() => "小熊"}
    />,
  );
  await act(async () => {
    ui().getByRole("button", { name: "预览 b.pdf" }).click();
  });
  await waitFor(() => expect(searchOf(router).preview).toBeDefined());
  expect(decodePreview(searchOf(router).preview)).toEqual({
    botId: "b1",
    path: "b.pdf",
    scope: { channel: "g1", run: "r2" },
  });
});

test("a delivery card's 预览 is scoped by its task", async () => {
  const router = await openPage(
    {},
    <DeliveryChatCard
      agentName="小周"
      event={{
        kind: "delivered",
        taskId: "t1",
        agentId: "bot-1",
        deliverable: { kind: "deliverable", workspaceFiles: ["a/b.pdf"] },
      }}
    />,
  );
  await act(async () => {
    ui().getByRole("button", { name: "预览 a/b.pdf" }).click();
  });
  await waitFor(() => expect(searchOf(router).preview).toBeDefined());
  expect(decodePreview(searchOf(router).preview)).toEqual({
    botId: "bot-1",
    path: "a/b.pdf",
    scope: { task: "t1" },
  });
});

test("a file with nothing to preview (svg) has no 预览 button", async () => {
  await openPage(
    {},
    <EventArtifacts
      channelId="c1"
      groups={[group("logo.svg") as never, group("a.pdf") as never]}
    />,
  );
  expect(ui().getByRole("button", { name: "预览 a.pdf" })).toBeTruthy();
  expect(ui().queryByRole("button", { name: "预览 logo.svg" })).toBeNull();
  expect(ui().getByRole("link", { name: "下载 logo.svg" })).toBeTruthy();
});

test("without a pane to open it, the lists draw no 预览 button", () => {
  render(
    <QueryClientProvider client={queryClient}>
      <EventArtifacts channelId="c1" groups={[group("a.pdf") as never]} />
    </QueryClientProvider>,
  );
  expect(ui().queryByRole("button", { name: /预览/ })).toBeNull();
  expect(ui().getByRole("link", { name: "下载 a.pdf" })).toBeTruthy();
});

/*
 * 没有 `computer.turn_artifacts` 事件时的老清单（审批开着时，获准的写入发生在每一段观察之外，就是这样）：
 * 也有「预览」，开的是同一个面板、同一组文件路由。老清单的下载本来就不带范围（看的人自己的那台电脑），
 * 预览也一样不带，不比下载放得更宽。下载链接不变。
 */
test("the plain list (no event) has 预览 too, unscoped like its download", async () => {
  const asked: string[] = [];
  const serve = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost/");
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/local-tools"))
      return Response.json({ machine: "workspace" });
    if (url.pathname.endsWith("/files/list") && init?.method === "POST")
      return Response.json({
        ok: true,
        entries: [{ path: "测试-test.txt", kind: "file", bytes: 1000 }],
      });
    if (url.pathname.endsWith("/files/text"))
      return Response.json({ kind: "text", text: "你好", truncated: false });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const written = [
    { id: "u1", role: "user", content: "写个文件" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          type: "function",
          function: {
            name: "computer_write_file",
            arguments: JSON.stringify({ path: "测试-test.txt" }),
          },
        },
      ],
    },
    {
      id: "r1",
      role: "tool",
      toolCallId: "t1",
      content: JSON.stringify({ ok: true, path: "测试-test.txt" }),
    },
  ] as never;
  const notes = turnArtifactNotes({
    messages: written,
    botId: "b1",
    events: [],
    channelId: "c1",
  });
  const router = await openPage(
    {},
    notes.map((note) => <div key={note.key}>{note.node}</div>),
    serve,
    true,
  );
  const button = await waitFor(() =>
    ui().getByRole("button", { name: "预览 测试-test.txt" }),
  );
  // 下载链接照旧：不带范围的那一条。
  expect(
    document
      .querySelector("[data-artifact-path='测试-test.txt'] a[download]")
      ?.getAttribute("href"),
  ).toBe("/api/computers/b1/files/download?path=%E6%B5%8B%E8%AF%95-test.txt");
  await act(async () => {
    button.click();
  });
  await waitFor(() => expect(searchOf(router).preview).toBeDefined());
  expect(decodePreview(searchOf(router).preview)).toEqual({
    botId: "b1",
    path: "测试-test.txt",
  });
  await waitFor(() => expect(panel()).not.toBeNull());
  await waitFor(() => expect(ui().getByText("你好")).toBeTruthy());
  expect(asked).toContain(
    "/api/computers/b1/files/text?path=%E6%B5%8B%E8%AF%95-test.txt",
  );
});

test("decodePreview keeps a file with no scope, and still refuses a program with none or a broken scope", () => {
  expect(decodePreview(encodePreview({ botId: "b1", path: "a.txt" }))).toEqual({
    botId: "b1",
    path: "a.txt",
  });
  const raw = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  expect(
    decodePreview(raw({ botId: "b1", app: { port: 8000, path: "/" } })),
  ).toBeUndefined();
  expect(
    decodePreview(raw({ botId: "b1", path: "a.txt", scope: null })),
  ).toBeUndefined();
  expect(
    decodePreview(raw({ botId: "b1", path: "a.txt", scope: { channel: "c" } })),
  ).toBeUndefined();
});

/*
 * 不带范围的文件目标只在单聊路由认（v0.2.17 修复评审）：群聊页地址里拼出这样一个 `?preview=`，面板不开，
 * 否则会显示看的人自己电脑上恰好同名的文件。带范围的照常打开。
 */
test("only the one-to-one route opens an unscoped file from the address", async () => {
  const unscoped = encodePreview({ botId: "b1", path: "out/报告.pdf" });
  await openPage({ preview: unscoped }, <p>group</p>);
  expect(panel()).toBeNull();
  cleanup();

  await openPage({ preview: encodePreview(TARGET) }, <p>group</p>);
  expect(panel()).not.toBeNull();
  cleanup();

  await openPage({ preview: unscoped }, <p>chat</p>, undefined, true);
  expect(panel()).not.toBeNull();
});

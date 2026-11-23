/*
 * 交付卡上的「程序」行：标题、端口、未核实，「打开」经内容源把员工正在运行的程序放进侧边栏；
 * 任务页没有侧边栏，改在新标签页打开。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { ArtifactPreview } from "@/components/channels/artifact-preview";
import {
  decodePreview,
  encodePreview,
  type PreviewController,
  type PreviewTarget,
  PreviewTargetContext,
} from "@/lib/computers/preview";
import type { ChatDeliveryEvent } from "@/lib/tasks/delivery-chat";
import { EvidenceLine } from "@/routes/_authed/_app/tasks.$taskId";
import { setSkin } from "@/skins/store";
import { DeliveryChatCard } from "@/skins/xiongbao/delivery-chat";
import { settleReactWork } from "./settle-react-work";

let registeredHere = false;
const originalFetch = globalThis.fetch;
const originalOpen = globalThis.window?.open;
const ui = () => within(document.body);

beforeAll(() => {
  if (!("document" in globalThis)) {
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
    registeredHere = true;
  }
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.open = originalOpen as typeof window.open;
  setSkin("xiongbao");
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const TASK = "t1";
const PORT_NOTE =
  "独立端口模式下，同一浏览器里先后打开的程序能互相读到内容，只打开你信任的程序。";
const NO_ORIGIN = "没有配置内容源，不能打开程序";
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

type Call = Record<string, unknown>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const opened = (url: string, extra: Record<string, unknown> = {}) =>
  json({
    available: true,
    url,
    mode: "port",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    replaces: false,
    ...extra,
  });

function serve(answer: (body: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/api/computers/bot-1/open") {
      const body = JSON.parse(String(init?.body)) as Call;
      calls.push(body);
      return answer(body);
    }
    if (path === "/api/me")
      return json({ user: { id: "u", email: "u@x.test", name: "我" } });
    return json({}, 404);
  }) as typeof fetch;
  return calls;
}

const delivered = (
  apps: { port: number; path: string; title: string }[],
  extra: Record<string, unknown> = {},
  over: { agentId?: string } = { agentId: "bot-1" },
): ChatDeliveryEvent => ({
  kind: "delivered",
  taskId: TASK,
  deliverable: { kind: "deliverable", apps, ...extra },
  ...over,
});

/** 像对话页那样：控制器把目标记下来，面板画 `ArtifactPreview`。 */
function Harness({
  children,
  seen,
}: {
  children: ReactNode;
  seen?: (target: PreviewTarget | undefined) => void;
}) {
  const [target, setTarget] = useState<PreviewTarget>();
  const controller: PreviewController = {
    target,
    open: (next) => {
      // 与路由控制器一样：目标走一遍地址参数的写法再读回。
      const roundTripped = decodePreview(encodePreview(next));
      setTarget(roundTripped);
      seen?.(roundTripped);
    },
    close: () => setTarget(undefined),
  };
  return (
    <PreviewTargetContext.Provider value={controller}>
      {children}
      {target ? <ArtifactPreview target={target} /> : null}
    </PreviewTargetContext.Provider>
  );
}

const drawCard = (
  event: ChatDeliveryEvent,
  seen?: (t?: PreviewTarget) => void,
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness seen={seen}>
        <DeliveryChatCard agentName="小周" event={event} />
      </Harness>
    </QueryClientProvider>,
  );

const app8000 = { port: 8000, path: "/", title: "销售看板" };
const app9000 = { port: 9000, path: "/x?a=1", title: "库存表" };

test("an app row shows title and port; open calls the endpoint with kind app and shows the pane", async () => {
  const calls = serve(() => opened("http://c.example:9000/__open/t1"));
  const view = drawCard(delivered([app8000]));
  expect(view.getByText(/销售看板/)).toBeDefined();
  expect(view.getByText(/端口 8000/)).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "打开 销售看板" }));
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://c.example:9000/__open/t1",
    ),
  );
  expect(calls).toEqual([{ kind: "app", port: 8000, path: "/", task: TASK }]);
  expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe(
    SANDBOX,
  );
  expect(ui().queryByText("已替换你之前打开的程序")).toBeNull();
});

test("without a content origin the button is disabled with the reason; replaced notice shows", async () => {
  serve(() => json({ available: false, reason: "not configured" }));
  const view = drawCard(delivered([app8000]));
  fireEvent.click(view.getByRole("button", { name: "打开 销售看板" }));
  await waitFor(() =>
    expect(ui().getAllByText(NO_ORIGIN).length).toBeGreaterThan(0),
  );
  expect(document.querySelector("iframe")).toBeNull();
  const pane = document.querySelector("[data-artifact-preview]") as HTMLElement;
  expect(
    within(pane).getByRole("button", { name: "打开" }).hasAttribute("disabled"),
  ).toBe(true);
  cleanup();

  serve(() => opened("http://c.example:9000/__open/t2", { replaces: true }));
  const second = drawCard(delivered([app8000]));
  fireEvent.click(second.getByRole("button", { name: "打开 销售看板" }));
  await waitFor(() =>
    expect(ui().getByText("已替换你之前打开的程序")).toBeDefined(),
  );
});

test("the trust note shows in port mode and not in domain mode", async () => {
  serve(() => opened("http://c.example:9000/__open/p", { mode: "port" }));
  let view = drawCard(delivered([app8000]));
  fireEvent.click(view.getByRole("button", { name: "打开 销售看板" }));
  await waitFor(() => expect(ui().getByText(PORT_NOTE)).toBeDefined());
  cleanup();

  serve(() => opened("http://a-1.c.example/__open/d", { mode: "domain" }));
  view = drawCard(delivered([app8000]));
  fireEvent.click(view.getByRole("button", { name: "打开 销售看板" }));
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://a-1.c.example/__open/d",
    ),
  );
  expect(ui().queryByText(PORT_NOTE)).toBeNull();
});

test("opening a second app unmounts the first iframe and the preview target becomes the new one", async () => {
  serve((body) => opened(`http://c.example:9000/__open/${String(body.port)}`));
  const targets: (PreviewTarget | undefined)[] = [];
  const view = drawCard(delivered([app8000, app9000]), (t) => targets.push(t));
  fireEvent.click(view.getByRole("button", { name: "打开 销售看板" }));
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://c.example:9000/__open/8000",
    ),
  );
  const first = document.querySelector("iframe");
  fireEvent.click(view.getByRole("button", { name: "打开 库存表" }));
  await waitFor(() =>
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://c.example:9000/__open/9000",
    ),
  );
  expect(first?.isConnected).toBe(false);
  expect(document.querySelectorAll("iframe").length).toBe(1);
  expect(targets.at(-1)).toEqual({
    botId: "bot-1",
    app: { port: 9000, path: "/x?a=1" },
    scope: { task: TASK },
  });
});

test("on the task page open goes to a new tab, no pane", async () => {
  const calls = serve(() => opened("http://c.example:9000/__open/tab"));
  const tab = {
    opener: {} as unknown,
    location: { replace: (_: string) => {} },
    close: () => {},
  };
  const replaced: string[] = [];
  tab.location.replace = (url) => void replaced.push(url);
  let sync = 0;
  window.open = ((url: string, target: string) => {
    sync += 1;
    expect([url, target]).toEqual(["", "_blank"]);
    return tab;
  }) as unknown as typeof window.open;
  const view = render(
    <EvidenceLine
      agentId="bot-1"
      row={{ kind: "app", port: 8000, path: "/", label: "销售看板" }}
      taskId={TASK}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "打开 销售看板" }));
  expect(sync).toBe(1);
  expect(tab.opener).toBeNull();
  await waitFor(() =>
    expect(replaced).toEqual(["http://c.example:9000/__open/tab"]),
  );
  expect(calls).toEqual([{ kind: "app", port: 8000, path: "/", task: TASK }]);
  expect(document.querySelector("iframe")).toBeNull();
  expect(view.getByText(/端口 8000/)).toBeDefined();
});

test("without an agentId there is no open button; an unverified app says so", () => {
  serve(() => opened("http://c.example:9000/__open/x"));
  let view = drawCard(delivered([app8000], {}, {}));
  expect(view.getByText(/销售看板/)).toBeDefined();
  expect(view.queryByRole("button", { name: /^打开/ })).toBeNull();
  cleanup();

  view = drawCard(delivered([app8000], { unverifiedApps: [8000] }));
  expect(view.getByText(/未核实/)).toBeDefined();
  cleanup();

  const line = render(
    <EvidenceLine
      agentId={null}
      row={{
        kind: "app",
        port: 8000,
        path: "/",
        label: "销售看板",
        unverified: true,
      }}
      taskId={TASK}
    />,
  );
  expect(line.getByText(/未核实/)).toBeDefined();
  expect(line.queryByRole("button", { name: /^打开/ })).toBeNull();
});

test("decodePreview keeps a good app target and rejects bad ones", () => {
  const scope = { task: TASK };
  const good: PreviewTarget = {
    botId: "bot-1",
    app: { port: 8000, path: "/a/b?c=1" },
    scope,
  };
  expect(decodePreview(encodePreview(good))).toEqual(good);
  const bad = (app: unknown) =>
    decodePreview(encodePreview({ botId: "bot-1", app, scope } as never));
  expect(bad({ port: 80, path: "/" })).toBeUndefined();
  expect(bad({ port: 70000, path: "/" })).toBeUndefined();
  expect(bad({ port: 8000.5, path: "/" })).toBeUndefined();
  expect(bad({ port: "8000", path: "/" })).toBeUndefined();
  expect(bad({ port: 8000, path: "x" })).toBeUndefined();
  expect(bad({ port: 8000, path: "//evil" })).toBeUndefined();
  expect(bad({ port: 8000, path: "/a\\b" })).toBeUndefined();
  expect(bad({ port: 8000, path: "/a\nb" })).toBeUndefined();
  expect(bad({ port: 8000 })).toBeUndefined();
  expect(bad(null)).toBeUndefined();
});

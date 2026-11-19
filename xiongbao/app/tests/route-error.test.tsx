import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { RouteError } from "@/components/layout/route-error";
import { verdictOf } from "../../scripts/acceptance/i18n-scan";
import { settleReactWork } from "./settle-react-work";

/**
 * 一页画崩了的时候，用户看到的是中文吗？
 *
 * 这条不是「以后要做」的事，是**已经做了**的事：`router.tsx` 把 `defaultErrorComponent` 设成了
 * `RouteError`。但它一直只靠读代码相信，没有一条断言。缺这条断言的代价在这次扩表里露出来了——
 * 我给 DOM 扫描器写「渲染崩了就报错」的时候，理由是「兜底是英文的 `Something went wrong!`」，
 * 而那句英文来自 TanStack 的默认组件，只出现在**扫描器自己的伪装树**里：那棵树另起了一个 router，
 * 没带 `defaultErrorComponent`。真应用里根本看不到它。
 *
 * 所以这里量的是真应用的配置：同一个 `RouteError`、同一个挂载方式，让一条路由真抛出去，看屏幕上
 * 剩下什么。三条断言各管一件事：
 *
 * 1. 是中文的，而且给了两条出路（重试 / 回到工作台）。
 * 2. **没有一行纯英文**。用扫描器同一套判据（`verdictOf`），免得「中文界面」只是个说法。
 * 3. 原始报错**不上屏**。`kaput` 这种裸消息对用户没意义，`RouteError` 只在消息本身是中文时才显示它
 *    （接口层写的中文提示就是那种）；英文消息一律换成一句中文。原始堆栈留在 console 里给开发看。
 */

const BOOM = "kaput";

function Boom(): never {
  throw new Error(BOOM);
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** 按 `router.tsx` 的配置挂一条会抛的路由。 */
async function renderBoom(): Promise<string[]> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const boom = createRoute({
    getParentRoute: () => root,
    path: "/boom",
    component: Boom,
  });
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ["/boom"] }),
    routeTree: root.addChildren([boom]),
    defaultErrorComponent: RouteError,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  for (let turn = 0; turn < 10; turn += 1) await settleReactWork();
  return (document.body.textContent ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("崩了的页面是中文的，并且给两条出路", async () => {
  const lines = await renderBoom();
  const text = lines.join("\n");
  expect(text).toContain("出了点问题");
  expect(text).toContain("重试");
  expect(text).toContain("回到工作台");
});

test("崩了的页面上没有纯英文文字行", async () => {
  const lines = await renderBoom();
  /*
   * 按空白再切一次：`textContent` 会把相邻节点连成一串（「重试回到工作台」），一行里混着按钮和正文，
   * 判断粒度太粗。切成词之后每个词单独判，纯英文的词一个都不许有。
   */
  const words = lines.flatMap((line) => line.split(/\s+/)).filter(Boolean);
  expect(
    words.filter((word) => verdictOf(word).kind === "english").map(String),
  ).toEqual([]);
});

test("原始报错不上屏", async () => {
  const lines = await renderBoom();
  expect(lines.join("\n")).not.toContain(BOOM);
});

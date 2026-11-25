import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { SkillView } from "@/components/skills/skill-view";

/**
 * 一条技能的只读面板（`/capabilities/skills?view=<slug>`）。
 *
 * 为什么要有这一页：`/capabilities/mine` 的 109 张技能卡只画标题、说明和阻断理由，正文（这条技能到底
 * 教员工做什么）从来没有一个读的地方——技能页是编辑面板，只有自己的技能才点得开。清单一列出来就
 * 该能走过去读，所以正文有了自己的地址。
 *
 * 这里只钉住「读」这一侧：画什么、缺正文说什么、读不到说什么。面板挂在哪条路由上由技能页的测试看管。
 */

let registered = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registered = true;
  }
});
afterAll(() => {
  if (registered) GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

type Row = {
  slug: string;
  title: string;
  summary?: string;
  instructions?: string;
  runnable?: string | null;
  blockedReason?: string | null;
  blockedReasonRef?: string | null;
  tools?: string[];
};

const skill = (row: Row) => ({
  id: `s-${row.slug}`,
  slug: row.slug,
  ownerUserId: null,
  title: row.title,
  summary: row.summary ?? "",
  instructions: row.instructions ?? "",
  origin: "xiongbao-package",
  installedBy: null,
  runnable: row.runnable ?? "full",
  blockedReason: row.blockedReason ?? null,
  blockedReasonRef: row.blockedReasonRef ?? null,
  grantedTo: [] as string[],
  tools: row.tools ?? [],
});

const renderView = (
  slug: string,
  rows: Row[],
  options: { fail?: boolean } = {},
) => {
  globalThis.fetch = (async (input: unknown) => {
    const path =
      String((input as { url?: string }).url ?? input).split("?")[0] ?? "";
    if (path.endsWith("/api/plugins")) {
      if (options.fail)
        return Response.json({ error: "boom" }, { status: 500 });
      return Response.json({
        catalogue: [],
        servers: [],
        skills: rows.map(skill),
        botsMayCallBack: true,
        redirectUri: null,
        composioConfigured: false,
      });
    }
    // 面板只读这一个端点；别的读发出来就该被看见。
    return Response.json({ error: "unknown" }, { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SkillView slug={slug} />
    </QueryClientProvider>,
  );
};

test("一条技能画标题、命令和正文，正文按原样换行", async () => {
  const view = renderView("report-writer", [
    {
      slug: "report-writer",
      title: "写周报",
      summary: "把一周的活攒成一份周报。",
      instructions: "第一步：读本周的提交。\n第二步：写三段，结论在前。",
    },
  ]);
  expect(await view.findByText("写周报")).toBeTruthy();
  expect(view.getByText("/report-writer")).toBeTruthy();
  expect(view.getByText("把一周的活攒成一份周报。")).toBeTruthy();
  expect(view.getByText(/第一步：读本周的提交/)).toBeTruthy();
  const body = view.getByText(/第一步：读本周的提交/) as HTMLElement;
  // 正文是给人读的原文：换行不能被排版吃掉。
  expect(body.className).toContain("whitespace-pre-wrap");
});

test("非完整可用的技能，档位和「缺什么」一起画，规则 id 挂 title", async () => {
  const view = renderView("dead-one", [
    {
      slug: "dead-one",
      title: "跑脚本",
      instructions: "执行 scripts/build.sh。",
      runnable: "blocked",
      blockedReason: "shell-command-prose",
      blockedReasonRef:
        "正文给出可执行的 shell 命令；xiongbao 员工没有本地运行时。",
    },
  ]);
  expect(await view.findByText("跑脚本")).toBeTruthy();
  expect(view.getByRole("status").textContent ?? "").toContain("暂不可用");
  const reason = view.getByText(/xiongbao 员工没有本地运行时/) as HTMLElement;
  expect(reason.title).toBe("shell-command-prose");
});

test("完整可用的技能不画理由——没有缺什么可说，哪怕行上还留着旧理由", async () => {
  const view = renderView("full-one", [
    {
      slug: "full-one",
      title: "整理会议",
      instructions: "把记录整理成三条结论。",
      // 移植复评把一条从 degraded 提成 full 时，理由字段可能还留在行上；提档之后它已经不是缺什么了。
      blockedReason: "stale-rule",
      blockedReasonRef: "这条理由属于上一版审计，已经不再成立。",
    },
  ]);
  await view.findByText("整理会议");
  expect(view.queryByText(/缺/)).toBeNull();
  expect(view.queryByText(/上一版审计/)).toBeNull();
});

test("没有正文的技能说清楚没有正文，而不是画一块空白", async () => {
  const view = renderView("empty-body", [
    { slug: "empty-body", title: "空技能", instructions: "   " },
  ]);
  expect(await view.findByText("空技能")).toBeTruthy();
  expect(view.getByText("这条技能没有正文。")).toBeTruthy();
});

test("点名的工具列出来；一个都不点就说没有", async () => {
  const view = renderView("uses-tools", [
    {
      slug: "uses-tools",
      title: "查工单",
      instructions: "查 TAPD 上的工单。",
      tools: ["tapd/search", "tapd/detail"],
    },
  ]);
  expect(await view.findByText("查工单")).toBeTruthy();
  expect(view.getByText("tapd/search")).toBeTruthy();
  expect(view.getByText("tapd/detail")).toBeTruthy();
  cleanup();

  const bare = renderView("no-tools", [
    { slug: "no-tools", title: "空工具", instructions: "什么都不用。" },
  ]);
  expect(await bare.findByText("空工具")).toBeTruthy();
  expect(bare.getByText("这条技能不点名任何工具。")).toBeTruthy();
});

test("地址里的那条技能不在列表里，就说它不在了，不画一个空面板", async () => {
  const view = renderView("gone", [
    { slug: "other", title: "别的技能", instructions: "正文。" },
  ]);
  expect(await view.findByText("这个技能不在了，或者不归你看。")).toBeTruthy();
});

test("读不到技能列表时说明读不到，而不是断言它不存在", async () => {
  const view = renderView("anything", [], { fail: true });
  const alert = await view.findByRole("alert");
  expect(alert.textContent ?? "").toContain("读不到这个技能");
  expect(view.queryByText(/不在了/)).toBeNull();
});

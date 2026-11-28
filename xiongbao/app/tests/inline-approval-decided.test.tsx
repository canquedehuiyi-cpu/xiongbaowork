import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { settleReactWork } from "./settle-react-work";

/*
 * 刷新以后，对话里已经处理过的审批还说得出结果（v0.2.17 验收 A3）。
 *
 * 以前卡片只在 pending 时画，决定以后把这一行交还给工具行；「已允许一次」只是点击那一刻组件里的状态，
 * 刷新就没了，批准过的那一步看起来和没问过一样。现在收件箱里那条请求已经有 `decision`，就在工具行上方
 * 画一行紧凑的结果：「已允许一次：保存文件 notes.txt」，不再有按钮。数据是收件箱里本来就有的字段。
 * 被拒的不画：工具行本身已经说了没做成。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const request = (
  id: string,
  status: string,
  decision: string | null,
  path: string,
) => ({
  id,
  status,
  decision,
  decidedVia: decision ? "web" : null,
  decidedAt: decision ? "2026-11-28T09:00:00Z" : null,
  createdAt: "2026-11-28T08:59:00Z",
  action: {
    botId: "assistant",
    toolRef: "computer_write_file",
    effect: "write",
    scope: "workspace",
    threadId: "thread-1",
    toolCallId: `call-${id}`,
    args: { path },
    target: { pageUrl: "", filePath: path },
    policy: {
      behaviour: "ask",
      source: "default",
      reason: "你设置了改动之前先问你。",
    },
  },
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/approvals")
      return Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          request("approved", "completed", "allow_once", "notes.txt"),
          request("denied", "completed", "deny", "secret.txt"),
          request("always", "approved", "allow_always", "a.txt"),
          request("conversation", "consumed", "allow_conversation", "b.txt"),
          request("waiting", "pending", null, "c.txt"),
        ],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

/** 每次都是一个新的查询缓存：等于刷新了页面，组件重新挂载、重新读收件箱。 */
function drawFresh(toolCallId: string) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <InlineApproval
        fallback={<span data-tool-line="">保存了文件</span>}
        threadId="thread-1"
        toolCallId={toolCallId}
      />
    </QueryClientProvider>,
  );
}

test("an approved step still says it was allowed once after a reload, with no buttons", async () => {
  serving();
  for (let reload = 0; reload < 2; reload++) {
    const view = drawFresh("call-approved");
    const line = await view.findByText("已允许一次：保存文件 notes.txt");
    expect(line.closest("[data-approval-outcome]")).not.toBeNull();
    // 工具自己的那一行照样在，结果行在它上方。
    expect(view.getByText("保存了文件")).toBeDefined();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("region", { name: "等你批准" })).toBeNull();
    cleanup();
  }
});

/*
 * 被拒的那一步只留一行：工具行自己已经写着「没有成功」（工具结果里是「你拒绝了这一步」），再画一行
 * 「已拒绝」是重复（v0.2.17 验收评审，用户决定）。
 */
test("a rejected step keeps only its own tool line after a reload, no outcome line", async () => {
  serving();
  for (let reload = 0; reload < 2; reload++) {
    const view = drawFresh("call-denied");
    expect(await view.findByText("保存了文件")).toBeDefined();
    // 收件箱已经读回来了（同一页上批准过的那条照样画结果行），拒绝的这条仍然没有。
    await settleReactWork();
    expect(view.container.querySelector("[data-approval-outcome]")).toBeNull();
    expect(view.queryByText(/已拒绝/)).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("region", { name: "等你批准" })).toBeNull();
    cleanup();
  }
  // 对照：同样的数据，批准的那条有结果行。
  const approved = drawFresh("call-approved");
  expect(
    await approved.findByText("已允许一次：保存文件 notes.txt"),
  ).toBeDefined();
});

test("the standing answers name where they hold", async () => {
  serving();
  let view = drawFresh("call-always");
  expect(
    await view.findByText("已在这里总是允许：保存文件 a.txt"),
  ).toBeDefined();
  cleanup();
  view = drawFresh("call-conversation");
  expect(
    await view.findByText("已在这段对话里都允许：保存文件 b.txt"),
  ).toBeDefined();
});

test("a request still waiting draws the card, not an outcome", async () => {
  serving();
  const view = drawFresh("call-waiting");
  expect(await view.findByRole("region", { name: "等你批准" })).toBeDefined();
  expect(view.container.querySelector("[data-approval-outcome]")).toBeNull();
  expect(view.queryByText("保存了文件")).toBeNull();
});

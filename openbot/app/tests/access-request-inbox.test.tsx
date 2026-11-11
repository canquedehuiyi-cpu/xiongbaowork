import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AccessRequestInbox } from "@/components/approvals/access-requests";
import { RequestError } from "@/lib/client";
import { accessRequestQueryOptions } from "@/lib/plugins/access-requests";

/**
 * 管理员的访问申请收件箱（审批页上，紧挨着审批收件箱）：列出待处理的申请，批准或驳回。
 * 服务端拒绝时，它的中文原因显示在那条申请上，申请留在列表里。普通成员看不到这一块。
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "admin";
/** 批准后这条申请是否已从待处理列表里消失（被撤回或驳回）。 */
let goneAfterApprove = false;
let approveAnswer: { status: number; body: unknown } = {
  status: 200,
  body: { granted: [] },
};
const sent: { path: string; method: string }[] = [];
const requested: string[] = [];

const pending = [
  {
    id: "r1",
    appKey: "notion",
    appTitle: "Notion",
    botId: "bot-1",
    botName: "小助理",
    requesterUserId: "u1",
    requesterName: "王小明",
    requesterEmail: "wang@example.test",
    kind: "enable",
    status: "pending",
    note: "要查项目文档",
    createdAt: new Date().toISOString(),
  },
  {
    id: "r2",
    appKey: "linear",
    appTitle: "Linear",
    botId: "bot-2",
    botName: null,
    requesterUserId: "u2",
    requesterName: null,
    requesterEmail: "li@example.test",
    kind: "grant",
    status: "pending",
    note: null,
    createdAt: new Date().toISOString(),
  },
];

beforeEach(() => {
  sent.length = 0;
  requested.length = 0;
  role = "admin";
  approveAnswer = { status: 200, body: { granted: [] } };
  goneAfterApprove = false;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      requested.push(url);
      if (init?.method && init.method !== "GET") {
        sent.push({ path: url, method: init.method });
        if (url.endsWith("/approve")) {
          if (goneAfterApprove) pending.splice(0, 1);
          return Response.json(approveAnswer.body, {
            status: approveAnswer.status,
          });
        }
        return Response.json({ request: {} });
      }
      if (url === "/api/plugins/access-requests")
        return Response.json({ requests: pending });
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AccessRequestInbox />
    </QueryClientProvider>,
  );
}

test("an administrator sees each pending request: the app, who asked, for which coworker, and why", async () => {
  const view = draw();
  await view.findByText("Notion");
  expect(view.getByText("访问申请")).toBeTruthy();
  expect(
    view.getByText("王小明 替员工「小助理」申请上架这个应用"),
  ).toBeTruthy();
  // 理由是员工（模型）写的，不是申请人的原话，标签要说清楚（评审 M-3）。
  expect(view.getByText("员工给出的理由：要查项目文档")).toBeTruthy();
  expect(view.getByText(/替正在使用它的人申请/)).toBeTruthy();
  expect(
    view.getByText("li@example.test 替员工「bot-2」申请把这个应用授予这位员工"),
  ).toBeTruthy();
});

test("X 系列：Team Bot 的申请显示批准范围（scopeNote），私人员工的申请写出申请人是谁", async () => {
  const note =
    "批准将对整个 Team Bot 生效：授予写在员工身上，每一个能用这位员工的人都会拿到它，不只是申请人。申请人是使用这位员工的队友，不是它的主人。";
  pending.push(
    {
      ...pending[0],
      id: "r3",
      appTitle: "Jira",
      requesterName: "赵六",
      appliesTo: "team_bot",
      requesterRole: "teammate",
      scopeNote: note,
    } as (typeof pending)[number],
    {
      ...pending[0],
      id: "r4",
      appTitle: "Figma",
      requesterName: "钱七",
      appliesTo: "bot",
      requesterRole: "owner",
      scopeNote: null,
    } as (typeof pending)[number],
  );
  try {
    const view = draw();
    await view.findByText("Jira");
    expect(view.getByText(note)).toBeTruthy();
    // scopeNote 已经说了申请人是谁，描述里不再重复。
    expect(
      view.getByText("赵六 替员工「小助理」申请上架这个应用"),
    ).toBeTruthy();
    expect(
      view.getByText("钱七（员工的主人） 替员工「小助理」申请上架这个应用"),
    ).toBeTruthy();
  } finally {
    pending.splice(2);
  }
});

test("approve and dismiss post to the request's own routes", async () => {
  const view = draw();
  await view.findByText("Notion");
  fireEvent.click(
    view.getAllByRole("button", { name: "批准" })[0] as HTMLElement,
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/plugins/access-requests/r1/approve",
      method: "POST",
    }),
  );
  fireEvent.click(
    view.getAllByRole("button", { name: "驳回" })[1] as HTMLElement,
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/plugins/access-requests/r2/dismiss",
      method: "POST",
    }),
  );
});

test("an approval the server could not carry out shows its reason on that request, which stays", async () => {
  approveAnswer = {
    status: 409,
    body: { error: "「Linear」没有标为只读的动作，在这里批准什么也授予不了。" },
  };
  const view = draw();
  await view.findByText("Linear");
  fireEvent.click(
    view.getAllByRole("button", { name: "批准" })[1] as HTMLElement,
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "「Linear」没有标为只读的动作，在这里批准什么也授予不了。",
  );
  expect(view.getByText("Linear")).toBeTruthy();
});

test("a member is shown nothing, and the inbox is never asked for", async () => {
  role = "user";
  const view = draw();
  await waitFor(() => expect(requested).toContain("/api/me"));
  expect(view.queryByText("访问申请")).toBeNull();
  expect(requested).not.toContain("/api/plugins/access-requests");
});

test("listed but withdrawn meanwhile: the server's sentence stays on screen after the request leaves the list", async () => {
  const sentence =
    "「Notion」已上架，但这条申请在此期间已被撤回或驳回，申请状态未改。如不需要，请到插件页下架。";
  approveAnswer = { status: 409, body: { error: sentence, applied: true } };
  goneAfterApprove = true;
  const view = draw();
  await view.findByText("Notion");
  fireEvent.click(
    view.getAllByRole("button", { name: "批准" })[0] as HTMLElement,
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(sentence);
  await waitFor(() => expect(view.queryByText("Notion")).toBeNull());
  expect(view.getByRole("alert").textContent).toContain(sentence);
});

test("a request somebody else cannot read is not retried: a 404 is an answer", () => {
  const retry = accessRequestQueryOptions("req-x").retry as (
    count: number,
    error: Error,
  ) => boolean;
  expect(retry(0, new RequestError("没有这条申请。", 404))).toBe(false);
  expect(retry(0, new RequestError("出错了", 502))).toBe(true);
  expect(retry(3, new RequestError("出错了", 502))).toBe(false);
});

test("with nothing waiting, it says so", async () => {
  pending.splice(0, pending.length);
  const view = draw();
  await view.findByText("没有待处理的访问申请。");
});

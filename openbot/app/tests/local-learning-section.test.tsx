import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  LocalLearningOverview,
  LocalSkillCandidateDetail,
  LocalSkillCandidateSummary,
} from "@openbot/shared/local-learning";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LocalLearningSection } from "@/components/settings/local-learning-section";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

type Call = { method: string; url: string; body: unknown };
/** 除 GET 之外的每个请求，按发出的顺序。 */
const writes: Call[] = [];

/** 每个地址对一个写请求的回答；没有写的用默认回答。 */
let answers: Record<string, () => Response> = {};
let overview: LocalLearningOverview;

const pending: LocalSkillCandidateSummary = {
  id: "cand-1",
  agentId: "agent-1",
  agentName: "小助手",
  slug: "weekly-report",
  title: "整理周报",
  summary: "把本周的进展整理成周报。",
  status: "pending_review",
  skillSlug: null,
  createdAt: "2026-11-09T08:00:00Z",
  reviewedAt: null,
};

const detail: LocalSkillCandidateDetail = {
  ...pending,
  instructions: "1. 读本周的对话。\n2. 按项目列出进展。",
  reason: "你这个月让小助手整理了四次周报。",
  evidence: [
    {
      threadId: "t1",
      runId: "r1",
      at: "2026-11-03T09:00:00Z",
      name: "周一例会",
      exists: true,
    },
    {
      threadId: "t2",
      runId: "r2",
      at: "2026-11-04T09:00:00Z",
      name: null,
      exists: false,
    },
  ],
};

function baseOverview(): LocalLearningOverview {
  return {
    available: true,
    enabled: true,
    running: false,
    nextRunAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
    lastRun: {
      startedAt: "2026-11-09T07:00:00Z",
      finishedAt: "2026-11-09T07:01:00Z",
      outcome: "proposed",
      skipReason: null,
      runsRead: 12,
      candidates: 1,
    },
    pending: [pending],
    reviewed: [
      {
        ...pending,
        id: "cand-0",
        title: "查订单",
        status: "approved",
        skillSlug: "find-order",
        reviewedAt: "2026-11-08T07:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  queryClient.clear();
  writes.length = 0;
  answers = {};
  overview = baseOverview();
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        if (url === "/api/local-learning") return Response.json(overview);
        if (url === "/api/local-learning/candidates/cand-1")
          return Response.json({ candidate: detail });
        if (url === "/api/plugins") return Response.json({ skills: [] });
        return new Response(null, { status: 404 });
      }
      writes.push({
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const answer = answers[url];
      if (answer) return answer();
      if (url === "/api/local-learning")
        return Response.json({ ...overview, enabled: false });
      if (url.endsWith("/approve"))
        return Response.json({
          candidate: { ...pending, status: "approved" },
        });
      if (url.endsWith("/reject"))
        return Response.json({
          candidate: { ...pending, status: "rejected" },
        });
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <LocalLearningSection />
    </QueryClientProvider>,
  );
}

async function openCandidate(view: ReturnType<typeof draw>) {
  fireEvent.click(await view.findByText("整理周报"));
  await view.findByText("你这个月让小助手整理了四次周报。");
}

test("这个部署没开启时只说明这一句", async () => {
  overview = { ...baseOverview(), available: false };
  const view = draw();
  expect(await view.findByText("这个部署没有开启从对话中学习。")).toBeTruthy();
  expect(view.queryByRole("switch")).toBeNull();
  expect(view.queryByText("现在学一次")).toBeNull();
});

test("显示上次学习的结果、待批准的草案和处理过的草案", async () => {
  const view = draw();
  expect(await view.findByText(/提出了 1 条草案。/)).toBeTruthy();
  expect(view.getByText(/^下次学习：/)).toBeTruthy();
  expect(view.getByText("把本周的进展整理成周报。")).toBeTruthy();
  expect(view.getByText("小助手")).toBeTruthy();
  expect(view.getByText(/^已批准（\/find-order）/)).toBeTruthy();
});

test("跳过时用跳过的原因说明", async () => {
  overview = {
    ...baseOverview(),
    lastRun: {
      startedAt: "2026-11-09T07:00:00Z",
      finishedAt: "2026-11-09T07:00:01Z",
      outcome: "skipped",
      skipReason: "no_evidence",
      runsRead: 0,
      candidates: 0,
    },
    pending: [],
  };
  const view = draw();
  expect(
    await view.findByText(/最近的对话还不够多，看不出反复出现的做法。/),
  ).toBeTruthy();
  expect(view.getByText("没有等你批准的草案")).toBeTruthy();
});

test("开关发 PUT", async () => {
  const view = draw();
  const toggle = await view.findByRole("switch", { name: "从对话中学习" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toEqual([
      { method: "PUT", url: "/api/local-learning", body: { enabled: false } },
    ]),
  );
});

test("「现在学一次」发 POST，开始后给出提示", async () => {
  answers["/api/local-learning/learn"] = () =>
    Response.json({ started: true }, { status: 202 });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "现在学一次" }));
  const status = await view.findByRole("status");
  expect(status.textContent).toBe("开始学习了，学完后草案会出现在这里。");
  expect(writes).toEqual([
    { method: "POST", url: "/api/local-learning/learn", body: null },
  ]);
});

test("「现在学一次」被拒时显示服务端的说法", async () => {
  answers["/api/local-learning/learn"] = () =>
    Response.json({ error: "正在学习，请稍后再看。" }, { status: 409 });
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "现在学一次" }));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("正在学习，请稍后再看。");
  expect(view.queryByRole("status")).toBeNull();
});

test("正在学习时按钮不能按，并说明正在学习", async () => {
  overview = { ...baseOverview(), running: true };
  const view = draw();
  const button = await view.findByRole("button", { name: "正在学习…" });
  expect(button.hasAttribute("disabled")).toBe(true);
});

test("对话框显示原因、步骤和来自的对话", async () => {
  const view = draw();
  await openCandidate(view);
  expect(view.getByText(/1\. 读本周的对话。/)).toBeTruthy();
  expect(view.getByText("周一例会")).toBeTruthy();
  expect(view.getByText("已删除的对话")).toBeTruthy();
  const slug = view.getByLabelText("命令名") as HTMLInputElement;
  expect(slug.value).toBe("weekly-report");
});

test("命令名不合规则时不能批准", async () => {
  const view = draw();
  await openCandidate(view);
  fireEvent.change(view.getByLabelText("命令名"), {
    target: { value: "Weekly Report" },
  });
  expect(
    await view.findByText("只能用小写字母、数字和连字符，2 到 40 个字符。"),
  ).toBeTruthy();
  const approve = view.getByRole("button", { name: "批准并交给员工" });
  expect(approve.hasAttribute("disabled")).toBe(true);
});

test("批准按存技能、交给员工、记为已批准的顺序调用", async () => {
  const view = draw();
  await openCandidate(view);
  fireEvent.change(view.getByLabelText("命令名"), {
    target: { value: "weekly-report-2" },
  });
  fireEvent.click(view.getByRole("button", { name: "批准并交给员工" }));
  expect(await view.findByText("已把技能交给小助手。")).toBeTruthy();
  expect(writes).toEqual([
    {
      method: "POST",
      url: "/api/plugins/skills",
      body: {
        slug: "weekly-report-2",
        title: "整理周报",
        summary: "把本周的进展整理成周报。",
        instructions: "1. 读本周的对话。\n2. 按项目列出进展。",
        tools: [],
      },
    },
    {
      method: "POST",
      url: "/api/plugins/grants",
      body: { kind: "skill", ref: "weekly-report-2", agentId: "agent-1" },
    },
    {
      method: "POST",
      url: "/api/local-learning/candidates/cand-1/approve",
      body: { slug: "weekly-report-2" },
    },
  ]);
  expect(view.queryByRole("dialog")).toBeNull();
});

test("技能存下了但没能交给员工时说清楚，并且不记为已批准", async () => {
  answers["/api/plugins/grants"] = () =>
    Response.json({ error: "There is no such Bot." }, { status: 403 });
  const view = draw();
  await openCandidate(view);
  fireEvent.click(view.getByRole("button", { name: "批准并交给员工" }));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "技能已保存，但没能交给这位员工：There is no such Bot.",
  );
  expect(writes.map((call) => call.url)).toEqual([
    "/api/plugins/skills",
    "/api/plugins/grants",
  ]);
});

test("存技能失败时停下，显示那一步的说法", async () => {
  answers["/api/plugins/skills"] = () =>
    Response.json(
      { error: "weekly-report is somebody else's skill." },
      { status: 403 },
    );
  const view = draw();
  await openCandidate(view);
  fireEvent.click(view.getByRole("button", { name: "批准并交给员工" }));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("weekly-report is somebody else's skill.");
  expect(writes.map((call) => call.url)).toEqual(["/api/plugins/skills"]);
});

test("「不要这一条」发 reject", async () => {
  const view = draw();
  await openCandidate(view);
  fireEvent.click(view.getByRole("button", { name: "不要这一条" }));
  expect(await view.findByText("已拒绝这条草案。")).toBeTruthy();
  expect(writes).toEqual([
    {
      method: "POST",
      url: "/api/local-learning/candidates/cand-1/reject",
      body: null,
    },
  ]);
});

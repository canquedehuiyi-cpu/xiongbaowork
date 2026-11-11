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
  LearningProposal,
  LearningProposalDetail,
  PersonalReview,
} from "@openbot/shared/learning";
import {
  environmentManager,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LearningReview } from "@/components/settings/learning-review";
import {
  personalLearningQueryOptions,
  personalReviewQueryOptions,
} from "@/lib/learning/queries";
import { queryClient } from "@/query-client";
import { LearningSettingsPage } from "@/routes/_authed/settings/learning";

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
let review: PersonalReview | null;
let insights: LearningProposalDetail["insights"] = [];
let detailOperation: LearningProposal["operation"] = "add";
const posts: string[] = [];
const puts: { url: string; body: unknown }[] = [];

const proposal = (
  id: string,
  title: string,
  operation: LearningProposal["operation"],
  status: LearningProposal["status"] = "pending_review",
): LearningProposal => ({
  id,
  title,
  description: `${title} description`,
  reason: "Seen in your recordings.",
  operation,
  status,
  createdAt: "2026-11-01T00:00:00Z",
  reviewedAt: null,
});

// A team has no automatic approval (autoApprove null); the personal edition has it on or off.
const body = (
  canReview: boolean,
  autoApprove: boolean | null = null,
): PersonalReview => ({
  canReview,
  autoApprove,
  sources: [
    {
      containerId: "user-1",
      kind: "recordings",
      label: "From your recordings",
      latestRun: null,
      proposals: [
        proposal("p1", "refund-order", "add"),
        proposal("p2", "close-ticket", "update"),
        proposal("p3", "old-skill", "remove"),
        proposal("p4", "done-skill", "add", "approved"),
      ],
    },
  ],
});

beforeEach(() => {
  queryClient.clear();
  posts.length = 0;
  puts.length = 0;
  review = body(false);
  insights = [];
  detailOperation = "add";
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (url === "/api/settings/learning/review") return Response.json(review);
      if (url === "/api/capabilities")
        return Response.json({ edition: "personal" });
      if (url === "/api/settings/learning")
        return Response.json({
          mode: "closed",
          sharingAllowed: true,
          skills: [],
        });
      if (method === "PUT") {
        const sent = JSON.parse(String(init?.body));
        puts.push({ url, body: sent });
        return Response.json(sent);
      }
      const detail =
        /^\/api\/settings\/learning\/proposals\/([^/?]+)\?container=(.+)$/.exec(
          url,
        );
      if (detail && method === "GET")
        return Response.json({
          proposal: {
            ...proposal(detail[1] ?? "", "refund-order", detailOperation),
            files: [{ path: "SKILL.md", content: "Look up the order." }],
            insights,
          },
        });
      if (method === "POST") {
        posts.push(url);
        return Response.json({ proposal: { id: "p1", status: "approved" } });
      }
      return new Response(null, { status: 404 });
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
      <LearningReview />
    </QueryClientProvider>,
  );
}

test("lists the pending proposals with what each does", async () => {
  const view = draw();
  await view.findByText("等管理员审核");
  expect(await view.findByText("新技能")).toBeTruthy();
  expect(view.getByText("更新「Close ticket」")).toBeTruthy();
  expect(view.getByText("删除「Old skill」")).toBeTruthy();
  expect(view.queryByText("Done skill")).toBeNull();
});

test("with admins approving, a person's pending proposal opens read-only", async () => {
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  await view.findByText("Look up the order.");
  expect(view.queryByText("批准并发布")).toBeNull();
  expect(view.getByText("完成")).toBeTruthy();
  expect(view.getByText(/这些由管理员审核/)).toBeTruthy();
});

test("with people approving, a person approves from the dialog", async () => {
  review = body(true);
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  fireEvent.click(await view.findByText("批准并发布"));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/proposals/p1/approve?container=user-1",
    ]),
  );
  expect(
    await view.findByText("已发布。你的员工从下一段对话起就会用它。"),
  ).toBeTruthy();
});

test("says so when proposals couldn't be read", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
      },
    ],
  };
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("读不到为你建议的技能。请刷新页面。");
});

test("says some were unreadable when another source was read", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
      },
      {
        containerId: "user-2",
        kind: "recordings",
        label: "More recordings",
        latestRun: null,
        proposals: [],
      },
    ],
  };
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("有些为你建议的技能读不到");
});

test("on a team, says what to expect when nothing is waiting", async () => {
  review = { canReview: true, autoApprove: null, sources: [] };
  const view = draw();
  expect(await view.findByText("没有待审核的内容")).toBeTruthy();
  expect(
    await view.findByText("学习分析完你的录制后，新建议会出现在这里。"),
  ).toBeTruthy();
});

test("in the personal edition the empty state mentions conversations", async () => {
  review = { canReview: true, autoApprove: false, sources: [] }; // personal: autoApprove is a boolean
  const view = draw();
  expect(
    await view.findByText("学习分析完你的录制和对话后，新建议会出现在这里。"),
  ).toBeTruthy();
});

test("with people approving, the latest run shows and Learn now starts one", async () => {
  review = body(true);
  const first = review.sources[0];
  if (first)
    first.latestRun = {
      id: "run-1",
      status: "succeeded",
      trigger: "manual",
      proposals: 2,
      insights: null,
      failureCode: null,
      createdAt: "2026-11-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
  const view = draw();
  expect(await view.findByText("最近一次运行：已完成。")).toBeTruthy();
  fireEvent.click(await view.findByRole("button", { name: "立即学习" }));
  await waitFor(() =>
    expect(posts).toEqual(["/api/settings/learning/runs?container=user-1"]),
  );
  const busy = await view.findByRole("button", {
    name: "正在学习…",
  });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  expect(view.queryByText(/Learning started/)).toBeNull();
});

test("a failed run says why, not only that it failed", async () => {
  review = body(true);
  const first = review.sources[0];
  const why =
    "Learning couldn't reach OpenBot to use your model plan. Quit OpenBot and open it again, then choose Learn now.";
  if (first)
    first.latestRun = {
      id: "run-1",
      status: "failed",
      trigger: "manual",
      proposals: null,
      insights: null,
      failureCode: "BatchInsightAgentFailed",
      failure: why,
      createdAt: "2026-11-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
  const view = draw();
  expect(await view.findByText(`最近一次运行：失败。 ${why}`)).toBeTruthy();
});

const run = (id: string, createdAt: string) => ({
  id,
  status: "succeeded" as const,
  trigger: "manual" as const,
  proposals: 1,
  insights: null,
  failureCode: null,
  createdAt,
  startedAt: null,
  completedAt: null,
});

test("turning automatic approval off shows proposals from recordings and from conversations to review", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: [proposal("p1", "refund-order", "add")],
      },
      {
        containerId: "user-1-chat",
        kind: "conversations",
        label: "From your conversations",
        latestRun: run("run-2", "2026-11-02T00:00:00Z"),
        proposals: [proposal("p5", "reply-politely", "add")],
      },
    ],
  };
  const view = draw();
  expect(await view.findByText("From your recordings")).toBeTruthy();
  expect(view.getByText("From your conversations")).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.getByText("Reply politely")).toBeTruthy();
  expect(view.getByText("还没运行过。")).toBeTruthy();
  expect(view.getByText("最近一次运行：已完成。")).toBeTruthy();
  const buttons = view.getAllByRole("button", { name: "立即学习" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1] as HTMLElement);
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/runs?container=user-1-chat",
    ]),
  );
});

test("sources with the same label make one group with one Learn now", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: ["a", "b"].map((id) => ({
      containerId: `bot-${id}`,
      kind: "conversations" as const,
      label: "From your conversations",
      latestRun: null,
      proposals: [proposal(`p-${id}`, `skill-${id}`, "add")],
    })),
  };
  const view = draw();
  expect(await view.findByText("Skill a")).toBeTruthy();
  expect(view.getAllByText("From your conversations")).toHaveLength(1);
  fireEvent.click(view.getByText("Skill b"));
  fireEvent.click(await view.findByText("批准并发布"));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/proposals/p-b/approve?container=bot-b",
    ]),
  );
  posts.length = 0;
  fireEvent.click(await view.findByText("完成"));
  fireEvent.click(await view.findByRole("button", { name: "立即学习" }));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/runs?container=bot-a",
      "/api/settings/learning/runs?container=bot-b",
    ]),
  );
});

test("Learn now starts every source in the group even when one fails", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: ["a", "b"].map((id) => ({
      containerId: `bot-${id}`,
      kind: "conversations" as const,
      label: "From your conversations",
      latestRun: null,
      proposals: [],
    })),
  };
  const ok = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (
        String(path) === "/api/settings/learning/runs?container=bot-a" &&
        init?.method === "POST"
      ) {
        posts.push(String(path));
        return Response.json({ error: "Nope" }, { status: 500 });
      }
      return ok(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "立即学习" }));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/runs?container=bot-a",
      "/api/settings/learning/runs?container=bot-b",
    ]),
  );
  expect((await view.findByRole("alert")).textContent).toBe("Nope");
});

test("with admins approving, there is no Learn now", async () => {
  const view = draw();
  await view.findByText("等管理员审核");
  expect(view.queryByRole("button", { name: "立即学习" })).toBeNull();
  expect(view.queryByText(/最近一次运行/)).toBeNull();
});

test("evidence names the recording by its title", async () => {
  const recording = (id: string, title: string | null) => ({
    kind: "recording" as const,
    id,
    title,
    available: true,
    eventCount: 2,
    events: ["Open the order", "Click Refund"],
  });
  insights = [
    {
      id: "i1",
      statement: "Refunds start from the order page.",
      impact: "Faster refunds.",
      evidence: [recording("r1", "Refund an order"), recording("r2", null)],
    },
  ];
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  expect(await view.findByText("Refund an order")).toBeTruthy();
  expect(view.getByText("一段录制")).toBeTruthy();
  expect(view.getAllByText("Open the order、Click Refund")).toHaveLength(2);
});

test("the personal edition shows Learning with automatic approval on and no sharing", async () => {
  const base = body(true);
  review = {
    ...base,
    autoApprove: true,
    sources: base.sources.map((source) => ({ ...source, proposals: [] })),
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LearningSettingsPage />
    </QueryClientProvider>,
  );
  const approve = await view.findByRole("switch", {
    name: "自动批准新技能",
  });
  expect(approve.getAttribute("aria-checked")).toBe("true");
  await view.findByText("你的技能");
  expect(view.queryByText("还有谁的员工能用你的技能")).toBeNull();
  expect(view.getByRole("button", { name: "立即学习" })).toBeTruthy();
  expect(view.queryByText("没有待审核的内容")).toBeNull();
  fireEvent.click(approve);
  await waitFor(() =>
    expect(puts).toEqual([
      {
        url: "/api/settings/learning/auto-approve",
        body: { autoApprove: false },
      },
    ]),
  );
});

test("Waiting for your review shows only once a skill is waiting, not while Learning runs with automatic approval on", async () => {
  const base = body(true, true);
  const source = (
    proposals: LearningProposal[],
    status: "batching" | null,
  ) => ({
    ...base.sources[0]!,
    latestRun: status
      ? { ...run("run-1", "2026-11-01T00:00:00Z"), status }
      : run("run-1", "2026-11-01T00:00:00Z"),
    proposals,
  });
  review = { ...base, sources: [source([], "batching")] };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LearningSettingsPage />
    </QueryClientProvider>,
  );
  await view.findByRole("button", { name: "Learning in progress…" });
  await view.findByText("Your skills");
  expect(view.queryByText("Waiting for your review")).toBeNull();
  expect(view.queryByText(/Approve a skill to publish it/)).toBeNull();
  expect(view.getByRole("heading", { name: "New skills" })).toBeTruthy();

  // The run finished and its skill was approved automatically: still nothing waits.
  review = { ...base, sources: [source([], null)] };
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  await view.findByRole("button", { name: "Learn now" });
  expect(view.queryByText("Waiting for your review")).toBeNull();

  // One skill is waiting: now the heading says so.
  review = {
    ...base,
    sources: [source([proposal("p1", "refund-order", "add")], null)],
  };
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  expect(
    await view.findByRole("heading", { name: "Waiting for your review" }),
  ).toBeTruthy();
  expect(
    view.getByText("Approve a skill to publish it to your Bots."),
  ).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.queryByRole("heading", { name: "New skills" })).toBeNull();
});

test("with nothing waiting, the empty state shows under New skills, not under a Waiting heading", async () => {
  review = { canReview: true, autoApprove: false, sources: [] };
  const view = draw();
  expect(await view.findByText("Nothing to review")).toBeTruthy();
  expect(view.queryByText("Waiting for your review")).toBeNull();
  expect(view.getByRole("heading", { name: "New skills" })).toBeTruthy();
  cleanup();
  queryClient.clear();

  // On a team where admins approve, the same rule holds for Waiting for an admin.
  review = { canReview: false, autoApprove: null, sources: [] };
  const team = draw();
  expect(await team.findByText("Nothing to review")).toBeTruthy();
  expect(team.queryByText("Waiting for an admin")).toBeNull();
});

test("a source Learning is off for says so plainly, without the read failure alert", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
        unavailable: "learning-off",
      },
    ],
  };
  const view = draw();
  expect(
    await view.findByText("后端没有提供学习功能，所以这里不会有建议。"),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText("没有待审核的内容")).toBeNull();
});

test("when only some sources are unavailable, the empty state is hidden and the notice names them", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      {
        containerId: "user-1",
        kind: "recordings",
        label: "From your recordings",
        latestRun: null,
        proposals: null,
        unavailable: "learning-off",
      },
      {
        containerId: "user-2",
        kind: "conversations",
        label: "From your conversations",
        latestRun: null,
        proposals: [],
      },
    ],
  };
  const view = draw();
  expect(
    await view.findByText(
      "From your recordings没有提供学习功能，所以那里不会有建议。",
    ),
  ).toBeTruthy();
  expect(view.queryByText("没有待审核的内容")).toBeNull();
});

test("a Learn now failure in one group does not show in another", async () => {
  review = {
    canReview: true,
    autoApprove: false,
    sources: ["a", "b"].map((id) => ({
      containerId: `src-${id}`,
      kind: "conversations" as const,
      label: `Group ${id}`,
      latestRun: null,
      proposals: [],
    })),
  };
  const ok = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (
        String(path) === "/api/settings/learning/runs?container=src-a" &&
        init?.method === "POST"
      )
        return Response.json({ error: "Nope" }, { status: 500 });
      return ok(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  const buttons = await view.findAllByRole("button", { name: "立即学习" });
  fireEvent.click(buttons[0] as HTMLElement);
  expect((await view.findByRole("alert")).textContent).toBe("Nope");
  fireEvent.click(view.getAllByRole("button", { name: "立即学习" })[1]!);
  await view.findByRole("button", { name: "正在学习…" });
  // Group b's start does not wipe or borrow group a's failure, and a's button comes back.
  expect(view.getByRole("alert").textContent).toBe("Nope");
  expect(view.getAllByRole("button", { name: "立即学习" })).toHaveLength(1);
});

test("Learn now stays disabled until the run it started has finished", async () => {
  review = body(true);
  const first = review.sources[0];
  if (first) first.latestRun = run("run-1", "2026-11-01T00:00:00Z");
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "立即学习" }));
  await view.findByRole("button", { name: "正在学习…" });
  const next = review.sources[0];
  if (next)
    next.latestRun = {
      ...run("run-2", "2026-11-02T00:00:00Z"),
      status: "batching",
    };
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  await view.findByText("最近一次运行：正在分析。");
  expect(
    (
      view.getByRole("button", {
        name: "正在学习…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  if (next) next.latestRun = run("run-2", "2026-11-02T00:00:00Z");
  await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
  await view.findByText("最近一次运行：已完成。");
  expect(
    (view.getByRole("button", { name: "立即学习" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("a run already going shows Learning in progress, disabled", async () => {
  review = body(true);
  const first = review.sources[0];
  if (first)
    first.latestRun = {
      ...run("run-1", "2026-11-01T00:00:00Z"),
      status: "queued",
    };
  const view = draw();
  const busy = await view.findByRole("button", {
    name: "正在学习…",
  });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
});

test("a source that failed to read still alerts next to one that is unavailable", async () => {
  const source = (id: string) => ({
    containerId: id,
    kind: "recordings" as const,
    label: `Source ${id}`,
    latestRun: null,
  });
  review = {
    canReview: true,
    autoApprove: false,
    sources: [
      { ...source("a"), proposals: null, unavailable: "learning-off" },
      { ...source("b"), proposals: null },
    ],
  };
  const view = draw();
  expect((await view.findByRole("alert")).textContent).toBe(
    "读不到为你建议的技能。请刷新页面。",
  );
});

test("the review is read again every ten seconds only while a run is going", () => {
  const options = personalReviewQueryOptions();
  const interval = (status: string | null) => {
    const data = {
      canReview: true,
      autoApprove: false,
      sources: [
        {
          containerId: "user-1",
          kind: "recordings",
          label: "From your recordings",
          proposals: [],
          latestRun: status ? { status } : null,
        },
      ],
    };
    const refetchInterval = options.refetchInterval as (
      query: unknown,
    ) => unknown;
    return refetchInterval({ state: { data } });
  };
  expect(interval("batching")).toBe(10_000);
  expect(interval("queued")).toBe(10_000);
  expect(interval("succeeded")).toBe(false);
  expect(interval("failed")).toBe(false);
  expect(interval(null)).toBe(false);
});

test("when a refetch finds fewer proposals waiting, Your skills is refreshed", async () => {
  review = body(true);
  const view = draw();
  await view.findByText("Refund order");
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return original(filters as never);
  }) as typeof queryClient.invalidateQueries;
  try {
    review = {
      ...body(true),
      sources: [
        {
          ...body(true).sources[0]!,
          proposals: [proposal("p1", "refund-order", "add", "approved")],
        },
      ],
    };
    await queryClient.invalidateQueries({ queryKey: ["learning", "review"] });
    await waitFor(() =>
      expect(invalidated).toContainEqual(["learning", "personal"]),
    );
  } finally {
    queryClient.invalidateQueries = original;
  }
});

test("skills approved while opening refresh Your skills on the first load", async () => {
  review = { ...body(true), approved: 1 };
  let skillsReads = 0;
  const inner = global.fetch;
  global.fetch = Object.assign(
    (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(path) === "/api/settings/learning") skillsReads += 1;
      return inner(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  // Your skills sits next to this section on the page, so its query is watched.
  const watcher = new QueryObserver(
    queryClient,
    personalLearningQueryOptions(),
  );
  const unsubscribe = watcher.subscribe(() => {});
  try {
    const view = draw();
    await view.findByText("Refund order");
    await waitFor(() => expect(skillsReads).toBeGreaterThanOrEqual(2));
  } finally {
    unsubscribe();
  }
});

test("a removal proposal says approve removal, then removed", async () => {
  review = body(true);
  detailOperation = "remove";
  const view = draw();
  fireEvent.click(await view.findByText("Old skill"));
  expect(view.queryByText("批准并发布")).toBeNull();
  fireEvent.click(await view.findByText("批准删除"));
  expect(
    await view.findByText("已删除。员工从下一段对话起不再用它。"),
  ).toBeTruthy();
  expect(view.queryByText(/已发布/)).toBeNull();
});

test("a recording without named steps says 1 step, then 2 steps", async () => {
  const recording = (id: string, eventCount: number) => ({
    kind: "recording" as const,
    id,
    title: `Recording ${id}`,
    available: true,
    eventCount,
    events: [],
  });
  insights = [
    {
      id: "i1",
      statement: "Refunds start from the order page.",
      impact: "Faster refunds.",
      evidence: [recording("r1", 1), recording("r2", 2)],
    },
  ];
  review = body(false);
  const view = draw();
  fireEvent.click(await view.findByText("Refund order"));
  expect(await view.findByText("1 个步骤")).toBeTruthy();
  expect(view.getByText("2 个步骤")).toBeTruthy();
});

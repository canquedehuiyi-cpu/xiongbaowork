/*
 * One employee, one detail page (user decision: 合并成一个详情页). /wakers/$agentId holds what the
 * old /bots/$agentId profile had — the 对你 controls, the activity feed, tool permissions and where
 * updates go — next to its own sections, and /bots/$agentId redirects there.
 *
 * M4 brought upstream v1.0.0's Bot page onto it: what the employee waits on the person for (需要你),
 * a glance at its activity with the full lists one row away on /bots/$agentId/activity, the tasks
 * marked done this week, its memory sources and check-ins, and the 运行方式 rows (framework, a
 * computer of its own, the starter's instructions).
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentProfile } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import type {
  AgentAuditEvent,
  AgentAuditPage,
} from "@/lib/bot-lifecycle/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import type { BotTask } from "@/lib/tasks/queries";
import { Route as BotProfileRoute } from "@/routes/_authed/_app/bots.$agentId";
import { Route as BotActivityRoute } from "@/routes/_authed/_app/bots.$agentId.activity";
import { Route as WakerDetailRoute } from "@/routes/_authed/_app/wakers_.$agentId";
import { settleReactWork } from "./settle-react-work";

/**
 * Story D5 at the screen a person reaches from a coworker's card: its duties, its running tasks,
 * its skill grants and its recent audit trail, each read from the endpoint that already serves it.
 *
 * The network is faked at `fetch`, not seeded into the cache, because half of what is worth asserting
 * is what the page asks for: the board narrowed to this executor and to `running`, and the audit
 * trail paged on the server's own cursor.
 */
let registeredHere = false;
beforeAll(() => {
  // One happy-dom global per process; see wakers-screen.test.tsx for why this is guarded.
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(async () => {
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;
const calls: { method: string; path: string; body?: unknown }[] = [];

const agentId = "agent-1";
const meId = "user-me";

const profile: AgentProfile = {
  id: agentId,
  name: "Backend Engineer",
  title: "后端工程师",
  roleDescription: "负责数据库迁移和接口。",
  avatarSeed: "a1",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  framework: "OpenBot",
};

const duty = (
  id: string,
  owner: string,
  title: string,
): ResponsibilityRecord => ({
  id,
  agentId: owner,
  channelId: "c1",
  threadId: "t1",
  title,
  instruction: `${title}的说明`,
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const routine = (id: string, owner: string, instruction: string) =>
  ({
    id,
    agentId: owner,
    schedule: "0 9 * * *",
    timezone: "Asia/Shanghai",
    instruction,
    title: null,
    channel: { id: "c1", name: "日报", title: null, gone: false },
    enabled: true,
    nextRunAt: "2026-11-03T01:00:00.000Z",
    lastRun: null,
  }) satisfies RoutineRecord;

const event = (
  id: string,
  eventType: string,
  actorUserId: string | null,
  initiatorKind = "person",
): AgentAuditEvent => ({
  id,
  eventType,
  actorUserId,
  initiatorKind,
  initiatorId: null,
  targetType: "agent",
  targetId: agentId,
  payload: {},
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

type Answer = { status: number; body: unknown } | "hang";
const ok = (body: unknown): Answer => ({ status: 200, body });

type Answers = {
  agent: Answer;
  duties: Answer;
  routines: Answer;
  tasks: Answer;
  plugins: Answer;
  /** Keyed by the cursor asked for; "" is the first page. */
  audit: Record<string, Answer>;
  /** `GET /api/models`; absent answers 404 like any unfaked path. */
  models?: Answer;
  /** `GET /api/approvals`: the questions and actions waiting on the person. */
  approvals?: Answer;
  /** `GET /api/bot-tasks`: started check-in work, the source of 本周完成. */
  botTasks?: Answer;
  /** `GET /api/agents/capabilities`: whether this deployment can give a computer of its own. */
  capabilities?: Answer;
};

const botTask = (
  id: string,
  owner: string,
  title: string,
  status: BotTask["status"],
): BotTask => ({
  id,
  agentId: owner,
  channelId: `c-${id}`,
  threadId: `t-${id}`,
  title,
  why: null,
  origin: "check_in",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status,
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt: status === "resolved" ? new Date().toISOString() : null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const fullAnswers = (): Answers => ({
  agent: ok({ agent: profile }),
  duties: ok({
    responsibilities: [
      duty("d1", agentId, "盯住慢查询"),
      // Somebody else's duty must not be listed on this coworker's page.
      duty("d2", "agent-2", "别人的职责"),
    ],
  }),
  routines: ok({
    routines: [
      routine("r1", agentId, "每天早上汇总迁移进度"),
      routine("r2", "agent-2", "别人的定时任务"),
    ],
    sweep: { lastSweptAt: null, working: true },
  }),
  tasks: ok({
    tasks: [
      {
        id: "task-1",
        title: "给 orders 表加索引",
        executorAgentId: agentId,
        source: "chat",
        status: "running",
        updatedAt: new Date().toISOString(),
      },
    ],
  }),
  plugins: ok({
    skills: [
      {
        slug: "careful-review",
        title: "仔细评审",
        summary: "逐行看改动",
        instructions: "",
      },
    ],
    tools: [
      {
        ref: "github:create_issue",
        toolName: "create_issue",
        description: "在 GitHub 上开 issue",
        inputSchema: {},
      },
    ],
  }),
  audit: {
    "": ok({
      scope: "everyone",
      events: [
        event("e1", "bot.updated", meId),
        event("e2", "agent.handoff_offered", null, "routine"),
      ],
    } satisfies AgentAuditPage),
  },
});

function serve(answers: Answers) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const url = new URL(path, "http://localhost");
    let answer: Answer | undefined;
    if (url.pathname === `/api/agents/${agentId}`) answer = answers.agent;
    else if (url.pathname === "/api/agents/capabilities")
      answer = answers.capabilities ?? ok({ capabilities: {} });
    else if (url.pathname === "/api/agents") answer = ok({ agents: [profile] });
    else if (url.pathname === "/api/admin/enterprise/me")
      answer = ok({ capabilities: {}, enforced: false });
    else if (url.pathname === "/api/approvals")
      answer =
        answers.approvals ??
        ok({
          enabled: true,
          rules: [],
          teamRules: [],
          requests: [],
          questions: [],
        });
    else if (url.pathname === "/api/bot-tasks")
      answer = answers.botTasks ?? ok({ tasks: [] });
    else if (url.pathname === "/api/proactive/suggestions")
      answer = ok({ suggestions: [] });
    else if (url.pathname === "/api/proactive/settings")
      answer = ok({ settings: [], allowed: true });
    else if (url.pathname === "/api/memory/sources")
      answer = ok({ sources: [] });
    else if (url.pathname === "/api/channels")
      answer = ok({ channels: [], nextCursor: null });
    else if (url.pathname === "/api/responsibilities") answer = answers.duties;
    else if (url.pathname === "/api/routines") answer = answers.routines;
    else if (url.pathname === "/api/tasks") answer = answers.tasks;
    else if (url.pathname === `/api/plugins/for/${agentId}`)
      answer = answers.plugins;
    else if (url.pathname === `/api/bots/${agentId}/audit`)
      answer = answers.audit[url.searchParams.get("cursor") ?? ""];
    else if (url.pathname === "/api/models") answer = answers.models;
    else if (url.pathname === `/api/bots/${agentId}/lifecycle`)
      answer = ok({
        lifecycle: { agentId, paused: false, pausedAt: null, notify: "all" },
      });
    else if (url.pathname === `/api/bots/${agentId}/activity`)
      answer = ok({
        activity: {
          inProgress: [
            {
              id: "act-1",
              kind: "handoff",
              title: "替你追问供应商报价",
              detail: null,
              status: "running",
              at: new Date().toISOString(),
              channelId: null,
              needsYou: false,
              stoppable: true,
              cancellable: false,
            },
          ],
          scheduled: [],
          completed: [],
        },
      });
    if (answer === "hang") return new Promise<Response>(() => {});
    if (!answer) return Response.json({ error: "not faked" }, { status: 404 });
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
}

let currentRouter: { state: { location: { pathname: string } } } | null = null;

function draw(answers: Answers, path = `/wakers/${agentId}`) {
  serve(answers);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(authKeys.currentUser(), { id: meId });
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => null,
    } as never);
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      WakerDetailRoute.update({
        getParentRoute: () => root,
        path: "/wakers/$agentId",
      } as never),
      // The page's links need their addresses to resolve; the screens behind them are not under test.
      // The archived profile keeps its activity page under it, as the app's route tree does.
      (
        BotProfileRoute.update({
          getParentRoute: () => root,
          path: "/bots/$agentId",
        } as never) as unknown as {
          addChildren: (children: unknown[]) => unknown;
        }
      ).addChildren([
        BotActivityRoute.update({
          getParentRoute: () => BotProfileRoute,
          path: "activity",
        } as never),
      ]) as never,
      stub("/wakers"),
      stub("/channel/new"),
      stub("/assemble/$agentId"),
      stub("/tasks"),
      stub("/routines"),
      stub("/responsibilities"),
      stub("/resources"),
      stub("/approvals"),
      stub("/autonomous"),
      stub("/channel/$channelId"),
    ]),
  });
  currentRouter = router;
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The `<section>` a heading names, so each assertion is about the section it claims to be. */

function headings(screen: ReturnType<typeof draw>): string[] {
  return screen
    .getAllByRole("heading", { level: 2 })
    .map((node) => node.textContent?.trim() ?? "");
}

describe("the merged employee detail page", () => {
  test("carries the old profile's sections beside its own", async () => {
    const screen = draw(fullAnswers());
    await screen.findByText("替你追问供应商报价");
    const titles = headings(screen);
    for (const title of [
      "对你",
      "动态",
      "权限",
      "消息发到哪里",
      "职责",
      "看板上的进行中任务",
      "技能授权",
      "运行方式",
      "记忆来源",
      "主动巡检",
      "最近审计",
    ]) {
      expect(titles).toContain(title);
    }
    // The full lists moved to the activity page; this page only glances at what is under way.
    for (const title of ["进行中", "已排期"]) {
      expect(titles).not.toContain(title);
    }
    // One page, so no section appears twice.
    expect(new Set(titles).size).toBe(titles.length);
    expect(
      screen.getByRole("link", { name: /发消息|和它说话|进对话/ }),
    ).toBeTruthy();
  });

  test("/bots/$agentId redirects to the merged page", async () => {
    const screen = draw(fullAnswers(), `/bots/${agentId}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: profile.name }),
    ).toBeTruthy();
    await screen.findByText("替你追问供应商报价");
    await waitFor(() =>
      expect(currentRouter?.state.location.pathname).toBe(`/wakers/${agentId}`),
    );
    // The merged page, not the archived one: its board section is there too.
    expect(
      screen.getByRole("heading", { level: 2, name: "看板上的进行中任务" }),
    ).toBeTruthy();
  });

  test("「需要你」列出这位员工在等你的事，「本周完成」收着这周标完成的任务", async () => {
    const answers = fullAnswers();
    answers.approvals = ok({
      enabled: true,
      rules: [],
      teamRules: [],
      requests: [],
      questions: [
        {
          id: "q1",
          botId: agentId,
          question: "报价要按含税还是不含税算？",
          createdAt: new Date().toISOString(),
        },
        {
          id: "q2",
          botId: "agent-2",
          question: "别的员工的问题",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    answers.botTasks = ok({
      tasks: [
        botTask("bt1", agentId, "整理上周的客户回访", "resolved"),
        botTask("bt2", "agent-2", "别人的完成任务", "resolved"),
      ],
    });
    const screen = draw(answers);

    const needsYou = await screen.findByRole("heading", {
      level: 2,
      name: "需要你",
    });
    const board = needsYou.closest("section") as HTMLElement;
    expect(
      await within(board).findByText(/报价要按含税还是不含税算/),
    ).toBeTruthy();
    // Only this employee's: another employee's question is not on its page.
    expect(within(board).queryByText(/别的员工的问题/)).toBeNull();

    const done = await screen.findByRole("heading", {
      level: 2,
      name: "已完成",
    });
    const doneSection = done.closest("section") as HTMLElement;
    expect(
      within(doneSection).getByText("这周你标为完成的任务有 1 项。"),
    ).toBeTruthy();
    // Folded until asked for.
    expect(within(doneSection).queryByText("整理上周的客户回访")).toBeNull();
    fireEvent.click(within(doneSection).getByRole("button", { name: "展开" }));
    expect(within(doneSection).getByText("整理上周的客户回访")).toBeTruthy();
    expect(within(doneSection).queryByText("别人的完成任务")).toBeNull();
    // Started work is read from its own address, not from the board's `/api/tasks`.
    expect(calls.some((call) => call.path === "/api/bot-tasks")).toBe(true);
  });

  test("「全部动态」打开 /bots/$agentId/activity，那里不再被送回员工页", async () => {
    const screen = draw(fullAnswers());
    await screen.findByText("替你追问供应商报价");
    const all = screen.getByRole("link", { name: /全部动态/ });
    expect(all.getAttribute("href")).toBe(`/bots/${agentId}/activity`);

    fireEvent.click(all);
    await waitFor(() =>
      expect(currentRouter?.state.location.pathname).toBe(
        `/bots/${agentId}/activity`,
      ),
    );
    // The activity page's own full lists, under its own title.
    expect(
      await screen.findByRole("heading", { level: 1, name: "动态" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "已排期" }),
    ).toBeTruthy();
  });

  test("「独立运行」开关只改这一项，整份资料原样带回", async () => {
    const answers = fullAnswers();
    answers.capabilities = ok({
      capabilities: { builtInAvailable: true, isolationAvailable: true },
    });
    const screen = draw(answers);
    const runtime = (
      await screen.findByRole("heading", { level: 2, name: "运行方式" })
    ).closest("section") as HTMLElement;
    expect(within(runtime).getByTestId("coworker-framework").textContent).toBe(
      "熊宝内置",
    );
    const toggle = await waitFor(() => {
      const found = within(runtime).getByRole("switch", { name: "独立运行" });
      expect(found.hasAttribute("data-disabled")).toBe(false);
      return found;
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        calls.find(
          (call) =>
            call.method === "PATCH" && call.path === `/api/agents/${agentId}`,
        )?.body,
      ).toEqual({
        name: profile.name,
        title: profile.title,
        roleDescription: profile.roleDescription,
        visibility: "private",
        // A built-in coworker's managed address is never sent back as if somebody typed it.
        endpoint: "",
        isolated: true,
      }),
    );
  });

  test("部署给不了独立电脑时，开关不可用并说明原因", async () => {
    const screen = draw(fullAnswers());
    const runtime = (
      await screen.findByRole("heading", { level: 2, name: "运行方式" })
    ).closest("section") as HTMLElement;
    expect(
      await within(runtime).findByText("这个熊宝没法给员工分配独立的电脑。"),
    ).toBeTruthy();
    expect(
      within(runtime)
        .getByRole("switch", { name: "独立运行" })
        .hasAttribute("data-disabled"),
    ).toBe(true);
  });

  test("内置员工的指令单独显示、单独保存；别的员工没有这一行", async () => {
    const answers = fullAnswers();
    answers.agent = ok({
      agent: { ...profile, instructions: "先问清楚再动手。" },
    });
    const screen = draw(answers);
    const runtime = (
      await screen.findByRole("heading", { level: 2, name: "运行方式" })
    ).closest("section") as HTMLElement;
    fireEvent.click(within(runtime).getByText("先问清楚再动手。"));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByLabelText("指令");
    fireEvent.change(box, { target: { value: "动手前先列计划。" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject(
        { instructions: "动手前先列计划。", name: profile.name },
      ),
    );
    cleanup();

    const plain = draw(fullAnswers());
    const plainRuntime = (
      await plain.findByRole("heading", { level: 2, name: "运行方式" })
    ).closest("section") as HTMLElement;
    expect(within(plainRuntime).queryByText("指令")).toBeNull();
  });

  test("记忆来源和主动巡检只读这位员工的，并指向你自己记住的内容", async () => {
    const screen = draw(fullAnswers());
    const sources = (
      await screen.findByRole("heading", { level: 2, name: "记忆来源" })
    ).closest("section") as HTMLElement;
    expect(await within(sources).findByText("还没有来源")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "能力与资源 › 信息源与记忆" })
        .getAttribute("href"),
    ).toBe("/resources?tab=sources");
    expect(
      await screen.findByRole("heading", { level: 2, name: "主动巡检" }),
    ).toBeTruthy();
  });

  test("职责区链到按这位员工筛选的长期职责页", async () => {
    const screen = draw(fullAnswers());
    const link = await screen.findByRole("link", { name: "去长期职责页管理" });
    expect(link.getAttribute("href")).toBe(
      `/responsibilities?agent=${agentId}`,
    );
  });
});

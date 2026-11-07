/*
 * One employee, one detail page (user decision: 合并成一个详情页). /wakers/$agentId holds what the
 * old /bots/$agentId profile had — the 对你 controls, the activity feed, tool permissions and where
 * updates go — next to its own sections, and /bots/$agentId redirects there.
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentProfile } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import type {
  AgentAuditEvent,
  AgentAuditPage,
} from "@/lib/bot-lifecycle/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import { Route as BotProfileRoute } from "@/routes/_authed/_app/bots.$agentId";
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
const calls: { method: string; path: string }[] = [];
const gets = (prefix: string) =>
  calls.filter((call) => call.method === "GET" && call.path.startsWith(prefix));

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
    channel: { id: "c1", name: "日报", gone: false },
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
const fail = (status: number, error: string): Answer => ({
  status,
  body: { error },
});

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
};

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
    calls.push({ method, path });
    const url = new URL(path, "http://localhost");
    let answer: Answer | undefined;
    if (url.pathname === `/api/agents/${agentId}`) answer = answers.agent;
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
      BotProfileRoute.update({
        getParentRoute: () => root,
        path: "/bots/$agentId",
      } as never),
      stub("/wakers"),
      stub("/channel/new"),
      stub("/assemble/$agentId"),
      stub("/tasks"),
      stub("/routines"),
      stub("/responsibilities"),
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
      "进行中",
      "已排期",
      "已完成",
      "权限",
      "消息发到哪里",
      "职责",
      "看板上的进行中任务",
      "技能授权",
      "最近审计",
    ]) {
      expect(titles).toContain(title);
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
});

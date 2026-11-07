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
    if (answer === "hang") return new Promise<Response>(() => {});
    if (!answer) return Response.json({ error: "not faked" }, { status: 404 });
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
}

function draw(answers: Answers) {
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
    history: createMemoryHistory({ initialEntries: [`/wakers/${agentId}`] }),
    routeTree: root.addChildren([
      WakerDetailRoute.update({
        getParentRoute: () => root,
        path: "/wakers/$agentId",
      } as never),
      // The page's links need their addresses to resolve; the screens behind them are not under test.
      stub("/wakers"),
      stub("/assemble/$agentId"),
      stub("/tasks"),
      stub("/routines"),
      stub("/responsibilities"),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The `<section>` a heading names, so each assertion is about the section it claims to be. */
function section(screen: ReturnType<typeof draw>, title: string) {
  const heading = screen.getByRole("heading", { name: title });
  const element = heading.closest("section");
  if (!element) throw new Error(`no section for ${title}`);
  return within(element);
}

test("the detail page shows duties, running tasks, skill grants and the audit trail of this coworker", async () => {
  const screen = draw(fullAnswers());

  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "职责" })).toBeTruthy(),
  );

  // 职责: the role, this coworker's duties only, and its routines only.
  const duties = section(screen, "职责");
  expect(duties.getByText("负责数据库迁移和接口。")).toBeTruthy();
  await waitFor(() => expect(duties.getByText("盯住慢查询")).toBeTruthy());
  expect(duties.queryByText("别人的职责")).toBeNull();
  await waitFor(() =>
    expect(duties.getByText("每天早上汇总迁移进度")).toBeTruthy(),
  );
  expect(duties.queryByText("别人的定时任务")).toBeNull();
  // Read-only: the routine is shown, but nothing on this page runs, pauses or deletes it; that is
  // the assembly page's, which the section links to.
  const routines = within(screen.getByTestId("routine-summary"));
  expect(routines.getByText("已启用")).toBeTruthy();
  expect(routines.queryByRole("button")).toBeNull();
  expect(routines.queryByRole("switch")).toBeNull();
  expect(routines.queryByRole("checkbox")).toBeNull();
  expect(routines.queryByText("立即运行")).toBeNull();
  expect(
    routines
      .getByText("去装配页管理定时任务")
      .closest("a")
      ?.getAttribute("href"),
  ).toBe(`/assemble/${agentId}`);

  // 进行中任务: the board, asked for this executor and for running work only.
  const running = section(screen, "看板上的进行中任务");
  await waitFor(() =>
    expect(running.getByText("给 orders 表加索引")).toBeTruthy(),
  );
  const [taskRead] = gets("/api/tasks");
  const asked = new URL(taskRead?.path ?? "", "http://localhost");
  expect(asked.searchParams.get("executor")).toBe(agentId);
  expect(asked.searchParams.get("status")).toBe("running");
  const board = new URL(
    running.getByText("在看板上看").closest("a")?.getAttribute("href") ?? "",
    "http://localhost",
  );
  expect(board.pathname).toBe("/tasks");
  // One coworker by its whole id (`executor`), never a comma-split roster (`crew`).
  expect(board.searchParams.get("executor")).toBe(agentId);
  expect(board.searchParams.has("crew")).toBe(false);
  expect(board.searchParams.get("status")).toBe("running");
  // The section reads running work with no time window, so the board link must not narrow to one.
  expect(board.searchParams.get("period")).toBe("all");
  expect(running.getByText(/^对话 · 更新于/)).toBeTruthy();

  // 技能授权: read-only — names what it holds, offers no box to tick, and points at the assembly page.
  const grants = section(screen, "技能授权");
  await waitFor(() => expect(grants.getByText("仔细评审")).toBeTruthy());
  expect(grants.getByText("create_issue")).toBeTruthy();
  expect(grants.queryByRole("checkbox")).toBeNull();
  expect(
    grants.getByText("去装配页修改").closest("a")?.getAttribute("href"),
  ).toBe(`/assemble/${agentId}`);

  // 最近审计: read from the per-agent trail, the person's own row said as 你, a routine's by its kind.
  const audit = section(screen, "最近审计");
  await waitFor(() =>
    expect(audit.getByText("你 · 修改了这位员工的设置")).toBeTruthy(),
  );
  expect(audit.getByText("定时任务 · 发起了一次交接")).toBeTruthy();
  expect(audit.queryByText(/只列出你自己/)).toBeNull();
  expect(audit.queryByText("加载更早的记录")).toBeNull();
  const [auditRead] = gets(`/api/bots/${agentId}/audit`);
  expect(
    new URL(auditRead?.path ?? "", "http://localhost").searchParams.has(
      "cursor",
    ),
  ).toBe(false);
});

test("the audit trail pages on the server's cursor, and an unknown event type is shown as itself", async () => {
  const answers = fullAnswers();
  answers.audit = {
    "": ok({
      scope: "own",
      events: [event("e1", "bot.paused", meId)],
      nextCursor: "cursor-page-2",
    } satisfies AgentAuditPage),
    "cursor-page-2": ok({
      scope: "own",
      events: [event("e0", "bot.some_future_event", meId)],
    } satisfies AgentAuditPage),
  };
  const screen = draw(answers);

  const audit = await waitFor(() => {
    const found = section(screen, "最近审计");
    expect(found.getByText("你 · 暂停了这位员工")).toBeTruthy();
    return found;
  });
  // Not the owner: the server answered `own`, and the page says why the list is short.
  expect(audit.getByText(/只列出你自己对它做过的操作/)).toBeTruthy();

  await userEvent
    .setup({ document: screen.baseElement.ownerDocument })
    .click(audit.getByRole("button", { name: "加载更早的记录" }));

  await waitFor(() =>
    expect(audit.getByText("你 · bot.some_future_event")).toBeTruthy(),
  );
  // The first page stays; the second is appended; no third is offered.
  expect(audit.getByText("你 · 暂停了这位员工")).toBeTruthy();
  expect(audit.queryByRole("button", { name: "加载更早的记录" })).toBeNull();
  const second = gets(`/api/bots/${agentId}/audit`).at(-1);
  expect(
    new URL(second?.path ?? "", "http://localhost").searchParams.get("cursor"),
  ).toBe("cursor-page-2");
});

test("each section has its own empty state", async () => {
  const answers = fullAnswers();
  answers.agent = ok({ agent: { ...profile, roleDescription: "" } });
  answers.duties = ok({ responsibilities: [duty("d2", "agent-2", "别人的")] });
  answers.routines = ok({
    routines: [],
    sweep: { lastSweptAt: null, working: true },
  });
  answers.tasks = ok({ tasks: [] });
  answers.plugins = ok({ skills: [], tools: [] });
  answers.audit = { "": ok({ scope: "everyone", events: [] }) };
  const screen = draw(answers);

  await waitFor(() =>
    expect(screen.getByText("它还没有长期职责。")).toBeTruthy(),
  );
  expect(screen.getByText("还没写角色描述。")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByText("这位员工还没有定时任务")).toBeTruthy(),
  );
  await waitFor(() =>
    expect(screen.getByText("它现在没有进行中的任务。")).toBeTruthy(),
  );
  await waitFor(() =>
    expect(screen.getByText("还没有授予任何技能或工具")).toBeTruthy(),
  );
  await waitFor(() => expect(screen.getByText("还没有审计记录")).toBeTruthy());
});

test("a section whose read fails says so on its own, and the other sections still render", async () => {
  const answers = fullAnswers();
  answers.tasks = fail(500, "看板坏了");
  answers.plugins = fail(500, "插件读不到");
  answers.audit = { "": fail(500, "审计坏了") };
  const screen = draw(answers);

  const running = await waitFor(() => {
    const found = section(screen, "看板上的进行中任务");
    expect(found.getByText("读不到进行中任务：看板坏了")).toBeTruthy();
    return found;
  });
  // A failed board is never said as "nothing running".
  expect(running.queryByText("它现在没有进行中的任务。")).toBeNull();
  await waitFor(() =>
    expect(
      section(screen, "技能授权").getByText("读不到技能授权：插件读不到"),
    ).toBeTruthy(),
  );
  await waitFor(() =>
    expect(
      section(screen, "最近审计").getByText("读不到审计记录：审计坏了"),
    ).toBeTruthy(),
  );
  // The section that did answer is untouched by the others failing.
  await waitFor(() =>
    expect(section(screen, "职责").getByText("盯住慢查询")).toBeTruthy(),
  );
});

test("a duties read that fails is said in the duties section, and a trail the deployment does not keep is not offered a retry", async () => {
  const answers = fullAnswers();
  answers.duties = fail(500, "职责坏了");
  answers.audit = { "": fail(503, "Audit logging is not configured.") };
  const screen = draw(answers);

  await waitFor(() =>
    expect(
      section(screen, "职责").getByText("读不到长期职责：职责坏了"),
    ).toBeTruthy(),
  );
  const audit = await waitFor(() => {
    const found = section(screen, "最近审计");
    expect(found.getByText(/这个部署没有开启审计记录/)).toBeTruthy();
    return found;
  });
  expect(audit.queryByRole("button", { name: "重试" })).toBeNull();
});

test("each section shows its own loading state while its read is outstanding", async () => {
  const answers = fullAnswers();
  answers.tasks = "hang";
  answers.audit = { "": "hang" };
  const screen = draw(answers);

  await waitFor(() =>
    expect(section(screen, "技能授权").getByText("仔细评审")).toBeTruthy(),
  );
  expect(
    section(screen, "看板上的进行中任务").getByLabelText("正在读取进行中任务"),
  ).toBeTruthy();
  expect(
    section(screen, "最近审计").getByLabelText("正在读取审计记录"),
  ).toBeTruthy();
});

test("a coworker the person cannot reach is said as not found, not as an empty page", async () => {
  const answers = fullAnswers();
  answers.agent = fail(404, "Agent not found.");
  const screen = draw(answers);

  await waitFor(() =>
    expect(
      screen.getByText("找不到这位员工，或者你没有权限查看它。"),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("heading", { name: "最近审计" })).toBeNull();
  // Nothing about the coworker is read before the coworker itself is known to be reachable.
  expect(gets(`/api/bots/${agentId}/audit`)).toHaveLength(0);
});

describe("the coworker's model (H4)", () => {
  const library = ok({
    models: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "openai",
        baseUrl: null,
        modelName: "gpt-6",
        label: "GPT-6",
        enabled: true,
        updatedAt: "2026-11-01T00:00:00.000Z",
        coworkers: 1,
      },
    ],
    templates: [],
    pool: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        provider: "zhipu",
        modelName: "glm-4.6",
        label: "GLM-4.6",
        coworkers: 1,
        available: true,
      },
    ],
    customModels: true,
  });

  async function modelShown(agent: Partial<AgentProfile>) {
    const answers = fullAnswers();
    answers.agent = ok({ agent: { ...profile, ...agent } });
    answers.models = library;
    const screen = draw(answers);
    await waitFor(() =>
      expect(screen.getByTestId("coworker-model").textContent).not.toContain(
        "正在读取",
      ),
    );
    return screen.getByTestId("coworker-model").textContent;
  }

  test("an unbound coworker runs on the deployment's model, and the library is not asked", async () => {
    expect(await modelShown({})).toBe("模型：部署默认模型");
    expect(gets("/api/models")).toEqual([]);
  });

  test("a library binding is named the way the assembly page names it", async () => {
    expect(
      await modelShown({ modelRef: "11111111-1111-4111-8111-111111111111" }),
    ).toBe("模型：GPT-6 · OpenAI");
  });

  test("a platform pool binding is named and said to be a platform experience model", async () => {
    expect(
      await modelShown({
        platformModelRef: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe("模型：GLM-4.6 · 智谱 GLM（平台体验模型）");
  });

  test("a binding outside the viewer's own library says whose library it is in, not an id", async () => {
    const shown = await modelShown({
      modelRef: "33333333-3333-4333-8333-333333333333",
      canManage: false,
      mine: false,
    });
    expect(shown).toBe("模型：主人模型库里的一个模型");
    expect(shown).not.toContain("3333");
  });

  test("a remote coworker's model is hosted elsewhere", async () => {
    expect(
      await modelShown({
        builtIn: false,
        endpoint: "https://agents.example.test/ag-ui",
        modelRef: null,
      }),
    ).toBe("模型：外部托管模型");
  });
});

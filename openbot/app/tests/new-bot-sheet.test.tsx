import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ISOLATED_EXPLAINED,
  ISOLATED_PUBLIC,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
} from "@/lib/agents/isolation";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * `import.meta.glob` is Vite's, and `bun test` has no Vite. Stubbed as the other create tests stub
 * it: a brand with a vendored mark resolves to something drawable, one without to null.
 */
mock.module("@/lib/marks", () => ({
  markFor: (id: string | null | undefined) =>
    id ? `data:image/svg+xml,${id}` : null,
}));

// After the stub: a static import is hoisted and would load the real marks module first.
const { NewBotSheet } = await import("@/components/agents/new-bot-sheet");

/**
 * The New Bot sheet, end to end against a stubbed server.
 *
 * What it promises: a name is the only thing asked for before Continue; where it runs is answered by
 * recognition, with the partners people look for first; a Bot that runs here is created straight
 * from that answer; one somebody else runs is created only once the server has reached its address;
 * and a Bot made with nothing but a name still satisfies a server that requires a title and a role
 * description.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let builtInAvailable = true;
/** Whether the deployment can make a computer for one Bot, and whether the person holds the switch. */
let isolationAvailable = true;
let mayIsolate = true;
/** What the server says when asked to reach an address. */
let verdict: { ok: true; events: string[] } | { ok: false; reason: string };
/** Every create sent, with its body. */
let creates: Record<string, unknown>[] = [];
/** Every address the server was asked to reach. */
let dialled: string[] = [];
/** The person's own apps the server offers to give a new Bot, and every give it was sent. */
let giveable: {
  key: string;
  displayName: string;
  logo: null;
  account: string;
}[] = [];
let given: string[] = [];
/** Every app that is turned on, as `GET /api/plugins` lists them, and every path the sheet asked for. */
let servers: { id: string; title: string; logo: null }[] = [];
let requested: string[] = [];

beforeEach(() => {
  builtInAvailable = true;
  isolationAvailable = true;
  mayIsolate = true;
  verdict = { ok: true, events: ["RUN_STARTED"] };
  creates = [];
  dialled = [];
  giveable = [];
  given = [];
  servers = [];
  requested = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requested.push(String(path));
      if (path === "/api/agents/capabilities") {
        return Response.json({
          capabilities: { builtInAvailable, isolationAvailable },
        });
      }
      // The switches as they apply to this person, shaped as `/api/admin/enterprise/me` answers.
      if (path === "/api/admin/enterprise/me") {
        return Response.json({
          capabilities: { isolatedComputers: mayIsolate },
          enforced: true,
        });
      }
      if (path === "/api/agents/test-connection") {
        dialled.push(body.endpoint);
        return Response.json(verdict);
      }
      if (path === "/api/agents" && init?.method === "POST") {
        creates.push(body);
        return Response.json({ agent: { id: "agent_new" } }, { status: 201 });
      }
      if (path === "/api/plugins/giveable")
        return Response.json({ apps: giveable });
      if (path === "/api/plugins")
        return Response.json({ catalogue: [], servers, skills: [] });
      if (String(path).endsWith("/give") && init?.method === "POST") {
        given.push(String(path));
        return Response.json({ granted: [] });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function draw(screen: ReactNode, edition: "team" | "personal" = "team") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), { edition });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  // Inside the provider the app's root gives every tooltip.
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The sheet open, on its first step: where the Bot will run. */
async function opened(onCreated: (id: string) => void = () => {}) {
  const view = draw(
    <NewBotSheet onClose={() => {}} onCreated={onCreated} open />,
  );
  await view.findByLabelText("名称");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user };
}

/** The first screen's custom agents, below the simple form. */
function customAgents(view: Awaited<ReturnType<typeof opened>>["view"]) {
  return within(view.getByRole("region", { name: "连接自定义智能体" }));
}

/** A name typed; the frameworks are on the same screen, below the form. */
async function customFlow() {
  const result = await opened();
  await result.user.type(result.view.getByLabelText("名称"), "Expense Review");
  return result;
}
async function connected(address = "https://agent.example.com/ag-ui") {
  const { view, user } = await customFlow();
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
  await user.click(
    customAgents(view).getByRole("button", { name: /LangChain/ }),
  );
  if (address)
    await user.type(await view.findByLabelText("智能体地址"), address);
  return { view, user };
}

/** Long enough for a request the press started to have reached `fetch`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

test("opens on New Bot details and creates locally without another screen", async () => {
  const { view, user } = await opened();
  expect(view.getByRole("heading", { name: "新建员工" })).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Run here/ })).toBeNull();
  // The custom agents are below the form, and do not take focus from Name.
  expect(view.getByRole("heading", { name: "连接自定义智能体" })).toBeTruthy();
  expect(document.activeElement).toBe(view.getByLabelText("名称"));
  expect(
    view.getByRole("button", { name: "创建员工" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.type(view.getByLabelText("名称"), "Expense Review");
  expect(
    view.getByRole("button", { name: "创建员工" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("unavailable hosting still permits the custom path", async () => {
  builtInAvailable = false;
  const { view, user } = await opened();
  await settle();
  expect(view.queryByRole("button", { name: /^Run here/ })).toBeNull();
  expect(view.queryByRole("region", { name: "连接自定义智能体" })).toBeNull();
  expect(view.queryByRole("button", { name: /LangChain/ })).toBeNull();
  expect(
    view.getByRole("button", { name: "继续" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.type(view.getByLabelText("名称"), "External");
  expect(
    view.getByRole("button", { name: "继续" }).hasAttribute("disabled"),
  ).toBe(false);
  await user.click(view.getByRole("button", { name: "继续" }));
  const framework = view.getByRole("button", { name: /LangChain/ });
  expect(framework.hasAttribute("aria-pressed")).toBe(false);
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
  await user.click(framework);
  expect(await view.findByLabelText("智能体地址")).toBeTruthy();
  expect(view.getByText("LangChain")).toBeTruthy();
  await user.type(
    view.getByLabelText("智能体地址"),
    "https://agent.example.test/ag-ui",
  );
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await waitFor(() => expect(creates).toHaveLength(1));
  expect(creates[0]?.roleDescription).toBe("Connected from LangChain.");
});

test("Create fills in what was left blank, then hands over", async () => {
  const handedOver: string[] = [];
  const { view, user } = await opened((id) => handedOver.push(id));
  const name = await view.findByLabelText("名称");
  await user.type(name, "Expense Review");
  // Enter in the name is Create.
  await act(async () => {
    fireEvent.keyDown(name, { key: "Enter", keyCode: 13 });
  });

  expect(await view.findByText("Expense Review准备好了")).toBeTruthy();
  expect(creates).toHaveLength(1);
  // Its subtitle says what runs it: OpenBot itself.
  expect(creates[0]).toMatchObject({
    name: "Expense Review",
    title: "由 OpenBot 驱动",
    visibility: "private",
    endpoint: "",
  });
  // It runs on OpenBot, which the server knows without being told.
  expect(creates[0]).not.toHaveProperty("harness");
  // For a Bot that runs here this is its system prompt, so it has to be something it can act on.
  expect(String(creates[0]?.roleDescription)).toStartWith(
    "You are Expense Review.",
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  });
  expect(handedOver).toEqual(["agent_new"]);
});

test("refuses an empty or unreachable custom endpoint without creating", async () => {
  verdict = { ok: false, reason: "Nothing answered at that address." };
  const { view, user } = await connected("");
  await user.click(view.getByRole("button", { name: "创建员工" }));
  expect(await view.findByText("请输入你的智能体地址。")).toBeTruthy();
  expect(dialled).toEqual([]);
  await user.type(
    view.getByLabelText("智能体地址"),
    "https://agent.example.com/ag-ui",
  );
  await user.click(view.getByRole("button", { name: "创建员工" }));
  expect(
    await view.findByText("Nothing answered at that address."),
  ).toBeTruthy();
  expect(creates).toEqual([]);
});

test("checks the connection then creates with its saved name and key", async () => {
  const { view, user } = await connected();
  await user.type(view.getByLabelText(/密钥/), "Bearer secret");
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await view.findByText("Expense Review准备好了");
  expect(dialled).toEqual(["https://agent.example.com/ag-ui"]);
  expect(creates[0]).toMatchObject({
    name: "Expense Review",
    endpoint: "https://agent.example.com/ag-ui",
    auth: { header: "Authorization", value: "Bearer secret" },
    // The framework picked from the list, by the name the list showed.
    title: "由 LangChain 驱动",
    // And by its id, so the Bot is told what runs it whatever its subtitle becomes.
    harness: "langgraph",
  });
});

test("preserves every entry across back navigation and hosting switches", async () => {
  const { view, user } = await connected();
  await user.type(view.getByLabelText(/密钥/), "Bearer secret");
  // Back from the address returns to the first screen, at its custom agents, with the name kept.
  await user.click(view.getByRole("button", { name: "返回" }));
  expect((view.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "Expense Review",
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "连接自定义智能体" }),
    ),
  );
  await user.type(view.getByLabelText(/^指令/), "Review carefully");
  await user.click(view.getByRole("button", { name: /公开/ }));
  expect((view.getByLabelText(/^指令/) as HTMLTextAreaElement).value).toBe(
    "Review carefully",
  );
  await user.click(
    customAgents(view).getByRole("button", { name: /LangChain/ }),
  );
  expect((view.getByLabelText("智能体地址") as HTMLInputElement).value).toBe(
    "https://agent.example.com/ag-ui",
  );
  expect((view.getByLabelText(/密钥/) as HTMLInputElement).value).toBe(
    "Bearer secret",
  );
  await user.click(view.getByRole("button", { name: "返回" }));
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await view.findByText("Expense Review准备好了");
  expect(creates[0]).toMatchObject({
    endpoint: "",
    visibility: "public",
    roleDescription: "Review carefully",
  });
  expect(creates[0]).not.toHaveProperty("auth");
});

test("the person's own apps arrive ticked, and the ones left ticked are given once the Bot exists", async () => {
  giveable = [
    {
      key: "composio-gmail",
      displayName: "Gmail",
      logo: null,
      account: "personal",
    },
    {
      key: "routines",
      displayName: "Routines",
      logo: null,
      account: "deployment",
    },
  ];
  const { view, user } = await opened();
  await user.type(await view.findByLabelText("名称"), "Research");
  const gmail = await view.findByRole("checkbox", { name: "Gmail" });
  const routines = view.getByRole("checkbox", { name: "Routines" });
  expect(gmail.getAttribute("aria-checked")).toBe("true");
  expect(routines.getAttribute("aria-checked")).toBe("true");
  await user.click(routines);
  expect(routines.getAttribute("aria-checked")).toBe("false");
  await user.click(view.getByRole("button", { name: "创建员工" }));
  expect(await view.findByText("Research准备好了")).toBeTruthy();
  expect(given).toEqual([
    "/api/plugins/for/agent_new/apps/composio-gmail/give",
  ]);
});

test("a person with no apps to give is asked nothing about apps", async () => {
  const { view } = await opened();
  await view.findByLabelText("名称");
  await settle();
  expect(view.queryByText("它能用的应用")).toBeNull();
});

/** On the details step the sheet opens on, with a name typed. */
async function named(name = "Research") {
  const { view, user } = await opened();
  await user.type(await view.findByLabelText("名称"), name);
  await settle();
  return { view, user };
}

/** The text of the tooltip beside Isolated, opened the way a pointer opens it. */
async function isolatedTooltip(
  view: Awaited<ReturnType<typeof named>>["view"],
  user: Awaited<ReturnType<typeof named>>["user"],
) {
  await user.hover(
    view.getByRole("button", { name: "「独立运行」是什么意思" }),
  );
  return (await view.findByText(new RegExp(ISOLATED_EXPLAINED.slice(0, 30))))
    .textContent;
}

test("Isolated is offered with what it means, and a public Bot is told who shares it", async () => {
  const { view, user } = await named();
  const isolated = await view.findByRole("checkbox", { name: "独立运行" });
  expect(isolated.getAttribute("aria-checked")).toBe("false");
  expect(isolated.hasAttribute("data-disabled")).toBe(false);
  expect(await isolatedTooltip(view, user)).toBe(ISOLATED_EXPLAINED);

  await user.unhover(
    view.getByRole("button", { name: "「独立运行」是什么意思" }),
  );
  await user.click(view.getByRole("button", { name: /公开/ }));
  expect(await isolatedTooltip(view, user)).toBe(
    `${ISOLATED_EXPLAINED}${ISOLATED_PUBLIC}`,
  );
});

test("a ticked Isolated is sent with the Bot, and an unticked one says no", async () => {
  const { view, user } = await named("Research");
  await user.click(await view.findByRole("checkbox", { name: "独立运行" }));
  await user.click(view.getByRole("button", { name: "创建员工" }));
  expect(await view.findByText("Research准备好了")).toBeTruthy();
  expect(creates[0]).toMatchObject({ name: "Research", isolated: true });

  cleanup();
  creates = [];
  const again = await named("Plain");
  await again.user.click(again.view.getByRole("button", { name: "创建员工" }));
  expect(await again.view.findByText("Plain准备好了")).toBeTruthy();
  expect(creates[0]).toMatchObject({ name: "Plain", isolated: false });
});

test("a deployment that cannot make a second computer shows Isolated disabled, and says why", async () => {
  isolationAvailable = false;
  const { view, user } = await named();
  const isolated = await view.findByRole("checkbox", { name: "独立运行" });
  expect(isolated.hasAttribute("data-disabled")).toBe(true);
  expect(view.getByText(ISOLATION_UNAVAILABLE)).toBeTruthy();
  await user.click(isolated);
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await view.findByText("Research准备好了");
  expect(creates[0]).toMatchObject({ isolated: false });
});

test("somebody an admin has not allowed sees Isolated disabled, and why", async () => {
  mayIsolate = false;
  const { view } = await named();
  const isolated = await view.findByRole("checkbox", { name: "独立运行" });
  expect(isolated.hasAttribute("data-disabled")).toBe(true);
  expect(await view.findByText(ISOLATION_NOT_ALLOWED)).toBeTruthy();
});

test("a framework on the first screen validates the name, then goes straight to its address", async () => {
  const { view, user } = await opened();
  await user.type(view.getByLabelText("名称"), "   ");
  await user.click(
    customAgents(view).getByRole("button", { name: /LangChain/ }),
  );
  expect((await view.findByRole("alert")).textContent).toBe("名字为必填项。");
  expect(document.activeElement).toBe(view.getByLabelText("名称"));
  expect(view.queryByLabelText("智能体地址")).toBeNull();
  await user.type(view.getByLabelText("名称"), "My Bot");
  await user.click(
    customAgents(view).getByRole("button", { name: /LangChain/ }),
  );
  expect(await view.findByLabelText("智能体地址")).toBeTruthy();
  expect(view.getByText("LangChain")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "返回" }));
  // Back to the first screen, not the list: the name is there, and so are the custom agents.
  expect(((await view.findByLabelText("名称")) as HTMLInputElement).value).toBe(
    "   My Bot",
  );
  expect(view.getByRole("region", { name: "连接自定义智能体" })).toBeTruthy();
});

test("an agent somebody already runs, picked on the first screen, goes to its address too", async () => {
  const { view, user } = await customFlow();
  await user.click(
    customAgents(view).getByRole("button", {
      name: /^An agent you already run/,
    }),
  );
  await user.type(
    await view.findByLabelText("智能体地址"),
    "https://agent.example.com/ag-ui",
  );
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await view.findByText("Expense Review准备好了");
  expect(creates[0]).not.toHaveProperty("harness");
});

test("the first screen's custom agents lead with Claude Agent SDK, LangChain, Google ADK and AWS Strands", async () => {
  const { view } = await opened();
  const names = customAgents(view)
    .getAllByRole("button")
    .map((button) => button.querySelector("span span")?.textContent ?? "")
    .filter(Boolean);
  expect(names.slice(0, 4)).toEqual([
    "Claude Agent SDK",
    "LangChain",
    "Google ADK",
    "AWS Strands",
  ]);
  // Every framework is here, "An agent you already run" last.
  expect(names).toHaveLength(13);
  expect(names.at(-1)).toBe("An agent you already run");
});

test("without hosting here, Back from the address returns to the list", async () => {
  builtInAvailable = false;
  const { view, user } = await opened();
  await settle();
  await user.type(view.getByLabelText("名称"), "External");
  await user.click(view.getByRole("button", { name: "继续" }));
  await user.click(view.getByRole("button", { name: /LangChain/ }));
  await view.findByLabelText("智能体地址");
  await user.click(view.getByRole("button", { name: "返回" }));
  expect(
    await view.findByRole("heading", { name: "连接自定义智能体" }),
  ).toBeTruthy();
  expect(view.queryByLabelText("名称")).toBeNull();
});

/**
 * What the Windows personal install showed: Gmail turned on but not connected, Parallel Search on
 * from the start, and Routines. Only Routines is the person's to give, so the sheet listed only
 * Routines, and the Bot it made came out with all three.
 */
const TURNED_ON = [
  { id: "composio-gmail", title: "Gmail", logo: null },
  { id: "parallel-search", title: "Parallel Search", logo: null },
  { id: "routines", title: "Routines", logo: null },
];
const ROUTINES_ONLY = [
  {
    key: "routines",
    displayName: "Routines",
    logo: null,
    account: "deployment",
  },
];

test("personal: the sheet lists every app that is turned on, with nothing to untick", async () => {
  servers = TURNED_ON;
  giveable = ROUTINES_ONLY;
  const view = draw(
    <NewBotSheet open onClose={() => {}} onCreated={() => {}} />,
    "personal",
  );
  const list = await view.findByRole("list", { name: "它能用的应用" });
  expect(
    Array.from(list.querySelectorAll("li")).map((item) => item.textContent),
  ).toEqual(["Gmail", "Parallel Search", "Routines"]);
  expect(
    view.getByText("你在「连接」里打开的每个应用，所有员工都能用。"),
  ).toBeTruthy();
  expect(view.queryAllByRole("checkbox")).toHaveLength(0);
});

test("team: the sheet offers only the apps the person can give, ticked", async () => {
  servers = TURNED_ON;
  giveable = ROUTINES_ONLY;
  const { view } = await opened();
  const routines = await view.findByRole("checkbox", { name: "Routines" });
  expect(routines.getAttribute("aria-checked")).toBe("true");
  expect(view.queryByText("Gmail")).toBeNull();
  expect(view.queryByText("Parallel Search")).toBeNull();
  expect(view.getByText("它总是用提问者本人的账号。")).toBeTruthy();
  expect(requested).not.toContain("/api/plugins");
});

test("the LangGraph harness is offered as LangChain, the name people know it by", async () => {
  const { view } = await customFlow();
  const framework = customAgents(view).getByRole("button", {
    name: /^LangChain/,
  });
  // LangChain's own name and a description that doesn't talk about graphs.
  expect(framework.textContent).not.toMatch(/Graph/);
});

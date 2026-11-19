import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { HardModelItem } from "@/components/agents/hard-model-item";
import { hardModelFrom } from "@/lib/agents/hard-model";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * 员工设置里的「难任务模型」（期七）：下拉的选项是对话里模型选择器那份目录，第一项「默认模型」是留空；
 * 选一个就存、选回默认就清掉；不归你管的员工只看；读不到时只在这一行说一句话。
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

const CATALOGUE = {
  provider: "openai",
  source: "openai",
  exposure: "allowed",
  default: "openai/gpt-6-mini",
  choosable: true,
  models: [
    { id: "openai/gpt-6", label: "GPT-6" },
    { id: "openai/gpt-6-mini", label: "GPT-6 mini" },
  ],
};

let stored: string | null = null;
let down = false;
const writes: unknown[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/model-catalogue") return Response.json(CATALOGUE);
    if (path === "/api/agents/reviewer/hard-model") {
      if (down) return Response.json({ error: "服务不可用" }, { status: 503 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          hardModel: string | null;
        };
        writes.push(body);
        stored = body.hardModel;
      }
      return Response.json({ hardModel: stored });
    }
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  stored = null;
  down = false;
  queryClient.clear();
});

async function draw(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("留空时下拉显示「默认模型」，旁边说明子代理什么时候用它", async () => {
  serving();
  const view = await draw(<HardModelItem agentId="reviewer" canManage />);
  const trigger = await view.findByRole("combobox", { name: "难任务模型" });
  await waitFor(() => expect(trigger.textContent).toContain("默认模型"));
  expect(view.getByText(/子代理遇到难的子任务时会用这个模型/)).toBeTruthy();
});

test("选项是模型目录里的模型（含管理员白名单已经收窄过的）；选一个就存，选回默认就清掉", async () => {
  serving();
  const view = await draw(<HardModelItem agentId="reviewer" canManage />);
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const trigger = await view.findByRole("combobox", { name: "难任务模型" });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));

  await user.click(trigger);
  const options = await view.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "默认模型",
    "GPT-6",
    "GPT-6 mini",
  ]);
  await user.click(options[1] as HTMLElement);
  await waitFor(() => expect(writes).toEqual([{ hardModel: "openai/gpt-6" }]));
  await waitFor(() => expect(trigger.textContent).toContain("GPT-6"));

  await user.click(trigger);
  const again = await view.findAllByRole("option");
  await user.click(again[0] as HTMLElement);
  await waitFor(() =>
    expect(writes).toEqual([
      { hardModel: "openai/gpt-6" },
      { hardModel: null },
    ]),
  );
  await waitFor(() => expect(trigger.textContent).toContain("默认模型"));
});

test("已经存着的模型打开就显示出来；它已不在目录里时照样列出并标明", async () => {
  stored = "openai/retired";
  serving();
  const view = await draw(<HardModelItem agentId="reviewer" canManage />);
  const trigger = await view.findByRole("combobox", { name: "难任务模型" });
  await waitFor(() =>
    expect(trigger.textContent).toContain(
      "openai/retired（已不在可用的模型里）",
    ),
  );
});

test("不归你管的员工只显示，不给下拉", async () => {
  stored = "openai/gpt-6";
  serving();
  const view = await draw(
    <HardModelItem agentId="reviewer" canManage={false} />,
  );
  expect(await view.findByText("GPT-6")).toBeTruthy();
  expect(view.queryByRole("combobox")).toBeNull();
});

test("读不到时只说一句话，下拉不能动，不抛错", async () => {
  down = true;
  serving();
  const view = await draw(<HardModelItem agentId="reviewer" canManage />);
  expect(
    await view.findByText(
      "读不到这位员工的难任务模型。",
      {},
      { timeout: 4000 },
    ),
  ).toBeTruthy();
  const trigger = view.getByRole("combobox", { name: "难任务模型" });
  expect(trigger.hasAttribute("disabled")).toBe(true);
});

test("服务器答的不是字符串：当没设置", () => {
  expect(hardModelFrom(null)).toBeNull();
  expect(hardModelFrom(5)).toBeNull();
  expect(hardModelFrom("  ")).toBeNull();
  expect(hardModelFrom(" openai/gpt-6 ")).toBe("openai/gpt-6");
});

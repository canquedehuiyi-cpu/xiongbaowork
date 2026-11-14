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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { CreateGroupForm } from "@/components/wakers/create-group-form";
import { queryClient } from "@/query-client";
import { Route as GroupNewRoute } from "@/routes/_authed/_app/group/new";
import { settleReactWork } from "./settle-react-work";

/*
 * 新建群组的 `?agent=`（聊天工作台 Task 7，员工名片的「拉进群」）：路由收下这个参数，表单打开时预先勾上
 * 那位员工、群组名跟着他；列表里没有的 id 不勾。
 */

function agent(id: string, name: string) {
  return {
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
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
  };
}

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  const answers = new Map<string, unknown>([
    [
      "GET /api/agents",
      { agents: [agent("a1", "代码熊"), agent("a2", "小熊会计")] },
    ],
  ]);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const answer = answers.get(`${init?.method ?? "GET"} ${path}`);
      if (answer !== undefined) return Response.json(answer);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderForm(initialChosen?: readonly string[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateGroupForm
        initialChosen={initialChosen}
        onCreated={() => {}}
        variant="page"
      />
    </QueryClientProvider>,
  );
}

/** 员工那一行的勾选框，按 id 找（happy-dom 算不出这个勾选框的可访问名字）。 */
async function box(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.getElementById(`group-bot-${id}`);
    if (!found) throw new Error(`no checkbox for ${id} yet`);
    return found;
  });
}

function checkedOf(element: HTMLElement): boolean {
  // Base UI 的勾选框：带 id 的是它藏起来的原生 input，勾没勾看它的 `checked`。
  return element instanceof HTMLInputElement
    ? element.checked
    : element.getAttribute("aria-checked") === "true";
}

test("新建群组的路由收下文字的 ?agent=，别的不收", () => {
  const validate = GroupNewRoute.options.validateSearch as (
    search: Record<string, unknown>,
  ) => { agent?: string };
  expect(validate({ agent: "a1" })).toEqual({ agent: "a1" });
  expect(validate({})).toEqual({});
});

test("initialChosen 打开时勾上那位员工，群组名跟着他", async () => {
  const view = renderForm(["a1"]);
  const coder = await box("a1");
  await waitFor(() => expect(checkedOf(coder)).toBe(true));
  expect(checkedOf(await box("a2"))).toBe(false);
  const form = within(view.container);
  expect(
    (form.getByRole("textbox", { name: "群组名称" }) as HTMLInputElement).value,
  ).toBe("代码熊");
  expect(form.getByText("第 1 个回答")).toBeTruthy();
});

test("列表里没有的员工不勾，什么都不选", async () => {
  const view = renderForm(["nobody"]);
  const coder = await box("a1");
  await settleReactWork();
  expect(checkedOf(coder)).toBe(false);
  expect(
    within(view.container).getByText("已选 0 位，至少还要 2 位"),
  ).toBeTruthy();
});

test("不传 initialChosen 时和原来一样，一位也不勾", async () => {
  renderForm();
  const coder = await box("a1");
  await settleReactWork();
  expect(checkedOf(coder)).toBe(false);
});

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { AgentDialog } from "@/components/agents/agent-dialog";
import type { AgentProfile } from "@/lib/agents/queries";
import type {
  ConnectedModel,
  ModelLibrary,
  PlatformPoolModel,
} from "@/lib/models/queries";
import { Route as ResourcesRoute } from "@/routes/_authed/_app/resources";
import { settleReactWork } from "./settle-react-work";

/**
 * Stories H1, H2, H6 and K1 on the screens a person uses: the platform's experience models listed
 * read-only on 能力与资源, the coworker's model picker offering the pool beside the person's own
 * library, a remote coworker named as hosted elsewhere, and the Free plan's own-key form locked
 * behind an upgrade.
 *
 * Every request is answered in memory, in the shapes `GET /api/models` and `PATCH /api/agents/:id`
 * answer on this branch, and every write is recorded so the assertions are about what the screen
 * SENT, not what it drew.
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

const originalFetch = globalThis.fetch;
const writes: { method: string; path: string; body: unknown }[] = [];
afterEach(() => {
  cleanup();
  writes.length = 0;
  globalThis.fetch = originalFetch;
});

const POOL_GLM = "11111111-1111-4111-8111-111111111111";
const POOL_DARK = "22222222-2222-4222-8222-222222222222";
const OWN_GPT = "33333333-3333-4333-8333-333333333333";

const pool: PlatformPoolModel[] = [
  {
    id: POOL_GLM,
    provider: "zhipu",
    modelName: "glm-4.6",
    label: "GLM-4.6",
    coworkers: 2,
    available: true,
  },
  {
    id: POOL_DARK,
    provider: "deepseek",
    modelName: "deepseek-chat",
    label: "DeepSeek Chat",
    coworkers: 0,
    // The deployment holds no key for it: listed, never pickable.
    available: false,
  },
];

const ownModel: ConnectedModel = {
  id: OWN_GPT,
  provider: "openai",
  baseUrl: null,
  modelName: "gpt-6",
  label: "GPT-6",
  enabled: true,
  updatedAt: "2026-11-01T00:00:00.000Z",
  coworkers: 1,
};

const coworker: AgentProfile = {
  id: "reviewer",
  name: "Reviewer",
  title: "Code review",
  roleDescription: "Reviews pull requests.",
  avatarSeed: "reviewer",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  modelRef: null,
  platformModelRef: null,
  persona: null,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The API this screen talks to, held in memory. */
function serve(library: ModelLibrary, agent: AgentProfile = coworker) {
  let profile = agent;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push({
          method,
          path,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
      }
      if (path === "/api/models" && method === "GET") return json(library);
      if (path === `/api/agents/${profile.id}`) {
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as Partial<AgentProfile>;
          // What the server does: binding one shelf clears the other.
          profile = {
            ...profile,
            ...(body.modelRef === undefined ? {} : { modelRef: body.modelRef }),
            ...(body.platformModelRef === undefined
              ? {}
              : { platformModelRef: body.platformModelRef }),
          };
        }
        return json({ agent: profile });
      }
      // Every other zone on the page is not what this file is about; it answers empty.
      return json({ error: "not here" }, 404);
    },
    { preconnect: originalFetch.preconnect },
  );
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function drawResources() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: {},
    history: createMemoryHistory({ initialEntries: ["/resources"] }),
    routeTree: root.addChildren([
      ResourcesRoute.update({
        getParentRoute: () => root,
        path: "/resources",
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/plans",
        component: () => null,
      } as never),
    ]),
  });
  return render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function drawDialog(agentId = coworker.id) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <AgentDialog agentId={agentId} onClose={() => {}} open />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The model picker's options, which Base UI portals into the body rather than the dialog. */
async function openPicker() {
  const user = userEvent.setup({ document });
  const trigger = await waitFor(() => {
    const found = within(document.body).getByRole("combobox", {
      name: "模型",
    });
    expect(found.hasAttribute("disabled")).toBe(false);
    return found;
  });
  await user.click(trigger);
  await within(document.body).findByRole("listbox");
  return user;
}

test("能力与资源 lists the platform's experience models read-only, with how many coworkers use each", async () => {
  serve({ models: [], templates: [], pool, customModels: true });
  const view = within(drawResources().baseElement as HTMLElement);

  await view.findByRole("heading", { name: "平台体验模型" });
  expect(await view.findByText("GLM-4.6 · 智谱 GLM")).toBeTruthy();
  expect(view.getByText("有 2 位员工在它上面回答")).toBeTruthy();
  // The row the deployment cannot serve says so instead of pretending to work.
  expect(view.getByText("DeepSeek Chat · DeepSeek")).toBeTruthy();
  expect(view.getByText(/暂不可用——平台还没有为它配置密钥/)).toBeTruthy();
  // Read-only: nothing on the pool rows changes them.
  const section = view
    .getByRole("heading", { name: "平台体验模型" })
    .closest("section");
  expect(section).toBeTruthy();
  expect(within(section as HTMLElement).queryAllByRole("button")).toHaveLength(
    0,
  );
  // Pro: the own-key form is offered, not locked.
  expect(view.queryByText("升级 Pro 解锁自定义 key")).toBeNull();
  expect(
    view.getByRole("button", { name: "接入" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("on Free the own-key form is drawn locked, with the way to the plans page", async () => {
  serve({ models: [], templates: [], pool, customModels: false });
  const view = within(drawResources().baseElement as HTMLElement);

  const upgrade = await view.findByRole("link", {
    name: "升级 Pro 解锁自定义 key",
  });
  expect(upgrade.getAttribute("href")).toBe("/plans");

  const legend = view.getByText("接入一个模型");
  const fieldset = legend.closest("fieldset") as HTMLFieldSetElement;
  expect(fieldset.disabled).toBe(true);
  // Each control is disabled in its own right too, not only through the fieldset.
  for (const field of within(fieldset).getAllByRole("textbox")) {
    expect((field as HTMLInputElement).disabled).toBe(true);
  }
  const key = view.getByPlaceholderText("API 密钥") as HTMLInputElement;
  expect(key.disabled).toBe(true);
  const provider = within(fieldset).getByRole("combobox");
  expect(
    provider.hasAttribute("disabled") ||
      provider.getAttribute("aria-disabled") === "true" ||
      provider.hasAttribute("data-disabled"),
  ).toBe(true);
  // Both ways in are shut: the header button and the form's own submit.
  const connect = view.getAllByRole("button", { name: "接入" });
  expect(connect).toHaveLength(2);
  for (const button of connect) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  // And a submit forced anyway sends nothing.
  (fieldset.closest("form") as HTMLFormElement).requestSubmit();
  await settleReactWork();
  expect(writes).toHaveLength(0);
});

test("the picker offers the pool and the library as two groups, the unavailable pool row disabled", async () => {
  serve({ models: [ownModel], templates: [], pool, customModels: true });
  drawDialog();

  await openPicker();
  const body = within(document.body);
  expect(body.getByText("平台体验模型")).toBeTruthy();
  expect(body.getByText("我的模型库")).toBeTruthy();
  const groups = body.getAllByRole("group");
  expect(groups).toHaveLength(2);
  expect(
    within(groups[0] as HTMLElement)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["GLM-4.6 · 智谱 GLM", "DeepSeek Chat · DeepSeek（暂不可用）"]);
  expect(
    within(groups[1] as HTMLElement)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["GPT-6 · OpenAI"]);
  const dark = body.getByRole("option", {
    name: "DeepSeek Chat · DeepSeek（暂不可用）",
  });
  expect(
    dark.getAttribute("aria-disabled") === "true" ||
      dark.hasAttribute("data-disabled"),
  ).toBe(true);
});

test("picking a pool model saves it and clears the library binding", async () => {
  serve(
    { models: [ownModel], templates: [], pool, customModels: true },
    { ...coworker, modelRef: OWN_GPT },
  );
  drawDialog();

  const user = await openPicker();
  await user.click(
    within(document.body).getByRole("option", { name: "GLM-4.6 · 智谱 GLM" }),
  );

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.method).toBe("PATCH");
  expect(writes[0]?.path).toBe("/api/agents/reviewer");
  expect(writes[0]?.body).toMatchObject({
    platformModelRef: POOL_GLM,
    modelRef: null,
  });
});

test("picking a library model saves it and clears the pool binding", async () => {
  serve(
    { models: [ownModel], templates: [], pool, customModels: true },
    { ...coworker, platformModelRef: POOL_GLM },
  );
  drawDialog();

  const user = await openPicker();
  await user.click(
    within(document.body).getByRole("option", { name: "GPT-6 · OpenAI" }),
  );

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toMatchObject({
    modelRef: OWN_GPT,
    platformModelRef: null,
  });
});

test("the deployment's own model clears both bindings", async () => {
  serve(
    { models: [ownModel], templates: [], pool, customModels: true },
    { ...coworker, platformModelRef: POOL_GLM },
  );
  drawDialog();

  const user = await openPicker();
  await user.click(
    within(document.body).getByRole("option", { name: "部署自带的模型" }),
  );

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toMatchObject({
    modelRef: null,
    platformModelRef: null,
  });
});

test("an unavailable pool row cannot be picked", async () => {
  serve({ models: [ownModel], templates: [], pool, customModels: true });
  drawDialog();

  const user = await openPicker();
  await user.click(
    within(document.body).getByRole("option", {
      name: "DeepSeek Chat · DeepSeek（暂不可用）",
    }),
  );
  // Give a save every chance to have been sent before asserting none was.
  await settleReactWork();
  expect(writes).toHaveLength(0);
});

test("a remote AG-UI coworker shows 外部托管模型 and no picker", async () => {
  serve(
    { models: [ownModel], templates: [], pool, customModels: true },
    {
      ...coworker,
      builtIn: false,
      endpoint: "https://agents.example.test/ag-ui",
    },
  );
  drawDialog();

  const body = within(document.body);
  expect(await body.findByText("外部托管模型")).toBeTruthy();
  expect(body.queryByRole("combobox", { name: "模型" })).toBeNull();
});

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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourcesStep } from "@/components/avatar/avatar-sources";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { type AvatarSourceState, avatarSourceKeys } from "@/lib/avatar/sources";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

/**
 * Story F1, stage 1: the onboarding step where a person tells their 分身 where their material lives.
 *
 * The step is drawn on its own for what it writes (the source, then the step, in that order; or the
 * step alone when skipped), and the whole wizard is drawn for where the step sits and that the step
 * number the server holds is where a reload resumes. The fetch is faked and records every call.
 */
let registeredHere = false;
beforeAll(() => {
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
const calls: { method: string; path: string; body: unknown }[] = [];
const writes = () => calls.filter((call) => call.method !== "GET");

const AVATAR = "avatar-person-1";
const emptyState: AvatarSourceState = {
  agentId: AVATAR,
  configuredAt: null,
  sources: [],
};

const user = (step: number): AuthenticatedUser => ({
  id: "person-1",
  email: "person@f1.test",
  role: "user",
  onboarding: { step, completedAt: null },
});

/** Answers the reads and writes these screens make; `refuse` makes the source save fail. */
function serve(options: { refuse?: { status: number; error: string } } = {}) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === "/api/me/avatar/sources" && method === "POST") {
      if (options.refuse)
        return Response.json(
          { error: options.refuse.error },
          { status: options.refuse.status },
        );
      return Response.json(
        {
          source: {
            id: "source-1",
            kind: "declaration",
            label: body.label,
            note: body.note,
            createdAt: "2026-11-03T00:00:00.000Z",
          },
        },
        { status: 201 },
      );
    }
    if (path === "/api/me/avatar/sources") return Response.json(emptyState);
    if (path === "/api/me/onboarding")
      return Response.json({
        onboarding: { step: body.step, completedAt: null },
      });
    if (path === "/api/me") return Response.json({ user: user(0) });
    return Response.json({});
  }) as typeof fetch;
}

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(avatarSourceKeys.state(), emptyState);
  return queryClient;
}

function drawStep(onAdvanced: () => void = () => {}) {
  const view = render(
    <QueryClientProvider client={client()}>
      <SourcesStep nextStep={2} onAdvanced={onAdvanced} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

const button = (view: ReturnType<typeof render>, name: string) =>
  view.getByRole("button", { name }) as HTMLButtonElement;

test("the step asks where the material is, says it goes to the model, and starts on a declaration", async () => {
  serve();
  const { view } = drawStep();

  expect(view.getByText("告诉你的分身，你的资料在哪里")).toBeTruthy();
  expect(view.getByLabelText("名称")).toBeTruthy();
  expect(view.getByLabelText("说明（可选）")).toBeTruthy();
  expect(
    view.getByText(/会把这些信息来源的名称和说明一起发送给你所用的模型服务/),
  ).toBeTruthy();
  expect(
    view.getByRole("checkbox", {
      name: "我已了解，信息来源的说明会发送给模型服务",
    }),
  ).toBeTruthy();
  expect(view.getByText("还没有登记信息来源。")).toBeTruthy();
  // Stage 2 offers a local folder beside the declaration (tests/avatar-local-folder-ui.test.tsx), but
  // the draft is a declaration until the folder is asked for, and no machine is asked about before.
  expect(button(view, "文字声明").getAttribute("aria-pressed")).toBe("true");
  expect(button(view, "本地文件夹").getAttribute("aria-pressed")).toBe("false");
  expect(view.queryByText("选择一个文件夹")).toBeNull();
  expect(calls.some((call) => call.path === "/api/devices")).toBeFalse();
  // Nothing is saved until somebody asks: no tick, no name, no save.
  expect(button(view, "保存并继续").disabled).toBeTrue();
  expect(writes()).toEqual([]);
});

test("saving writes the declaration, then the next step, and only then moves on", async () => {
  serve();
  let advanced = 0;
  const { view, user } = drawStep(() => {
    advanced += 1;
  });

  await user.type(view.getByLabelText("名称"), "周报");
  await user.type(view.getByLabelText("说明（可选）"), "在飞书 / 工作 / 周报");
  // Typed but not agreed: the notice is a condition of saving, not decoration.
  expect(button(view, "保存并继续").disabled).toBeTrue();
  await user.click(
    view.getByRole("checkbox", {
      name: "我已了解，信息来源的说明会发送给模型服务",
    }),
  );
  await user.click(button(view, "保存并继续"));

  await waitFor(() => expect(advanced).toBe(1));
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/me/avatar/sources",
      body: {
        kind: "declaration",
        label: "周报",
        note: "在飞书 / 工作 / 周报",
      },
    },
    { method: "POST", path: "/api/me/onboarding", body: { step: 2 } },
  ]);
});

test("skipping writes no source, and still saves the next step", async () => {
  serve();
  let advanced = 0;
  const { view, user } = drawStep(() => {
    advanced += 1;
  });

  // Even with something typed: skipping is not saving.
  await user.type(view.getByLabelText("名称"), "草稿");
  await user.click(button(view, "跳过，稍后在分身详情页配置"));

  await waitFor(() => expect(advanced).toBe(1));
  expect(writes()).toEqual([
    { method: "POST", path: "/api/me/onboarding", body: { step: 2 } },
  ]);
});

test("a refused save is said, and the wizard does not move on", async () => {
  serve({ refuse: { status: 409, error: "每个分身最多登记 10 个信息来源。" } });
  let advanced = 0;
  const { view, user } = drawStep(() => {
    advanced += 1;
  });

  await user.type(view.getByLabelText("名称"), "周报");
  await user.click(
    view.getByRole("checkbox", {
      name: "我已了解，信息来源的说明会发送给模型服务",
    }),
  );
  await user.click(button(view, "保存并继续"));

  expect((await view.findByRole("alert")).textContent).toBe(
    "每个分身最多登记 10 个信息来源。",
  );
  expect(advanced).toBe(0);
  expect(writes().map((call) => call.path)).toEqual(["/api/me/avatar/sources"]);
});

/** The whole wizard, with the person's onboarding status as the server holds it. */
function drawWizard(step: number) {
  const queryClient = client();
  queryClient.setQueryData(authKeys.currentUser(), user(step));
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/onboarding"] }),
    routeTree: root.addChildren([
      OnboardingRoute.update({
        getParentRoute: () => root,
        path: "/onboarding",
      } as never),
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => null,
      } as never),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("the step comes right after the welcome, and moving to it is saved", async () => {
  serve();
  const { view, user } = drawWizard(0);

  await view.findByText(/欢迎来到/);
  await user.click(view.getByRole("button", { name: "继续" }));

  await view.findByText("告诉你的分身，你的资料在哪里");
  expect(writes()).toEqual([
    { method: "POST", path: "/api/me/onboarding", body: { step: 1 } },
  ]);
  // The step carries its own ways forward, so the wizard's 继续 is not shown under it.
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
});

test("a reload resumes at the step the server holds", async () => {
  serve();
  const { view } = drawWizard(1);

  expect(await view.findByText("告诉你的分身，你的资料在哪里")).toBeTruthy();
  expect(view.queryByText(/欢迎来到/)).toBeNull();
  expect(writes()).toEqual([]);
});

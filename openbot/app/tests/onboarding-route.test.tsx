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
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
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
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

/**
 * Where somebody is in onboarding lives in the address: `?step=<id>`. A reload stays on the step,
 * browser Back walks back one, and every move is saved, so arriving without a step opens the one
 * they were on. There are three steps at most: Welcome, where the person's 分身 finds their material
 * (你的资料, which carries its own ways forward), and the name, which is left out once the name is
 * known. The last step's way forward is the way out: it completes onboarding, plays its finish and
 * opens the app. Upstream's Book a demo step (a sales calendar) is left out of this deployment.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = {
  id: "general",
  name: "General Assistant",
  title: "Everyday work",
  roleDescription: "",
  avatarSeed: "general",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  mine: false,
};

/** A Bot computer row as the server sends it: none configured. */
const NO_COMPUTER = {
  id: "computer",
  scope: "deployment",
  title: "Bot computer",
  required: false,
  status: "needs_setup",
  ready: false,
  detail: "Your admin sets this up.",
  fix: null,
};

const originalFetch = globalThis.fetch;
let saved: number;
let saves: number[];
let completed: boolean;
let completeFail: boolean;
let named: string | null;
/** What `GET /api/setup` answers. */
let checklist: { audience: string; rows: unknown[] };
/** Ask before making changes, as `GET /api/approvals` says it, and every change asked for. */
let askFirst: boolean;
let askFirstChanges: unknown[];
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  // Another file's screens may have cached the signed-in person in the app's one query client.
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
    mutations: { ...defaults.mutations, retry: false },
  });
  saved = 0;
  saves = [];
  completed = false;
  completeFail = false;
  named = null;
  checklist = {
    audience: "admin",
    rows: [{ ...NO_COMPUTER, status: "ready", ready: true }],
  };
  askFirst = false;
  askFirstChanges = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/me")
        return Response.json({
          user: {
            id: "person-1",
            email: "maya@example.com",
            name: named ?? "maya@example.com",
            needsName: named === null,
            role: "admin",
            onboarding: {
              step: saved,
              completedAt: completed ? "2026-10-23T00:00:00Z" : null,
            },
          },
        });
      if (path === "/api/me/profile" && method === "PATCH") {
        named = (JSON.parse(String(init?.body)) as { name: string }).name;
        return Response.json({ profile: { name: named, needsName: false } });
      }
      if (path === "/api/me/onboarding" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          step?: number;
          completed?: boolean;
        };
        if (body.completed) {
          if (completeFail)
            return Response.json({ error: "down" }, { status: 503 });
          completed = true;
          return Response.json({
            onboarding: { step: saved, completedAt: "2026-10-23T00:00:00Z" },
          });
        }
        if (body.step === undefined) throw new Error("Missing onboarding step");
        saves.push(body.step);
        saved = body.step;
        return Response.json({
          onboarding: { step: saved, completedAt: null },
        });
      }
      // The 你的资料 step: the person's 分身 with nothing registered yet.
      if (path === "/api/me/avatar/sources")
        return Response.json({
          agentId: "avatar-person-1",
          configuredAt: null,
          sources: [],
        });
      if (path.startsWith("/api/agents"))
        return Response.json({ agents: [BOT] });
      if (path === "/api/setup") return Response.json({ checklist });
      if (path === "/api/approvals")
        return Response.json({ enabled: askFirst, rules: [], pending: [] });
      if (path === "/api/approvals/preferences" && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { enabled?: boolean };
        askFirstChanges.push(body);
        if (body.enabled !== undefined) askFirst = body.enabled;
        return Response.json({ enabled: askFirst });
      }
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
});

function open(path: string, given?: ReturnType<typeof createMemoryHistory>) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const homeRoute = createRoute({
    path: "/",
    getParentRoute: () => authedRoute,
    component: () => <p>Home</p>,
  });
  const wired = (
    OnboardingRoute as unknown as {
      update: (options: unknown) => typeof OnboardingRoute;
    }
  ).update({
    id: "/onboarding",
    path: "/onboarding",
    getParentRoute: () => authedRoute,
  });
  const history = given ?? createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([homeRoute, wired]),
    ]),
    history,
    context: { queryClient },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router, history });
}

const heading = (view: ReturnType<typeof render>, name: string) =>
  view.findByRole("heading", { name });
const searchOf = (view: ReturnType<typeof open>) =>
  view.router.state.location.search as { step?: string };
/** The phone's Back, at the top left. The desktop's is the same button beside Continue. */
const back = (view: ReturnType<typeof render>) => {
  const found = view.container.querySelector<HTMLButtonElement>(
    '[data-onboarding-back="phone"]',
  );
  if (!found) throw new Error("no Back");
  return found;
};
/** The desktop's list of steps, opened from "Step N of M" above the heading. */
const openSteps = async (view: ReturnType<typeof render>) => {
  fireEvent.click(
    await waitFor(() => {
      const found = view.container.querySelector("[data-onboarding-steps]");
      if (!found) throw new Error("no step menu");
      return found as HTMLElement;
    }),
  );
  return view.findByRole("navigation", { name: "新手引导步骤" });
};
/** The names in the list of steps, without the marks' words. */
const stepNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((item) =>
      item.textContent
        ?.replace(/^\d/, "")
        .replace(/，(已完成|暂不可用)$/, ""),
    );
/** A footer button by name, once the deployment's answer has let it be pressed. */
const ready = async (view: ReturnType<typeof render>, name: string) => {
  const button = await view.findByRole("button", { name });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
};
const continueButton = (view: ReturnType<typeof render>) =>
  ready(view, "继续");
/** 你的资料's own way on without registering anything. */
const skipSources = (view: ReturnType<typeof render>) =>
  ready(view, "跳过，稍后在分身详情页配置");
/** The footer's buttons, in order. */
const footerButtons = (view: ReturnType<typeof render>) =>
  Array.from(view.container.querySelectorAll("footer button")).map(
    (button) => button.textContent,
  );
/** How many scenes the intro's reel plays, read from its dots. */
const reelScenes = (view: ReturnType<typeof render>) =>
  view.container.querySelectorAll("[data-intro-reel] > [aria-hidden] > span")
    .length;

const WELCOME = "欢迎来到熊宝数字员工";
const SOURCES = "告诉你的分身，你的资料在哪里";
const NAME = "我们该怎么称呼你？";

test("arriving without a step writes the first one into the address, in place", async () => {
  const view = open("/onboarding");

  await heading(view, WELCOME);
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
  // In place: nothing behind it to go Back to inside onboarding.
  expect(view.history.length).toBe(1);
});

// "Hand work to Bots" was read with "Hand" as a noun. "Give" can only be the verb.
test("Welcome says to give work to Bots in plain words", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);
  expect(
    view.getByText("用平常的话把工作交给员工，做完了它会告诉你。"),
  ).toBeTruthy();
  expect(view.queryByText(/Hand work to Bots/)).toBeNull();
});

test("Continue adds a step to the address and to history, and saves it", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  fireEvent.click(await continueButton(view));

  await heading(view, SOURCES);
  expect(searchOf(view).step).toBe("sources");
  expect(view.history.length).toBe(2);
  await waitFor(() => expect(saves).toContain(4));
});

test("somebody whose name isn't known has three steps: Welcome, their material, then the name", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  expect(stepNames(await openSteps(view))).toEqual([WELCOME, SOURCES, NAME]);
});

test("on every step, its name in the list of steps is its heading", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  const seen: string[] = [];
  for (;;) {
    const h1 = view.container.querySelector(
      `[data-step="${searchOf(view).step}"] h1`,
    );
    const list = await openSteps(view);
    const current = list.querySelector('[aria-current="step"]');
    expect(current?.textContent?.replace(/^\d/, "")).toBe(
      h1?.textContent ?? "",
    );
    seen.push(h1?.textContent ?? "");
    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() =>
      expect(
        view.queryByRole("navigation", { name: "新手引导步骤" }),
      ).toBeNull(),
    );
    if (searchOf(view).step === "name") break;
    const step = searchOf(view).step;
    fireEvent.click(
      step === "sources"
        ? await skipSources(view)
        : await continueButton(view),
    );
    await waitFor(() => expect(searchOf(view).step).not.toBe(step));
  }
  expect(seen).toEqual([WELCOME, SOURCES, NAME]);
});

test("Welcome asks to set up permissions, with Always ask before making changes beside the words, not in the picture", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  const permissions = view.getByRole("heading", { name: "设置权限" });
  expect(permissions.tagName).toBe("H2");
  const ask = await view.findByRole("switch", {
    name: "做任何改动前都先问我",
  });
  // A real control: with the words, and nowhere inside the inert illustration.
  expect(ask.closest("[data-onboarding-intro]")).not.toBeNull();
  expect(ask.closest("[data-onboarding-demo]")).toBeNull();
  expect(ask.closest("[inert]")).toBeNull();
  expect(
    view.container.querySelector("[data-onboarding-demo] [data-intro-reel]"),
  ).not.toBeNull();
});

/*
 * REPORTED ON 0.3.3: "Ask before making changes" read as if turning it off also stopped the asks for
 * deleting, sending, sharing and posting, and the sentence saying they always ask sat under the
 * switch where it was missed. What always asks is said first, above the switch, and the switch says
 * it adds routine changes on top (server/src/approvals/policy.ts: safety before the default).
 */
test("Welcome says what always asks before the switch, and the switch says it covers every change", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  const ask = await view.findByRole("switch", {
    name: "做任何改动前都先问我",
  });
  const always = view.getByText(
    /^员工在你的应用或网站上删除、发送、分享或发布内容之前，总会先征得你的同意。/,
  );
  expect(always.textContent).toContain(
    "付款和账号安全设置的改动，员工会留给你亲自处理。",
  );
  // Above the switch in the reading order, not under it.
  expect(
    always.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const row = ask.closest("[data-slot='item']");
  expect(row?.textContent).toContain("做任何改动前都先问我");
  expect(row?.textContent).toContain(
    "对你的应用、网站和文件的每一处改动都要先经你同意，日常的编辑和更新也不例外。",
  );
  expect(row?.textContent).not.toContain(
    "Review a Bot's changes to websites, connected apps, and files.",
  );

  // The workspace exception and where to change it later come after the switch, each on its own.
  const workspace = view.getByText(
    "除非打开这个开关，员工可以在自己的工作区里新建、修改和删除文件，不必先问你。",
  );
  const later = view.getByText("之后随时可以在设置里修改。");
  expect(
    ask.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(workspace).not.toBe(later);
  expect(view.queryByText(/always wait for you/)).toBeNull();
});

test("switching Always ask before making changes on Welcome saves it, and moves nothing on", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  const ask = await view.findByRole("switch", {
    name: "做任何改动前都先问我",
  });
  await waitFor(() => expect(ask.hasAttribute("data-disabled")).toBe(false));
  expect(ask.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(ask);

  await waitFor(() => expect(askFirstChanges).toEqual([{ enabled: true }]));
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "做任何改动前都先问我" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(searchOf(view).step).toBe("welcome");
});

test("with a Bot computer, the intro plays all three scenes", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));

  expect(reelScenes(view)).toBe(3);
});

test("without a Bot computer, the intro leaves the computer scene out", async () => {
  checklist = { audience: "member", rows: [NO_COMPUTER] };
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  await waitFor(() => expect(reelScenes(view)).toBe(2));
  expect(view.container.querySelector('[data-scene="computer"]')).toBeNull();
});

test("moving on and Back start the new step's picture at the top of its pane", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);
  const pane = () =>
    view.container.querySelector("[data-onboarding-demo]") as HTMLElement;
  pane().scrollTop = 120;

  fireEvent.click(await continueButton(view));
  const sources = await heading(view, SOURCES);
  await waitFor(() => expect(document.activeElement).toBe(sources));
  fireEvent.click(await skipSources(view));

  const name = await heading(view, NAME);
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(pane().scrollTop).toBe(0);

  pane().scrollTop = 120;
  fireEvent.click(back(view));
  await heading(view, SOURCES);
  fireEvent.click(back(view));
  const welcome = await heading(view, WELCOME);
  await waitFor(() => expect(document.activeElement).toBe(welcome));
  expect(pane().scrollTop).toBe(0);
});

test("browser Back goes to the step before, not out of onboarding", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);
  fireEvent.click(await continueButton(view));
  await heading(view, SOURCES);

  await act(async () => view.history.back());

  expect(await heading(view, WELCOME)).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
});

test("Back after Continue returns through history, so Forward still works", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);
  fireEvent.click(await continueButton(view));
  await heading(view, SOURCES);

  fireEvent.click(back(view));

  expect(await heading(view, WELCOME)).toBeTruthy();
  expect(view.history.canGoBack()).toBe(false);
  await act(async () => view.history.forward());
  expect(await heading(view, SOURCES)).toBeTruthy();
});

test("Back on a step opened by reload replaces it with the step before", async () => {
  const view = open("/onboarding?step=name");
  await heading(view, NAME);

  fireEvent.click(back(view));

  expect(await heading(view, SOURCES)).toBeTruthy();
  expect(searchOf(view).step).toBe("sources");
  expect(view.history.length).toBe(1);
});

test("on a desktop, a step already passed can be picked from the list", async () => {
  const view = open("/onboarding?step=sources");
  await heading(view, SOURCES);

  const list = await openSteps(view);
  expect(within(list).queryByRole("button", { name: /我们该怎么称呼你/ })).toBe(
    null,
  );
  fireEvent.click(within(list).getByRole("button", { name: /欢迎来到/ }));

  expect(await heading(view, WELCOME)).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
  // It has seen 你的资料, so the list leads back to it.
  fireEvent.click(
    within(await openSteps(view)).getByRole("button", {
      name: /你的资料在哪里/,
    }),
  );
  expect(await heading(view, SOURCES)).toBeTruthy();
});

test("a reload stays on the step in the address", async () => {
  const view = open("/onboarding?step=name");

  expect(await heading(view, NAME)).toBeTruthy();
  expect(searchOf(view).step).toBe("name");
});

test("arriving with no step opens the one the server saved", async () => {
  saved = 4;
  const view = open("/onboarding");

  expect(await heading(view, SOURCES)).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("sources"));
});

test("a step that isn't one is ignored", async () => {
  const view = open("/onboarding?step=nonsense");

  expect(await heading(view, WELCOME)).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
});

/*
 * Upstream's Book a demo step kept the number 2. This deployment leaves the step out, so neither its
 * id in the address nor its number on the server opens anything but the start, and 2 is never saved.
 */
test.each([
  ["in the address", "/onboarding?step=selfhost", 0],
  ["saved", "/onboarding", 2],
])(
  "upstream's Book a demo step %s opens Welcome, and saves that",
  async (_label, path, stored) => {
    saved = stored;
    const view = open(path);

    expect(await heading(view, WELCOME)).toBeTruthy();
    await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
    await waitFor(() => expect(saved).toBe(1));
    expect(saves).not.toContain(2);
  },
);

test("after a reload, Back still returns through history, not a second entry", async () => {
  const first = open("/onboarding?step=welcome");
  await heading(first, WELCOME);
  fireEvent.click(await continueButton(first));
  await heading(first, SOURCES);
  const history = first.history;
  first.unmount();
  queryClient.clear();

  // The same history, a new page: what a reload keeps.
  const reloaded = open("/onboarding?step=sources", history);
  await heading(reloaded, SOURCES);
  fireEvent.click(back(reloaded));

  expect(await heading(reloaded, WELCOME)).toBeTruthy();
  expect(history.length).toBe(2);
  expect(history.canGoBack()).toBe(false);
});

// Saving the name makes it known: the name step stays until onboarding ends, never Welcome again.
test("Get started on the name step saves the name, finishes, plays the orb's finish, then opens the app", async () => {
  const view = open("/onboarding?step=name");
  await heading(view, NAME);
  // The frame's primary is the name form's Get started, not a Continue.
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();
  // Under the orb: on a phone the picture comes first.
  expect(
    view.container.querySelector("[data-onboarding-demo]")?.className,
  ).toContain("row-start-2");

  await userEvent.setup({ document }).type(view.getByLabelText("名字"), "Maya");
  fireEvent.click(view.getByRole("button", { name: "开始使用" }));

  await waitFor(() =>
    expect(
      view.container.querySelector(
        '[data-onboarding-finish] [data-state="done"]',
      ),
    ).not.toBeNull(),
  );
  expect(named).toBe("Maya");
  expect(completed).toBe(true);
  expect(view.queryByText("Home")).toBeNull();
  // While the orb finishes, the button says what has happened.
  expect(
    view.getByRole("button", { name: "好了" }).hasAttribute("data-done"),
  ).toBe(true);
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
});

/*
 * A NAME ALREADY KNOWN IS NOT ASKED FOR. The name step leaves the list, and the last step left
 * finishes onboarding in its place: 你的资料, whose own ways on open the app.
 */

test("somebody whose name is known has Welcome then their material, and skipping it opens the app", async () => {
  named = "Maya";
  const view = open("/onboarding?step=welcome");
  await heading(view, WELCOME);

  expect(stepNames(await openSteps(view))).toEqual([WELCOME, SOURCES]);
  fireEvent.keyDown(
    view.getByRole("navigation", { name: "新手引导步骤" }),
    { key: "Escape" },
  );
  fireEvent.click(await continueButton(view));
  await heading(view, SOURCES);
  // The step carries its own ways on: no frame button that would finish behind its back.
  expect(view.queryByRole("button", { name: "开始使用" })).toBeNull();
  expect(view.queryByRole("button", { name: "继续" })).toBeNull();

  fireEvent.click(await skipSources(view));

  await waitFor(() => expect(completed).toBe(true));
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
  expect(view.router.state.location.pathname).toBe("/");
});

test("a name step in the address, once the name is known, opens the last step there is", async () => {
  named = "Maya";
  const view = open("/onboarding?step=name");

  expect(await heading(view, SOURCES)).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("sources"));
  expect(view.queryByRole("heading", { name: NAME })).toBe(null);
});

test("a completion that fails on the last step says so, stays, and can be pressed again", async () => {
  named = "Maya";
  completeFail = true;
  const view = open("/onboarding?step=sources");
  await heading(view, SOURCES);

  fireEvent.click(await skipSources(view));

  expect((await view.findByRole("alert")).textContent).toBe("down");
  expect(completed).toBe(false);
  expect(view.queryByText("Home")).toBeNull();

  completeFail = false;
  fireEvent.click(await skipSources(view));
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
});

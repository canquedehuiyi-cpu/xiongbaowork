import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
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
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import {
  AVATAR_SEED_PATTERN,
  agentFormSchema,
  agentInputFrom,
  emptyAgentForm,
  randomAvatarSeed,
} from "@/lib/agents/form";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * Story D2: a new Waker's avatar seed is chosen in the create dialog, and the face shown is the face
 * created.
 *
 * Same harness as `composing-enter.test.tsx`: `GlobalRegistrator`, `cleanup`, a stubbed `fetch` that
 * records every write, and the real dialog inside a router of one route.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

let writes: { request: string; body: unknown }[] = [];

const CREATED: AgentProfile = {
  id: "agent_new",
  name: "报销专员",
  title: "财务运营",
  roleDescription: "审核票据。",
  avatarSeed: "agent_new",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  modelRef: null,
  persona: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

beforeEach(() => {
  writes = [];
  global.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      if (path === "/api/agents/capabilities") {
        return Response.json({ capabilities: { builtInAvailable: true } });
      }
      if (path === "/api/agents" && method === "POST") {
        return Response.json({ agent: CREATED }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function draw(screen: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** The seed the preview is drawn from right now. */
function previewSeed(preview: HTMLElement): string {
  const seed = preview.getAttribute("data-avatar-seed");
  if (!seed) throw new Error("the avatar preview has no seed");
  return seed;
}

describe("the avatar seed in the form contract", () => {
  test("a fresh seed always matches what the server accepts, and differs each time", () => {
    const seeds = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const seed = randomAvatarSeed();
      expect(seed).toMatch(AVATAR_SEED_PATTERN);
      seeds.add(seed);
    }
    expect(seeds.size).toBe(50);
  });

  test("the schema refuses a seed the server would refuse", () => {
    const valid = {
      ...emptyAgentForm,
      name: "a",
      title: "b",
      roleDescription: "c",
    };
    expect(
      agentFormSchema.safeParse({ ...valid, avatarSeed: "ok-seed:1.x_y" })
        .success,
    ).toBe(true);
    expect(agentFormSchema.safeParse(valid).success).toBe(true);
    for (const bad of ["", "s".repeat(65), "有空 格", "a/b"]) {
      expect(
        agentFormSchema.safeParse({ ...valid, avatarSeed: bad }).success,
      ).toBe(false);
    }
  });

  test("the API input carries a chosen seed and omits an absent one", () => {
    expect(agentInputFrom({ ...emptyAgentForm, avatarSeed: "abc" })).toEqual(
      expect.objectContaining({ avatarSeed: "abc" }),
    );
    expect("avatarSeed" in agentInputFrom(emptyAgentForm)).toBe(false);
  });
});

test("the create dialog previews a seed, rerolls it with 换一个, and creates with the previewed one", async () => {
  const created: string[] = [];
  const view = draw(
    <CreateAgentDialog
      onClose={() => {}}
      onCreated={(id) => {
        created.push(id);
      }}
      open
    />,
  );

  const preview = await view.findByTestId("create-agent-avatar-preview");
  const first = previewSeed(preview);
  expect(first).toMatch(AVATAR_SEED_PATTERN);
  // The face itself is drawn, and announced once, as this coworker's avatar.
  expect(view.getByRole("img", { name: "新员工的头像" })).toBeTruthy();

  const user = userEvent.setup({ document: preview.ownerDocument });
  await user.click(view.getByRole("button", { name: "换一个" }));
  const rerolled = previewSeed(view.getByTestId("create-agent-avatar-preview"));
  expect(rerolled).toMatch(AVATAR_SEED_PATTERN);
  expect(rerolled).not.toBe(first);
  // Rerolling is not Continue: still on the first step, and nothing was written.
  expect(view.getByText("第 1 步，共 3 步")).toBeTruthy();
  expect(writes).toEqual([]);

  await user.type(view.getByLabelText("名字"), "报销专员");
  await user.type(view.getByLabelText("头衔"), "财务运营");
  await user.type(view.getByLabelText("角色"), "审核票据。");
  // The preview names the coworker once it has a name, and keeps the same face.
  expect(view.getByRole("img", { name: "报销专员的头像" })).toBeTruthy();
  expect(previewSeed(view.getByTestId("create-agent-avatar-preview"))).toBe(
    rerolled,
  );

  await user.click(view.getByRole("button", { name: "下一步" }));
  expect(await view.findByText("第 2 步，共 3 步")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "下一步" }));
  expect(await view.findByText("第 3 步，共 3 步")).toBeTruthy();

  const builtIn = view.container.ownerDocument.querySelector(
    'input[value="builtin"]',
  );
  if (!builtIn) throw new Error("no built-in choice");
  await user.click(builtIn);
  await user.click(view.getByRole("button", { name: "创建员工" }));
  await settle();

  expect(writes).toHaveLength(1);
  expect(writes[0]?.request).toBe("POST /api/agents");
  expect(writes[0]?.body).toMatchObject({
    name: "报销专员",
    title: "财务运营",
    roleDescription: "审核票据。",
    visibility: "private",
    avatarSeed: rerolled,
  });
  expect(created).toEqual([CREATED.id]);
});

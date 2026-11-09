import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
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
import { cleanup, render } from "@testing-library/react";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import * as gallery from "@/lib/copilot/gallery-registry";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen on Windows after an in-app update: Activity showed two identical rows at the same second,
 * "Let a component read data / Activity report / Started by OpenBot / Can read this", one per data
 * function OpenBot Personal gave the report, neither saying which. And a Bot creating a routine
 * showed twice: "Create routine / Routines / Called on this Bot's behalf" for its call, and "Create a
 * routine / - / Allowed" for the routine, with no Bot.
 */

/*
 * 熊宝版没有个人版的「活动」页：这里只测管理端的审计表（上游 `components/manage/audit-page.tsx`，
 * 待接入 /admin/audit），个人版专有的用例不收。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

// `import.meta.glob` is Vite's; under `bun test` the gallery lookup is answered from its modules.
const compiled = spyOn(gallery, "galleryComponent");
beforeEach(() => {
  compiled.mockImplementation((name) =>
    ACTIVITY.find((spec) => spec.name === name),
  );
});
afterAll(() => compiled.mockRestore());

const BOT = "personal-assistant";

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId: string;
    initiatorKind?: string;
    payload: Record<string, unknown>;
  },
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    ...fields,
    createdAt: `2026-11-08T03:${String(minute).padStart(2, "0")}:00Z`,
  };
}

const granted = (id: string, minute: number, data: Record<string, unknown>) =>
  row(id, minute, {
    eventType: "component.function_granted",
    targetType: "component",
    targetId: "showActivityReport",
    initiatorKind: "deployment",
    payload: { actor: "person@example.test", ...data },
  });

const ROUTINE = row("routine", 30, {
  eventType: "routine.created",
  targetType: "routine",
  targetId: "routine-1",
  payload: { agentId: BOT, channelId: null, cron: "0 9 * * *" },
});

/** As the server answers Activity: a Routines call whose routine has its own row is left out. */
const ROWS = [
  ROUTINE,
  // One row naming both, as OpenBot Personal now gives them.
  granted("given", 25, { functions: ["botActivity", "recentRefusals"] }),
  // As 0.3.3 recorded them: a row per function, at the same second.
  granted("given-one", 20, { function: "botActivity" }),
  granted("given-two", 20, { function: "recentRefusals" }),
];

async function renderPage(audit: Record<string, unknown[]>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  for (const [search, events] of Object.entries(audit))
    seedAuditPage(queryClient, search, { events });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Personal Assistant" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("结果");
  return view;
}

const lines = (cell: Element | null) =>
  [...(cell?.children ?? [])].map((line) => line.textContent);

function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    what: lines(tr.querySelector("[data-column=what]")),
    who: lines(tr.querySelector("[data-column=bot]")),
  }));
}

test("Admin names the functions as stored", async () => {
  const view = await renderPage({ "": ROWS });
  expect(drawn(view.container).map((one) => one.what)).toEqual([
    ["创建定时任务"],
    ["允许组件读取数据", "showActivityReport · botActivity, recentRefusals"],
    ["允许组件读取数据", "showActivityReport · botActivity"],
    ["允许组件读取数据", "showActivityReport · recentRefusals"],
  ]);
});

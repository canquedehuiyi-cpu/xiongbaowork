import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { withBot } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Activity page after a day of work in conversations and no tasks: it used to say "Nothing
 * has finished yet", because it lists tasks, routines and goals and a saved file is none of them.
 * It now says what it lists, and links to every action the Bot took, in the trail narrowed to it.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = "bot-claude";
const AuditRoutePage = AuditRoute.options.component as ComponentType;

async function renderWith(
  ui: ReactNode,
  options: {
    edition: "personal" | "team";
    role: "admin" | "user";
    audit?: Record<string, unknown[]>;
    ready?: string;
    /** Where the page is opened, search included. */
    at?: string;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(botLifecycleKeys.activity(BOT), {
    inProgress: [],
    scheduled: [],
    completed: [],
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: options.edition,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "person",
    email: "person@example.test",
    role: options.role,
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Claude Agent SDK" },
  ]);
  for (const [search, events] of Object.entries(options.audit ?? {}))
    seedAuditPage(queryClient, search, { events });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: [options.at ?? "/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText(options.ready ?? "已完成");
  return view;
}

test("says what it lists, and does not claim the Bot has done nothing", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "team",
    role: "admin",
  });
  expect(view.queryByText("Nothing has finished yet.")).toBeNull();
  expect(view.getByText("还没有做完的事。")).toBeTruthy();
  // And where the rest of what it did is: every action, in the trail.
  expect(view.getByText("这位员工做过的每个动作")).toBeTruthy();
});

test("for a team admin, links to Admin › Audit narrowed to this Bot", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "team",
    role: "admin",
  });
  const link = view
    .getByText("这位员工做过的每个动作")
    .closest("a") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(`/admin/audit?bot=${BOT}`);
});

test("a team member, who cannot open the trail, is not sent to it", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "team",
    role: "user",
  });
  expect(view.queryByText("这位员工做过的每个动作")).toBeNull();
});

test("the trail opened for one Bot asks the server for that Bot's rows, and says so", async () => {
  const search = withBot("", BOT);
  expect(search).toBe(`?bot=${BOT}`);
  // Beside a saved view's types, it narrows that view.
  expect(
    withBot("?eventType=computer.action_refused,mcp.call_rejected", BOT),
  ).toBe(`?eventType=computer.action_refused%2Cmcp.call_rejected&bot=${BOT}`);
  // Seeded only under the narrowed query: rows drawn mean the page asked for exactly that.
  const view = await renderWith(<AuditRoutePage />, {
    edition: "team",
    role: "admin",
    ready: "结果",
    at: `/?bot=${BOT}`,
    audit: {
      [search]: [
        {
          id: "e1",
          actorUserId: "person",
          initiatorKind: "person",
          initiatorId: null,
          eventType: "computer.action_allowed",
          targetType: "computer",
          targetId: BOT,
          payload: { bot: BOT, action: "computer_write_file", file: "a.txt" },
          createdAt: "2026-11-06T09:00:00Z",
        },
      ],
    },
  });
  expect(view.container.querySelector("tbody")?.textContent).toContain("a.txt");
  expect(
    view.getByRole("button", {
      name: "显示所有员工，而不只是 Claude Agent SDK",
    }).textContent,
  ).toBe("只看 Claude Agent SDK");
});

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
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Two rows Settings > Activity showed in the personal edition that a person could not read. Seen on
 * Windows: "Choose tools for a run / 96 of 96 tools / Couldn't choose, so all were offered" on every
 * turn, OpenBot's own working; and choosing a folder for a Bot on Settings > Computer read "Change a
 * setting" with no Bot and no folder.
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

const BOT = "personal-assistant";

function row(
  id: string,
  minute: number,
  eventType: string,
  targetType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId: id,
    payload,
    createdAt: `2026-11-07T18:${String(minute).padStart(2, "0")}:00Z`,
  };
}

const CHOOSE_TOOLS = row("tools", 2, "mcp.tools_discovered", "bot", {
  bot: BOT,
  reason: "unavailable",
  granted: 96,
  offered: 96,
  skills: [],
});
const READ = row("read", 1, "computer.action_allowed", "host_access", {
  bot: BOT,
  action: "host/read_file",
  file: "todo.txt",
});

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

/** Each row as drawn: what, and what it was done to; the Bot, and who started it; the decision. */
function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    what: lines(tr.querySelector("[data-column=what]")),
    who: lines(tr.querySelector("[data-column=bot]")),
    decision: lines(tr.querySelector("[data-column=decision]")),
  }));
}

test("Admin keeps choosing tools for a run, as it read before", async () => {
  const view = await renderPage({ "": [CHOOSE_TOOLS, READ] });
  expect(drawn(view.container)[0]).toEqual({
    what: ["为一次运行挑选工具", "96 / 96 个工具"],
    who: ["Personal Assistant", "由某个人发起"],
    decision: ["本次运行提供的工具", "没法挑选，所以全部提供"],
  });
});

/** A folder row as Settings > Computer writes it, and as it wrote it before it said so. */
const FOLDER_ROWS = [
  row("given", 9, "configuration.changed", "host_access", {
    change: "host_folder_granted",
    bot: BOT,
    folder: "share",
  }),
  row("taken", 8, "configuration.changed", "host_access", {
    change: "host_folder_revoked",
    bot: BOT,
    folder: "share",
  }),
  row("stopped", 7, "configuration.changed", "host_access", {
    change: "host_access_stopped",
    bot: BOT,
    folders: ["share", "Documents"],
  }),
  row("old-given", 3, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    targetId: "old-given",
    change: "host_folder_granted",
    botId: BOT,
  }),
  row("old-taken", 2, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    targetId: "old-given",
    change: "host_folder_revoked",
  }),
  row("old-stopped", 1, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    change: "host_access_stopped",
  }),
];

test("a folder given to a Bot, taken away or stopped reads in words, with the Bot and the folder", async () => {
  const view = await renderPage({ "": FOLDER_ROWS });
  const person = "由某个人发起";
  const changed = ["配置已修改"];
  expect(drawn(view.container)).toEqual([
    {
      what: ["给员工一个文件夹", "share"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    {
      what: ["从员工收回文件夹", "share"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    {
      what: ["停止文件夹访问", "share, Documents"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    // Older rows read as well as what they kept: the Bot a folder was given to, and no folder.
    {
      what: ["给员工一个文件夹"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    {
      what: ["从员工收回文件夹"],
      who: ["-", person],
      decision: changed,
    },
    { what: ["停止文件夹访问"], who: ["-", person], decision: changed },
  ]);
  expect(view.container.textContent).not.toContain("修改设置");
});
